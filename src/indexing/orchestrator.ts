import { createBatchId } from "../graph/batchWriter.js";
import type { GraphDB } from "../graph/db.js";
import type { LogicLensConfig } from "../config/schema.js";
import type { ParsedGraphFile, RepoNode } from "../parsers/types.js";
import { toRepoNode } from "../repos/repoRegistry.js";
import type { IndexOptions } from "../commands/index.js";
import type { IndexRunContext } from "./context.js";
import type { IndexPlanningResult } from "./planning.js";
import { scanAndParseRepo, type ScanParseRepoResult } from "./scanParse.js";
import { getGraphWriteFailureDetails, runFactBuildPhase, runGraphWritePhase, selectGraphWriter, type GraphWriteResult } from "./graphWrite.js";
import { runLlmSummaryPhase, type SummaryFailureState } from "./summaries.js";
import { runIndexStateCommitPhase } from "./stateCommit.js";
import { runRelationRebuildPhase, runSemanticWritePhase, runStaleMarkPhase } from "./semanticWrite.js";
import type { ProgressReporter } from "../utils/progress.js";

type ProgressBarLike = {
  tick(label?: string): void;
  update(current: number, label?: string, total?: number, stepMs?: number): void;
  complete(label?: string): void;
  reporter(): ProgressReporter;
};

export type IndexCounters = {
  filesScanned: number;
  filesChanged: number;
};

export type IndexPathResult = IndexCounters & {
  repos: RepoNode[];
};

type BatchCounts = Map<string, { scanned: number; changed: number }>;
type SummaryFailuresByRepo = Map<string, SummaryFailureState>;

function createProgressBar(ctx: IndexRunContext): (label: string, total: number) => ProgressBarLike {
  return ctx.logger.createProgressBar ?? (() => ({
    tick: () => {},
    update: () => {},
    complete: () => {},
    reporter: () => () => {}
  }));
}

function log(ctx: IndexRunContext): (message: string) => void {
  return ctx.logger.log ?? (() => {});
}

function warn(ctx: IndexRunContext): (message: string) => void {
  return ctx.logger.warn ?? (() => {});
}

function errorLogger(ctx: IndexRunContext): (...args: any[]) => void {
  return ctx.logger.error ?? (() => {});
}

export function logStage(ctx: IndexRunContext, label: string, timeStarted: number): void {
  log(ctx)(`${label}: ${((Date.now() - timeStarted) / 1000).toFixed(2)}s`);
}

export function sumCounts(results: ScanParseRepoResult[]): IndexCounters {
  return results.reduce((counts, result) => {
    counts.filesScanned += result.filesScanned;
    counts.filesChanged += result.filesChanged;
    return counts;
  }, { filesScanned: 0, filesChanged: 0 });
}

function countsByRepo(results: ScanParseRepoResult[]): BatchCounts {
  return new Map(results.map((result) => [
    result.repo.id,
    { scanned: result.filesScanned, changed: result.filesChanged }
  ]));
}

async function scanParseRepos(input: {
  db?: GraphDB;
  ctx: IndexRunContext;
  repoConfigs: LogicLensConfig["repos"];
  options: IndexOptions;
  changedOnly?: boolean;
}): Promise<ScanParseRepoResult[]> {
  const { db, ctx, repoConfigs, options, changedOnly } = input;
  const results: ScanParseRepoResult[] = [];
  for (const repoConfig of repoConfigs) {
    const repo = toRepoNode(repoConfig, ctx.cwd);
    results.push(await scanAndParseRepo({
      db,
      repo,
      config: ctx.config,
      changedOnly,
      maxFiles: options.maxFiles,
      createProgressBar: createProgressBar(ctx)
    }));
  }
  return results;
}

