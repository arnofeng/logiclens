import {
  WorkspaceLexicalStoreError,
  type WorkspaceLexicalStore
} from "../../../core/retrieval/provider.js";
import type { LexicalHit, LexicalIndexHealth } from "../../../core/retrieval/types.js";
import { createRetrievalCandidate, candidatesFromLexicalHits, type RetrievalCandidate } from "../candidates.js";
import type { QueryPlan } from "../planner.js";
import { normalizeExactPaths } from "./exact.js";
import { emptyRouteResult, successfulRouteResult, type RetrieverRouteResult } from "./types.js";

export type WorkspaceLexicalRetrieverOptions = Readonly<{
  workspaceId: string;
  enabled?: boolean;
  health?: LexicalIndexHealth;
  repoRoots?: readonly string[];
}>;

function verifiedLexicalCandidates(
  candidates: readonly RetrievalCandidate[],
  plan: QueryPlan,
  repoRoots: readonly string[]
): RetrievalCandidate[] {
  const exactPaths = new Set(normalizeExactPaths(plan.paths, repoRoots));
  const canonicalIds = new Set(plan.exactIdentifiers.filter((value) => value.includes(":")));
  return candidates.map((candidate) => {
    const reason = candidate.location?.path && exactPaths.has(candidate.location.path)
      ? "exact-path"
      : canonicalIds.has(candidate.canonicalId)
        ? "canonical-id"
        : undefined;
    if (!reason || (candidate.kind !== "code" && candidate.kind !== "contract")) return candidate;
    return createRetrievalCandidate({
      canonicalId: candidate.canonicalId,
      repoId: candidate.repoId,
      kind: candidate.kind,
      routes: candidate.routes,
      provenance: candidate.provenance.map((provenance) => ({ ...provenance, confidence: "corroborated" })),
      matchReasons: [...candidate.matchReasons, reason],
      confidence: "corroborated"
    });
  });
}

export async function retrieveWorkspaceLexical(
  store: WorkspaceLexicalStore | undefined,
  plan: QueryPlan,
  options: WorkspaceLexicalRetrieverOptions
): Promise<RetrieverRouteResult<LexicalHit>> {
  if (options.enabled === false || !plan.enabledRoutes.includes("lexical")) {
    return emptyRouteResult("lexical", "disabled", "route-disabled");
  }
  const text = plan.normalizedLexicalQuery.trim();
  if (!text) return emptyRouteResult("lexical", "disabled", "query-empty");
  if (!store) return emptyRouteResult("lexical", "unavailable", "provider-unavailable");

  let health: LexicalIndexHealth;
  try {
    health = options.health ?? await store.health(options.workspaceId);
  } catch (error) {
    if (!(error instanceof WorkspaceLexicalStoreError)) throw error;
    return emptyRouteResult("lexical", "failed", "health-check-failed");
  }
  if (health.status === "unavailable") {
    return emptyRouteResult("lexical", "unavailable", health.reasons[0] ?? "provider-unavailable");
  }
  if (health.status !== "healthy") {
    return emptyRouteResult("lexical", "unhealthy", health.reasons[0] ?? "provider-unhealthy");
  }

  const limit = Math.max(0, plan.budgets.lexical.limit);
  if (limit === 0) return successfulRouteResult("lexical", [], [], 0);
  try {
    const hits = (await store.search(
      { workspaceId: options.workspaceId, text },
      { topK: limit }
    )).slice(0, limit);
    const candidates = verifiedLexicalCandidates(
      candidatesFromLexicalHits(hits, options.workspaceId),
      plan,
      options.repoRoots ?? []
    );
    return successfulRouteResult("lexical", candidates, hits, 1);
  } catch (error) {
    if (!(error instanceof WorkspaceLexicalStoreError)) throw error;
    return emptyRouteResult("lexical", "failed", "search-failed", { executed: true, queryCount: 1 });
  }
}
