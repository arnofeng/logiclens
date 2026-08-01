import assert from "node:assert/strict";
import type { GraphDB, GraphValue } from "../../src/core/graph-model/db.js";

type SnapshotRow = Record<string, GraphValue>;

export type SnapshotPartition = {
  status: "available" | "unsupported";
  items: SnapshotRow[];
};

export type SchemaBaselineSnapshot = {
  publicGraph: {
    contracts: SnapshotRow[];
    contractSpecs: SnapshotRow[];
    hasSpec: SnapshotRow[];
    semanticRelations: SnapshotRow[];
    provenance: SnapshotRow[];
    diagnostics: SnapshotRow[];
  };
  internalIndex: {
    declarations: SnapshotPartition;
    resolutionContexts: SnapshotPartition;
    resolutionScopeDependencies: SnapshotPartition;
    roots: SnapshotPartition;
    dependencies: SnapshotPartition;
    reverseDependencies: SnapshotPartition;
    fingerprints: SnapshotPartition;
    activeGeneration: SnapshotPartition;
  };
  lexical: SnapshotRow[];
};

const INTERNAL_PARTITIONS = [
  "declarations",
  "resolutionContexts",
  "resolutionScopeDependencies",
  "roots",
  "dependencies",
  "reverseDependencies",
  "fingerprints",
  "activeGeneration"
] as const;

function stableValue(value: GraphValue): GraphValue {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function stableJson(value: GraphValue): string {
  return JSON.stringify(stableValue(value));
}

function normalizeRows(rows: SnapshotRow[]): SnapshotRow[] {
  return rows.map((row) => stableValue(row) as SnapshotRow).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
}

async function rows(db: GraphDB, cypher: string, params: Record<string, GraphValue> = {}): Promise<SnapshotRow[]> {
  return normalizeRows(await db.query<SnapshotRow>(cypher, params));
}

/**
 * Provider-neutral semantic snapshot. Volatile batch/time/path/provider fields
 * are excluded at query time; every retained row and token array is sorted.
 */
export async function captureSchemaBaselineSnapshot(db: GraphDB, workspaceId: string): Promise<SchemaBaselineSnapshot> {
  const [contracts, contractSpecs, hasSpec, semanticRelations, evidenceRows, lexical] = await Promise.all([
    rows(db, "MATCH (n:Contract) RETURN n.id AS id, n.kind AS kind, n.key AS key, n.name AS name, n.description AS description;"),
    rows(db, "MATCH (n:ContractSpec) WHERE n.active = true RETURN n.id AS id, n.contractId AS contractId, n.specKind AS specKind, n.repoId AS repoId, n.fileId AS fileId, n.evidenceId AS evidenceId, n.sourceSymbolId AS sourceSymbolId, n.canonicalKey AS canonicalKey, n.httpMethod AS httpMethod, n.pathTemplate AS pathTemplate, n.eventTopic AS eventTopic, n.framework AS framework, n.version AS version, n.specJson AS specJson, n.confidence AS confidence, n.active AS active;"),
    rows(db, "MATCH (a:Contract)-[r:HAS_SPEC]->(b:ContractSpec) WHERE r.active = true RETURN a.id AS contractId, b.id AS specId, r.evidenceId AS evidenceId, r.confidence AS confidence, r.active AS active;"),
    rows(db, "MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec) WHERE r.active = true RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind, r.evidenceId AS evidenceId, r.reason AS reason, r.confidence AS confidence, r.active AS active;"),
    rows(db, "MATCH (n:Evidence) WHERE n.active = true RETURN n.id AS id, n.repoId AS repoId, n.fileId AS fileId, n.filePath AS filePath, n.line AS line, n.raw AS raw, n.rule AS rule, n.confidence AS confidence, n.active AS active;"),
    rows(db, "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.active = true RETURN n.id AS id, n.canonicalId AS canonicalId, n.repoId AS repoId, n.kind AS kind, n.title AS title, n.qualifiedName AS qualifiedName, n.path AS path, n.searchableText AS searchableText, n.tokens AS tokens, n.active AS active, n.sourceHash AS sourceHash, n.renderRef AS renderRef;", { workspaceId })
  ]);
  const evidenceIds = new Set([
    ...contractSpecs.map((item) => item.evidenceId),
    ...hasSpec.map((item) => item.evidenceId),
    ...semanticRelations.map((item) => item.evidenceId)
  ].filter((value): value is string => typeof value === "string"));
  const unsupported = (): SnapshotPartition => ({ status: "unsupported", items: [] });
  const internalIndex = Object.fromEntries(INTERNAL_PARTITIONS.map((key) => [key, unsupported()])) as SchemaBaselineSnapshot["internalIndex"];
  return {
    publicGraph: {
      contracts,
      contractSpecs,
      hasSpec,
      semanticRelations,
      provenance: evidenceRows.filter((item) => typeof item.id === "string" && evidenceIds.has(item.id)),
      diagnostics: []
    },
    internalIndex,
    lexical
  };
}

export function assertNormalizedSchemaSnapshot(snapshot: SchemaBaselineSnapshot): void {
  for (const rowsToCheck of [
    snapshot.publicGraph.contracts,
    snapshot.publicGraph.contractSpecs,
    snapshot.publicGraph.hasSpec,
    snapshot.publicGraph.semanticRelations,
    snapshot.publicGraph.provenance,
    snapshot.publicGraph.diagnostics,
    snapshot.lexical
  ]) {
    assert.deepEqual(rowsToCheck, normalizeRows(rowsToCheck));
    const serialized = JSON.stringify(rowsToCheck);
    assert.doesNotMatch(serialized, /indexedAt|lastIndexedAt|batchId|lastBatchId/u);
  }
  for (const partition of Object.values(snapshot.internalIndex)) {
    assert.equal(partition.status, "unsupported");
    assert.deepEqual(partition.items, []);
  }
}

/** Shared assertion entry point used unchanged by Kuzu and Neo4j fixtures. */
export async function runSchemaSnapshotConformance(db: GraphDB, workspaceId: string): Promise<SchemaBaselineSnapshot> {
  const first = await captureSchemaBaselineSnapshot(db, workspaceId);
  assertNormalizedSchemaSnapshot(first);
  const repeated = await captureSchemaBaselineSnapshot(db, workspaceId);
  assert.deepEqual(repeated, first);
  return first;
}