async function runGraphPipeline(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  batchId: string;
  indexedAt: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  label: string;
  stageLabel?: string;
  repoName?: string;
  selection: ReturnType<typeof selectGraphWriter>;
}): Promise<GraphWriteResult> {
  const { db, ctx, batchId, indexedAt, repos, parsedFiles, label, stageLabel, repoName, selection } = input;
  const logPrefix = stageLabel ?? (repoName ? undefined : "");
  // Keep fact construction and graph writes as one reusable phase bundle so
  // full, batched, and per-repo paths share the same writer semantics.
  const factsStarted = Date.now();
  const factBuild = await runFactBuildPhase({ batchId, indexedAt, repos, parsedFiles, config: ctx.config, repoName });
  logStage(ctx, repoName ? `Facts build ${repoName}` : logPrefix ? `${logPrefix} facts build` : "Facts build", factsStarted);

  const writeStarted = Date.now();
  const graphWrite = await runGraphWritePhase({
    db,
    cwd: ctx.cwd,
    selection,
    facts: factBuild.facts,
    repos,
    parsedFiles,
    config: ctx.config,
    llmSummaryLevel: ctx.llm.summaryLevel,
    openAiApiKey: ctx.llm.apiKey,
    openAiBaseUrl: ctx.llm.baseUrl,
    label,
    repoName,
    createProgressBar: createProgressBar(ctx),
    log: log(ctx),
    warn: warn(ctx)
  });
  logStage(ctx, repoName ? `Graph write ${repoName}` : logPrefix ? `${logPrefix} graph write` : "Graph write", writeStarted);
  return graphWrite;
}

async function runSemanticPipeline(input: {
  ctx: IndexRunContext;
  batchId: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  label: string;
  repoName?: string;
}): Promise<string | undefined> {
  const { ctx, batchId, repos, parsedFiles, label, repoName } = input;
  if (!ctx.embedding.enabled) return undefined;
  const semanticWrite = await runSemanticWritePhase({
    cwd: ctx.cwd,
    repos,
    parsedFiles,
    config: ctx.config,
    enabled: true,
    label,
    repoName,
    batchId,
    createProgressBar: createProgressBar(ctx),
    warn: warn(ctx)
  });
  return semanticWrite.warning;
}

async function runSummaryPipeline(input: {
  ctx: IndexRunContext;
  batchId: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  label: string;
}): Promise<SummaryFailuresByRepo> {
  const { ctx, batchId, repos, parsedFiles, label } = input;
  const summaryPhase = await runLlmSummaryPhase({
    parsedFiles,
    repos,
    config: ctx.config,
    openAiApiKey: ctx.llm.apiKey,
    openAiBaseUrl: ctx.llm.baseUrl,
    llmSummaryLevel: ctx.llm.summaryLevel,
    label,
    batchId,
    createProgressBar: createProgressBar(ctx),
    errorLogger: errorLogger(ctx)
  });
  return summaryPhase.failuresByRepo;
}

async function commitSucceededRepos(input: {
  db: GraphDB;
  repos: RepoNode[];
  counts: BatchCounts;
  batchId: string;
  indexedAt: string;
  summaryFailures: SummaryFailuresByRepo;
  semanticWarning?: string;
  graphWrite?: GraphWriteResult;
}): Promise<void> {
  const { db, repos, counts, batchId, indexedAt, summaryFailures, semanticWarning, graphWrite } = input;
  for (const repo of repos) {
    const repoCounts = counts.get(repo.id) ?? { scanned: 0, changed: 0 };
    await runIndexStateCommitPhase({
      db,
      repo,
      batchId,
      indexedAt,
      filesScanned: repoCounts.scanned,
      filesChanged: repoCounts.changed,
      filesStale: 0,
      status: "succeeded",
      summaryFailures: summaryFailures.get(repo.id),
      semanticWarning,
      graphWriteAtomicity: graphWrite?.atomicityMode,
      graphWriteStatus: graphWrite?.journalStatus
    });
  }
}

async function commitFailedRepos(input: {
  db: GraphDB;
  repos: RepoNode[];
  counts: BatchCounts;
  batchId: string;
  indexedAt: string;
  error: unknown;
  graphWrite?: GraphWriteResult;
}): Promise<void> {
  const { db, repos, counts, batchId, indexedAt, error, graphWrite } = input;
  const graphWriteFailure = getGraphWriteFailureDetails(error);
  for (const repo of repos) {
    const repoCounts = counts.get(repo.id) ?? { scanned: 0, changed: 0 };
    await runIndexStateCommitPhase({
      db,
      repo,
      batchId,
      indexedAt,
      filesScanned: repoCounts.scanned,
      filesChanged: 0,
      filesStale: 0,
      status: "failed",
      graphWriteAtomicity: graphWrite?.atomicityMode ?? graphWriteFailure?.graphWriteAtomicity,
      graphWriteStatus: graphWrite?.journalStatus ?? graphWriteFailure?.graphWriteStatus,
      error
    });
  }
}

