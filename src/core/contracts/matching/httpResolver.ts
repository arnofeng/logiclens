import type { ContractSpecNode, SemanticRelationEdge } from "../../parsing/types.js";
import type { SpecRoleMap } from "./types.js";
import { confidenceFor } from "../../../shared/confidence.js";
import { deserializeSpec } from "../spec.js";
import type { HttpEndpointSpec } from "../spec.js";

// ---------------------------------------------------------------------------
// Bucket indexing
// ---------------------------------------------------------------------------

/** Extracts the first non-template path segment as a bucket key. */
function bucketKey(pathTemplate: string): string {
  const trimmed = pathTemplate.replace(/\/$/, "") || "/";
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const first = segments[0]!;
  // Template first segments (e.g. `{tenant}`) go to a catch-all bucket so they
  // can only match other template-first-segment specs.
  if (isTemplateSegment(first)) return "*";
  return `/${first}`;
}

function isTemplateSegment(segment: string): boolean {
  return /^\{.+\}$/.test(segment);
}

function splitPath(pathTemplate: string): string[] {
  return pathTemplate.replace(/\/$/, "").split("/").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

/**
 * Returns true when `a` and `b` have the same number of segments and every
 * segment is either identical or at least one side is a template `{param}`.
 */
function pathsCompatible(a: string, b: string): boolean {
  const segA = splitPath(a);
  const segB = splitPath(b);
  if (segA.length !== segB.length) return false;
  for (let i = 0; i < segA.length; i++) {
    if (segA[i] === segB[i]) continue;
    if (isTemplateSegment(segA[i]!) || isTemplateSegment(segB[i]!)) continue;
    return false;
  }
  return true;
}

/** True when `staticPath` (no templates) matches the template pattern. */
function staticFitsTemplate(staticPath: string, templatePath: string): boolean {
  const segStatic = splitPath(staticPath);
  const segTpl = splitPath(templatePath);
  if (segStatic.length !== segTpl.length) return false;
  for (let i = 0; i < segStatic.length; i++) {
    if (isTemplateSegment(segTpl[i]!)) continue;
    if (segStatic[i] !== segTpl[i]) return false;
  }
  return true;
}

function hasTemplates(path: string): boolean {
  return splitPath(path).some(isTemplateSegment);
}

// ---------------------------------------------------------------------------
// Match classification
// ---------------------------------------------------------------------------

type HttpMatchKind =
  | "exact-method-path"
  | "template-compatible"
  | "static-to-template"
  | "path-only"
  | "wildcard";

interface ClassifiedMatch {
  kind: HttpMatchKind;
  reason: string;
  confidence: number;
}

function classifyHttpMatch(
  fromSpec: ContractSpecNode,
  toSpec: ContractSpecNode
): ClassifiedMatch | null {
  const fromHttp = deserializeSpec(fromSpec.specJson) as HttpEndpointSpec;
  const toHttp = deserializeSpec(toSpec.specJson) as HttpEndpointSpec;

  const fromPath = fromHttp.pathTemplate || fromHttp.path;
  const toPath = toHttp.pathTemplate || toHttp.path;
  const fromMethod = fromHttp.method;
  const toMethod = toHttp.method;

  // 1. exact-method-path: method + pathTemplate identical
  if (fromMethod && toMethod && fromMethod === toMethod && fromPath === toPath) {
    return {
      kind: "exact-method-path",
      reason: `Exact method+path match: ${fromMethod} ${fromPath}`,
      confidence: confidenceFor("exact-method-path-match")
    };
  }

  // 2. path-only: path matches, one side lacks method
  if (fromPath === toPath && (!fromMethod || !toMethod)) {
    const methodNote = fromMethod || toMethod
      ? ` (method: ${fromMethod || toMethod} vs unknown)`
      : "";
    return {
      kind: "path-only",
      reason: `Path match with missing method: ${fromPath}${methodNote}`,
      confidence: confidenceFor("path-only-match")
    };
  }

  // 3. static-to-template: one is static, other is template
  const fromHasTpl = hasTemplates(fromPath);
  const toHasTpl = hasTemplates(toPath);
  if (fromHasTpl !== toHasTpl) {
    const staticPath = fromHasTpl ? toPath : fromPath;
    const templatePath = fromHasTpl ? fromPath : toPath;
    if (staticFitsTemplate(staticPath, templatePath)) {
      // Reject when both sides declare a method and they differ — a GET /list
      // consumer does not call a DELETE /{id} producer just because their paths
      // happen to be template-compatible.
      if (fromMethod && toMethod && fromMethod !== toMethod) return null;
      const methodInfo = fromMethod && toMethod
        ? ` ${fromMethod}`
        : "";
      return {
        kind: "static-to-template",
        reason: `Static path ${staticPath} matches template ${templatePath}${methodInfo}`,
        confidence: confidenceFor("static-path-to-template-match")
      };
    }
  }

  // 4. template-compatible: both have templates, segment counts match
  if (fromHasTpl && toHasTpl && pathsCompatible(fromPath, toPath)) {
    // Reject when both sides declare a method and they differ.
    if (fromMethod && toMethod && fromMethod !== toMethod) return null;
    const methodInfo = fromMethod && toMethod
      ? ` ${fromMethod}`
      : "";
    return {
      kind: "template-compatible",
      reason: `Template-compatible: ${fromPath} ↔ ${toPath}${methodInfo}`,
      confidence: confidenceFor("template-compatible-match")
    };
  }

  // 5. wildcard: first segment is template on either side, paths compatible
  const fromFirst = splitPath(fromPath)[0];
  const toFirst = splitPath(toPath)[0];
  if (
    (fromFirst && isTemplateSegment(fromFirst)) ||
    (toFirst && isTemplateSegment(toFirst))
  ) {
    if (pathsCompatible(fromPath, toPath)) {
      // Reject when both sides declare a method and they differ.
      if (fromMethod && toMethod && fromMethod !== toMethod) return null;
      return {
        kind: "wildcard",
        reason: `Wildcard/template first-segment match: ${fromPath} ↔ ${toPath}`,
        confidence: confidenceFor("wildcard-path-match")
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Matches HTTP endpoint ContractSpecs across repos and produces CALLS_ENDPOINT
 * SEMANTIC_REL edges (consumer → producer).
 *
 * Uses bucket indexing by first path segment for O(N) average performance.
 */
export function resolveHttpRelations(
  specs: ContractSpecNode[],
  specRoles: SpecRoleMap
): SemanticRelationEdge[] {
  const httpSpecs = specs.filter((s) => s.specKind === "http-endpoint");
  if (httpSpecs.length < 2) return [];

  // Partition into producers and consumers
  const producers: ContractSpecNode[] = [];
  const consumers: ContractSpecNode[] = [];

  for (const spec of httpSpecs) {
    const role = specRoles.get(`${spec.contractId}:${spec.repoId}`) ?? "shared";
    if (role === "producer" || role === "owner") {
      producers.push(spec);
    } else if (role === "consumer") {
      consumers.push(spec);
    }
    // "shared" specs participate as both
    if (role === "shared") {
      producers.push(spec);
      consumers.push(spec);
    }
  }

  if (producers.length === 0 || consumers.length === 0) return [];

  // Bucket by first path segment
  const producerBuckets = bucketSpecs(producers);
  const consumerBuckets = bucketSpecs(consumers);

  interface Candidate {
    consumerSpec: ContractSpecNode;
    producerSpec: ContractSpecNode;
    matchKind: HttpMatchKind;
    edge: SemanticRelationEdge;
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  // Match within each consumer bucket against its corresponding producer bucket,
  // and also against the "*" catch-all producer bucket for wildcard cross-bucket
  // matches (e.g. consumer at /acme/orders matching producer at /{tenant}/orders).
  for (const [bucket, consumerList] of consumerBuckets) {
    // Same-bucket producers
    const sameBucketProducers = producerBuckets.get(bucket) ?? [];
    // Catch-all producers (template-first-segment)
    const wildcardProducers = bucket !== "*" ? (producerBuckets.get("*") ?? []) : [];

    const allProducers = [...sameBucketProducers, ...wildcardProducers];
    if (allProducers.length === 0) continue;

    for (const consumerSpec of consumerList) {
      for (const producerSpec of allProducers) {
        // Skip same spec
        if (consumerSpec.id === producerSpec.id) continue;
        // Skip same repo
        if (consumerSpec.repoId === producerSpec.repoId) continue;

        const match = classifyHttpMatch(consumerSpec, producerSpec);
        if (!match) continue;

        const dedupKey = `${consumerSpec.id}:${producerSpec.id}:CALLS_ENDPOINT`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        candidates.push({
          consumerSpec,
          producerSpec,
          matchKind: match.kind,
          edge: {
            fromSpecId: consumerSpec.id,
            toSpecId: producerSpec.id,
            kind: "CALLS_ENDPOINT",
            evidenceId: consumerSpec.evidenceId,
            reason: match.reason,
            confidence: match.confidence
          }
        });
      }
    }
  }

  // Also match catch-all consumers ("*" bucket) against all producer buckets
  const wildcardConsumers = consumerBuckets.get("*") ?? [];
  if (wildcardConsumers.length > 0) {
    for (const [, producerList] of producerBuckets) {
      for (const consumerSpec of wildcardConsumers) {
        for (const producerSpec of producerList) {
          if (consumerSpec.id === producerSpec.id) continue;
          if (consumerSpec.repoId === producerSpec.repoId) continue;

          const match = classifyHttpMatch(consumerSpec, producerSpec);
          if (!match) continue;

          const dedupKey = `${consumerSpec.id}:${producerSpec.id}:CALLS_ENDPOINT`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          candidates.push({
            consumerSpec,
            producerSpec,
            matchKind: match.kind,
            edge: {
              fromSpecId: consumerSpec.id,
              toSpecId: producerSpec.id,
              kind: "CALLS_ENDPOINT",
              evidenceId: consumerSpec.evidenceId,
              reason: match.reason,
              confidence: match.confidence
            }
          });
        }
      }
    }
  }

  // Group candidates by consumerSpec.id
  const candidatesByConsumer = new Map<string, Candidate[]>();
  for (const c of candidates) {
    let list = candidatesByConsumer.get(c.consumerSpec.id);
    if (!list) {
      list = [];
      candidatesByConsumer.set(c.consumerSpec.id, list);
    }
    list.push(c);
  }

  const finalEdges: SemanticRelationEdge[] = [];

  for (const [_, consumerCandidates] of candidatesByConsumer) {
    // Group this consumer's candidates by the producer's repoId
    const candidatesByRepo = new Map<string, Candidate[]>();
    for (const c of consumerCandidates) {
      const repoId = c.producerSpec.repoId;
      let list = candidatesByRepo.get(repoId);
      if (!list) {
        list = [];
        candidatesByRepo.set(repoId, list);
      }
      list.push(c);
    }

    for (const [_, repoCandidates] of candidatesByRepo) {
      // Prioritize exact-method-path, then path-only, then fallback to other matches in this repo group
      const hasExact = repoCandidates.some(c => c.matchKind === "exact-method-path");
      const hasPathOnly = repoCandidates.some(c => c.matchKind === "path-only");
      for (const c of repoCandidates) {
        if (hasExact) {
          if (c.matchKind !== "exact-method-path") {
            continue;
          }
        } else if (hasPathOnly) {
          if (c.matchKind !== "path-only") {
            continue;
          }
        }
        finalEdges.push(c.edge);
      }
    }
  }

  return finalEdges;

}

function bucketSpecs(specs: ContractSpecNode[]): Map<string, ContractSpecNode[]> {
  const map = new Map<string, ContractSpecNode[]>();
  for (const spec of specs) {
    const key = bucketKey(spec.pathTemplate ?? (JSON.parse(spec.specJson) as HttpEndpointSpec).path);
    const list = map.get(key);
    if (list) {
      list.push(spec);
    } else {
      map.set(key, [spec]);
    }
  }
  return map;
}
