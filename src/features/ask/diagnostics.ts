import type { LexicalIndexHealth } from "../../core/retrieval/types.js";
import type { RetrievalRoute } from "./planner.js";
import type { RetrieverRouteResult, RetrieverRouteStatus } from "./retrievers/types.js";

export type RetrievalOutcome = "succeeded" | "degraded" | "no_results" | "failed";

export type RetrievalStageStatus = "completed" | "skipped" | "unavailable" | "unhealthy" | "failed" | "not_run";

export type RetrievalStageDiagnostic = Readonly<{
  status: RetrievalStageStatus;
  durationMs: number;
}>;

export type RetrievalRouteDiagnostic = Readonly<{
  status: RetrieverRouteStatus;
  reason?: string;
  executed: boolean;
  queryCount: number;
}>;

export type RetrievalDiagnostics = Readonly<{
  routes: Readonly<Record<RetrievalRoute, RetrievalRouteDiagnostic>>;
  timings: Readonly<{
    planning: RetrievalStageDiagnostic;
    exactContractEntity: RetrievalStageDiagnostic;
    lexical: RetrievalStageDiagnostic;
    graphExpansion: RetrievalStageDiagnostic;
    semantic: RetrievalStageDiagnostic;
    fusion: RetrievalStageDiagnostic;
    selection: RetrievalStageDiagnostic;
    sourceLoading: RetrievalStageDiagnostic;
    total: RetrievalStageDiagnostic;
  }>;
  queries: Readonly<{
    total: number;
    byRoute: Readonly<Record<RetrievalRoute, number>>;
    dependencies: number;
  }>;
  compatibility: Readonly<{
    dependencies: RetrievalRouteDiagnostic;
  }>;
  providers: Readonly<{
    lexical: Readonly<{
      status: RetrieverRouteStatus;
      providerVersion?: string;
      projectionSchemaVersion?: string;
      tokenizerVersion?: string;
    }>;
    semantic: Readonly<{
      status: RetrieverRouteStatus;
      provider?: string;
      primaryProvider?: string;
      effectiveProvider?: string;
      fallbackUsed?: boolean;
      fallbackReason?: string;
      primaryStatus?: "succeeded" | "failed";
    }>;
  }>;
}>;

export function safeLexicalProviderDiagnostic(
  route: RetrieverRouteResult<unknown>,
  health?: LexicalIndexHealth
): RetrievalDiagnostics["providers"]["lexical"] {
  return Object.freeze({
    status: route.status,
    ...(health ? {
      providerVersion: health.providerVersion,
      projectionSchemaVersion: health.projectionSchemaVersion,
      tokenizerVersion: health.tokenizerVersion
    } : {})
  });
}

export function determineRetrievalOutcome(
  selectedCount: number,
  routes: readonly RetrieverRouteResult<unknown>[],
  compatibilityStatuses: readonly RetrieverRouteStatus[] = []
): RetrievalOutcome {
  const problematic = (status: RetrieverRouteStatus) => status === "failed" || status === "unavailable" || status === "unhealthy";
  const hasCompatibilityProblem = compatibilityStatuses.some(problematic);
  const hasProblem = routes.some(({ status }) => problematic(status)) || hasCompatibilityProblem;
  if (selectedCount > 0) return hasProblem ? "degraded" : "succeeded";
  if (hasCompatibilityProblem) return "failed";
  const hasSuccessfulRoute = routes.some(({ status }) => status === "succeeded");
  return hasSuccessfulRoute || !hasProblem ? "no_results" : "failed";
}
