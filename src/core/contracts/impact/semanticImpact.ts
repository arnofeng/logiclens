import type {
  ReadableContractSpecNode,
  SemanticRelationEdge,
  SemanticRelationKind
} from "../../parsing/types.js";
import { isKnownContractSpecNode } from "../../parsing/types.js";
import type { GraphDB } from "../../graph-model/db.js";
import { SEMANTIC_REL_META } from "../semanticRelations.js";
import { findTargetSpecs } from "./impactEngine.js";
import { normalizeSemanticTarget } from "../targetNormalization.js";
import { summarizeSpec } from "../semanticTrace.js";
import {
  SEMANTIC_REL_RETURN,
  SPEC_RETURN,
  rowToReadableContractSpec,
  rowToSemanticRel,
  type SemanticRelRow,
  type SpecRow
} from "../specRows.js";

export type SemanticImpactNode = {
  specId: string;
  contractId: string;
  specKind: string;
  canonicalKey: string;
  repoId: string;
  filePath: string;
  hop: number;
  summary: string;
  confidence: number;
  relationKind?: SemanticRelationKind;
  reason?: string;
  viaSpecId?: string;
};

export type SemanticImpactEdge = {
  fromSpecId: string;
  toSpecId: string;
  kind: SemanticRelationKind;
  reason: string;
  confidence: number;
  hop: number;
};

export type SemanticImpactReport = {
  target: string;
  normalizedTarget: string;
  maxHops: number;
  targets: SemanticImpactNode[];
  nodes: SemanticImpactNode[];
  edges: SemanticImpactEdge[];
  affectedRepos: string[];
  recommendedFiles: string[];
  truncated: boolean;
};

export type SemanticImpactOptions = {
  maxHops?: number;
};

type ImpactStep = {
  impactedSpecId: string;
  edge: SemanticRelationEdge;
  viaSpecId?: string;
};

export function getImpactedSpecId(edge: SemanticRelationEdge, currentSpecId: string): string | null {
  const meta = SEMANTIC_REL_META[edge.kind];
  if (!meta) return null;
  if (meta.category !== "consumer-to-producer" && meta.category !== "schema-to-use") return null;

  if (meta.direction === "forward") {
    return edge.toSpecId === currentSpecId ? edge.fromSpecId : null;
  }
  return edge.fromSpecId === currentSpecId ? edge.toSpecId : null;
}

export function traceImpactPropagation(
  startSpecIds: Set<string>,
  specs: ReadableContractSpecNode[],
  relations: SemanticRelationEdge[],
  maxHops: number
): {
  visited: Map<string, number>;
  incomingStep: Map<string, ImpactStep>;
  pathEdges: SemanticImpactEdge[];
  truncated: boolean;
} {
  const visited = new Map<string, number>();
  const incomingStep = new Map<string, ImpactStep>();
  const pathEdges: SemanticImpactEdge[] = [];
  let frontier = new Set(startSpecIds);
  let truncated = false;
  const specMap = new Map(specs.map((s) => [s.id, s]));
  const bridgedLocalSpecs = new Set<string>();

  for (const id of frontier) visited.set(id, 0);

  for (let hop = 1; hop <= maxHops; hop++) {
    const next = new Set<string>();
    for (const currentSpecId of frontier) {
      for (const edge of relations) {
        for (const step of impactStepsFromEdge(edge, currentSpecId, specMap)) {
          if (bridgedLocalSpecs.has(step.impactedSpecId)) continue;
          if (visited.has(step.impactedSpecId) || next.has(step.impactedSpecId)) continue;

          if (step.viaSpecId && step.edge.fromSpecId !== step.viaSpecId) {
            bridgedLocalSpecs.add(step.edge.fromSpecId);
          }
          next.add(step.impactedSpecId);
          incomingStep.set(step.impactedSpecId, step);
          pathEdges.push({
            fromSpecId: edge.fromSpecId,
            toSpecId: edge.toSpecId,
            kind: edge.kind,
            reason: edge.reason,
            confidence: edge.confidence,
            hop
          });
        }
      }
    }

    if (next.size === 0) break;
    for (const id of next) visited.set(id, hop);

    if (hop === maxHops) {
      truncated = hasMoreImpactTargets(next, specs, relations, visited);
      break;
    }
    frontier = next;
  }

  return { visited, incomingStep, pathEdges, truncated };
}

