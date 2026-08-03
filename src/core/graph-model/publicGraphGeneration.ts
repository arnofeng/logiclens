import type { GraphValue } from "./db.js";

export type PublicGraphGenerationScope = {
  workspaceId: string;
  generation: string;
};

export type PublicGraphWriteScope = PublicGraphGenerationScope & {
  systemName: string;
};

export function publicGraphStatsId(scope: PublicGraphGenerationScope): string {
  return `public-graph-stats:${scope.workspaceId}:${scope.generation}`;
}

export const PUBLIC_GRAPH_NODE_LABELS = [
  "System",
  "Repo",
  "File",
  "Code",
  "Section",
  "Entity",
  "Operation",
  "Workflow",
  "Contract",
  "Evidence",
  "ContractSpec"
] as const;

export type PublicGraphNodeLabel = (typeof PUBLIC_GRAPH_NODE_LABELS)[number];

export type PublicGraphNodeDescriptor = {
  label: PublicGraphNodeLabel;
  properties: readonly string[];
};

export const PUBLIC_GRAPH_NODE_DESCRIPTORS = [
  { label: "System", properties: ["id", "name", "summary"] },
  { label: "Repo", properties: ["id", "name", "path", "remoteUrl", "branch", "commitSha", "language", "indexedAt", "summary"] },
  { label: "File", properties: ["id", "repoId", "path", "directory", "language", "hash", "loc", "batchId", "indexedAt", "active"] },
  { label: "Code", properties: ["id", "repoId", "fileId", "kind", "name", "qualifiedName", "startLine", "endLine", "signature", "summary", "hash", "batchId", "indexedAt", "active"] },
  { label: "Section", properties: ["id", "repoId", "fileId", "heading", "level", "startLine", "endLine", "text", "summary", "hash", "batchId", "indexedAt", "active"] },
  { label: "Entity", properties: ["id", "name", "kind", "description"] },
  { label: "Operation", properties: ["id", "verb", "entityName", "description"] },
  { label: "Workflow", properties: ["id", "name", "description"] },
  { label: "Contract", properties: ["id", "kind", "key", "name", "description"] },
  { label: "Evidence", properties: ["id", "repoId", "fileId", "filePath", "line", "raw", "rule", "confidence", "batchId", "indexedAt", "active"] },
  { label: "ContractSpec", properties: ["id", "contractId", "specKind", "repoId", "fileId", "evidenceId", "sourceSymbolId", "canonicalKey", "httpMethod", "pathTemplate", "eventTopic", "framework", "version", "specJson", "confidence", "batchId", "indexedAt", "active"] }
] as const satisfies readonly PublicGraphNodeDescriptor[];

export type PublicGraphRelationshipDescriptor = {
  relationshipType: string;
  fromLabel: PublicGraphNodeLabel;
  toLabel: PublicGraphNodeLabel;
  properties: readonly string[];
};

function relationship(
  relationshipType: string,
  fromLabel: PublicGraphNodeLabel,
  toLabel: PublicGraphNodeLabel,
  properties: readonly string[]
): PublicGraphRelationshipDescriptor {
  return { relationshipType, fromLabel, toLabel, properties };
}