export async function runBatchedFullIndex(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  repoBatches: LogicLensConfig["repos"][];
  options: IndexOptions;
  initialRepoCount: number;
}): Promise<IndexPathResult> {
  const { db, ctx, repoBatches, options, initialRepoCount } = input;
  const indexedRepos: RepoNode[] = [];
  let filesScanned = 0;
  let filesChanged = 0;
  let graphIsEmpty = initialRepoCount === 0;

  // Batched full indexing is the only path that switches from bulk-copy to
  // append-copy across batches; keep that state here instead of in runIndexing.
  log(ctx)(`Batched indexing: batches=${repoBatches.length} batchSize=${options.batchSize ?? ctx.config.indexing.batchSize}`);
  for (const [batchIndex, batchRepoConfigs] of repoBatches.entries()) {
    const batchStarted = Date.now();
    const batchNumber = batchIndex + 1;
    const batchLabel = `Batch ${batchNumber}/${repoBatches.length}`;
    const batchId = createBatchId(`batch:${batchNumber}`);
    const indexedAt = new Date().toISOString();
    let batchRepos: RepoNode[] = [];
    let perRepoCounts: BatchCounts = new Map();
    log(ctx)(`${batchLabel}: repos=${batchRepoConfigs.length}`);

    try {
      const scanStarted = Date.now();
      const scanParseResults = await scanParseRepos({ ctx, repoConfigs: batchRepoConfigs, options });
      batchRepos = scanParseResults.map((result) => result.repo);
      perRepoCounts = countsByRepo(scanParseResults);
      const batchCounts = sumCounts(scanParseResults);
      filesScanned += batchCounts.filesScanned;
      filesChanged += batchCounts.filesChanged;
      indexedRepos.push(...batchRepos);
      const parsedFiles = scanParseResults.flatMap((result) => result.parsedFiles);

      const summaryFailures = await runSummaryPipeline({ ctx, batchId, repos: batchRepos, parsedFiles, label: `batch ${batchNumber}` });
      logStage(ctx, `${batchLabel} scan/parse/summarize`, scanStarted);
      const graphWrite = await runGraphPipeline({
        db,
        ctx,
        batchId,
        indexedAt,
        repos: batchRepos,
        parsedFiles,
        label: `batch ${batchNumber}/${repoBatches.length}`,
        stageLabel: batchLabel,
        selection: selectGraphWriter({ writeMode: ctx.writeMode, batchedFull: true, graphIsEmpty: graphIsEmpty && batchIndex === 0, provider: ctx.config.graph.provider })
      });
      graphIsEmpty = false;
      const semanticWarning = await runSemanticPipeline({ ctx, batchId, repos: batchRepos, parsedFiles, label: `batch ${batchNumber}/${repoBatches.length}` });
      await commitSucceededRepos({ db, repos: batchRepos, counts: perRepoCounts, batchId, indexedAt, summaryFailures, semanticWarning, graphWrite });

      log(ctx)(`${batchLabel} complete: repos=${batchRepos.length} filesScanned=${batchCounts.filesScanned} filesChanged=${batchCounts.filesChanged} duration=${((Date.now() - batchStarted) / 1000).toFixed(2)}s`);
    } catch (error) {
      await commitFailedRepos({ db, repos: batchRepos, counts: perRepoCounts, batchId, indexedAt, error });
      throw error;
    }
  }

  return { filesScanned, filesChanged, repos: indexedRepos };
}

export async function runFullCopyBulkIndex(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  planning: IndexPlanningResult;
  options: IndexOptions;
}): Promise<IndexPathResult> {
  const { db, ctx, planning, options } = input;
  const batchId = createBatchId("bulk");
  const indexedAt = new Date().toISOString();
  let repos: RepoNode[] = [];
  let perRepoCounts: BatchCounts = new Map();
  try {
    const scanStarted = Date.now();
    const scanParseResults = await scanParseRepos({ ctx, repoConfigs: planning.repoConfigs, options });
    repos = scanParseResults.map((result) => result.repo);
    const parsedFiles = scanParseResults.flatMap((result) => result.parsedFiles);
    const counts = sumCounts(scanParseResults);
    perRepoCounts = countsByRepo(scanParseResults);

    const summaryFailures = await runSummaryPipeline({ ctx, batchId, repos, parsedFiles, label: "all repos" });
    logStage(ctx, "Scan/parse/summarize", scanStarted);
    const graphWrite = await runGraphPipeline({
      db,
      ctx,
      batchId,
      indexedAt,
      repos,
      parsedFiles,
      label: "bulk-copy",
      selection: selectGraphWriter({ writeMode: ctx.writeMode, fullCopyBulk: true, provider: ctx.config.graph.provider })
    });
    const semanticWarning = await runSemanticPipeline({ ctx, batchId, repos, parsedFiles, label: "all repos" });
    await commitSucceededRepos({ db, repos, counts: perRepoCounts, batchId, indexedAt, summaryFailures, semanticWarning, graphWrite });
    return { ...counts, repos };
  } catch (error) {
    await commitFailedRepos({ db, repos, counts: perRepoCounts, batchId, indexedAt, error });
    throw error;
  }
}

