import type { AppConfig } from "../../../config/schema.js";
import {
  defaultSemanticIndex,
  type SemanticIndex,
  type SemanticSearchResult
} from "../../../core/semantic/semanticIndex.js";
import {
  resolveEmbeddingProvider,
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
    if (!(error instanceof Error)) throw error;
    return emptyRouteResult("semantic", "unavailable", "provider-resolve-failed");
  }
  if (!provider) return emptyRouteResult("semantic", "unavailable", "provider-unavailable");

  const limit = Math.max(0, plan.budgets.semantic.limit);
  if (limit === 0) return successfulRouteResult("semantic", [], [], 0);
  const createIndex = options.dependencies?.createIndex ?? defaultSemanticIndex;
  try {
    const rows = (await createIndex(options.cwd, config).search(question, {
      embeddingProvider: provider,
      providerPolicy: {
        retry: embedding.retry,
        budget: embedding.budget,
        rateLimit: embedding.rateLimit
      },
      limit
    })).slice(0, limit);
    return successfulRouteResult("semantic", candidatesFromSemanticResults(rows), rows, 1);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return emptyRouteResult("semantic", "failed", "search-failed", { executed: true, queryCount: 1 });
  }
}
