import type { AppConfig } from "../../config/schema.js";
import type { GraphDB } from "../graph-model/db.js";
import { runIndexPhase } from "./phases.js";
import type { IndexWriteMode } from "./context.js";
import type { IndexOptions } from "./types.js";
import { deriveWorkspaceId } from "../workspace/identity.js";
import type { GraphValue } from "../graph-model/db.js";
import { SCHEMA_INDEX_VERSION } from "../schema/model.js";
import { LEXICAL_PROJECTION_SCHEMA_VERSION } from "../retrieval/types.js";

export type IndexRunPath = "batched-full" | "full-copy-bulk" | "per-repo";

// Captures the pre-indexing decisions that should stay independent from
// scanning, parsing, and graph writes.
export type IndexPlanningResult = {
  writeMode: IndexWriteMode;
  repoConfigs: AppConfig["repos"];
  initialRepoCount: number;
  batchSize: number;
  shouldUseCopyBulk: boolean;
  runPath: IndexRunPath;
  activeGeneration?: string;
  activeRevision?: string;
  publicationMode: "full-snapshot" | "incremental";
};

type GenerationState = {
  activeGeneration?: string;
  activeRevision?: string;
  schemaIndexVersion?: string;
  lexicalProjectionVersion?: string;
};

async function generationState(db: GraphDB, workspaceId: string): Promise<GenerationState | undefined> {
  const rows = await db.query<{
    activeGeneration?: GraphValue;
    activeRevision?: GraphValue;
    schemaIndexVersion?: GraphValue;
    lexicalProjectionVersion?: GraphValue;
  }>(
    "MATCH (s:SchemaGenerationState {id: $id}) RETURN s.activeGeneration AS activeGeneration, " +
    "s.activeRevision AS activeRevision, s.schemaIndexVersion AS schemaIndexVersion, " +
    "s.lexicalProjectionVersion AS lexicalProjectionVersion;",
    { id: `schema-generation-state:${workspaceId}` }
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    activeGeneration: typeof row.activeGeneration === "string" && row.activeGeneration
      ? row.activeGeneration
      : undefined,
    activeRevision: typeof row.activeRevision === "string" && row.activeRevision
      ? row.activeRevision
      : undefined,
    schemaIndexVersion: typeof row.schemaIndexVersion === "string"
      ? row.schemaIndexVersion
      : undefined,
    lexicalProjectionVersion: typeof row.lexicalProjectionVersion === "string"
      ? row.lexicalProjectionVersion
      : undefined
  };
}

export async function planIndexRun(input: {
  db: GraphDB;
  config: AppConfig;
  options: IndexOptions;
}): Promise<IndexPlanningResult> {
  const { db, config, options } = input;
  const planning = await runIndexPhase({ phase: "repo-planning", writerMode: options.writeMode }, async () => {
    const writeMode = options.writeMode ?? "auto";
    if (!["auto", "merge", "bulk", "bulk-upsert"].includes(writeMode)) {
      throw new Error(`Unsupported write mode "${writeMode}". Expected auto, merge, bulk, or bulk-upsert.`);
    }
    if (options.repo && options.repos && options.repos.length > 0) {
      throw new Error("Use either --repo or an internal repos list, not both.");
    }

    const requestedRepoNames = options.repos && options.repos.length > 0 ? new Set(options.repos) : undefined;
    const repoConfigs = config.repos.filter((repo) => {
      if (options.repo) return repo.name === options.repo;
      if (requestedRepoNames) return requestedRepoNames.has(repo.name);
      return true;
    });

    const workspaceId = deriveWorkspaceId(config.systemName);
    const state = await generationState(db, workspaceId);
    if (!state) {
      const legacyRows = await db.query<{ count?: GraphValue }>(
        "MATCH (r:Repo) RETURN count(r) AS count;"
      );
      const legacyCount = legacyRows[0]?.count;
      if ((typeof legacyCount === "number" || typeof legacyCount === "bigint") && Number(legacyCount) > 0) {
        throw new Error(
          "Existing public graph data has no generation state and cannot be upgraded in place; " +
          "clean generated graph/internal/lexical artifacts and run a full reindex."
        );
      }
    }
    if (state && state.schemaIndexVersion !== SCHEMA_INDEX_VERSION) {
      const mode = options.changedOnly ? "changed-only/watch indexing" : "indexing";
      throw new Error(
        `Schema index version ${state.schemaIndexVersion ?? "missing"} is incompatible with ${mode}; ` +
        `clean generated graph/internal/lexical artifacts and run a full reindex (required version ${SCHEMA_INDEX_VERSION}).`
      );
    }
    if (state && state.lexicalProjectionVersion !== LEXICAL_PROJECTION_SCHEMA_VERSION) {
      const mode = options.changedOnly ? "changed-only/watch indexing" : "indexing";
      throw new Error(
        `Lexical projection version ${state.lexicalProjectionVersion ?? "missing"} is incompatible with ${mode}; ` +
        `clean generated graph/internal/lexical artifacts and run a full reindex (required version ${LEXICAL_PROJECTION_SCHEMA_VERSION}).`
      );
    }
    if (state && Boolean(state.activeGeneration) !== Boolean(state.activeRevision)) {
      throw new Error(
        "Schema generation/revision state is incomplete; clean generated graph/internal/lexical artifacts and run a full reindex."
      );
    }
    const pinnedGeneration = state?.activeGeneration;
    const pinnedRevision = state?.activeRevision;
    const initialRepoCount = pinnedGeneration
      ? await db.repoCount({ workspaceId, generation: pinnedGeneration })
      : 0;
    let batchSize = options.batchSize ?? config.indexing.batchSize ?? 0;
    if (!Number.isInteger(batchSize) || batchSize < 0) {
      throw new Error(`Invalid batch size "${batchSize}". Expected a non-negative integer.`);
    }
    if (repoConfigs.length > 10 && batchSize === 0) {
      batchSize = 10;
    }

    const partialSelection = Boolean(options.repo || requestedRepoNames);
    const publicationMode: IndexPlanningResult["publicationMode"] = pinnedGeneration && (options.changedOnly || partialSelection)
      ? "incremental"
      : "full-snapshot";
    // A full snapshot always targets a new empty physical generation, even
    // when it replaces an existing workspace. Incremental publication never
    // uses COPY because its mutation set is applied to the active dataset.
    const shouldUseCopyBulk = publicationMode === "full-snapshot"
      && (writeMode === "bulk" || writeMode === "auto");
    // runPath is intentionally descriptive for future phase orchestration;
    // existing writer selection still uses the legacy booleans below.
    const runPath: IndexRunPath = batchSize > 0 && publicationMode === "full-snapshot"
      ? "batched-full"
      : shouldUseCopyBulk
        ? "full-copy-bulk"
        : "per-repo";

    return {
      writeMode: writeMode as IndexWriteMode,
      repoConfigs,
      initialRepoCount,
      batchSize,
      shouldUseCopyBulk,
      runPath,
      activeGeneration: pinnedGeneration,
      activeRevision: pinnedRevision,
      publicationMode
    };
  });

  return planning.result;
}
