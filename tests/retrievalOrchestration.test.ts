import { describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import type { WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";
import { WorkspaceLexicalStoreError } from "../src/core/retrieval/provider.js";
import type { LexicalIndexHealth } from "../src/core/retrieval/types.js";
import type { LexicalDocument } from "../src/core/retrieval/types.js";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
import { lexicalDocumentId } from "../src/core/retrieval/projection.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { candidatesFromCodeRows, candidatesFromContractRows, candidatesFromLexicalHits, createRetrievalCandidate } from "../src/features/ask/candidates.js";
import { reciprocalRankFusion } from "../src/features/ask/fusion.js";
import type { QueryPlan } from "../src/features/ask/planner.js";
import { retrieveForQuestion as retrieveForQuestionCore } from "../src/features/ask/retrieve.js";
import { emptyRouteResult, RetrieverOperationalError, successfulRouteResult } from "../src/features/ask/retrievers/types.js";
import { DEFAULT_RETRIEVE_OPTIONS } from "../src/features/ask/options.js";

const HEALTH: LexicalIndexHealth = {
  providerVersion: "test-1", projectionSchemaVersion: "1", tokenizerVersion: "1",
  status: "healthy", reasons: [], metrics: { documentCount: 2, indexSizeBytes: 20 }
};
const READ_SNAPSHOT = Object.freeze({
  workspaceId: deriveWorkspaceId("default-system"),
  generation: "generation:test",
  revision: "generation:test"
});

function retrieveForQuestion(
  db: GraphDB,
  question: string,
  options: Parameters<typeof retrieveForQuestionCore>[2] = {}
): ReturnType<typeof retrieveForQuestionCore> {
  return retrieveForQuestionCore(db, question, {
    ...options,
    publicGraphSnapshot: options.publicGraphSnapshot ?? READ_SNAPSHOT
  });
}

function plan(): QueryPlan {
  return {
    kind: "general", terms: ["Order"], exactIdentifiers: ["Order"], paths: [], contractTargets: [],
    normalizedLexicalQuery: "Order workflow",
    enabledRoutes: ["exact", "contract", "entity", "lexical", "graph", "semantic"],
    budgets: { exact: { limit: 5 }, contract: { limit: 5 }, entity: { limit: 5 }, lexical: { limit: 5 }, graph: { limit: 5 }, semantic: { limit: 5 } }
  };
}

function candidate(route: "exact" | "lexical" | "graph", canonicalId: string) {
  const workspaceId = deriveWorkspaceId("default-system");
  const renderRef = createRenderRef({ workspaceId, repoId: "repo:a", kind: "code", canonicalId, fileId: `file:${canonicalId}`, path: `src/${route}.ts` });
  return createRetrievalCandidate({
    canonicalId, repoId: "repo:a", kind: "code",
    routes: [{ route, rank: 1, documentIds: [`doc:${canonicalId}`] }],
    provenance: [{ route, rank: 1, confidence: route === "lexical" ? "corroborated" : "exact", documentId: `doc:${canonicalId}`, renderRef }],
    matchReasons: route === "lexical" ? ["exact-identifier"] : [route],
    confidence: route === "lexical" ? "corroborated" : "exact"
  });
}

function store(order: string[]): WorkspaceLexicalStore {
  return {
    health: vi.fn(async () => { order.push("lexical-health"); return HEALTH; }),
    pendingHealth: vi.fn(async () => HEALTH),
    loadDocuments: vi.fn(async ({ workspaceId, documentIds }: { workspaceId: string; documentIds: readonly string[] }) => {
      order.push("source-loading");
      return documentIds.map((id): LexicalDocument => {
        const canonicalId = id.slice("doc:".length);
        const route = canonicalId.includes("repo:b") ? "lexical" : canonicalId.includes("repo:c") ? "graph" : "exact";
        const renderRef = createRenderRef({ workspaceId, repoId: "repo:a", kind: "code", canonicalId, fileId: `file:${canonicalId}`, path: `src/${route}.ts` });
        return { id, canonicalId, workspaceId, repoId: "repo:a", kind: "code", title: canonicalId, path: `src/${route}.ts`, searchableText: canonicalId, tokens: [], active: true, sourceHash: "hash", batchId: "batch", renderRef };
      });
    }),
    search: vi.fn(), ensureSchema: vi.fn(), commitVersions: vi.fn(), initializeGeneration: vi.fn(),
    deleteGeneration: vi.fn(), upsertDocuments: vi.fn(), deleteDocuments: vi.fn(),
    reconcileRepoDocuments: vi.fn(), reconcileRepoFileDocuments: vi.fn(), cleanupBatch: vi.fn()
  } as unknown as WorkspaceLexicalStore;
}

describe("Ask retrieval orchestration", () => {
  it("applies route switches, topK, graph hops zero, and context budget consistently", async () => {
    const lexical = vi.fn();
    const graph = vi.fn();
    const semantic = vi.fn();
    const selection = vi.fn(() => ({
      selectedCandidates: [], rejections: [], estimatedChars: 0, contextCharBudget: 512,
    }));
    const sourceLoader = vi.fn(async ({ selectedCandidates }) => ({
      evidence: selectedCandidates, rejections: [], status: "skipped" as const, queryCount: 0,
    }));
    const result = await retrieveForQuestion({} as GraphDB, "Order", {
      retrieval: { ...DEFAULT_RETRIEVE_OPTIONS, lexical: false, semantic: false, topK: 1, graphHops: 0, contextBudget: 512 },
      dependencies: {
        plan,
        exact: async () => ({
          exact: successfulRouteResult("exact", [candidate("exact", "code:repo:a:src/a.ts:function:Order:1")], [], 1),
          contract: emptyRouteResult("contract", "disabled", "route-disabled"),
          entity: emptyRouteResult("entity", "disabled", "route-disabled"),
        }),
        lexical, graph, semantic, selection: selection as never, sourceLoader: sourceLoader as never,
      },
    });
    expect(lexical).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
    expect(semantic).not.toHaveBeenCalled();
    expect(selection).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ maxCandidates: 1, maxContextChars: 512 }));
    expect(result.diagnostics.routes.lexical).toMatchObject({ status: "disabled", queryCount: 0 });
    expect(result.diagnostics.routes.semantic).toMatchObject({ status: "disabled", queryCount: 0 });
    expect(result.diagnostics.routes.graph).toMatchObject({ status: "disabled", queryCount: 0 });
  });

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
    expect(order).toEqual(["plan", "exact-contract-entity", "lexical-health", "lexical-search", "graph", "semantic", "fusion", "source-loading"]);
    expect(fusion).toHaveBeenCalledTimes(1);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(result.selectedCandidates).toEqual(result.fusedCandidates);
    expect(result.loadedEvidence).toHaveLength(3);
    expect(result.diagnostics.queries.sourceLoading).toBe(1);
    expect(result.outcome).toBe("succeeded");
  });

  it("loads real exact-only evidence and fuses exact+lexical provenance without false degradation", async () => {
    const workspaceId = deriveWorkspaceId("default-system");
    const canonicalId = "code:repo:alpha:src/Order.ts:class:Order:1";
    const documentId = lexicalDocumentId(workspaceId, "repo:alpha", "code", canonicalId);
    const documentRenderRef = createRenderRef({
      workspaceId, repoId: "repo:alpha", kind: "code", canonicalId,
      fileId: "file:repo:alpha:src/Order.ts", path: "src/Order.ts", startLine: 1, endLine: 8
    });
    const document: LexicalDocument = {
      id: documentId, canonicalId, workspaceId, repoId: "repo:alpha", kind: "code", title: "Order",
      path: "src/Order.ts", searchableText: "class Order", tokens: ["order"], active: true,
      sourceHash: "hash", batchId: "batch", renderRef: documentRenderRef
    };
    const exactCandidate = candidatesFromCodeRows([{
      repoName: "alpha", filePath: "src/Order.ts", codeId: canonicalId, kind: "class", name: "Order",
      qualifiedName: "Order", summary: "", signature: "class Order"
    }], workspaceId)[0]!;
    const lexicalCandidate = candidatesFromLexicalHits([{
      canonicalId, documentId, repoId: "repo:alpha", kind: "code", rank: 1,
      matchReasons: ["title"], renderRef: documentRenderRef
    }], workspaceId)[0]!;
    const loadDocuments = vi.fn(async () => [document]);
    const lexicalStore = {
      ...store([]),
      loadDocuments
    } as WorkspaceLexicalStore;
    const routes = (includeLexical: boolean) => ({
      plan: () => ({
        ...plan(),
        enabledRoutes: includeLexical ? ["exact", "lexical"] : ["exact"]
      }),
      exact: async () => ({
        exact: successfulRouteResult("exact", [exactCandidate], [], 1),
        contract: emptyRouteResult("contract", "disabled", "route-disabled"),
        entity: emptyRouteResult("entity", "disabled", "route-disabled")
      }),
      ...(includeLexical ? { lexical: async () => successfulRouteResult("lexical", [lexicalCandidate], [], 1) } : {}),
      graph: async () => emptyRouteResult("graph", "disabled", "route-disabled"),
      semantic: async () => emptyRouteResult("semantic", "disabled", "route-disabled")
    });

    const exactOnly = await retrieveForQuestion({} as GraphDB, "Order", { lexicalStore, dependencies: routes(false) as never });
    expect(exactOnly.selectedCandidates).toHaveLength(1);
    expect(exactOnly.loadedEvidence).toHaveLength(1);
    expect(exactOnly.sourceLoadRejections).toEqual([]);
    expect(exactOnly.outcome).toBe("succeeded");

    const fused = await retrieveForQuestion({} as GraphDB, "Order", { lexicalStore, dependencies: routes(true) as never });
    expect(fused.selectedCandidates).toHaveLength(1);
    expect(fused.selectedCandidates[0]?.routes.map(({ route }) => route)).toEqual(["exact", "lexical"]);
    expect(fused.loadedEvidence).toHaveLength(1);
    expect(fused.sourceLoadRejections).toEqual([]);
    expect(fused.outcome).toBe("succeeded");
    expect(loadDocuments).toHaveBeenCalledTimes(2);
  });

  it("loads resolved contract-only evidence using the projection evidence discriminator", async () => {
    const workspaceId = deriveWorkspaceId("default-system");
    const canonicalId = "contract:api:post-orders";
    const evidenceId = "evidence:post-orders";
    const documentId = lexicalDocumentId(workspaceId, "repo:alpha", "contract", canonicalId, evidenceId);
    const renderRef = createRenderRef({
      workspaceId, repoId: "repo:alpha", kind: "contract", canonicalId,
      fileId: "file:repo:alpha:src/routes.ts", path: "src/routes.ts", startLine: 12
    });
    const document: LexicalDocument = {
      id: documentId, canonicalId, workspaceId, repoId: "repo:alpha", kind: "contract", title: "POST /orders",
      path: "src/routes.ts", searchableText: "POST /orders producer route", tokens: ["post", "orders"], active: true,
      sourceHash: "hash", batchId: "batch", renderRef
    };
    const contractCandidate = candidatesFromContractRows([{
      contractId: canonicalId, kind: "api", key: "POST:/orders", name: "POST /orders", role: "producer",
      repoName: "alpha", filePath: "src/routes.ts", line: 12, evidenceId,
      raw: "router.post('/orders')", rule: "express-route", confidence: 0.95, resolution: "exact"
    }], workspaceId)[0]!;
    const loadDocuments = vi.fn(async ({ documentIds }: { documentIds: readonly string[] }) => {
      expect(documentIds).toEqual([documentId]);
      return [document];
    });
    const result = await retrieveForQuestion({} as GraphDB, "POST /orders", {
      lexicalStore: { ...store([]), loadDocuments } as WorkspaceLexicalStore,
      dependencies: {
        plan: () => ({ ...plan(), enabledRoutes: ["contract"] }),
        exact: async () => ({
          exact: emptyRouteResult("exact", "disabled", "route-disabled"),
          contract: successfulRouteResult("contract", [contractCandidate], [], 1),
          entity: emptyRouteResult("entity", "disabled", "route-disabled")
        }),
        graph: async () => emptyRouteResult("graph", "disabled", "route-disabled"),
        semantic: async () => emptyRouteResult("semantic", "disabled", "route-disabled")
      } as never
    });
    expect(result.selectedCandidates).toHaveLength(1);
    expect(result.loadedEvidence).toHaveLength(1);
    expect(result.sourceLoadRejections).toEqual([]);
    expect(result.outcome).toBe("succeeded");
    expect(loadDocuments).toHaveBeenCalledTimes(1);
  });

  it("anchors structured contract queries to exact and graph evidence only", async () => {
    const workspaceId = deriveWorkspaceId("default-system");
    const exactCandidate = candidate("exact", "code:repo:a:src/explicit.ts:function:CreateActivity:1");
    const lexicalCandidate = candidate("lexical", "code:repo:a:src/unrelated.ts:function:createActivity:1");
    const graphCandidate = candidate("graph", "code:repo:a:src/implementation.ts:function:createActivity:1");
    const contractCandidate = candidatesFromContractRows([{
      contractId: "contract:api:post-create-activity",
      kind: "api",
      key: "POST:/mall/mgr/groupon/activity/createActivity",
      name: "POST /mall/mgr/groupon/activity/createActivity",
      role: "consumer",
      repoName: "a",
      filePath: "src/api.ts",
      line: 12,
      evidenceId: "evidence:create-activity",
      raw: "createActivity(payload)",
      rule: "http-client",
      confidence: 0.95,
      resolution: "exact"
    }], workspaceId)[0]!;
    const strictPlan: QueryPlan = {
      ...plan(),
      kind: "general",
      exactIdentifiers: ["CreateActivity"],
      contractTargets: [{ kind: "api", value: "/mall/mgr/groupon/activity/createActivity" }]
    };
    const lexical = vi.fn(async () => successfulRouteResult("lexical", [lexicalCandidate], [], 1));
    const semantic = vi.fn(async () => successfulRouteResult("semantic", [], [], 1));
    const graph = vi.fn(async (_db, _plan, seeds) => {
      expect(seeds).toEqual([exactCandidate, contractCandidate]);
      return successfulRouteResult("graph", [graphCandidate], [], 1);
    });
    const sourceLoader = vi.fn(async ({ selectedCandidates }) => ({
      evidence: selectedCandidates,
      rejections: [],
      status: "completed" as const,
      queryCount: selectedCandidates.length > 0 ? 1 : 0
    }));

    const result = await retrieveForQuestion({} as GraphDB, "api:/mall/mgr/groupon/activity/createActivity", {
      dependencies: {
        plan: () => strictPlan,
        exact: async (_db, exactPlan) => {
          expect(exactPlan.enabledRoutes).toEqual(["exact", "contract", "graph"]);
          return {
            exact: successfulRouteResult("exact", [exactCandidate], [], 1),
            contract: successfulRouteResult("contract", [contractCandidate], [], 1),
            entity: emptyRouteResult("entity", "disabled", "route-disabled")
          };
        },
        lexical,
        graph: graph as never,
        semantic,
        sourceLoader: sourceLoader as never
      }
    });

    expect(lexical).not.toHaveBeenCalled();
    expect(semantic).not.toHaveBeenCalled();
    expect(graph).toHaveBeenCalledOnce();
    expect(new Set(result.fusedCandidates.map(({ canonicalId }) => canonicalId))).toEqual(new Set([
      exactCandidate.canonicalId,
      contractCandidate.canonicalId,
      graphCandidate.canonicalId
    ]));
    expect(result.fusedCandidates.some(({ canonicalId }) => canonicalId === lexicalCandidate.canonicalId)).toBe(false);
    expect(result.diagnostics.routes.lexical).toMatchObject({ status: "disabled", reason: "route-disabled" });
    expect(result.diagnostics.routes.entity).toMatchObject({ status: "disabled", reason: "route-disabled" });
    expect(result.diagnostics.routes.semantic).toMatchObject({ status: "disabled", reason: "route-disabled" });
  });

  it("returns no candidates when a structured contract target cannot be resolved", async () => {
    const exactCandidate = candidate("exact", "code:repo:a:src/explicit.ts:function:CreateActivity:1");
    const graph = vi.fn(async (_db, _plan, seeds) => {
      expect(seeds).toEqual([]);
      return emptyRouteResult("graph", "disabled", "no-eligible-seeds");
    });
    const sourceLoader = vi.fn(async ({ selectedCandidates }) => ({
      evidence: selectedCandidates,
      rejections: [],
      status: "skipped" as const,
      queryCount: 0
    }));
    const strictPlan: QueryPlan = {
      ...plan(),
      kind: "general",
      contractTargets: [{ kind: "api", value: "/missing" }]
    };

    const result = await retrieveForQuestion({} as GraphDB, "api:/missing", {
      dependencies: {
        plan: () => strictPlan,
        exact: async () => ({
          exact: successfulRouteResult("exact", [exactCandidate], [], 1),
          contract: successfulRouteResult("contract", [], [], 1),
          entity: successfulRouteResult("entity", [], [], 0)
        }),
        graph: graph as never,
        sourceLoader: sourceLoader as never
      }
    });

    expect(graph).toHaveBeenCalledOnce();
    expect(result.fusedCandidates).toEqual([]);
    expect(result.selectedCandidates).toEqual([]);
    expect(result.loadedEvidence).toEqual([]);
    expect(result.outcome).toBe("no_results");
  });

  it("keeps non-lexical routes and source loading available when the lexical gate is unhealthy", async () => {
    const workspaceId = deriveWorkspaceId("default-system");
    const canonicalId = "code:repo:alpha:src/Order.ts:class:Order:1";
    const exactCandidate = candidate("exact", canonicalId);
    const lexicalStore = store([]);
    const lexical = vi.fn();
    const graph = vi.fn(async () => emptyRouteResult("graph", "disabled", "no-seeds"));
    const result = await retrieveForQuestion({} as GraphDB, "Order workflow", {
      lexicalStore,
      lexicalProviderGate: {
        configuredProvider: "auto",
        effectiveProvider: "test",
        workspaceId,
        generation: READ_SNAPSHOT.generation,
        status: "unavailable",
        reason: "index_unhealthy",
        reasonCodes: ["index_unhealthy"],
        capability: {
          scope: "workspace", updateConsistency: "synchronous",
          supportsFieldBoost: false, supportsPrefix: false
        },
        store: lexicalStore,
        health: { ...HEALTH, status: "unhealthy", reasons: ["fts_index_failed"] }
      },
      dependencies: {
        plan,
        exact: async () => ({
          exact: successfulRouteResult("exact", [exactCandidate], [], 1),
          contract: successfulRouteResult("contract", [], [], 1),
          entity: successfulRouteResult("entity", [], [], 1)
        }),
        lexical,
        graph: graph as never,
        semantic: async () => emptyRouteResult("semantic", "disabled", "provider-off")
      } as never
    });

    expect(lexical).not.toHaveBeenCalled();
    expect(graph).toHaveBeenCalledOnce();
    expect(result.diagnostics.routes.lexical).toMatchObject({
      status: "unavailable", reason: "index_unhealthy", queryCount: 0
    });
    expect(result.diagnostics.providers.lexical).toMatchObject({
      configuredProvider: "auto", effectiveProvider: "test", gateStatus: "unavailable",
      reasonCodes: ["index_unhealthy"], indexStatus: "unhealthy"
    });
    expect(result.selectedCandidates).toHaveLength(1);
    expect(result.loadedEvidence).toHaveLength(1);
    expect(result.loadedEvidence[0]?.document.workspaceId).toBe(workspaceId);
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

  it("classifies source-loading provider failures, counts the batch query, and rethrows programming errors", async () => {
    const lexicalCandidate = candidate("lexical", "code:orders");
    const dependencies = {
      plan: () => plan(),
      exact: async () => ({
        exact: successfulRouteResult("exact", [], [], 0), contract: successfulRouteResult("contract", [], [], 0), entity: successfulRouteResult("entity", [], [], 0)
      }),
      lexical: async () => successfulRouteResult("lexical", [lexicalCandidate], [], 1),
      graph: async () => emptyRouteResult("graph", "disabled", "test"),
      semantic: async () => emptyRouteResult("semantic", "disabled", "test")
    };
    const failedStore = store([]);
    failedStore.loadDocuments = vi.fn(async () => { throw new WorkspaceLexicalStoreError("load_failed", { operation: "loadDocuments" }); });
    const result = await retrieveForQuestion({} as GraphDB, "orders", { lexicalStore: failedStore, dependencies: dependencies as never });
    expect(result.outcome).toBe("failed");
    expect(result.loadedEvidence).toEqual([]);
    expect(result.diagnostics.timings.sourceLoading.status).toBe("failed");
    expect(result.diagnostics.queries.sourceLoading).toBe(1);
    expect(result.diagnostics.queries.total).toBe(2);
    expect(result.diagnostics.sourceLoading).toMatchObject({ status: "failed", reason: "provider_failed", queryCount: 1 });

    const brokenStore = store([]);
    brokenStore.loadDocuments = vi.fn(async () => { throw new Error("loader invariant"); });
    await expect(retrieveForQuestion({} as GraphDB, "orders", { lexicalStore: brokenStore, dependencies: dependencies as never })).rejects.toThrow("loader invariant");
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
