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
    provenance: SnapshotPartition;
    diagnostics: SnapshotPartition;
    activeGeneration: SnapshotPartition;
  };
};

const INTERNAL_PARTITIONS = [
  "declarations",
  "resolutionContexts",
  "resolutionScopeDependencies",
  "roots",
  "dependencies",
  "reverseDependencies",
  "fingerprints",
  "provenance",
  "diagnostics",
  "activeGeneration"
] as const;

function stableValue(value: GraphValue): GraphValue {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const nullableEmptyColumns = new Set(["eventTopic", "framework", "httpMethod", "pathTemplate", "sourceSymbolId", "version"]);
    const volatileColumns = new Set(["batchId", "indexedAt", "lastBatchId", "lastIndexedAt", "provider"]);
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !volatileColumns.has(key))
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [
      key,
      key === "generation" || key === "activeGeneration"
        ? "<generation>"
        : key === "id" && typeof item === "string" && item.startsWith("generation-fact:")
          ? "<generation-fact>"
          : key === "id" && typeof item === "string" && item.startsWith("schema-contribution:")
            ? "<schema-contribution>"
        : key === "payload" && typeof item === "string"
          ? stablePayload(item)
          : nullableEmptyColumns.has(key) && (item === null || item === "") ? "" : stableValue(item)
    ]));
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function stablePayload(payload: string): string {
  try {
    return JSON.stringify(stableValue(JSON.parse(payload) as GraphValue));
  } catch {
    return payload;
  }
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
  const generationState = await db.query<SnapshotRow>(
    "MATCH (n:SchemaGenerationState {id: $stateId}) RETURN n.activeGeneration AS activeGeneration, n.schemaIndexVersion AS schemaIndexVersion;",
    { stateId: `schema-generation-state:${workspaceId}` }
  );
  const activeGeneration = generationState[0]?.activeGeneration;
  if (typeof activeGeneration !== "string" || activeGeneration.length === 0) {
    throw new Error(`No active schema generation exists for workspace ${workspaceId}.`);
  }
  const snapshotParams = { workspaceId, generation: activeGeneration };
  const [contracts, contractSpecs, hasSpec, semanticRelations, evidenceRows] = await Promise.all([
    rows(db, "MATCH (n:Contract) WHERE n.workspaceId = $workspaceId AND n.generation = $generation RETURN n.id AS id, n.kind AS kind, n.key AS key, n.name AS name, n.description AS description;", snapshotParams),
    rows(db, "MATCH (n:ContractSpec) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND (n.active IS NULL OR n.active = true) RETURN n.id AS id, n.contractId AS contractId, n.specKind AS specKind, n.repoId AS repoId, n.fileId AS fileId, n.evidenceId AS evidenceId, n.sourceSymbolId AS sourceSymbolId, n.canonicalKey AS canonicalKey, n.httpMethod AS httpMethod, n.pathTemplate AS pathTemplate, n.eventTopic AS eventTopic, n.framework AS framework, n.version AS version, n.specJson AS specJson, n.confidence AS confidence, n.active AS active;", snapshotParams),
    rows(db, "MATCH (a:Contract)-[r:HAS_SPEC]->(b:ContractSpec) WHERE a.workspaceId = $workspaceId AND a.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND b.workspaceId = $workspaceId AND b.generation = $generation AND (r.active IS NULL OR r.active = true) AND (b.active IS NULL OR b.active = true) RETURN a.id AS contractId, b.id AS specId, r.evidenceId AS evidenceId, r.confidence AS confidence, r.active AS active;", snapshotParams),
    rows(db, "MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec) WHERE a.workspaceId = $workspaceId AND a.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND b.workspaceId = $workspaceId AND b.generation = $generation AND (a.active IS NULL OR a.active = true) AND (r.active IS NULL OR r.active = true) AND (b.active IS NULL OR b.active = true) RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind, r.evidenceId AS evidenceId, r.reason AS reason, r.confidence AS confidence, r.active AS active;", snapshotParams),
    rows(db, "MATCH (n:Evidence) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND (n.active IS NULL OR n.active = true) RETURN n.id AS id, n.repoId AS repoId, n.fileId AS fileId, n.filePath AS filePath, n.line AS line, n.raw AS raw, n.rule AS rule, n.confidence AS confidence, n.active AS active;", snapshotParams)
  ]);
  const evidenceIds = new Set([
    ...contractSpecs.map((item) => item.evidenceId),
    ...hasSpec.map((item) => item.evidenceId),
    ...semanticRelations.map((item) => item.evidenceId)
  ].filter((value): value is string => typeof value === "string"));
  const internalQueries: Record<(typeof INTERNAL_PARTITIONS)[number], string> = {
    declarations: "MATCH (n:TypeDeclarationFact) WHERE n.generation = $generation RETURN n.id AS id, n.generation AS generation, n.repoId AS repoId, n.fileId AS fileId, n.payload AS payload;",
    resolutionContexts: "MATCH (n:ResolutionContextFact) WHERE n.generation = $generation RETURN n.id AS id, n.generation AS generation, n.repoId AS repoId, n.fileId AS fileId, n.payload AS payload;",
    resolutionScopeDependencies: "MATCH (n:ResolutionScopeDependencyFact) WHERE n.generation = $generation RETURN n.id AS id, n.generation AS generation, n.repoId AS repoId, n.fileId AS fileId, n.payload AS payload;",
    roots: "MATCH (n:SchemaRootFact) WHERE n.generation = $generation RETURN n.id AS id, n.generation AS generation, n.repoId AS repoId, n.fileId AS fileId, n.payload AS payload;",
    dependencies: "MATCH (n:SchemaDependencyFact) WHERE n.generation = $generation RETURN n.id AS id, n.generation AS generation, n.repoId AS repoId, n.fileId AS fileId, n.payload AS payload;",
    reverseDependencies: "MATCH (n:SchemaContribution) WHERE n.generation = $generation RETURN n.id AS id, n.generation AS generation, n.rootReferenceId AS rootReferenceId, n.entityKind AS entityKind, n.entityId AS entityId, n.payload AS payload;",
    fingerprints: "MATCH (n:SchemaBehaviorFingerprintFact) WHERE n.generation = $generation RETURN n.id AS id, n.generation AS generation, n.repoId AS repoId, n.fileId AS fileId, n.payload AS payload;",
    provenance: "MATCH (n:SchemaProvenanceFact) WHERE n.generation = $generation RETURN n.id AS id, n.generation AS generation, n.repoId AS repoId, n.fileId AS fileId, n.payload AS payload;",
    diagnostics: "MATCH (n:SchemaDiagnosticFact) WHERE n.generation = $generation RETURN n.id AS id, n.generation AS generation, n.repoId AS repoId, n.fileId AS fileId, n.payload AS payload;",
    activeGeneration: "MATCH (n:SchemaGenerationState {id: $stateId}) RETURN n.activeGeneration AS activeGeneration, n.schemaIndexVersion AS schemaIndexVersion;"
  };
  const internalEntries = await Promise.all(INTERNAL_PARTITIONS.map(async (key) => [key, {
    status: "available" as const,
    items: key === "activeGeneration"
      ? normalizeRows(generationState)
      : await rows(db, internalQueries[key], { generation: activeGeneration })
  }] as const));
  const internalIndex = Object.fromEntries(internalEntries) as SchemaBaselineSnapshot["internalIndex"];
  return {
    publicGraph: {
      contracts,
      contractSpecs,
      hasSpec,
      semanticRelations,
      provenance: evidenceRows.filter((item) => typeof item.id === "string" && evidenceIds.has(item.id)),
      diagnostics: []
    },
    internalIndex
  };
}

export function assertNormalizedSchemaSnapshot(snapshot: SchemaBaselineSnapshot): void {
  for (const rowsToCheck of [
    snapshot.publicGraph.contracts,
    snapshot.publicGraph.contractSpecs,
    snapshot.publicGraph.hasSpec,
    snapshot.publicGraph.semanticRelations,
    snapshot.publicGraph.provenance,
    snapshot.publicGraph.diagnostics
  ]) {
    assert.deepEqual(rowsToCheck, normalizeRows(rowsToCheck));
    const serialized = JSON.stringify(rowsToCheck);
    assert.doesNotMatch(serialized, /indexedAt|lastIndexedAt|batchId|lastBatchId/u);
  }
  for (const partition of Object.values(snapshot.internalIndex)) {
    assert.equal(partition.status, "available");
    assert.deepEqual(partition.items, normalizeRows(partition.items));
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
