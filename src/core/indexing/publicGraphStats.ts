import type { GraphFactsBatch } from "../graph-model/facts.js";
import type { GraphDB, Stats, StatsDelta } from "../graph-model/db.js";
import type { PublicGraphGenerationScope } from "../graph-model/publicGraphGeneration.js";
import type { IncrementalPublicGraphReplacementPlan } from "./graphWrite.js";
import { generatedDatabaseRecoveryInstruction } from "../../shared/branding.js";

const STAT_FIELDS = [
  "repos",
  "files",
  "codeNodes",
  "sectionNodes",
  "callEdges",
  "importEdges",
  "entities"
] as const satisfies readonly (keyof Stats)[];

type IdRow = { id: string };
type CallIdentityRow = { fromId: string; toId: string; raw: string };
type ImportIdentityRow = { fromId: string; toId: string; module: string };

export type IncrementalPublicGraphStatsPreparation = {
  delta: StatsDelta;
  next: Stats;
};

function uniqueCount<T>(items: readonly T[], keyFor: (item: T) => string): number {
  return new Set(items.map(keyFor)).size;
}

function requireSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer.`);
  return value;
}

function nextStats(current: Readonly<Stats>, delta: Readonly<StatsDelta>): Stats {
  return Object.fromEntries(STAT_FIELDS.map((field) => {
    const value = requireSafeInteger(current[field] + delta[field], `Next public graph stats ${field}`);
    if (value < 0) throw new Error(`Incremental public graph stats would make ${field} negative; run a clean full reindex.`);
    return [field, value];
  })) as Stats;
}

/**
 * Computes the complete public graph count delta from exact replacement
 * owners. Every query is bounded by touched source or stable candidate IDs;
 * this function never scans or clones the active generation.
 */
export async function prepareIncrementalPublicGraphStatsDelta(input: {
  db: GraphDB;
  scope: PublicGraphGenerationScope;
  facts: GraphFactsBatch;
  replacement: IncrementalPublicGraphReplacementPlan;
  expectedRevision: string;
}): Promise<IncrementalPublicGraphStatsPreparation> {
  const { db, scope, facts, replacement, expectedRevision } = input;
  if (facts.workspaceId !== scope.workspaceId || facts.generation !== scope.generation) {
    throw new Error("Incremental public graph stats facts target a different physical generation.");
  }
  const current = await db.readPublicGraphStats(scope);
  if (!current) {
    throw new Error(
      "Public graph stats metadata is missing for incremental indexing; " +
      `${generatedDatabaseRecoveryInstruction()}.`
    );
  }
  if (current.revision !== expectedRevision) {
    throw new Error(
      `Public graph stats revision ${current.revision} does not match incremental parent ${expectedRevision}; ` +
      `${generatedDatabaseRecoveryInstruction()}.`
    );
  }

  const sourceFileIds = [...new Set(replacement.sourceFileIds)].sort();
  if (sourceFileIds.length === 0) {
    const delta = Object.fromEntries(STAT_FIELDS.map((field) => [field, 0])) as StatsDelta;
    return { delta, next: { ...current } };
  }
  const staleCodeIds = [...new Set(replacement.staleCodeIds)].sort();
  const deletedFileIds = [...new Set(replacement.deletedFileIds)].sort();
  const entityCandidateIds = [...new Set([
    ...facts.entities.map((entity) => entity.id),
    ...replacement.orphanEntityIds
  ])].sort();
  const repoCandidateIds = [...new Set(facts.repos.map((repo) => repo.id))].sort();
  const scopeParams = {
    workspaceId: scope.workspaceId,
    generation: scope.generation
  };
  const sourceParams = { ...scopeParams, sourceFileIds };

  // Keep these bounded reads sequential. Kuzu connections are transaction-safe,
  // but concurrent prepared statements against one embedded database can race
  // parameter binding while an incremental run is preparing its mutation set.
  const oldFiles = await db.query<IdRow>(
    "MATCH (n:File) WHERE n.workspaceId = $workspaceId AND n.generation = $generation " +
    "AND n.id IN $sourceFileIds AND (n.active IS NULL OR n.active = true) RETURN n.id AS id;",
    sourceParams
  );
  const oldCode = await db.query<IdRow>(
    "MATCH (n:Code) WHERE n.workspaceId = $workspaceId AND n.generation = $generation " +
    "AND n.fileId IN $sourceFileIds AND (n.active IS NULL OR n.active = true) RETURN n.id AS id;",
    sourceParams
  );
  const oldSections = await db.query<IdRow>(
    "MATCH (n:Section) WHERE n.workspaceId = $workspaceId AND n.generation = $generation " +
    "AND n.fileId IN $sourceFileIds AND (n.active IS NULL OR n.active = true) RETURN n.id AS id;",
    sourceParams
  );
  const removedCalls = await db.query<CallIdentityRow>(
    "MATCH (source:Code)-[r:CALLS]->(target:Code) " +
    "WHERE source.workspaceId = $workspaceId AND source.generation = $generation " +
    "AND target.workspaceId = $workspaceId AND target.generation = $generation " +
    "AND r.workspaceId = $workspaceId AND r.generation = $generation " +
    "AND (r.active IS NULL OR r.active = true) " +
    (staleCodeIds.length > 0
      ? "AND (source.fileId IN $sourceFileIds OR target.id IN $staleCodeIds) "
      : "AND source.fileId IN $sourceFileIds ") +
    "RETURN source.id AS fromId, target.id AS toId, r.raw AS raw;",
    staleCodeIds.length > 0 ? { ...sourceParams, staleCodeIds } : sourceParams
  );
  const removedImports = await db.query<ImportIdentityRow>(
    "MATCH (source:File)-[r:IMPORTS]->(target:File) " +
    "WHERE source.workspaceId = $workspaceId AND source.generation = $generation " +
    "AND target.workspaceId = $workspaceId AND target.generation = $generation " +
    "AND r.workspaceId = $workspaceId AND r.generation = $generation " +
    "AND (r.active IS NULL OR r.active = true) " +
    (deletedFileIds.length > 0
      ? "AND (source.id IN $sourceFileIds OR target.id IN $deletedFileIds) "
      : "AND source.id IN $sourceFileIds ") +
    "RETURN source.id AS fromId, target.id AS toId, r.module AS module;",
    deletedFileIds.length > 0 ? { ...sourceParams, deletedFileIds } : sourceParams
  );
  const existingEntities = entityCandidateIds.length === 0
    ? []
    : await db.query<IdRow>(
      "MATCH (n:Entity) WHERE n.workspaceId = $workspaceId AND n.generation = $generation " +
      "AND n.id IN $entityCandidateIds RETURN n.id AS id;",
      { ...scopeParams, entityCandidateIds }
    );
  const existingRepos = repoCandidateIds.length === 0
    ? []
    : await db.query<IdRow>(
      "MATCH (n:Repo) WHERE n.workspaceId = $workspaceId AND n.generation = $generation " +
      "AND n.id IN $repoCandidateIds RETURN n.id AS id;",
      { ...scopeParams, repoCandidateIds }
    );

  const existingEntityIds = new Set(existingEntities.map((row) => row.id));
  const existingRepoIds = new Set(existingRepos.map((row) => row.id));
  const nextEntityIds = new Set(facts.entities.map((entity) => entity.id));
  const removedEntityCount = uniqueCount(
    replacement.orphanEntityIds.filter((id) => existingEntityIds.has(id) && !nextEntityIds.has(id)),
    (id) => id
  );
  const addedEntityCount = uniqueCount(
    facts.entities.filter((entity) => !existingEntityIds.has(entity.id)),
    (entity) => entity.id
  );
  const delta: StatsDelta = {
    repos: uniqueCount(facts.repos.filter((repo) => !existingRepoIds.has(repo.id)), (repo) => repo.id),
    files: uniqueCount(facts.files.filter((file) => file.active !== false), (file) => file.id) - oldFiles.length,
    codeNodes: uniqueCount(facts.code.filter((code) => code.active !== false), (code) => code.id) - oldCode.length,
    sectionNodes: uniqueCount(facts.sections.filter((section) => section.active !== false), (section) => section.id) - oldSections.length,
    callEdges: uniqueCount(
      facts.calls.filter((edge) => edge.active !== false),
      (edge) => `${edge.fromCodeId}\u0000${edge.toCodeId}\u0000${edge.raw}`
    ) - removedCalls.length,
    importEdges: uniqueCount(
      facts.imports.filter((edge) => edge.active !== false),
      (edge) => `${edge.fromFileId}\u0000${edge.toFileId}\u0000${edge.module}`
    ) - removedImports.length,
    entities: addedEntityCount - removedEntityCount
  };
  for (const field of STAT_FIELDS) requireSafeInteger(delta[field], `Public graph stats delta ${field}`);
  return { delta, next: nextStats(current, delta) };
}
