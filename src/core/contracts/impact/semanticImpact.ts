import type {
  ReadableContractSpecNode,
  SemanticRelationEdge,
  SemanticRelationKind
} from "../../parsing/types.js";
import { isKnownContractSpecNode } from "../../parsing/types.js";
import type { GraphDB } from "../../graph-model/db.js";
import { loadActiveSemanticGraph } from "../../graph-model/queries.js";
import { SEMANTIC_REL_META, selectImpactRootIds } from "../semanticRelations.js";
import { findTargetSpecs } from "./impactEngine.js";
import { normalizeSemanticTarget } from "../targetNormalization.js";
import { summarizeSpec } from "../semanticTrace.js";
import {
  getImpactPropagationSpecId,
  implementationBridgeStepsFromEdge,
  type TraceRelationKind
} from "../inferredBridge.js";

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
  relationKind?: TraceRelationKind;
  materialization?: "materialized" | "inferred";
  sourceEdgeKind?: SemanticRelationKind;
  reason?: string;
  viaSpecId?: string;
};

export type SemanticImpactEdge = {
  fromSpecId: string;
  toSpecId: string;
  kind: TraceRelationKind;
  materialization: "materialized" | "inferred";
  sourceEdgeKind?: SemanticRelationKind;
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
  kind: TraceRelationKind;
  materialization: "materialized" | "inferred";
  sourceEdgeKind?: SemanticRelationKind;
  reason: string;
  confidence: number;
  viaSpecId?: string;
};

export function getImpactedSpecId(edge: SemanticRelationEdge, currentSpecId: string): string | null {
  return getImpactPropagationSpecId(edge, currentSpecId);
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

  // Index relations by direct specId and by consumer fileKey to avoid O(E) scan
  const relationsBySpecId = new Map<string, SemanticRelationEdge[]>();
  const relationsByFileId = new Map<string, SemanticRelationEdge[]>();

  for (const edge of relations) {
    const meta = SEMANTIC_REL_META[edge.kind];
    if (!meta) continue;
    if (meta.category !== "consumer-to-producer" && meta.category !== "schema-to-use") continue;

    const listFrom = relationsBySpecId.get(edge.fromSpecId) ?? [];
    listFrom.push(edge);
    relationsBySpecId.set(edge.fromSpecId, listFrom);

    const listTo = relationsBySpecId.get(edge.toSpecId) ?? [];
    listTo.push(edge);
    relationsBySpecId.set(edge.toSpecId, listTo);

    const consumerSpec = specMap.get(edge.fromSpecId);
    if (consumerSpec && consumerSpec.fileId) {
      const fileKey = `${consumerSpec.repoId}:${consumerSpec.fileId}`;
      const listFile = relationsByFileId.get(fileKey) ?? [];
      listFile.push(edge);
      relationsByFileId.set(fileKey, listFile);
    }
  }

  for (let hop = 1; hop <= maxHops; hop++) {
    const next = new Set<string>();
    for (const currentSpecId of frontier) {
      const spec = specMap.get(currentSpecId);
      const activeRelations = new Set<SemanticRelationEdge>();

      const directRels = relationsBySpecId.get(currentSpecId);
      if (directRels) {
        for (const edge of directRels) activeRelations.add(edge);
      }

      if (spec && spec.fileId) {
        const fileKey = `${spec.repoId}:${spec.fileId}`;
        const fileRels = relationsByFileId.get(fileKey);
        if (fileRels) {
          for (const edge of fileRels) activeRelations.add(edge);
        }
      }

      for (const edge of activeRelations) {
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
            kind: step.kind,
            materialization: step.materialization,
            sourceEdgeKind: step.sourceEdgeKind,
            reason: step.reason,
            confidence: step.confidence,
            hop
          });
        }
      }
    }

    if (next.size === 0) break;
    for (const id of next) visited.set(id, hop);

    if (hop === maxHops) {
      truncated = hasMoreImpactTargets(next, specs, relationsBySpecId, relationsByFileId, visited);
      break;
    }
    frontier = next;
  }

  return { visited, incomingStep, pathEdges, truncated };
}

function hasMoreImpactTargets(
  frontier: Set<string>,
  specs: ReadableContractSpecNode[],
  relationsBySpecId: Map<string, SemanticRelationEdge[]>,
  relationsByFileId: Map<string, SemanticRelationEdge[]>,
  visited: Map<string, number>
): boolean {
  const specMap = new Map(specs.map((s) => [s.id, s]));
  for (const currentSpecId of frontier) {
    const spec = specMap.get(currentSpecId);
    const activeRelations = new Set<SemanticRelationEdge>();

    const directRels = relationsBySpecId.get(currentSpecId);
    if (directRels) {
      for (const edge of directRels) activeRelations.add(edge);
    }

    if (spec && spec.fileId) {
      const fileKey = `${spec.repoId}:${spec.fileId}`;
      const fileRels = relationsByFileId.get(fileKey);
      if (fileRels) {
        for (const edge of fileRels) activeRelations.add(edge);
      }
    }

    for (const edge of activeRelations) {
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
  if (direct) {
    return [{
      impactedSpecId: direct,
      edge,
      kind: edge.kind,
      materialization: "materialized",
      reason: edge.reason,
      confidence: edge.confidence
    }];
  }

  return implementationBridgeStepsFromEdge(edge, currentSpecId, specMap).map((step) => ({
    impactedSpecId: step.specId,
    edge,
    kind: step.kind,
    materialization: step.materialization,
    sourceEdgeKind: step.sourceEdgeKind,
    reason: step.reason,
    confidence: step.confidence,
    viaSpecId: currentSpecId
  }));
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
      relationKind: step?.kind,
      materialization: step?.materialization,
      sourceEdgeKind: step?.sourceEdgeKind,
      reason: step?.reason,
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



export async function analyzeSemanticImpactFromDB(
  target: string,
  db: GraphDB,
  options: SemanticImpactOptions = {}
): Promise<SemanticImpactReport | null> {
  const { specs, relations } = await loadActiveSemanticGraph(db);

  return analyzeSemanticImpact(
    target,
    specs,
    relations,
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