function hasMoreImpactTargets(
  frontier: Set<string>,
  specs: ReadableContractSpecNode[],
  relations: SemanticRelationEdge[],
  visited: Map<string, number>
): boolean {
  const specMap = new Map(specs.map((s) => [s.id, s]));
  for (const currentSpecId of frontier) {
    for (const edge of relations) {
      for (const step of impactStepsFromEdge(edge, currentSpecId, specMap)) {
        if (!visited.has(step.impactedSpecId)) return true;
      }
    }
  }
  return false;
}

function impactStepsFromEdge(
  edge: SemanticRelationEdge,
  currentSpecId: string,
  specMap: Map<string, ReadableContractSpecNode>
): ImpactStep[] {
  const direct = getImpactedSpecId(edge, currentSpecId);
  if (direct) return [{ impactedSpecId: direct, edge }];

  return [
    ...getImplementationUpstreamSpecIds(edge, currentSpecId, specMap),
    ...getImplementationDownstreamSpecIds(edge, currentSpecId, specMap)
  ].map((impactedSpecId) => ({ impactedSpecId, edge, viaSpecId: currentSpecId }));
}

function getImplementationUpstreamSpecIds(
  edge: SemanticRelationEdge,
  currentSpecId: string,
  specMap: Map<string, ReadableContractSpecNode>
): string[] {
  const meta = SEMANTIC_REL_META[edge.kind];
  if (!meta || meta.category !== "consumer-to-producer" || meta.direction !== "forward") return [];
  if (edge.fromSpecId !== currentSpecId) return [];

  const localConsumer = specMap.get(currentSpecId);
  if (!localConsumer) return [];

  const results: string[] = [];
  for (const candidate of specMap.values()) {
    if (candidate.id === localConsumer.id) continue;
    if (candidate.repoId !== localConsumer.repoId || candidate.fileId !== localConsumer.fileId) continue;
    if (!isLocalProducerBridgeTarget(candidate)) continue;
    if (!sameActionName(localConsumer, candidate)) continue;
    results.push(candidate.id);
  }
  return results;
}

function getImplementationDownstreamSpecIds(
  edge: SemanticRelationEdge,
  currentSpecId: string,
  specMap: Map<string, ReadableContractSpecNode>
): string[] {
  const meta = SEMANTIC_REL_META[edge.kind];
  if (!meta || meta.category !== "consumer-to-producer" || meta.direction !== "forward") return [];

  const current = specMap.get(currentSpecId);
  const localConsumer = specMap.get(edge.fromSpecId);
  if (!current || !localConsumer) return [];
  if (current.id === localConsumer.id) return [];
  if (!isLocalProducerBridgeTarget(current)) return [];
  if (current.repoId !== localConsumer.repoId || current.fileId !== localConsumer.fileId) return [];
  if (!sameActionName(current, localConsumer)) return [];

  return [edge.toSpecId];
}

function isLocalProducerBridgeTarget(spec: ReadableContractSpecNode): boolean {
  return spec.specKind === "http-endpoint" || spec.specKind === "event" || spec.specKind === "graphql-operation";
}

function sameActionName(a: ReadableContractSpecNode, b: ReadableContractSpecNode): boolean {
  const actionA = actionNameOf(a);
  const actionB = actionNameOf(b);
  return !!actionA && !!actionB && actionA === actionB;
}

