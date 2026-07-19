import type { AppConfig } from "../../../config/schema.js";
import {
  defaultSemanticIndex,
  SemanticProviderOperationalError,
  type SemanticIndex,
  type SemanticSearchExecution,
  type SemanticSearchResult
} from "../../../core/semantic/semanticIndex.js";
import {
  resolveEmbeddingProvider,
  EmbeddingProviderUnavailableError,
  type EmbeddingProvider
} from "../../../core/semantic/embeddings.js";
import { candidatesFromSemanticResults } from "../candidates.js";
import type { QueryPlan } from "../planner.js";
import { emptyRouteResult, successfulRouteResult, type RetrieverRouteResult } from "./types.js";

export type SemanticRetrieverDependencies = Readonly<{
  resolveProvider?: (providerName: string) => EmbeddingProvider | undefined;
  createIndex?: (cwd: string | undefined, config: AppConfig | undefined) => SemanticIndex;
}>;

export async function retrieveOptionalSemantic(
  plan: QueryPlan,
  question: string,
  config: AppConfig | undefined,
  options: { cwd?: string; dependencies?: SemanticRetrieverDependencies } = {}
): Promise<RetrieverRouteResult<SemanticSearchResult>> {
  if (!plan.enabledRoutes.includes("semantic")) {
    return emptyRouteResult("semantic", "disabled", "route-disabled");
  }
  const embedding = config?.embedding;
  const providerName = embedding?.provider ?? "off";
  if (!embedding || providerName === "off" || embedding.level === "off") {
    return emptyRouteResult("semantic", "disabled", "provider-off");
  }

  const resolveProvider = options.dependencies?.resolveProvider ?? resolveEmbeddingProvider;
  let provider: EmbeddingProvider | undefined;
  try {
    provider = resolveProvider(providerName);
  } catch (error) {
    if (error instanceof EmbeddingProviderUnavailableError) {
      return emptyRouteResult("semantic", "unavailable", "provider-resolve-failed");
    }
    throw error;
  }
  if (!provider) return emptyRouteResult("semantic", "unavailable", "provider-unavailable");

  const limit = Math.max(0, plan.budgets.semantic.limit);
  if (limit === 0) return successfulRouteResult("semantic", [], [], 0);
  const createIndex = options.dependencies?.createIndex ?? defaultSemanticIndex;
  try {
    const index = createIndex(options.cwd, config);
    const searchOptions = {
      embeddingProvider: provider,
      providerPolicy: {
        retry: embedding.retry,
        budget: embedding.budget,
        rateLimit: embedding.rateLimit
      },
      limit
    };
    let execution: SemanticSearchExecution | undefined;
    const rows = index.searchWithMetadata
      ? [...(execution = await index.searchWithMetadata(question, searchOptions)).rows].slice(0, limit)
      : (await index.search(question, searchOptions)).slice(0, limit);
    const base = successfulRouteResult("semantic", candidatesFromSemanticResults(rows), rows, execution?.attemptedSearchCount ?? 1);
    if (!execution) return base;
    return Object.freeze({
      ...base,
      ...(execution.metadata.primaryStatus === "failed" ? {
        status: "unhealthy" as const,
        reason: "primary-provider-failed"
      } : {}),
      providerMetadata: execution.metadata
    });
  } catch (error) {
    if (error instanceof SemanticProviderOperationalError) {
      return Object.freeze({
        ...emptyRouteResult<SemanticSearchResult>("semantic", "failed", "search-failed", {
          executed: error.attemptedSearchCount > 0,
          queryCount: error.attemptedSearchCount
        }),
        ...(error.metadata ? { providerMetadata: error.metadata } : {})
      });
    }
    throw error;
  }
}
