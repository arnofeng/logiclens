import type { LexicalIndexHealth } from "../../core/retrieval/types.js";
import type {
  LexicalProviderGateResult,
  LexicalProviderGateSummary
} from "../../core/retrieval/provider.js";
import type { RetrievalRoute } from "./planner.js";
import type {
  RetrieverRouteResult,
  RetrieverRouteStatus,
} from "./retrievers/types.js";
import type {
  SourceLoadRejectionReason,
  SourceLoadStatus,
} from "./sourceLoader.js";

export type RetrievalOutcome =
  | "succeeded"
  | "degraded"
  | "no_results"
  | "failed";

export type RetrievalStageStatus =
  | "completed"
  | "skipped"
  | "unavailable"
  | "unhealthy"
  | "failed"
  | "not_run";

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
    sourceLoading: number;
  }>;
  compatibility: Readonly<{
    dependencies: RetrievalRouteDiagnostic;
  }>;
  providers: Readonly<{
    lexical: Readonly<{
      status: RetrieverRouteStatus;
      configuredProvider?: string;
      effectiveProvider?: string;
      gateStatus?: LexicalProviderGateSummary["status"];
      reasonCodes?: LexicalProviderGateSummary["reasonCodes"];
      providerVersion?: string;
      projectionSchemaVersion?: string;
      tokenizerVersion?: string;
      indexStatus?: LexicalIndexHealth["status"];
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
  sourceLoading: Readonly<{
    status: SourceLoadStatus;
    reason?: string;
    queryCount: number;
    rejectionCounts: Readonly<
      Partial<Record<SourceLoadRejectionReason, number>>
    >;
  }>;
}>;

export function safeLexicalProviderDiagnostic(
  route: RetrieverRouteResult<unknown>,
  health?: LexicalIndexHealth,
  gate?: LexicalProviderGateResult,
): RetrievalDiagnostics["providers"]["lexical"] {
  const diagnosticHealth = health ?? gate?.health;
  return Object.freeze({
    status: route.status,
    ...(gate ? {
      configuredProvider: gate.configuredProvider,
      ...(gate.effectiveProvider ? { effectiveProvider: gate.effectiveProvider } : {}),
      gateStatus: gate.status,
      reasonCodes: Object.freeze([...gate.reasonCodes]),
      indexStatus: gate.health?.status,
    } : {}),
    ...(diagnosticHealth
      ? {
          providerVersion: diagnosticHealth.providerVersion,
          projectionSchemaVersion: diagnosticHealth.projectionSchemaVersion,
          tokenizerVersion: diagnosticHealth.tokenizerVersion,
          indexStatus: diagnosticHealth.status,
        }
      : {}),
  });
}

export function determineRetrievalOutcome(
  reliableEvidenceCount: number,
  routes: readonly RetrieverRouteResult<unknown>[],
  compatibilityStatuses: readonly (
    | RetrieverRouteStatus
    | SourceLoadStatus
  )[] = [],
): RetrievalOutcome {
  const problematic = (status: RetrieverRouteStatus | SourceLoadStatus) =>
    status === "failed" || status === "unavailable" || status === "unhealthy";
  const hasCompatibilityProblem = compatibilityStatuses.some(problematic);
  const hasProblem =
    routes.some(({ status }) => problematic(status)) || hasCompatibilityProblem;
  if (reliableEvidenceCount > 0) return hasProblem ? "degraded" : "succeeded";
  if (hasProblem || hasCompatibilityProblem) return "failed";
  return "no_results";
}
