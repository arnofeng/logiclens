import path from "node:path";
import type { AppConfig } from "../../config/schema.js";
import { writeGraphFactsBatch } from "../graph-model/batchWriter.js";
import { writeGraphFactsWithKuzuAppendCopy, writeGraphFactsWithKuzuBulk, writeGraphFactsWithKuzuBulkUpsert } from "../graph-model/bulkWriter.js";
import type { GraphDB, GraphWriteAtomicityMode, GraphWriteBatchStatus } from "../graph-model/db.js";
import { buildGraphFactsBatch, type GraphFactsBatch } from "../graph-model/facts.js";
import { writeGraphFactsWithNeo4jBatch } from "../../adapters/graph-db/neo4j/Neo4jBatchWriter.js";
import type { ParsedGraphFile, RepoNode } from "../parsing/types.js";
import type { IndexWriteMode } from "./context.js";
import { runIndexPhase } from "./phases.js";
import { shouldSummarizeGraphWithLlm, summarizeGraphWithProgress } from "./summaries.js";
import type { ProgressReporter } from "../../shared/progress.js";
import { BRAND_PATHS } from "../../shared/branding.js";

export type GraphWriterMode = "bulk-copy" | "append-copy" | "bulk-upsert" | "merge";

export type GraphWriterSelection = {
  mode: GraphWriterMode;
  fast: boolean;
  fallbackToMerge: boolean;
};

export type FactBuildResult = {
  facts: GraphFactsBatch;
  counts: {
    files: number;
    code: number;
    sections: number;
    imports: number;
    calls: number;
    entities: number;
  };
};

export type GraphWriteResult = {
  writerMode: GraphWriterMode;
  batchId: string;
  repoNames: string[];
  repoIds: string[];
  atomicityMode: GraphWriteAtomicityMode;
  journalStatus: GraphWriteBatchStatus;
  recoveredBatchIds: string[];
  fallback: boolean;
  fallbackError?: string;
};

export type GraphWriteFailureDetails = {
  graphWriteAtomicity: GraphWriteAtomicityMode;
  graphWriteStatus: GraphWriteBatchStatus;
};

type ProgressBarLike = {
  update(current: number, label?: string, total?: number, stepMs?: number): void;
  reporter(): ProgressReporter;
  complete(): void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function graphWriteAtomicityMode(_mode: GraphWriterMode): GraphWriteAtomicityMode {
  return "journaled-recoverable";
}

function markGraphWriteFailure(error: unknown, details: GraphWriteFailureDetails): unknown {
  if (error && (typeof error === "object" || typeof error === "function")) {
    Object.assign(error, details);
    return error;
  }
  const wrapped = new Error(errorMessage(error));
  Object.assign(wrapped, details);
  return wrapped;
}

export function getGraphWriteFailureDetails(error: unknown): GraphWriteFailureDetails | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Partial<GraphWriteFailureDetails>;
  if (!candidate.graphWriteAtomicity || !candidate.graphWriteStatus) return undefined;
  return {
    graphWriteAtomicity: candidate.graphWriteAtomicity,
    graphWriteStatus: candidate.graphWriteStatus
  };
}

// Centralizes the existing writer-mode contract so batch/full/incremental
// orchestration cannot drift into slightly different auto-mode behavior.
export function selectGraphWriter(input: {
  writeMode: IndexWriteMode;
  changedOnly?: boolean;
  batchedFull?: boolean;
  fullCopyBulk?: boolean;
  graphIsEmpty?: boolean;
  provider?: string;
}): GraphWriterSelection {
  const { writeMode, changedOnly, batchedFull, fullCopyBulk, graphIsEmpty, provider } = input;
  // Non-Kuzu providers (e.g. Neo4j) don't support COPY FROM / LOAD FROM bulk
  // operations, so force merge mode regardless of writeMode.
  if (provider && provider !== "kuzu") {
    return {
      mode: "merge",
      fast: false,
      fallbackToMerge: false
    };
  }
  if (batchedFull) {
    return {
      mode: graphIsEmpty ? "bulk-copy" : "append-copy",
      fast: true,
      fallbackToMerge: false
    };
  }
  if (fullCopyBulk) {
    return {
      mode: "bulk-copy",
      fast: true,
      fallbackToMerge: false
    };
  }
  if (writeMode === "auto" && !changedOnly) {
    return {
      mode: "append-copy",
      fast: true,
      fallbackToMerge: true
    };
  }
  if (writeMode === "bulk-upsert" || (writeMode === "auto" && changedOnly)) {
    return {
      mode: "bulk-upsert",
      fast: true,
      // Explicit bulk-upsert keeps the old hard-fail behavior; auto
      // changed-only may fall back to merge if the fast path is unavailable.
      fallbackToMerge: writeMode !== "bulk-upsert"
    };
  }
  return {
    mode: "merge",
    fast: false,
    fallbackToMerge: false
  };
}

