import type { RetrievalCandidate } from "../candidates.js";
import type { RetrievalRoute } from "../planner.js";

export type RetrieverRouteStatus = "succeeded" | "disabled" | "unavailable" | "unhealthy" | "failed";

export type RetrieverRouteResult<LegacyRow = never> = Readonly<{
  route: RetrievalRoute;
  candidates: readonly RetrievalCandidate[];
  legacyRows: readonly LegacyRow[];
  executed: boolean;
  queryCount: number;
  status: RetrieverRouteStatus;
  reason?: string;
}>;

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
