import type {
  ReadableContractSpecNode,
  SemanticRelationEdge
} from "../../parsing/types.js";
import { isKnownContractSpecNode } from "../../parsing/types.js";
import type { GraphDB } from "../../graph-model/db.js";
import { loadActiveSemanticGraph } from "../../graph-model/queries.js";
import { withPublicGraphReadSnapshot, type PublicGraphReadSnapshot } from "../../graph-model/readSnapshot.js";
import { SEMANTIC_REL_META, selectImpactRootIds, semanticRelationResolution } from "../semanticRelations.js";
import { findTargetSpecs } from "./impactEngine.js";
import { normalizeSemanticTarget } from "../targetNormalization.js";
import { summarizeSpec } from "../semanticTrace.js";
import type { ConfidenceBand } from "../../../shared/confidence.js";

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
  relationKind?: SemanticRelationEdge["kind"];
  resolution?: ConfidenceBand;
  reason?: string;
  viaSpecId?: string;
};

export type SemanticImpactEdge = {
  fromSpecId: string;
  toSpecId: string;
  kind: SemanticRelationEdge["kind"];
  evidenceId: string;
  resolution: ConfidenceBand;
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
  reason: string;
  confidence: number;
  viaSpecId?: string;
  traversalMode: "normal" | "downstream";
};

export function getImpactedSpecId(edge: SemanticRelationEdge, currentSpecId: string): string | null {
  const meta = SEMANTIC_REL_META[edge.kind];
  if (!meta) return null;
  if (meta.category === "execution-flow") {
    return edge.fromSpecId === currentSpecId ? edge.toSpecId : null;
  }
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
  let frontier: Map<string, "normal" | "downstream"> = new Map([...startSpecIds].map((id) => [id, "normal"]));
  let truncated = false;

  for (const id of frontier.keys()) visited.set(id, 0);

  // Index relations by exact spec id. Execution flow must never be inferred
  // merely because two contracts occur in the same file.
  const relationsBySpecId = new Map<string, SemanticRelationEdge[]>();

  for (const edge of relations) {
    const meta = SEMANTIC_REL_META[edge.kind];
    if (!meta) continue;
    if (meta.category !== "consumer-to-producer" && meta.category !== "schema-to-use" && meta.category !== "execution-flow") continue;

    const listFrom = relationsBySpecId.get(edge.fromSpecId) ?? [];
    listFrom.push(edge);
    relationsBySpecId.set(edge.fromSpecId, listFrom);

    const listTo = relationsBySpecId.get(edge.toSpecId) ?? [];
    listTo.push(edge);
    relationsBySpecId.set(edge.toSpecId, listTo);

  }

  for (let hop = 1; hop <= maxHops; hop++) {
    const next = new Map<string, "normal" | "downstream">();
    for (const [currentSpecId, traversalMode] of frontier) {
      const activeRelations = new Set<SemanticRelationEdge>();

      const directRels = relationsBySpecId.get(currentSpecId);
      if (directRels) {
        for (const edge of directRels) activeRelations.add(edge);
      }

      for (const edge of activeRelations) {
        for (const step of impactStepsFromEdge(edge, currentSpecId, traversalMode)) {
          if (visited.has(step.impactedSpecId) || next.has(step.impactedSpecId)) continue;
          next.set(step.impactedSpecId, step.traversalMode);
          incomingStep.set(step.impactedSpecId, step);
          pathEdges.push({
            fromSpecId: edge.fromSpecId,
            toSpecId: edge.toSpecId,
            kind: edge.kind,
            evidenceId: edge.evidenceId,
            resolution: semanticRelationResolution(edge),
            reason: step.reason,
            confidence: step.confidence,
            hop
          });
        }
      }
    }

    if (next.size === 0) break;
    for (const id of next.keys()) visited.set(id, hop);

    if (hop === maxHops) {
      truncated = hasMoreImpactTargets(
        next,
        relationsBySpecId,
        visited
      );
      break;
    }
    frontier = next;
  }

  return { visited, incomingStep, pathEdges, truncated };
}

function hasMoreImpactTargets(
  frontier: Map<string, "normal" | "downstream">,
  relationsBySpecId: Map<string, SemanticRelationEdge[]>,
  visited: Map<string, number>
): boolean {
  for (const [currentSpecId, traversalMode] of frontier) {
    const activeRelations = new Set<SemanticRelationEdge>();

    const directRels = relationsBySpecId.get(currentSpecId);
    if (directRels) {
      for (const edge of directRels) activeRelations.add(edge);
    }

    for (const edge of activeRelations) {
      for (const step of impactStepsFromEdge(edge, currentSpecId, traversalMode)) {
        if (!visited.has(step.impactedSpecId)) return true;
      }
    }
  }
  return false;
}

function impactStepsFromEdge(
  edge: SemanticRelationEdge,
  currentSpecId: string,
  traversalMode: "normal" | "downstream"
): ImpactStep[] {
  const meta = SEMANTIC_REL_META[edge.kind];
  if (traversalMode === "downstream") {
    if (meta.category === "execution-flow" && edge.fromSpecId === currentSpecId) {
      return [{ impactedSpecId: edge.toSpecId, edge, reason: edge.reason, confidence: edge.confidence, traversalMode }];
    }
    if (meta.category === "consumer-to-producer" && meta.direction === "forward" && edge.fromSpecId === currentSpecId) {
      return [{ impactedSpecId: edge.toSpecId, edge, reason: edge.reason, confidence: edge.confidence, traversalMode }];
    }
    return [];
  }
  const direct = getImpactedSpecId(edge, currentSpecId);
  if (!direct) return [];
  return [{
    impactedSpecId: direct,
    edge,
    reason: edge.reason,
    confidence: edge.confidence,
    traversalMode: meta.category === "execution-flow" ? "downstream" : "normal"
  }];
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
      resolution: step ? semanticRelationResolution(step.edge) : undefined,
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
  workspaceId: string,
  options: SemanticImpactOptions = {},
  pinnedSnapshot?: PublicGraphReadSnapshot
): Promise<SemanticImpactReport | null> {
  if (!pinnedSnapshot) {
    return withPublicGraphReadSnapshot(db, workspaceId, (snapshot) =>
      analyzeSemanticImpactFromDB(target, db, workspaceId, options, snapshot));
  }
  const snapshot = pinnedSnapshot;
  const { specs, relations } = await loadActiveSemanticGraph(db, snapshot);

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
