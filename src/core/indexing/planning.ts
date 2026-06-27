import type { LogicLensConfig } from "../../config/schema.js";
import type { GraphDB } from "../graph-model/db.js";
import { runIndexPhase } from "./phases.js";
import type { IndexWriteMode } from "./context.js";
import type { IndexOptions } from "./types.js";

export type IndexRunPath = "batched-full" | "full-copy-bulk" | "per-repo";

// Captures the pre-indexing decisions that should stay independent from
// scanning, parsing, and graph writes.
export type IndexPlanningResult = {
  writeMode: IndexWriteMode;
  repoConfigs: LogicLensConfig["repos"];
  initialRepoCount: number;
  batchSize: number;
  shouldUseCopyBulk: boolean;
  runPath: IndexRunPath;
};

async function repoCount(db: GraphDB): Promise<number> {
  return db.repoCount();
}

export async function planIndexRun(input: {
  db: GraphDB;
  config: LogicLensConfig;
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

    const initialRepoCount = await repoCount(db);
    let batchSize = options.batchSize ?? config.indexing.batchSize ?? 0;
    if (!Number.isInteger(batchSize) || batchSize < 0) {
      throw new Error(`Invalid batch size "${batchSize}". Expected a non-negative integer.`);
    }
    if (repoConfigs.length > 10 && batchSize === 0) {
      batchSize = 10;
    }

    // Empty full imports can use the fastest COPY path. Incremental and
    // existing-graph runs must keep stale/active semantics intact.
    const shouldUseCopyBulk = writeMode === "bulk" || (writeMode === "auto" && !options.changedOnly && initialRepoCount === 0);
    // runPath is intentionally descriptive for future phase orchestration;
    // existing writer selection still uses the legacy booleans below.
    const runPath: IndexRunPath = batchSize > 0 && !options.changedOnly
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
      runPath
    };
  });

  return planning.result;
}
