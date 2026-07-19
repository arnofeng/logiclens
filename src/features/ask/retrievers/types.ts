import type { RetrievalCandidate } from "../candidates.js";
import type { RetrievalRoute } from "../planner.js";
import type { SemanticSearchMetadata } from "../../../core/semantic/semanticIndex.js";

export type RetrieverRouteStatus = "succeeded" | "disabled" | "unavailable" | "unhealthy" | "failed";

export type RetrieverRouteResult<LegacyRow = never> = Readonly<{
  route: RetrievalRoute;
  candidates: readonly RetrievalCandidate[];
  legacyRows: readonly LegacyRow[];
  executed: boolean;
  queryCount: number;
  status: RetrieverRouteStatus;
  reason?: string;
  providerMetadata?: SemanticSearchMetadata;
}>;

/** Marks an expected provider/database route failure at the orchestration boundary. */
export class RetrieverOperationalError extends Error {
  readonly route: RetrievalRoute;
  readonly attemptedQueryCount: number;
  readonly reason: string;

  constructor(route: RetrievalRoute, attemptedQueryCount: number, reason = "route-failed", options?: ErrorOptions) {
    super(`Retrieval route failed: ${route}`, options);
    this.name = "RetrieverOperationalError";
    this.route = route;
    this.attemptedQueryCount = attemptedQueryCount;
    this.reason = reason;
  }
}

export function emptyRouteResult<LegacyRow>(
  route: RetrievalRoute,
  status: Exclude<RetrieverRouteStatus, "succeeded">,
  reason: string,
  input: { executed?: boolean; queryCount?: number } = {}
): RetrieverRouteResult<LegacyRow> {
  return Object.freeze({
    route,
    candidates: Object.freeze([]),
    legacyRows: Object.freeze([]),
    executed: input.executed ?? false,
    queryCount: input.queryCount ?? 0,
    status,
    reason
  });
}

export function successfulRouteResult<LegacyRow>(
  route: RetrievalRoute,
  candidates: readonly RetrievalCandidate[],
  legacyRows: readonly LegacyRow[],
  queryCount: number
): RetrieverRouteResult<LegacyRow> {
  return Object.freeze({
    route,
    candidates: Object.freeze([...candidates]),
    legacyRows: Object.freeze([...legacyRows]),
    executed: queryCount > 0,
    queryCount,
    status: "succeeded"
  });
}

export function failedRouteResult<LegacyRow>(
  route: RetrievalRoute,
  queryCount: number,
  reason = "route-failed"
): RetrieverRouteResult<LegacyRow> {
  return emptyRouteResult(route, "failed", reason, { executed: queryCount > 0, queryCount });
}
