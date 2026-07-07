import { type GraphDB, withTransaction, type GraphWriteAtomicityMode, type GraphWriteBatchStatus } from "../graph-model/db.js";
import type { RepoNode } from "../parsing/types.js";
import type { SummaryFailureState } from "./summaries.js";
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
  error?: unknown;
}): Promise<void> {
  const { db, repo, batchId, indexedAt, filesScanned, filesChanged, filesStale, status, summaryFailures, semanticWarning, graphWriteAtomicity, graphWriteStatus, error } = input;
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
        graphWriteStatus
      });
    });
  });
}
