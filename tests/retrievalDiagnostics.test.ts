import { describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import type { WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";
import type { QueryPlan } from "../src/features/ask/planner.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { candidatesFromSemanticResults } from "../src/features/ask/candidates.js";
import { determineRetrievalOutcome } from "../src/features/ask/diagnostics.js";
import { retrieveForQuestion } from "../src/features/ask/retrieve.js";
import { emptyRouteResult, successfulRouteResult } from "../src/features/ask/retrievers/types.js";

const ROUTES = ["exact", "contract", "entity", "lexical", "graph", "semantic"] as const;
const PUBLIC_GRAPH_SNAPSHOT = Object.freeze({
  workspaceId: deriveWorkspaceId("default-system"),
  generation: "generation:retrieval-diagnostics",
  revision: "generation:retrieval-diagnostics"
});
function plan(): QueryPlan {
  return { kind: "general", terms: [], exactIdentifiers: [], paths: [], contractTargets: [], normalizedLexicalQuery: "orders", enabledRoutes: [...ROUTES], budgets: {
    exact: { limit: 1 }, contract: { limit: 1 }, entity: { limit: 1 }, lexical: { limit: 1 }, graph: { limit: 1 }, semantic: { limit: 1 }
  } };
}

describe("retrieval diagnostics", () => {
  it("uses an injected monotonic clock, counts each route, and safely maps provider health", async () => {
    let tick = 0;
    const health = vi.fn(async () => ({
      providerVersion: "kuzu-safe", projectionSchemaVersion: "1", tokenizerVersion: "1", status: "healthy" as const,
      reasons: [], metrics: { documentCount: 2, indexSizeBytes: 12 }
    }));
    const store = { health } as unknown as WorkspaceLexicalStore;
    const result = await retrieveForQuestion({} as GraphDB, "orders", {
      publicGraphSnapshot: PUBLIC_GRAPH_SNAPSHOT,
      lexicalStore: store,
      config: { embedding: { provider: "off", level: "off" } } as never,
      dependencies: {
        now: () => tick++, plan: () => plan(),
        exact: async () => ({ exact: successfulRouteResult("exact", [], [], 2), contract: successfulRouteResult("contract", [], [], 3), entity: successfulRouteResult("entity", [], [], 4) }),
        lexical: async () => successfulRouteResult("lexical", [], [], 1),
        graph: async () => successfulRouteResult("graph", [], [], 2),
        semantic: async () => emptyRouteResult("semantic", "disabled", "provider-off")
      } as never
    });
    expect(health).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.timings).toMatchObject({
      planning: { status: "completed", durationMs: 1 }, exactContractEntity: { status: "completed", durationMs: 1 }, lexical: { status: "completed", durationMs: 1 },
      graphExpansion: { status: "completed", durationMs: 1 }, semantic: { status: "skipped", durationMs: 1 }, fusion: { status: "completed", durationMs: 1 }, selection: { status: "completed", durationMs: 1 },
      sourceLoading: { status: "skipped", durationMs: 1 }, total: { durationMs: 17 }
    });
    expect(result.diagnostics.queries).toEqual({ total: 12, byRoute: { exact: 2, contract: 3, entity: 4, lexical: 1, graph: 2, semantic: 0 }, dependencies: 0, sourceLoading: 0 });
    expect(result.diagnostics.sourceLoading).toEqual({ status: "skipped", reason: "no_loadable_documents", queryCount: 0, rejectionCounts: {} });
    expect(result.diagnostics.providers).toEqual({
      lexical: { status: "succeeded", providerVersion: "kuzu-safe", projectionSchemaVersion: "1", tokenizerVersion: "1", indexStatus: "healthy" },
      semantic: { status: "disabled" }
    });
    expect(Object.values(result.diagnostics.timings).every(({ durationMs }) => durationMs >= 0)).toBe(true);
  });

  it.each([
    ["disabled", "skipped"], ["unavailable", "unavailable"], ["unhealthy", "unhealthy"], ["failed", "failed"]
  ] as const)("maps lexical %s to a truthful %s stage", async (routeStatus, stageStatus) => {
    const lexicalResult = routeStatus === "disabled"
      ? emptyRouteResult("lexical", "disabled", "route-disabled")
      : emptyRouteResult("lexical", routeStatus, "test-status", { executed: routeStatus === "failed", queryCount: routeStatus === "failed" ? 1 : 0 });
    const result = await retrieveForQuestion({} as GraphDB, "orders", { publicGraphSnapshot: PUBLIC_GRAPH_SNAPSHOT, lexicalStore: { health: vi.fn(async () => ({
      providerVersion: "test", projectionSchemaVersion: "1", tokenizerVersion: "1", status: "healthy", reasons: [], metrics: { documentCount: 0, indexSizeBytes: 0 }
    })) } as unknown as WorkspaceLexicalStore, dependencies: {
      plan: () => routeStatus === "disabled" ? { ...plan(), enabledRoutes: plan().enabledRoutes.filter((route) => route !== "lexical") } : plan(),
      exact: async () => ({ exact: successfulRouteResult("exact", [], [], 0), contract: successfulRouteResult("contract", [], [], 0), entity: successfulRouteResult("entity", [], [], 0) }),
      lexical: async () => lexicalResult,
      graph: async () => emptyRouteResult("graph", "disabled", "no-seeds"), semantic: async () => emptyRouteResult("semantic", "disabled", "provider-off")
    } as never });
    expect(result.diagnostics.timings.lexical.status).toBe(stageStatus);
  });

  it("locks outcome transitions while disabled routes do not degrade results", () => {
    const success = successfulRouteResult("exact", [], [], 1);
    const disabled = emptyRouteResult("semantic", "disabled", "provider-off");
    const failed = emptyRouteResult("lexical", "failed", "search-failed", { executed: true, queryCount: 1 });
    expect(determineRetrievalOutcome(1, [success, disabled])).toBe("succeeded");
    expect(determineRetrievalOutcome(1, [success, failed])).toBe("degraded");
    expect(determineRetrievalOutcome(0, [success, disabled])).toBe("no_results");
    expect(determineRetrievalOutcome(0, [disabled, failed])).toBe("failed");
  });

  it("reports semantic primary fallback and fails when no reliable evidence can be loaded", async () => {
    const semanticHit = candidatesFromSemanticResults([{
      nodeId: "code:repo:api:src/orders.ts:function:createOrder:1",
      nodeKind: "Code",
      repoId: "repo:api",
      title: "createOrder",
      sourceText: "createOrder",
      sourceHash: "hash",
      updatedAt: "now",
      score: 0.9
    }])[0]!;
    const semantic = Object.freeze({
      ...successfulRouteResult("semantic", [semanticHit], [], 2),
      status: "unhealthy" as const,
      reason: "primary-provider-failed",
      providerMetadata: Object.freeze({
        primaryProvider: "chroma",
        effectiveProvider: "json",
        fallbackUsed: true,
        fallbackReason: "primary-search-failed" as const,
        primaryStatus: "failed" as const
      })
    });
    const result = await retrieveForQuestion({} as GraphDB, "orders", {
      publicGraphSnapshot: PUBLIC_GRAPH_SNAPSHOT,
      config: { embedding: { provider: "test", level: "file" } } as never,
      dependencies: {
        plan: () => plan(),
        exact: async () => ({ exact: successfulRouteResult("exact", [], [], 0), contract: successfulRouteResult("contract", [], [], 0), entity: successfulRouteResult("entity", [], [], 0) }),
        lexical: async () => emptyRouteResult("lexical", "disabled", "test"),
        graph: async () => emptyRouteResult("graph", "disabled", "test"),
        semantic: async () => semantic
      } as never
    });

    expect(result.outcome).toBe("failed");
    expect(result.diagnostics.routes.semantic).toMatchObject({ status: "unhealthy", reason: "primary-provider-failed", queryCount: 2 });
    expect(result.diagnostics.queries.byRoute.semantic).toBe(2);
    expect(result.diagnostics.queries.total).toBe(2);
    expect(result.diagnostics.timings.semantic.status).toBe("unhealthy");
    expect(result.diagnostics.providers.semantic).toEqual({
      status: "unhealthy",
      provider: "test",
      primaryProvider: "chroma",
      effectiveProvider: "json",
      fallbackUsed: true,
      fallbackReason: "primary-search-failed",
      primaryStatus: "failed"
    });
  });
});