export const PUBLIC_GRAPH_RELATIONSHIP_DESCRIPTORS = [
  relationship("CONTAINS", "System", "Repo", []),
  relationship("CONTAINS", "Repo", "File", []),
  relationship("CONTAINS", "File", "Code", []),
  relationship("CONTAINS", "File", "Section", []),
  relationship("IMPORTS", "File", "File", ["module", "raw", "batchId", "active"]),
  relationship("CALLS", "Code", "Code", ["confidence", "resolution", "raw", "batchId", "active"]),
  relationship("MENTIONS", "Code", "Entity", ["confidence"]),
  relationship("MENTIONS", "Section", "Entity", ["confidence"]),
  relationship("DESCRIBES", "Section", "Repo", []),
  relationship("DOCUMENTS", "Section", "Code", ["confidence"]),
  relationship("REFERENCES", "Section", "File", ["raw"]),
  relationship("OPERATES_ON", "Code", "Entity", ["verb", "confidence"]),
  relationship("OWNS_PACKAGE", "Repo", "Contract", ["evidenceId", "confidence", "batchId", "active"]),
  relationship("PRODUCES", "Repo", "Contract", ["evidenceId", "confidence", "batchId", "active"]),
  relationship("CONSUMES", "Repo", "Contract", ["evidenceId", "confidence", "batchId", "active"]),
  relationship("SHARES_CONTRACT", "Repo", "Contract", ["evidenceId", "confidence", "batchId", "active"]),
  relationship("CONTRACT_MENTIONS", "Contract", "Entity", ["evidenceId", "confidence", "batchId", "active"]),
  relationship("PARTICIPATES_IN", "Repo", "Operation", ["role", "evidenceId", "confidence", "batchId", "active"]),
  relationship("WORKFLOW_STEP", "Workflow", "Operation", ["step", "evidenceId", "confidence", "batchId", "active"]),
  relationship("HAS_EVIDENCE", "Contract", "Evidence", []),
  relationship("HAS_EVIDENCE", "Repo", "Evidence", []),
  relationship("USES_PACKAGE", "Repo", "Contract", ["packageName", "evidenceId", "raw", "confidence", "batchId", "active"]),
  relationship("DEPENDS_ON", "Repo", "Repo", ["dependencyType", "sourceContractId", "targetContractId", "evidenceId", "raw", "confidence", "batchId", "active"]),
  relationship("HAS_SPEC", "Contract", "ContractSpec", ["evidenceId", "confidence", "batchId", "active"]),
  relationship("SEMANTIC_REL", "ContractSpec", "ContractSpec", ["kind", "evidenceId", "reason", "confidence", "batchId", "active"])
] as const satisfies readonly PublicGraphRelationshipDescriptor[];

const STORAGE_ID_SEPARATOR = "\u001f";

function assertStorageIdPart(value: string, label: string): void {
  if (!value || value.includes(STORAGE_ID_SEPARATOR)) {
    throw new TypeError(`${label} must be non-empty and cannot contain the public graph storage separator.`);
  }
}

export function publicNodeStorageId(generation: string, logicalId: string): string {
  assertStorageIdPart(generation, "generation");
  assertStorageIdPart(logicalId, "logicalId");
  return `${generation}${STORAGE_ID_SEPARATOR}${logicalId}`;
}

export function publicNodeStorageParams(
  scope: PublicGraphGenerationScope,
  logicalId: string
): Record<string, GraphValue> {
  return {
    storageId: publicNodeStorageId(scope.generation, logicalId),
    id: logicalId,
    workspaceId: scope.workspaceId,
    generation: scope.generation
  };
}

export function publicRelationshipScopeParams(
  scope: PublicGraphGenerationScope
): Record<string, GraphValue> {
  return {
    workspaceId: scope.workspaceId,
    generation: scope.generation
  };
}

export type PublicGraphGenerationExecutor = {
  query<T = Record<string, GraphValue>>(
    cypher: string,
    params?: Record<string, GraphValue>
  ): Promise<T[]>;
};

export async function deletePublicGraphGeneration(
  executor: PublicGraphGenerationExecutor,
  scope: PublicGraphGenerationScope
): Promise<void> {
  const params = publicRelationshipScopeParams(scope);
  await executor.query(
    "MATCH (s:PublicGraphStats {id: $statsId}) WHERE s.workspaceId = $workspaceId AND s.generation = $generation DELETE s;",
    { ...params, statsId: publicGraphStatsId(scope) }
  );
  const relationshipTypes = [...new Set(
    PUBLIC_GRAPH_RELATIONSHIP_DESCRIPTORS.map((descriptor) => descriptor.relationshipType)
  )];
  for (const relationshipType of relationshipTypes) {
    await executor.query(
      `MATCH ()-[r:${relationshipType}]->() ` +
      "WHERE r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
      params
    );
  }
  for (const descriptor of [...PUBLIC_GRAPH_NODE_DESCRIPTORS].reverse()) {
    await executor.query(
      `MATCH (n:${descriptor.label}) ` +
      "WHERE n.workspaceId = $workspaceId AND n.generation = $generation DELETE n;",
      params
    );
  }
}
