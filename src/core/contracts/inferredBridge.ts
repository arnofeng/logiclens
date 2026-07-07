import type {
  ReadableContractSpecNode,
  SemanticRelationEdge,
  SemanticRelationKind
} from "../parsing/types.js";
import { SEMANTIC_REL_META } from "./semanticRelations.js";

export type TraceRelationKind = SemanticRelationKind | "INTERNAL_CALL";

export type InferredBridgeStep = {
  specId: string;
  sourceEdge: SemanticRelationEdge;
  kind: TraceRelationKind;
  materialization: "inferred";
  sourceEdgeKind: SemanticRelationKind;
  reason: string;
  confidence: number;
};

export type InferredInternalCallEdge = {
  fromSpecId: string;
  toSpecId: string;
  kind: "INTERNAL_CALL";
  materialization: "inferred";
  sourceEdgeKind: SemanticRelationKind;
  sourceFromSpecId: string;
  sourceToSpecId: string;
  reason: string;
  confidence: number;
};

export function getImpactPropagationSpecId(
  edge: SemanticRelationEdge,
  currentSpecId: string
): string | null {
  const meta = SEMANTIC_REL_META[edge.kind];
  if (!meta) return null;
  if (meta.category !== "consumer-to-producer" && meta.category !== "schema-to-use") return null;

  if (meta.direction === "forward") {
    return edge.toSpecId === currentSpecId ? edge.fromSpecId : null;
  }
  return edge.fromSpecId === currentSpecId ? edge.toSpecId : null;
}

export function getImplementationUpstreamBridgeSteps(
  edge: SemanticRelationEdge,
  currentSpecId: string,
  specMap: Map<string, ReadableContractSpecNode>
): InferredBridgeStep[] {
  const meta = SEMANTIC_REL_META[edge.kind];
  if (!meta || meta.category !== "consumer-to-producer" || meta.direction !== "forward") return [];
  if (edge.fromSpecId !== currentSpecId) return [];

  const localConsumer = specMap.get(currentSpecId);
  if (!localConsumer) return [];

  const results: InferredBridgeStep[] = [];
  for (const candidate of specMap.values()) {
    if (candidate.id === localConsumer.id) continue;
    if (candidate.repoId !== localConsumer.repoId || candidate.fileId !== localConsumer.fileId) continue;
    if (!isLocalProducerBridgeTarget(candidate)) continue;
    if (!sameActionName(localConsumer, candidate)) continue;
    results.push({
      specId: candidate.id,
      sourceEdge: edge,
      kind: "INTERNAL_CALL",
      materialization: "inferred",
      sourceEdgeKind: edge.kind,
      reason: `same file and same action name; linked through ${edge.kind}`,
      confidence: Math.min(edge.confidence, 0.75)
    });
  }
  return results;
}

export function getImplementationDownstreamBridgeSteps(
  edge: SemanticRelationEdge,
  currentSpecId: string,
  specMap: Map<string, ReadableContractSpecNode>
): InferredBridgeStep[] {
  const meta = SEMANTIC_REL_META[edge.kind];
  if (!meta || meta.category !== "consumer-to-producer" || meta.direction !== "forward") return [];

  const current = specMap.get(currentSpecId);
  const localConsumer = specMap.get(edge.fromSpecId);
  if (!current || !localConsumer) return [];
  if (current.id === localConsumer.id) return [];
  if (!isLocalProducerBridgeTarget(current)) return [];
  if (current.repoId !== localConsumer.repoId || current.fileId !== localConsumer.fileId) return [];
  if (!sameActionName(current, localConsumer)) return [];

  return [{
    specId: edge.toSpecId,
    sourceEdge: edge,
    kind: "INTERNAL_CALL",
    materialization: "inferred",
    sourceEdgeKind: edge.kind,
    reason: `same file and same action name; linked through ${edge.kind}`,
    confidence: Math.min(edge.confidence, 0.75)
  }];
}

export function implementationBridgeStepsFromEdge(
  edge: SemanticRelationEdge,
  currentSpecId: string,
  specMap: Map<string, ReadableContractSpecNode>
): InferredBridgeStep[] {
  return [
    ...getImplementationUpstreamBridgeSteps(edge, currentSpecId, specMap),
    ...getImplementationDownstreamBridgeSteps(edge, currentSpecId, specMap)
  ];
}

export function inferInternalCallEdges(
  specs: ReadableContractSpecNode[],
  relations: SemanticRelationEdge[]
): InferredInternalCallEdge[] {
  const specMap = new Map(specs.map((s) => [s.id, s]));
  const results: InferredInternalCallEdge[] = [];
  const seen = new Set<string>();

  const specsByFile = new Map<string, ReadableContractSpecNode[]>();
  for (const spec of specs) {
    if (spec.fileId) {
      const fileKey = `${spec.repoId}:${spec.fileId}`;
      const list = specsByFile.get(fileKey) ?? [];
      list.push(spec);
      specsByFile.set(fileKey, list);
    }
  }

  for (const edge of relations) {
    const meta = SEMANTIC_REL_META[edge.kind];
    if (!meta || meta.category !== "consumer-to-producer" || meta.direction !== "forward") continue;

    const localConsumer = specMap.get(edge.fromSpecId);
    if (!localConsumer || !localConsumer.fileId) continue;

    const fileKey = `${localConsumer.repoId}:${localConsumer.fileId}`;
    const candidates = specsByFile.get(fileKey) ?? [];
    for (const candidate of candidates) {
      if (candidate.id === localConsumer.id) continue;
      if (!isLocalProducerBridgeTarget(candidate)) continue;
      if (!sameActionName(localConsumer, candidate)) continue;

      const key = `${candidate.id}->${localConsumer.id}:INTERNAL_CALL`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        fromSpecId: candidate.id,
        toSpecId: localConsumer.id,
        kind: "INTERNAL_CALL",
        materialization: "inferred",
        sourceEdgeKind: edge.kind,
        sourceFromSpecId: edge.fromSpecId,
        sourceToSpecId: edge.toSpecId,
        reason: `same file and same action name; linked through ${edge.kind}`,
        confidence: Math.min(edge.confidence, 0.75)
      });
    }
  }

  return results;
}

export function isLocalProducerBridgeTarget(spec: ReadableContractSpecNode): boolean {
  return spec.specKind === "http-endpoint" || spec.specKind === "event" || spec.specKind === "graphql-operation";
}

export function sameActionName(a: ReadableContractSpecNode, b: ReadableContractSpecNode): boolean {
  const actionA = actionNameOf(a);
  const actionB = actionNameOf(b);
  return !!actionA && !!actionB && actionA === actionB;
}

export function actionNameOf(spec: ReadableContractSpecNode): string | null {
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
  if (spec.specKind === "event") {
    let eventName: string | undefined;
    try {
      const parsed = JSON.parse(spec.specJson);
      eventName = parsed.eventName;
    } catch {}
    if (eventName) {
      return eventName.toLowerCase();
    }
    const topic = spec.eventTopic || spec.canonicalKey.split(":").slice(1).join(":");
    const segment = topic.split("?")[0]?.split(/[./:]/).filter(Boolean).pop();
    return segment ? segment.toLowerCase() : null;
  }
  return null;
}

function lastPathSegment(path: string): string | null {
  const segment = path.split("?")[0]?.split("/").filter(Boolean).pop();
  return segment ? segment.toLowerCase() : null;
}