export async function runFactBuildPhase(input: {
  batchId: string;
  indexedAt: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  config: AppConfig;
  repoName?: string;
}): Promise<FactBuildResult> {
  const { batchId, indexedAt, repos, parsedFiles, config, repoName } = input;
  const result = await runIndexPhase({ phase: "fact-build", repoName, batchId }, async () => {
    const facts = await buildGraphFactsBatch({ batchId, indexedAt, repos, parsedFiles, semantic: true, config });
    return {
      facts,
      counts: {
        files: facts.files.length,
        code: facts.code.length,
        sections: facts.sections.length,
        imports: facts.imports.length,
        calls: facts.calls.length,
        entities: facts.entities.length
      }
    };
  });
  return result.result;
}

// 鈹€鈹€ summary helper (shared between Neo4j batch path and Kuzu path) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async function generateAndUpdateSummaries(input: {
  db: GraphDB;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  crossRepo: GraphFactsBatch["crossRepo"];
  config: AppConfig;
  llmSummaryLevel: AppConfig["indexing"]["llmSummaryLevel"];
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  label: string;
  createProgressBar: (label: string, total: number) => ProgressBarLike;
}): Promise<void> {
  const { db, repos, parsedFiles, crossRepo, config, llmSummaryLevel, openAiApiKey, openAiBaseUrl, label, createProgressBar } = input;
  const summaries = await summarizeGraphWithProgress({
    repos,
    parsedFiles,
    crossRepo,
    options: {
      semantic: shouldSummarizeGraphWithLlm(llmSummaryLevel),
      model: config.llm.model,
      maxSourceChars: config.llm.maxSourceCharsPerNode,
      apiKey: openAiApiKey,
      baseUrl: openAiBaseUrl,
      providerPolicy: { retry: config.llm.retry, budget: config.llm.budget, rateLimit: config.llm.rateLimit }
    }
  }, label, createProgressBar);
  for (const summary of summaries.repoSummaries) await db.updateRepoSummary(summary.repoId, summary.summary);
  await db.updateSystemSummary(summaries.systemSummary);
}

// 鈹€鈹€ legacy one-by-one merge writer (kept as fallback) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async function writeWithMerge(input: {
  db: GraphDB;
  batchId: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  config: AppConfig;
  llmSummaryLevel: AppConfig["indexing"]["llmSummaryLevel"];
  openAiApiKey?: string;
  openAiBaseUrl?: string;
}): Promise<void> {
  const { db, batchId, repos, parsedFiles, config, llmSummaryLevel, openAiApiKey, openAiBaseUrl } = input;
  await writeGraphFactsBatch(db, {
    batchId,
    repos,
    parsedFiles
  }, {
    semantic: true,
    llmSummary: shouldSummarizeGraphWithLlm(llmSummaryLevel),
    llmModel: config.llm.model,
    maxSourceChars: config.llm.maxSourceCharsPerNode,
    apiKey: openAiApiKey,
    baseUrl: openAiBaseUrl
  });
}

