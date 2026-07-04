// ---------------------------------------------------------------------------
// Phase 5: Impact Analysis Engine
//
// Walks the SEMANTIC_REL graph transitively from a changed ContractSpec to
// find all directly and indirectly affected consumers. For schema field
// changes, performs memory-level regex search in consumer files to locate
// field references (avoids SchemaField node explosion in the graph).
// ---------------------------------------------------------------------------

import type {
  ContractSpecKind,
  ContractSpecNode,
  ReadableContractSpecNode,
  SemanticRelationEdge,
  SemanticRelationKind
} from "../../parsing/types.js";
import { isKnownContractSpecNode } from "../../parsing/types.js";
import { deserializeSpec } from "../spec.js";
import {
  CONSUMER_TO_PRODUCER_KINDS,
  SCHEMA_TO_USE_KINDS,
  SEMANTIC_REL_META
} from "../semanticRelations.js";
import {
  type ChangeIntent,
  type ImpactItem,
  type ImpactReport,
  type ImpactSeverity,
  type ImpactAnalysisOptions
} from "./types.js";
import { findFieldReferences } from "./fieldSearch.js";
import { assessHttpEndpointChange, classifyHttpEndpointTargetChange } from "./rules/httpImpactRules.js";
import { assessEventChange, classifyEventTargetChange } from "./rules/eventImpactRules.js";
import { assessSchemaFieldChange, classifySchemaTargetChange } from "./rules/schemaImpactRules.js";
import { assessGrpcMethodChange, classifyGrpcMethodTargetChange } from "./rules/grpcImpactRules.js";
import { assessDubboMethodChange, classifyDubboMethodTargetChange } from "./rules/dubboImpactRules.js";
import { assessGraphqlOperationChange, classifyGraphqlOperationTargetChange } from "./rules/graphqlImpactRules.js";
import { normalizeSemanticTarget } from "../targetNormalization.js";
import {
  getImpactPropagationSpecId,
  getImplementationUpstreamBridgeSteps
} from "../inferredBridge.js";

