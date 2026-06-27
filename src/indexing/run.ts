import type { GraphDB } from "../graph/db.js";
import type { LogicLensConfig } from "../config/schema.js";
import { runIndexQueue } from "./scheduler.js";
import { planIndexRun } from "./planning.js";
import { createIndexRunContext } from "./context.js";
import { runBatchedFullIndex, runDependencyRebuild, runFullCopyBulkIndex, runPerRepoIndex, type IndexCounters } from "./orchestrator.js";
import type { IndexLogger, IndexOptions, IndexResult } from "./types.js";

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function addCounters(target: IndexCounters, increment: IndexCounters): void {
  target.filesScanned += increment.filesScanned;
  target.filesChanged += increment.filesChanged;
}

export async function runIndexing(
  db: GraphDB,
  config: LogicLensConfig,
  options: IndexOptions & { cwd?: string; logger?: IndexLogger }
): Promise<IndexResult> {
  const started = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? {};
  const planning = await planIndexRun({ db, config, options });
  const ctx = createIndexRunContext({ cwd, config, options, logger, writeMode: planning.writeMode });
  const totals: IndexCounters = { filesScanned: 0, filesChanged: 0 };

  // The command layer now only chooses the indexing route and aggregates the
  // public IndexResult. Scanning, parsing, graph writes, semantic writes, stale
  // marking, and state commits live behind phase orchestration helpers.
  if (planning.runPath === "batched-full") {
    if (planning.writeMode !== "auto" && planning.writeMode !== "bulk") {
      throw new Error("Batched full indexing supports write modes auto or bulk. Omit --batch-size to use merge or bulk-upsert.");
    }
    const repoBatches = chunks(planning.repoConfigs, planning.batchSize);
    const result = await runBatchedFullIndex({ db, ctx, repoBatches, options: { ...options, batchSize: planning.batchSize }, initialRepoCount: planning.initialRepoCount });
    addCounters(totals, result);
    const rebuildStarted = Date.now();
    await runDependencyRebuild({ db, ctx });
    const dependencyRebuildMs = Date.now() - rebuildStarted;
    logger.log?.(`Batched indexing complete: batches=${repoBatches.length} filesScanned=${totals.filesScanned} filesChanged=${totals.filesChanged} dependencyRebuild=${(dependencyRebuildMs / 1000).toFixed(2)}s total=${((Date.now() - started) / 1000).toFixed(2)}s`);
  } else if (planning.runPath === "full-copy-bulk") {
    if (options.changedOnly) throw new Error("Bulk write mode currently supports full empty-graph imports only; use merge mode for --changed-only.");
    if (planning.writeMode === "bulk" && planning.initialRepoCount > 0) throw new Error("Bulk write mode supports empty graph imports only; use --write-mode auto, bulk-upsert, or merge for existing graphs.");
    addCounters(totals, await runFullCopyBulkIndex({ db, ctx, planning, options }));
  } else {
    const indexedRepoIds: string[] = [];
    const jobs = await runIndexQueue(planning.repoConfigs, { concurrency: config.indexing.concurrency, retries: 1 }, async (repoConfig) => {
      const result = await runPerRepoIndex({ db, ctx, repoConfig, options });
      addCounters(totals, result);
      indexedRepoIds.push(...result.repos.map((repo) => repo.id));
    }, (repoConfig) => `repo:${repoConfig.name}`);
    const failedJobs = jobs.filter((job) => job.status === "failed");
    if (failedJobs.length > 0) {
      const details = failedJobs.map((job) => `${job.id}: ${job.error ?? "unknown error"}`).join("; ");
      throw new Error(`Indexing failed for ${details}`);
    }
    await runDependencyRebuild({ db, ctx, repoIds: options.repo ? indexedRepoIds : undefined });
  }

  const stats = await db.stats();
  return {
    filesScanned: totals.filesScanned,
    filesChanged: totals.filesChanged,
    codeNodes: stats.codeNodes,
    sectionNodes: stats.sectionNodes,
    callEdges: stats.callEdges,
    importEdges: stats.importEdges,
    entities: stats.entities,
    durationMs: Date.now() - started
  };
}

/**
 * Decides which target repos must be refused because a full (non-incremental)
 * index would rebuild already-indexed data. A full re-index of an existing repo
 * is the slow per-repo append-copy path and can leave orphaned shared nodes
 * behind, so callers should prefer --changed-only or a clean graph rebuild.
 *
 * Returns the names of targeted repos that are already indexed. An empty array
 * means the run is allowed (new repos, or --changed-only runs).
 */
export function findBlockedReindexTargets(input: {
  changedOnly?: boolean;
  repo?: string;
  configuredRepoNames: string[];
  indexedRepoNames: string[];
}): string[] {
  if (input.changedOnly) return [];
  const indexed = new Set(input.indexedRepoNames);
  const targets = input.repo ? [input.repo] : input.configuredRepoNames;
  return targets.filter((name) => indexed.has(name));
}