export async function runPerRepoIndex(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  repoConfig: LogicLensConfig["repos"][number];
  options: IndexOptions;
}): Promise<IndexPathResult> {
  const { db, ctx, repoConfig, options } = input;
  const repo = toRepoNode(repoConfig, ctx.cwd);
  const batchId = createBatchId(`repo:${repo.name}`);
  const indexedAt = new Date().toISOString();

  try {
    await db.upsertRepo(repo);
    const scanStarted = Date.now();
    const scanParse = await scanAndParseRepo({
      db,
      repo,
      config: ctx.config,
      changedOnly: options.changedOnly,
      maxFiles: options.maxFiles,
      createProgressBar: createProgressBar(ctx)
    });
    const parsedFiles = scanParse.parsedFiles;
    const summaryFailuresByRepo = await runSummaryPipeline({ ctx, batchId, repos: [repo], parsedFiles, label: repo.name });
    const summaryFailures = summaryFailuresByRepo.get(repo.id);
    logStage(ctx, `Scan/parse/summarize ${repo.name}`, scanStarted);

    let semanticWarning: string | undefined;
    let graphWrite: GraphWriteResult | undefined;
    if (parsedFiles.length > 0) {
      graphWrite = await runGraphPipeline({
        db,
        ctx,
        batchId,
        indexedAt,
        repos: [repo],
        parsedFiles,
        label: repo.name,
        repoName: repo.name,
        selection: selectGraphWriter({ writeMode: ctx.writeMode, changedOnly: options.changedOnly, provider: ctx.config.graph.provider })
      });
      semanticWarning = await runSemanticPipeline({ ctx, batchId, repos: [repo], parsedFiles, label: repo.name, repoName: repo.name });
    }

    const staleStarted = Date.now();
    const filesStale = await runStaleMarkPhase({ db, repo, activeFileIds: scanParse.activeFileIds, batchId, indexedAt });
    logStage(ctx, `Stale mark ${repo.name}`, staleStarted);
    await runIndexStateCommitPhase({
      db,
      repo,
      batchId,
      indexedAt,
      filesScanned: scanParse.filesScanned,
      filesChanged: parsedFiles.length,
      filesStale,
      status: "succeeded",
      summaryFailures,
      semanticWarning,
      graphWriteAtomicity: graphWrite?.atomicityMode,
      graphWriteStatus: graphWrite?.journalStatus
    });

    return { filesScanned: scanParse.filesScanned, filesChanged: scanParse.filesChanged, repos: [repo] };
  } catch (error) {
    const graphWriteFailure = getGraphWriteFailureDetails(error);
    await runIndexStateCommitPhase({
      db,
      repo,
      batchId,
      indexedAt,
      filesScanned: 0,
      filesChanged: 0,
      filesStale: 0,
      status: "failed",
      graphWriteAtomicity: graphWriteFailure?.graphWriteAtomicity,
      graphWriteStatus: graphWriteFailure?.graphWriteStatus,
      error
    });
    throw error;
  }
}

export async function runDependencyRebuild(input: {
  db: GraphDB;
  ctx: IndexRunContext;
  repoIds?: string[];
}): Promise<number> {
  const { db, ctx, repoIds } = input;
  const rebuildStarted = Date.now();
  const rebuilt = await runRelationRebuildPhase({ db, repoIds, batchId: createBatchId("deps"), log: log(ctx) });
  logStage(ctx, "Dependency rebuild", rebuildStarted);
  return rebuilt;
}
