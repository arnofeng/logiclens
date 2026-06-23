import { KuzuGraphDB } from "../graph/db.js";
import type { LogicLensConfig } from "../config/schema.js";
import { runIndexQueue } from "../indexing/scheduler.js";
import { planIndexRun } from "../indexing/planning.js";
import { createIndexRunContext } from "../indexing/context.js";
import { runBatchedFullIndex, runDependencyRebuild, runFullCopyBulkIndex, runPerRepoIndex, type IndexCounters } from "../indexing/orchestrator.js";
import { ProgressBar } from "../utils/progress.js";
import { createLogicLens } from "../sdk/client.js";

export type IndexOptions = {
  repo?: string;
  repos?: string[];
  changedOnly?: boolean;
  maxFiles?: number;
  batchSize?: number;
  writeMode?: "auto" | "merge" | "bulk" | "bulk-upsert";
};

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function addCounters(target: IndexCounters, increment: IndexCounters): void {
  target.filesScanned += increment.filesScanned;
  target.filesChanged += increment.filesChanged;
}

export type IndexLogger = {
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (...args: any[]) => void;
  writeStderr?: (msg: string) => void;
  createProgressBar?: (label: string, total: number) => any;
};

export type IndexResult = {
  filesScanned: number;
  filesChanged: number;
  codeNodes: number;
  sectionNodes: number;
  callEdges: number;
  importEdges: number;
  entities: number;
  durationMs: number;
};

export async function runIndexing(
  db: KuzuGraphDB,
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

export async function indexCommand(options: IndexOptions, cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({
    cwd,
    logger: {
      log: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
      error: (msg) => console.error(msg),
      writeStderr: (msg) => process.stderr.write(msg),
      createProgressBar: (label, total) => new ProgressBar(label, total)
    }
  });
  try {
    const result = await client.index(options);
    console.log(`Indexed ${client.getConfig().repos.length} repos`);
    console.log(`Files scanned: ${result.filesScanned}`);
    console.log(`Files changed: ${result.filesChanged}`);
    console.log(`Code nodes: ${result.codeNodes}`);
    console.log(`Section nodes: ${result.sectionNodes}`);
    console.log(`Call edges: ${result.callEdges}`);
    console.log(`Import edges: ${result.importEdges}`);
    console.log(`Entities: ${result.entities}`);
    const totalDuration = (result.durationMs / 1000).toFixed(1);
    process.stderr.write(`Total duration: ${totalDuration}s\n`);
  } finally {
    await client.close();
  }
}
