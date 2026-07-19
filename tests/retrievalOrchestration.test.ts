import { describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import type { WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";
import type { LexicalIndexHealth } from "../src/core/retrieval/types.js";
import { createRetrievalCandidate } from "../src/features/ask/candidates.js";
import { reciprocalRankFusion } from "../src/features/ask/fusion.js";
import type { QueryPlan } from "../src/features/ask/planner.js";
import { retrieveForQuestion } from "../src/features/ask/retrieve.js";
import { emptyRouteResult, RetrieverOperationalError, successfulRouteResult } from "../src/features/ask/retrievers/types.js";

const HEALTH: LexicalIndexHealth = {
  providerVersion: "test-1", projectionSchemaVersion: "1", tokenizerVersion: "1",
  status: "healthy", reasons: [], metrics: { documentCount: 2, indexSizeBytes: 20 }
};

function plan(): QueryPlan {
  return {
    kind: "general", terms: ["Order"], exactIdentifiers: ["Order"], paths: [], contractTargets: [],
    normalizedLexicalQuery: "Order workflow",
    enabledRoutes: ["exact", "contract", "entity", "lexical", "graph", "semantic"],
    budgets: { exact: { limit: 5 }, contract: { limit: 5 }, entity: { limit: 5 }, lexical: { limit: 5 }, graph: { limit: 5 }, semantic: { limit: 5 } }
  };
}

function candidate(route: "exact" | "lexical" | "graph", canonicalId: string) {
  return createRetrievalCandidate({
    canonicalId, repoId: "repo:a", kind: "code",
    routes: [{ route, rank: 1, documentIds: [] }],
    matchReasons: route === "lexical" ? ["exact-identifier"] : [route],
    confidence: route === "lexical" ? "corroborated" : "exact"
  });
}

function store(order: string[]): WorkspaceLexicalStore {
  return {
    health: vi.fn(async () => { order.push("lexical-health"); return HEALTH; }),
    search: vi.fn(), ensureSchema: vi.fn(), commitVersions: vi.fn(), upsertDocuments: vi.fn(),
    reconcileRepoDocuments: vi.fn(), reconcileRepoFileDocuments: vi.fn(), cleanupBatch: vi.fn(), loadDocuments: vi.fn()
  } as unknown as WorkspaceLexicalStore;
}

describe("Ask retrieval orchestration", () => {
  it("runs routes in strict order, seeds graph from all preceding routes, and fuses once", async () => {
    const order: string[] = [];
    const exactCandidate = candidate("exact", "code:repo:a:src/a.ts:function:Order:1");
    const lexicalCandidate = candidate("lexical", "code:repo:b:src/b.ts:function:Order:1");
    const fusion = vi.fn((candidates) => { order.push("fusion"); return reciprocalRankFusion(candidates); });
    const graph = vi.fn(async (_db, _plan, seeds) => {
      order.push("graph");
      expect(seeds).toEqual([exactCandidate, lexicalCandidate]);
      return successfulRouteResult("graph", [candidate("graph", "code:repo:c:src/c.ts:function:Order:1")], [], 1);
    });
    const result = await retrieveForQuestion({} as GraphDB, "Order workflow", {
      lexicalStore: store(order),
      dependencies: {
        plan: () => { order.push("plan"); return plan(); },
        exact: async () => { order.push("exact-contract-entity"); return {
          exact: successfulRouteResult("exact", [exactCandidate], [], 1),
          contract: successfulRouteResult("contract", [], [], 1),
          entity: successfulRouteResult("entity", [], [], 1)
        }; },
        lexical: async () => { order.push("lexical-search"); return successfulRouteResult("lexical", [lexicalCandidate], [], 1); },
        graph: graph as never,
        semantic: async () => { order.push("semantic"); return emptyRouteResult("semantic", "disabled", "provider-off"); },
        fusion
      }
    });
    expect(order).toEqual(["plan", "exact-contract-entity", "lexical-health", "lexical-search", "graph", "semantic", "fusion"]);
    expect(fusion).toHaveBeenCalledTimes(1);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(result.selectedCandidates).toEqual(result.fusedCandidates);
    expect(result.outcome).toBe("succeeded");
  });

  it("rethrows ordinary programming errors and only degrades typed operational failures", async () => {
    const order: string[] = [];
    const dependencies = {
      plan: () => plan(),
      exact: async () => ({
        exact: successfulRouteResult("exact", [], [], 0), contract: successfulRouteResult("contract", [], [], 0), entity: successfulRouteResult("entity", [], [], 0)
      }),
      lexical: async () => { order.push("lexical"); return successfulRouteResult("lexical", [], [], 1); },
      graph: async () => { order.push("graph"); throw new RetrieverOperationalError("graph", 2, "query-failed", { cause: new Error("secret=hidden") }); },
      semantic: async () => { order.push("semantic"); return emptyRouteResult("semantic", "disabled", "provider-off"); }
    };
    const result = await retrieveForQuestion({} as GraphDB, "Order workflow", { lexicalStore: store(order), dependencies: dependencies as never });
    expect(order).toEqual(["lexical-health", "lexical", "graph", "semantic"]);
    expect(result.diagnostics.routes.graph).toMatchObject({ status: "failed", reason: "query-failed", executed: true, queryCount: 2 });
    expect(JSON.stringify(result.diagnostics)).not.toContain("secret");

    await expect(retrieveForQuestion({} as GraphDB, "x", { dependencies: { plan: () => plan(), exact: async () => { throw new Error("invariant failed"); } } })).rejects.toThrow("invariant failed");
    await expect(retrieveForQuestion({} as GraphDB, "x", { dependencies: { plan: () => plan(), exact: async () => ({
      exact: successfulRouteResult("exact", [], [], 0), contract: successfulRouteResult("contract", [], [], 0), entity: successfulRouteResult("entity", [], [], 0)
    }), fusion: () => { throw new Error("fusion bug"); } } })).rejects.toThrow("fusion bug");
  });

  it("keeps lexical disabled when the plan does not enable it even if store resolution failed", async () => {
    const disabledPlan = { ...plan(), normalizedLexicalQuery: "", enabledRoutes: [] };
    const result = await retrieveForQuestion({} as GraphDB, "", {
      lexicalStoreUnavailable: true,
      dependencies: {
        plan: () => disabledPlan,
        exact: async () => ({
          exact: emptyRouteResult("exact", "disabled", "route-disabled"),
          contract: emptyRouteResult("contract", "disabled", "route-disabled"),
          entity: emptyRouteResult("entity", "disabled", "route-disabled")
        }),
        graph: async () => emptyRouteResult("graph", "disabled", "route-disabled"),
        semantic: async () => emptyRouteResult("semantic", "disabled", "route-disabled")
      } as never
    });
    expect(result.diagnostics.routes.lexical).toMatchObject({ status: "disabled", reason: "route-disabled", executed: false, queryCount: 0 });
    expect(result.diagnostics.timings.lexical.status).toBe("skipped");
    expect(result.outcome).toBe("no_results");
  });

  it("deduplicates and caps legacy code and section compatibility rows", async () => {
    const codeRows = Array.from({ length: 21 }, (_, index) => ({ codeId: `code:${index}`, repoName: "repo", filePath: `src/${index}.ts`, kind: "function", name: `f${index}`, qualifiedName: `f${index}`, summary: "", signature: "" }));
    const sectionRows = Array.from({ length: 21 }, (_, index) => ({ sectionId: `section:${index}`, repoName: "repo", filePath: `docs/${index}.md`, heading: `H${index}`, level: 1, startLine: 1, endLine: 1, summary: "", text: "" }));
    const result = await retrieveForQuestion({} as GraphDB, "x", { dependencies: {
      plan: () => plan(),
      exact: async () => ({
        exact: successfulRouteResult("exact", [], [{ kind: "code", row: codeRows[0]! }, { kind: "section", row: sectionRows[0]! }], 1),
        contract: successfulRouteResult("contract", [], [], 0), entity: successfulRouteResult("entity", [], [], 0)
      }),
      lexical: async () => emptyRouteResult("lexical", "unavailable", "provider-unavailable"),
      graph: async () => successfulRouteResult("graph", [], [
        ...codeRows.map((row) => ({ kind: "implementation" as const, row })),
        ...sectionRows.map((row) => ({ kind: "section" as const, row }))
      ], 1),
      semantic: async () => emptyRouteResult("semantic", "disabled", "provider-off")
    } as never });
    expect(result.code).toHaveLength(20);
    expect(new Set(result.code.map(({ codeId }) => codeId)).size).toBe(20);
    expect(result.sections).toHaveLength(20);
    expect(new Set(result.sections.map(({ sectionId }) => sectionId)).size).toBe(20);
  });

  it("diagnoses typed compatibility dependency failures and propagates ordinary errors", async () => {
    const dependencyPlan = { ...plan(), kind: "dependency" as const, enabledRoutes: [] };
    const baseDependencies = {
      plan: () => dependencyPlan,
      exact: async () => ({
        exact: emptyRouteResult("exact", "disabled", "route-disabled"),
        contract: emptyRouteResult("contract", "disabled", "route-disabled"),
        entity: emptyRouteResult("entity", "disabled", "route-disabled")
      }),
      graph: async () => emptyRouteResult("graph", "disabled", "route-disabled"),
      semantic: async () => emptyRouteResult("semantic", "disabled", "route-disabled")
    };
    const result = await retrieveForQuestion({} as GraphDB, "dependencies", { dependencies: {
      ...baseDependencies,
      dependencies: async () => { throw new RetrieverOperationalError("graph", 1, "dependency-query-failed"); }
    } as never });
    expect(result.dependencies).toEqual([]);
    expect(result.diagnostics.compatibility.dependencies).toEqual({
      status: "failed", reason: "dependency-query-failed", executed: true, queryCount: 1
    });
    expect(result.diagnostics.queries.dependencies).toBe(1);
    expect(result.outcome).toBe("failed");

    await expect(retrieveForQuestion({} as GraphDB, "dependencies", { dependencies: {
      ...baseDependencies,
      dependencies: async () => { throw new Error("dependency invariant failed"); }
    } as never })).rejects.toThrow("dependency invariant failed");
  });
});