// Re-export for backward compatibility (tests and external consumers)
export { findFieldReferences } from "./fieldSearch.js";
export type { ImpactAnalysisOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Graph traversal helpers
// ---------------------------------------------------------------------------

/** Builds an adjacency list in the semantic impact propagation direction. */
function buildImpactAdjacency(
  edges: SemanticRelationEdge[]
): Map<string, { impactedSpecId: string; fromSpecId: string; toSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number }[]> {
  const adj = new Map<string, { impactedSpecId: string; fromSpecId: string; toSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number }[]>();
  for (const e of edges) {
    const meta = SEMANTIC_REL_META[e.kind];
    if (!meta || (meta.category !== "consumer-to-producer" && meta.category !== "schema-to-use")) continue;

    const currentSpecId = meta.direction === "forward" ? e.toSpecId : e.fromSpecId;
    const impactedSpecId = meta.direction === "forward" ? e.fromSpecId : e.toSpecId;
    const next = {
      impactedSpecId,
      fromSpecId: e.fromSpecId,
      toSpecId: e.toSpecId,
      kind: e.kind,
      reason: e.reason,
      confidence: e.confidence
    };
    const list = adj.get(currentSpecId);
    if (list) {
      list.push(next);
    } else {
      adj.set(currentSpecId, [next]);
    }
  }
  return adj;
}

/**
 * Finds all specs impacted by `startSpecIds` by following relation-specific
 * impact propagation direction up to `maxHops` hops.
 */
function traverseImpactDirection(
  startSpecIds: Set<string>,
  impactAdj: Map<string, { impactedSpecId: string; kind: SemanticRelationKind; confidence: number }[]>,
  maxHops: number
): Map<string, number> {
  const visited = new Map<string, number>();
  let frontier = new Set(startSpecIds);
  for (const id of frontier) visited.set(id, 0);

  for (let hop = 1; hop <= maxHops; hop++) {
    const next = new Set<string>();
    for (const id of frontier) {
      const neighbors = impactAdj.get(id);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!visited.has(n.impactedSpecId)) {
          visited.set(n.impactedSpecId, hop);
          next.add(n.impactedSpecId);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  return visited;
}

type ImpactPathStep = {
  impactedSpecId: string;
  edge: SemanticRelationEdge;
  hop: number;
};

function traverseImpactSteps(
  startSpecIds: Set<string>,
  specs: ReadableContractSpecNode[],
  relations: SemanticRelationEdge[],
  maxHops: number
): { visited: Map<string, number>; steps: ImpactPathStep[] } {
  const visited = new Map<string, number>();
  const steps: ImpactPathStep[] = [];
  const specMap = new Map(specs.map((s) => [s.id, s]));
  let frontier = new Set(startSpecIds);
  for (const id of frontier) visited.set(id, 0);

  for (let hop = 1; hop <= maxHops; hop++) {
    const next = new Set<string>();
    for (const currentSpecId of frontier) {
      for (const edge of relations) {
        for (const impactedSpecId of getImpactStepSpecIds(edge, currentSpecId, specMap)) {
          if (visited.has(impactedSpecId) || next.has(impactedSpecId)) continue;
          next.add(impactedSpecId);
          steps.push({ impactedSpecId, edge, hop });
        }
      }
    }
    if (next.size === 0) break;
    for (const id of next) visited.set(id, hop);
    frontier = next;
  }

  return { visited, steps };
}

function getImpactStepSpecIds(
  edge: SemanticRelationEdge,
  currentSpecId: string,
  specMap: Map<string, ReadableContractSpecNode>
): string[] {
  const direct = getImpactedSpecId(edge, currentSpecId);
  if (direct) return [direct];
  return getImplementationUpstreamBridgeSteps(edge, currentSpecId, specMap).map((step) => step.specId);
}

function getImpactedSpecId(edge: SemanticRelationEdge, currentSpecId: string): string | null {
  return getImpactPropagationSpecId(edge, currentSpecId);
}

// ---------------------------------------------------------------------------
// Edge collection — finds the specific edges on shortest paths
// ---------------------------------------------------------------------------

/** Collects the edges that connect visited specs to their predecessors. */
function collectIncomingEdgesOnPaths(
  visited: Map<string, number>,
  relations: SemanticRelationEdge[]
): { fromSpecId: string; toSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number; hop: number }[] {
  const result: { fromSpecId: string; toSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number; hop: number }[] = [];

  for (const edge of relations) {
    const meta = SEMANTIC_REL_META[edge.kind];
    if (!meta || (meta.category !== "consumer-to-producer" && meta.category !== "schema-to-use")) continue;

    const currentSpecId = meta.direction === "forward" ? edge.toSpecId : edge.fromSpecId;
    const impactedSpecId = meta.direction === "forward" ? edge.fromSpecId : edge.toSpecId;
    const hopCurrent = visited.get(currentSpecId);
    const hopImpacted = visited.get(impactedSpecId);
    if (hopCurrent === undefined || hopImpacted === undefined) continue;

    if (hopImpacted === hopCurrent + 1) {
      result.push({
        fromSpecId: edge.fromSpecId,
        toSpecId: edge.toSpecId,
        kind: edge.kind,
        reason: edge.reason,
        confidence: edge.confidence,
        hop: hopImpacted
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Spec resolution
// ---------------------------------------------------------------------------

/**
 * Parses a target string like "schema:CreateOrderRequest" or
 * "api:POST:/api/orders" into { kind, key } components.
 */
export function parseTarget(target: string): { kind: string; key: string } | null {
  const colonIdx = target.indexOf(":");
  if (colonIdx === -1) {
    // Could be a bare schema name — treat as schema kind
    return { kind: "schema", key: target };
  }
  const kind = target.slice(0, colonIdx);
  const key = target.slice(colonIdx + 1);
  return { kind, key };
}

/**
 * Finds ContractSpec nodes matching a target string.
 */
export function findTargetSpecs(
  target: string,
  specs: ContractSpecNode[]
): ContractSpecNode[] {
  const parsed = parseTarget(normalizeSemanticTarget(target));
  if (!parsed) return [];

  // Map user-facing kind to specKind
  const specKindMap: Record<string, string> = {
    api: "http-endpoint",
    http: "http-endpoint",
    event: "event",
    schema: "schema",
    dto: "schema",
    grpc: "grpc-method",
    dubbo: "dubbo-method",
    graphql: "graphql-operation",
  };
  const targetSpecKind = specKindMap[parsed.kind] ?? parsed.kind;

  return specs.filter((s) => {
    if (s.specKind !== targetSpecKind) return false;
    // Match by canonicalKey, contractId, or name within specJson
    if (s.canonicalKey === parsed.key) return true;
    if (s.contractId.endsWith(`:${parsed.key}`)) return true;
    // For schema, also match by name in specJson
    if (s.specKind === "schema") {
      try {
        const spec = deserializeSpec(s.specJson);
        if (spec.kind === "schema" && spec.name === parsed.key) return true;
      } catch { /* ignore parse errors */ }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function worstSeverity(a: ImpactSeverity, b: ImpactSeverity): ImpactSeverity {
  const order: ImpactSeverity[] = ["compatible", "risky", "breaking"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Main analysis entry point
// ---------------------------------------------------------------------------


/**
 * Analyzes the downstream impact of a contract change.
 *
 * Algorithm:
 * 1. Resolve the target change to matching ContractSpec node(s)
 * 2. Walk incoming edges (consumer-to-producer and schema-to-use only) from the
 *    target spec(s) to find all directly and indirectly affected dependents.
 *    This single traversal covers schema, endpoint, event, and gRPC targets:
 *    e.g. for a schema change it reaches the endpoints/events that use the
 *    schema and, transitively, their consumers.
 * 3. For each reachable dependent spec, apply the appropriate impact rule
 * 4. For schema field changes, search consumer files for field references
 * 5. Aggregate into a structured ImpactReport
 */
export function analyzeImpact(
  change: ChangeIntent,
  specs: ReadableContractSpecNode[],
  relations: SemanticRelationEdge[],
  options: ImpactAnalysisOptions = {}
): ImpactReport {
  const maxHops = options.maxHops ?? 3;

  // -- Step 1: Resolve target specs ------------------------------------------
  const knownSpecs = specs.filter(isKnownContractSpecNode);
  const targetSpecs = findTargetSpecs(change.target, knownSpecs);
  if (targetSpecs.length === 0) {
    return {
      change,
      overallSeverity: "compatible",
      impacts: [],
      summary: { breaking: 0, risky: 0, compatible: 0 },
      recommendedFiles: [],
      traversedEdgeCount: 0,
      inspectedSpecCount: 0,
    };
  }

  const targetSpecIds = selectImpactRootIds(new Set(targetSpecs.map((s) => s.id)), relations);
  const impactRootSpecs = targetSpecs.filter((s) => targetSpecIds.has(s.id));
  const specMap = new Map(specs.map((s) => [s.id, s]));
  const isSchemaChange = impactRootSpecs[0]?.specKind === "schema";

  const transitiveRelations = relations.filter((e) =>
    CONSUMER_TO_PRODUCER_KINDS.has(e.kind) || SCHEMA_TO_USE_KINDS.has(e.kind)
  );

  // -- Step 2: Traverse the graph --------------------------------------------
  const impacts: ImpactItem[] = [];
  const seenEdges = new Set<string>();
  let inspectedSpecIds = new Set(targetSpecIds);

  // For the target specs themselves, produce an "intended change" item
  for (const ts of impactRootSpecs) {
    const targetItem = classifyTargetChange(change, ts);
    if (targetItem) impacts.push(targetItem);
  }

  // Walk relation-specific impact direction to find directly and indirectly affected consumers
  const { visited, steps: pathSteps } = traverseImpactSteps(targetSpecIds, specs, transitiveRelations, maxHops);

  for (const step of pathSteps) {
    const impactedSpec = specMap.get(step.impactedSpecId);
    if (!impactedSpec || targetSpecIds.has(step.impactedSpecId)) continue;
    inspectedSpecIds.add(step.impactedSpecId);
    inspectedSpecIds.add(step.edge.fromSpecId);
    inspectedSpecIds.add(step.edge.toSpecId);

    const edgeKey = `${step.impactedSpecId}:${step.edge.kind}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);

    const items = classifyImpact(change, impactedSpec, step.edge.kind, step.edge.reason, step.edge.confidence, options);
    impacts.push(...items);
  }

  // -- Step 3: Field-level search in consumer files (schema changes only) ----
  if (isSchemaChange && options.readFile && change.detail) {
    const consumerSpecIds = new Set<string>();
    // Collect all consumer specs from the impacts so far
    for (const edge of relations) {
      if (CONSUMER_TO_PRODUCER_KINDS.has(edge.kind)) {
        consumerSpecIds.add(edge.fromSpecId);
      }
    }

    for (const specId of consumerSpecIds) {
      const spec = specMap.get(specId);
      if (!spec || !spec.fileId) continue;
      const content = options.readFile(spec.repoId, spec.fileId);
      if (!content) continue;

      const refs = findFieldReferences(content, change.detail);
      if (refs.length > 0) {
        for (const ref of refs) {
          impacts.push({
            repoId: spec.repoId,
            specId: spec.id,
            filePath: spec.fileId,
            line: ref.line,
            symbol: `${change.target.split(":").pop() ?? change.target}.${change.detail}`,
            relationKind: "USES_SCHEMA",
            severity: change.changeType === "field-removed" ? "breaking"
              : change.changeType === "field-added" ? "compatible" : "risky",
            description: `Field '${change.detail}' referenced in ${spec.repoId}/${spec.fileId}`,
            evidence: ref.raw,
            confidence: spec.confidence,
          });
        }
      }
    }
  }

  // -- Step 4: Deduplicate and aggregate ------------------------------------
  const deduped = deduplicateImpacts(impacts);

  let overallSeverity: ImpactSeverity = "compatible";
  let breaking = 0, risky = 0, compatible = 0;
  for (const imp of deduped) {
    if (imp.severity === "breaking") breaking++;
    else if (imp.severity === "risky") risky++;
    else compatible++;
    overallSeverity = worstSeverity(overallSeverity, imp.severity);
  }

  const recommendedFiles = [...new Set(
    deduped.filter((i) => i.filePath).map((i) => `${i.repoId}/${i.filePath}`)
  )].sort();

  return {
    change,
    overallSeverity,
    impacts: deduped.sort(bySeverityThenRepo),
    summary: { breaking, risky, compatible },
    recommendedFiles,
    traversedEdgeCount: seenEdges.size,
    inspectedSpecCount: inspectedSpecIds.size,
  };
}

function selectImpactRootIds(matchedSpecIds: Set<string>, relations: SemanticRelationEdge[]): Set<string> {
  const roots = new Set<string>();
  for (const edge of relations) {
    if (!matchedSpecIds.has(edge.fromSpecId) || !matchedSpecIds.has(edge.toSpecId)) continue;
    const meta = SEMANTIC_REL_META[edge.kind];
    if (!meta || (meta.category !== "consumer-to-producer" && meta.category !== "schema-to-use")) continue;
    roots.add(meta.direction === "forward" ? edge.toSpecId : edge.fromSpecId);
  }
  return roots.size > 0 ? roots : matchedSpecIds;
}

// ---------------------------------------------------------------------------
// Impact classification — registry-based dispatch
// ---------------------------------------------------------------------------

/** Registry: target change classifiers keyed by specKind. */
const TARGET_CLASSIFIERS: Partial<Record<
  ContractSpecKind,
  (change: ChangeIntent, spec: ContractSpecNode) => ImpactItem | null
>> = {
  "http-endpoint": classifyHttpEndpointTargetChange,
  "event":         classifyEventTargetChange,
  "schema":        classifySchemaTargetChange,
  "grpc-method":   classifyGrpcMethodTargetChange,
  "dubbo-method":  classifyDubboMethodTargetChange,
  "graphql-operation": classifyGraphqlOperationTargetChange,
};

/** Registry: downstream impact classifiers keyed by specKind. */
const IMPACT_CLASSIFIERS: Partial<Record<
  ContractSpecKind,
  (change: ChangeIntent, spec: ContractSpecNode, relationKind: SemanticRelationKind,
   reason: string, confidence: number, options: ImpactAnalysisOptions) => ImpactItem[]
>> = {
  "http-endpoint": assessHttpEndpointChange,
  "event":         assessEventChange,
  "schema":        assessSchemaFieldChange,
  "grpc-method":   assessGrpcMethodChange,
  "dubbo-method":  assessDubboMethodChange,
  "graphql-operation": assessGraphqlOperationChange,
};

function classifyTargetChange(
  change: ChangeIntent,
  spec: ContractSpecNode
): ImpactItem | null {
  const classifier = TARGET_CLASSIFIERS[spec.specKind];
  return classifier ? classifier(change, spec) : null;
}

function classifyImpact(
  change: ChangeIntent,
  dependentSpec: ReadableContractSpecNode,
  relationKind: SemanticRelationKind,
  reason: string,
  confidence: number,
  options: ImpactAnalysisOptions
): ImpactItem[] {
  if (!isKnownContractSpecNode(dependentSpec)) {
    return [{
      severity: "risky",
      repoId: dependentSpec.repoId,
      filePath: dependentSpec.fileId,
      symbol: dependentSpec.canonicalKey,
      relationKind,
      description: `Opaque contract spec ${dependentSpec.specKind} is connected by ${relationKind}; structured impact rules were not applied.`,
      evidence: reason || dependentSpec.warning,
      specId: dependentSpec.id,
      confidence: Math.min(confidence, 0.4)
    }];
  }
  const classifier = IMPACT_CLASSIFIERS[dependentSpec.specKind];
  if (!classifier) return [];
  const items = classifier(change, dependentSpec, relationKind, reason, confidence, options);
  if (items.length > 0) return items;
  return [{
    severity: "risky",
    repoId: dependentSpec.repoId,
    filePath: dependentSpec.fileId,
    symbol: dependentSpec.canonicalKey,
    relationKind,
    description: `${dependentSpec.specKind} is transitively connected to ${change.target}; no specific ${change.changeType} rule was applied.`,
    evidence: reason,
    specId: dependentSpec.id,
    confidence: Math.min(confidence, dependentSpec.confidence, 0.6)
  }];
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function deduplicateImpacts(impacts: ImpactItem[]): ImpactItem[] {
  const seen = new Map<string, ImpactItem>();
  for (const imp of impacts) {
    const key = `${imp.repoId}:${imp.filePath}:${imp.symbol}:${imp.relationKind}:${imp.line ?? 0}`;
    const existing = seen.get(key);
    // Keep the one with higher confidence, or worst severity on tie
    if (!existing || imp.confidence > existing.confidence ||
        (imp.confidence === existing.confidence && severityRank(imp.severity) > severityRank(existing.severity))) {
      seen.set(key, imp);
    }
  }
  return [...seen.values()];
}

function severityRank(s: ImpactSeverity): number {
  return s === "breaking" ? 3 : s === "risky" ? 2 : 1;
}

function bySeverityThenRepo(a: ImpactItem, b: ImpactItem): number {
  const sa = severityRank(a.severity);
  const sb = severityRank(b.severity);
  if (sa !== sb) return sb - sa; // breaking first
  return a.repoId.localeCompare(b.repoId) || a.filePath.localeCompare(b.filePath);
}

// ---------------------------------------------------------------------------
// Graph-DB backed analysis (for runtime use)
// ---------------------------------------------------------------------------

import type { GraphDB } from "../../graph-model/db.js";
import {
  SEMANTIC_REL_RETURN,
  SPEC_RETURN,
  rowToReadableContractSpec,
  rowToSemanticRel,
  type SemanticRelRow,
  type SpecRow
} from "../specRows.js";

/**
 * Analyzes impact by querying the graph database for ContractSpec nodes and
 * SEMANTIC_REL edges, then delegating to the in-memory {@link analyzeImpact}.
 */
export async function analyzeImpactFromDB(
  change: ChangeIntent,
  db: GraphDB,
  options: ImpactAnalysisOptions = {}
): Promise<ImpactReport> {
  const specRows = await db.query<SpecRow>(
    `MATCH (s:ContractSpec)
     WHERE (s.active IS NULL OR s.active = true)
     RETURN ${SPEC_RETURN}`
  );

  const relRows = await db.query<SemanticRelRow>(
    `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
     WHERE (r.active IS NULL OR r.active = true)
     RETURN ${SEMANTIC_REL_RETURN}`
  );

  const specs = specRows.map(rowToReadableContractSpec);
  const relations = relRows.map(rowToSemanticRel);

  return analyzeImpact(change, specs, relations, options);
}