export async function runGraphWritePhase(input: {
  db: GraphDB;
  cwd: string;
  selection: GraphWriterSelection;
  facts: GraphFactsBatch;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  config: AppConfig;
  llmSummaryLevel: AppConfig["indexing"]["llmSummaryLevel"];
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  label: string;
  repoName?: string;
  createProgressBar: (label: string, total: number) => ProgressBarLike;
  log: (message: string) => void;
  warn: (message: string) => void;
}): Promise<GraphWriteResult> {
  const { db, cwd, selection, facts, repos, parsedFiles, config, llmSummaryLevel, openAiApiKey, openAiBaseUrl, label, repoName, createProgressBar, log, warn } = input;
  const result = await runIndexPhase({
    phase: "graph-write",
    repoName,
    batchId: facts.batchId,
    writerMode: selection.mode
  }, async () => {
    let fallback = false;
    let fallbackError: string | undefined;
    const stagingRoot = path.resolve(cwd, BRAND_PATHS.batchStaging);
    const repoIds = repos.map((repo) => repo.id);
    const repoNames = repos.map((repo) => repo.name);
    const atomicityMode = graphWriteAtomicityMode(selection.mode);
    const recovered = await db.recoverIncompleteGraphWriteBatches({ repoIds, updatedAt: new Date().toISOString() });
    for (const journal of recovered) {
      warn(`Recovered incomplete graph writer batch repo=${journal.repoNames.join(",")} batchId=${journal.batchId} writer=${journal.writerMode}`);
    }

    log(`Writer: ${selection.mode}${repoName ? ` repo=${repoName}` : ""} batchId=${facts.batchId}`);
    await db.beginGraphWriteBatch({
      batchId: facts.batchId,
      repoIds,
      repoNames,
      writerMode: selection.mode,
      atomicityMode,
      startedAt: new Date().toISOString(),
      completedStage: "begin"
    });
    async function cleanupFailedBatch(error: unknown, completedStage: string): Promise<GraphWriteBatchStatus> {
      await db.failGraphWriteBatch({ batchId: facts.batchId, updatedAt: new Date().toISOString(), error: errorMessage(error), completedStage, awaitingCleanup: true });
      try {
        await db.cleanupGraphWriteBatch(facts.batchId);
        await db.failGraphWriteBatch({ batchId: facts.batchId, updatedAt: new Date().toISOString(), error: errorMessage(error), completedStage: `${completedStage}-cleanup-complete` });
        return "failed";
      } catch (cleanupError) {
        // If cleanup itself fails, preserve the journal as awaiting-cleanup so
        // the next graph-write phase can recover it before making new results
        // visible for the same repo scope.
        await db.failGraphWriteBatch({ batchId: facts.batchId, updatedAt: new Date().toISOString(), error: errorMessage(cleanupError), completedStage: `${completedStage}-cleanup-failed`, awaitingCleanup: true });
        return "awaiting-cleanup";
      }
    }

    try {
      const doSummaries = shouldSummarizeGraphWithLlm(llmSummaryLevel);
      if (selection.mode === "merge") {
        // Neo4j: use UNWIND-based batch writer - 50-100x faster than the
        // one-by-one merge writer because it reduces ~40 000 individual
        // transactions to about 30.
        const writeProgress = createProgressBar(`Graph write ${label}`, 1);
        await writeGraphFactsWithNeo4jBatch(db, facts, { progress: writeProgress.reporter() });
        writeProgress.complete();
        if (doSummaries) {
          await generateAndUpdateSummaries({ db, repos, parsedFiles, crossRepo: facts.crossRepo, config, llmSummaryLevel, openAiApiKey, openAiBaseUrl, label, createProgressBar });
        }
      } else {
        const writeProgress = createProgressBar(`Graph write ${label}`, 1);
        if (selection.mode === "bulk-copy") {
          await writeGraphFactsWithKuzuBulk(db, facts, { stagingRoot, progress: writeProgress.reporter() });
        } else if (selection.mode === "append-copy") {
          // Append-copy does not delete stale rows by itself, so the phase owns
          // the repo-scoped cleanup immediately before staging COPY files.
          for (const repo of repos) await db.clearRepoIndexedArtifacts(repo.id);
          await writeGraphFactsWithKuzuAppendCopy(db, facts, { stagingRoot, progress: writeProgress.reporter() });
        } else {
          await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot, progress: writeProgress.reporter() });
        }
        writeProgress.complete();
        if (doSummaries) {
          await generateAndUpdateSummaries({ db, repos, parsedFiles, crossRepo: facts.crossRepo, config, llmSummaryLevel, openAiApiKey, openAiBaseUrl, label, createProgressBar });
        }
      }
      await db.commitGraphWriteBatch({ batchId: facts.batchId, updatedAt: new Date().toISOString(), completedStage: "commit" });
    } catch (error) {
      const writeFailureStatus = await cleanupFailedBatch(error, "write-failed");
      if (!selection.fallbackToMerge) {
        throw markGraphWriteFailure(error, { graphWriteAtomicity: atomicityMode, graphWriteStatus: writeFailureStatus });
      }
      fallback = true;
      fallbackError = errorMessage(error);
      warn(`Fast graph writer failed${repoName ? ` for ${repoName}` : ""}; falling back to merge writer: ${fallbackError}`);
      await db.beginGraphWriteBatch({
        batchId: facts.batchId,
        repoIds,
        repoNames,
        writerMode: "merge",
        atomicityMode,
        startedAt: new Date().toISOString(),
        completedStage: "fallback-begin",
        error: fallbackError
      });
      try {
        await writeWithMerge({ db, batchId: facts.batchId, repos, parsedFiles, config, llmSummaryLevel, openAiApiKey, openAiBaseUrl });
        await db.commitGraphWriteBatch({ batchId: facts.batchId, updatedAt: new Date().toISOString(), completedStage: "fallback-commit" });
      } catch (fallbackWriteError) {
        const fallbackFailureStatus = await cleanupFailedBatch(fallbackWriteError, "fallback-failed");
        throw markGraphWriteFailure(fallbackWriteError, { graphWriteAtomicity: atomicityMode, graphWriteStatus: fallbackFailureStatus });
      }
    }

    return {
      writerMode: fallback ? "merge" : selection.mode,
      batchId: facts.batchId,
      repoNames,
      repoIds,
      atomicityMode,
      journalStatus: "committed" as const,
      recoveredBatchIds: recovered.map((journal) => journal.batchId),
      fallback,
      fallbackError
    };
  });

  return result.result;
}
