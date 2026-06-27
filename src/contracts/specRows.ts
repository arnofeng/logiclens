import type {
  ContractSpecNode,
  RepoDependencyEdge,
  SemanticRelationEdge
} from "../parsers/types.js";

// ---------------------------------------------------------------------------
// Shared graph-row shapes and mappers for ContractSpec / SEMANTIC_REL /
// DEPENDS_ON. Used by both the dependency rebuild (graph/rebuildRelations.ts)
// and the precision/recall evaluation (contracts/evaluation/precisionRecall.ts)
// so the column projections and row→node conversions stay in one place.
// ---------------------------------------------------------------------------

export type SemanticRelRow = {
  fromSpecId: string;
  toSpecId: string;
  kind: string;
  evidenceId: string;
  reason: string;
  confidence: number;
};

export type SpecRow = {
  id: string;
  contractId: string;
  specKind: string;
  repoId: string;
  fileId: string;
  evidenceId: string;
  sourceSymbolId: string | null;
  canonicalKey: string;
  httpMethod: string | null;
  pathTemplate: string | null;
  eventTopic: string | null;
  framework: string | null;
  version: string | null;
  specJson: string;
  confidence: number;
  batchId: string | null;
  indexedAt: string | null;
  active: boolean;
};

export type DepEdgeRow = {
  fromRepoId: string;
  toRepoId: string;
  dependencyType: string;
  sourceContractId: string;
  targetContractId: string;
  evidenceId: string;
  raw: string;
  confidence: number;
  batchId: string | null;
  active: boolean;
};

/**
 * RETURN projection for a `(s:ContractSpec)` node, aligned with {@link SpecRow}.
 */
export const SPEC_RETURN = `s.id AS id, s.contractId AS contractId, s.specKind AS specKind,
       s.repoId AS repoId, s.fileId AS fileId, s.evidenceId AS evidenceId,
       s.sourceSymbolId AS sourceSymbolId, s.canonicalKey AS canonicalKey,
       s.httpMethod AS httpMethod, s.pathTemplate AS pathTemplate,
       s.eventTopic AS eventTopic, s.framework AS framework,
       s.version AS version, s.specJson AS specJson,
       s.confidence AS confidence, s.batchId AS batchId,
       s.indexedAt AS indexedAt, s.active AS active`;

/**
 * RETURN projection for a `(a)-[r:SEMANTIC_REL]->(b)` edge, aligned with
 * {@link SemanticRelRow}.
 */
export const SEMANTIC_REL_RETURN = `a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind,
       r.evidenceId AS evidenceId, r.reason AS reason, r.confidence AS confidence`;

/**
 * RETURN projection for a `(from)-[d:DEPENDS_ON]->(to)` edge, aligned with
 * {@link DepEdgeRow}.
 */
export const DEP_EDGE_RETURN = `from.id AS fromRepoId, to.id AS toRepoId, d.dependencyType AS dependencyType,
       d.sourceContractId AS sourceContractId, d.targetContractId AS targetContractId,
       d.evidenceId AS evidenceId, d.raw AS raw, d.confidence AS confidence,
       d.batchId AS batchId, d.active AS active`;

export function rowToContractSpec(row: SpecRow): ContractSpecNode {
  return {
    id: row.id,
    contractId: row.contractId,
    specKind: row.specKind as ContractSpecNode["specKind"],
    repoId: row.repoId,
    fileId: row.fileId,
    evidenceId: row.evidenceId,
    sourceSymbolId: row.sourceSymbolId ?? undefined,
    canonicalKey: row.canonicalKey,
    httpMethod: row.httpMethod ?? undefined,
    pathTemplate: row.pathTemplate ?? undefined,
    eventTopic: row.eventTopic ?? undefined,
    framework: row.framework ?? undefined,
    version: row.version ?? undefined,
    specJson: row.specJson,
    confidence: row.confidence,
    batchId: row.batchId ?? undefined,
    indexedAt: row.indexedAt ?? undefined,
    active: row.active
  };
}

export function rowToSemanticRel(row: SemanticRelRow): SemanticRelationEdge {
  return {
    fromSpecId: row.fromSpecId,
    toSpecId: row.toSpecId,
    kind: row.kind as SemanticRelationEdge["kind"],
    evidenceId: row.evidenceId,
    reason: row.reason,
    confidence: row.confidence
  };
}

export function rowToDepEdge(row: DepEdgeRow): RepoDependencyEdge {
  return {
    fromRepoId: row.fromRepoId,
    toRepoId: row.toRepoId,
    dependencyType: row.dependencyType as RepoDependencyEdge["dependencyType"],
    sourceContractId: row.sourceContractId,
    targetContractId: row.targetContractId,
    evidenceId: row.evidenceId,
    raw: row.raw,
    confidence: row.confidence,
    batchId: row.batchId ?? undefined,
    active: row.active
  };
}
