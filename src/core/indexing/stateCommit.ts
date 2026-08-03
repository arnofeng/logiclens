import { type GraphDB, withTransaction, type GraphWriteAtomicityMode, type GraphWriteBatchStatus } from "../graph-model/db.js";
import type { RepoNode } from "../parsing/types.js";
import type { SummaryFailureState } from "./summaries.js";
import type { LexicalWriteResult } from "./lexicalWrite.js";
import { runIndexPhase } from "./phases.js";

export type IndexStateStatus = "succeeded" | "failed";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSummaryWarning(summaryFailures: SummaryFailureState | undefined): string | undefined {
  if (!summaryFailures) return undefined;
  const warnings: string[] = [];
  if (summaryFailures.failedCount > 0) {
    warnings.push(`Failed to generate ${summaryFailures.failedCount} LLM summaries. First few errors:\n${summaryFailures.errors.slice(0, 3).join("\n")}`);
  }
  if (summaryFailures.providerWarning) warnings.push(summaryFailures.providerWarning);
  return warnings.length > 0 ? warnings.join("\n\n") : undefined;
}

export function combineIndexWarnings(...warnings: (string | undefined)[]): string | undefined {
  const present = warnings.filter((warning): warning is string => Boolean(warning));
  return present.length > 0 ? present.join("\n\n") : undefined;
}

/**
 * Replaces the provisional lexical snapshot written by individual repo/batch
 * transactions with the health of the completed indexing run. Version
 * metadata is intentionally refreshed only after commitVersions succeeds.
 */
export async function refreshSucceededIndexStateLexicalMetrics(input: {
  db: GraphDB;
  repoIds: string[];
  lexicalDocumentCount: number;
  lexicalIndexSizeBytes: number;
  lexicalProjectionSchemaVersion: string;
  lexicalTokenizerVersion: string;
  lexicalIndexStatus: string;
  lexicalProjectionDurationMs: number;
  lexicalWriteDurationMs: number;
}): Promise<void> {
  const repoIds = [...new Set(input.repoIds)];
  if (repoIds.length === 0) return;
  await input.db.query(
    `MATCH (s:IndexState)
     WHERE s.repoId IN $repoIds AND s.status = 'succeeded'
     SET s.lexicalDocumentCount = $lexicalDocumentCount,
         s.lexicalIndexSizeBytes = $lexicalIndexSizeBytes,
         s.lexicalProjectionSchemaVersion = $lexicalProjectionSchemaVersion,
         s.lexicalTokenizerVersion = $lexicalTokenizerVersion,
         s.lexicalIndexStatus = $lexicalIndexStatus,
         s.lexicalProjectionDurationMs = $lexicalProjectionDurationMs,
         s.lexicalWriteDurationMs = $lexicalWriteDurationMs,
         s.graphWriteStatus = 'committed';`,
    {
      repoIds,
      lexicalDocumentCount: input.lexicalDocumentCount,
      lexicalIndexSizeBytes: input.lexicalIndexSizeBytes,
      lexicalProjectionSchemaVersion: input.lexicalProjectionSchemaVersion,
      lexicalTokenizerVersion: input.lexicalTokenizerVersion,
      lexicalIndexStatus: input.lexicalIndexStatus,
      lexicalProjectionDurationMs: input.lexicalProjectionDurationMs,
      lexicalWriteDurationMs: input.lexicalWriteDurationMs
    }
  );
}

export async function runIndexStateCommitPhase(input: {
  db: GraphDB;
  repo: RepoNode;
  batchId: string;
  indexedAt: string;
  filesScanned: number;
  filesChanged: number;
  filesStale: number;
  status: IndexStateStatus;
  summaryFailures?: SummaryFailureState;
  semanticWarning?: string;
  graphWriteAtomicity?: GraphWriteAtomicityMode;
  graphWriteStatus?: GraphWriteBatchStatus;
  lexical?: LexicalWriteResult;
  lexicalProjectionDurationMs?: number;
  error?: unknown;
}): Promise<void> {
  const { db, repo, batchId, indexedAt, filesScanned, filesChanged, filesStale, status, summaryFailures, semanticWarning, graphWriteAtomicity, graphWriteStatus, lexical, lexicalProjectionDurationMs, error } = input;
  await runIndexPhase({ phase: "index-state-commit", repoName: repo.name, repoId: repo.id, batchId }, async () => {
    // IndexState.error is the operator-facing rollup for soft warnings and
    // hard failures, so downstream freshness checks only need one field.
    const stateError = status === "failed"
      ? errorMessage(error)
      : combineIndexWarnings(formatSummaryWarning(summaryFailures), semanticWarning);

    // Wrap in a transaction so the IndexState commit is atomic with respect
    // to the graph writes that precede it. If the DB adapter supports
    // transactions, this ensures the state row and the graph data are
    // committed (or rolled back) as a unit.
    await withTransaction(db, async () => {
      await db.upsertIndexState({
        repoId: repo.id,
        repoName: repo.name,
        lastBatchId: batchId,
        lastIndexedAt: indexedAt,
        lastCommitSha: repo.commitSha,
        filesScanned,
        filesChanged,
        filesStale,
        status,
        error: stateError,
        graphWriteAtomicity,
        graphWriteStatus,
        lexicalDocumentCount: lexical?.providerHealth.metrics.documentCount,
        lexicalIndexSizeBytes: lexical?.providerHealth.metrics.indexSizeBytes,
        lexicalProjectionSchemaVersion: lexical?.projectionSchemaVersion,
        lexicalTokenizerVersion: lexical?.tokenizerVersion,
        lexicalIndexStatus: lexical?.indexStatus,
        lexicalProjectionDurationMs,
        lexicalWriteDurationMs: lexical?.durationMs
      });
    });
  });
}
