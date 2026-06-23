import type { LogicLensConfig } from "../config/schema.js";
import { rebuildRepoDependencies } from "../graph/rebuildRelations.js";
import type { GraphDB } from "../graph/db.js";
import type { ParsedGraphFile, RepoNode } from "../parsers/types.js";
import { indexSemanticText, type SemanticIndexingResult } from "../semantic/semanticIndex.js";
import type { ProgressReporter } from "../utils/progress.js";
import { formatProviderStats } from "../providers/openaiProvider.js";
import { runIndexPhase } from "./phases.js";

type ProgressBarLike = {
  reporter(): ProgressReporter;
  complete(): void;
};

export type SemanticWriteResult = {
  indexed: boolean;
  warning?: string;
  fallbackEvents: number;
};

function formatSemanticIndexWarning(result: SemanticIndexingResult | undefined): string | undefined {
  if (!result) return undefined;
  const warnings: string[] = [];
  if (result.fallbackEvents.length > 0) {
    const details = result.fallbackEvents.slice(0, 3).map((event) => `${event.operation}: ${event.message}`).join("\n");
    warnings.push(`Semantic index used fallback storage for ${result.fallbackEvents.length} operation(s). First few errors:\n${details}`);
  }
  const providerStats = result.providerStats ? formatProviderStats("Embedding", result.providerStats) : undefined;
  if (providerStats) warnings.push(providerStats);
  return warnings.length > 0 ? warnings.join("\n\n") : undefined;
}

export async function runSemanticWritePhase(input: {
  cwd: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  config: LogicLensConfig;
  enabled: boolean;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  label: string;
  repoName?: string;
  batchId?: string;
  createProgressBar: (label: string, total: number) => ProgressBarLike;
  warn: (message: string) => void;
}): Promise<SemanticWriteResult> {
  const { cwd, repos, parsedFiles, config, enabled, model, apiKey, baseUrl, label, repoName, batchId, createProgressBar, warn } = input;
  const result = await runIndexPhase({ phase: "semantic-write", repoName, batchId }, async () => {
    if (!enabled) return { indexed: false, fallbackEvents: 0 };

    const embeddingProgress = createProgressBar(`Embeddings ${label}`, 1);
    try {
      // The semantic index may downgrade from the configured backend to local
      // JSON storage; keep that as a warning so graph indexing still succeeds.
      const semanticResult = await indexSemanticText({
        cwd,
        repos,
        parsedFiles,
        model,
        apiKey,
        baseUrl,
        config,
        progress: embeddingProgress.reporter()
      });
      const warning = formatSemanticIndexWarning(semanticResult);
      if (warning) warn(warning);
      return {
        indexed: true,
        warning,
        fallbackEvents: semanticResult.fallbackEvents.length
      };
    } finally {
      embeddingProgress.complete();
    }
  });

  return result.result;
}

export async function runStaleMarkPhase(input: {
  db: GraphDB;
  repo: RepoNode;
  activeFileIds: string[];
  batchId: string;
  indexedAt: string;
}): Promise<number> {
  const { db, repo, activeFileIds, batchId, indexedAt } = input;
  const result = await runIndexPhase({ phase: "stale-mark", repoName: repo.name, repoId: repo.id, batchId }, async () => {
    // Only incremental/per-repo indexing calls this phase. Full and batched
    // paths retain their existing cleanup behavior in the graph writer.
    return db.markRepoArtifactsStale({ repoId: repo.id, activeFileIds, batchId, indexedAt });
  });
  return result.result;
}

export async function runRelationRebuildPhase(input: {
  db: GraphDB;
  repoIds?: string[];
  batchId: string;
  log: (message: string) => void;
}): Promise<number> {
  const { db, repoIds, batchId, log } = input;
  const result = await runIndexPhase({ phase: "relation-rebuild", batchId }, async () => {
    const rebuilt = await rebuildRepoDependencies(db, { repoIds, batchId, logger: { log } });
    return rebuilt.length;
  });
  return result.result;
}