function actionNameOf(spec: ReadableContractSpecNode): string | null {
  if (spec.specKind === "http-endpoint") {
    const path = spec.pathTemplate || spec.canonicalKey.split(":").slice(1).join(":");
    return lastPathSegment(path);
  }
  if (spec.specKind === "dubbo-method") {
    return spec.canonicalKey.split("#").pop()?.toLowerCase() || null;
  }
  if (spec.specKind === "grpc-method") {
    return spec.canonicalKey.split("/").pop()?.toLowerCase() || null;
  }
  if (spec.specKind === "graphql-operation") {
    return spec.canonicalKey.split(".").pop()?.toLowerCase() || null;
  }
  return null;
}

function lastPathSegment(path: string): string | null {
  const segment = path.split("?")[0]?.split("/").filter(Boolean).pop();
  return segment ? segment.toLowerCase() : null;
}

export function analyzeSemanticImpact(
  target: string,
  specs: ReadableContractSpecNode[],
  relations: SemanticRelationEdge[],
  options: SemanticImpactOptions = {}
): SemanticImpactReport | null {
  const maxHops = options.maxHops ?? 3;
  const normalizedTarget = normalizeSemanticTarget(target);
  const knownSpecs = specs.filter(isKnownContractSpecNode);
  const targetSpecs = findTargetSpecs(normalizedTarget, knownSpecs);
  if (targetSpecs.length === 0) return null;

  const targetIds = selectImpactRootIds(new Set(targetSpecs.map((s) => s.id)), relations);
  const specMap = new Map(specs.map((s) => [s.id, s]));
  const { visited, incomingStep, pathEdges, truncated } = traceImpactPropagation(
    targetIds,
    specs,
    relations,
    maxHops
  );

  const nodes: SemanticImpactNode[] = [];
  for (const [specId, hop] of visited) {
    const spec = specMap.get(specId);
    if (!spec) continue;
    const step = incomingStep.get(specId);
    nodes.push({
      specId: spec.id,
      contractId: spec.contractId,
      specKind: spec.specKind,
      canonicalKey: spec.canonicalKey,
      repoId: spec.repoId,
      filePath: filePathOf(spec.fileId),
      hop,
      summary: summarizeSpec(spec),
      confidence: spec.confidence,
      relationKind: step?.edge.kind,
      reason: step?.edge.reason,
      viaSpecId: step?.viaSpecId ?? (step ? otherSpecId(step.edge, specId) : undefined)
    });
  }

  nodes.sort((a, b) => a.hop - b.hop || repoNameOf(a.repoId).localeCompare(repoNameOf(b.repoId)) || a.canonicalKey.localeCompare(b.canonicalKey));

  const affectedRepos = [...new Set(nodes.map((n) => repoNameOf(n.repoId)))].sort();
  const recommendedFiles = [...new Set(nodes.map((n) => `${repoNameOf(n.repoId)}/${n.filePath}`).filter((f) => !f.endsWith("/")))].sort();
  const targets = nodes.filter((n) => n.hop === 0);

  return {
    target,
    normalizedTarget,
    maxHops,
    targets,
    nodes,
    edges: pathEdges,
    affectedRepos,
    recommendedFiles,
    truncated
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

export async function analyzeSemanticImpactFromDB(
  target: string,
  db: GraphDB,
  options: SemanticImpactOptions = {}
): Promise<SemanticImpactReport | null> {
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

  return analyzeSemanticImpact(
    target,
    specRows.map(rowToReadableContractSpec),
    relRows.map(rowToSemanticRel),
    options
  );
}

function otherSpecId(edge: SemanticRelationEdge, specId: string): string {
  return edge.fromSpecId === specId ? edge.toSpecId : edge.fromSpecId;
}

function repoNameOf(repoId: string): string {
  return repoId.replace(/^repo:/, "");
}

function filePathOf(fileId: string): string {
  const parts = fileId.split(":");
  if (parts[0] === "file" && parts[1] === "repo") return parts.slice(3).join(":");
  return parts.slice(2).join(":") || fileId;
}
