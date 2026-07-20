import { describe, expect, it, vi } from "vitest";
import {
  ASK_QUESTION_INPUT_SCHEMA,
  buildFreshnessMetadata,
  buildFreshnessNotice,
  buildWorkspaceHealthStatus,
  handleAskQuestion,
  loadWorkspaceHealthStatus,
  projectAskQuestionResponse,
} from "../src/interfaces/mcp/server.js";
import type { RetrievalResult } from "../src/features/ask/retrieve.js";

function retrieval(): RetrievalResult {
  const diagnostics = {
    routes: Object.fromEntries(["exact", "contract", "entity", "lexical", "graph", "semantic"].map((route) => [route, {
      status: route === "lexical" ? "succeeded" : "disabled", executed: route === "lexical", queryCount: route === "lexical" ? 1 : 0,
    }])),
    timings: Object.fromEntries(["planning", "exactContractEntity", "lexical", "graphExpansion", "semantic", "fusion", "selection", "sourceLoading", "total"].map((stage) => [stage, { status: "completed", durationMs: 1 }])),
    queries: { total: 2, byRoute: { exact: 0, contract: 0, entity: 0, lexical: 1, graph: 0, semantic: 0 }, dependencies: 0, sourceLoading: 1 },
    compatibility: { dependencies: { status: "disabled", reason: "not-required", executed: false, queryCount: 0 } },
    providers: { lexical: { status: "succeeded", providerVersion: "safe" }, semantic: { status: "disabled" } },
    sourceLoading: { status: "completed", queryCount: 1, rejectionCounts: {} },
  } as RetrievalResult["diagnostics"];
  return {
    questionKind: "general", code: [], sections: [], entities: [], contracts: [], dependencies: [], semantic: [], edges: [],
    fusedCandidates: [], selectedCandidates: [], selectionRejections: [], sourceLoadRejections: [],
    loadedEvidence: [{
      candidate: {
        canonicalId: "code:repo:api:src/orders.ts:function:createOrder:1", repoId: "repo:api", kind: "code",
        routes: [{ route: "lexical", rank: 1, documentIds: ["doc:1"] }], provenance: [],
        matchReasons: ["full-text"], confidence: "discovery", fusionScore: 0.5,
      },
      provenance: { route: "lexical", rank: 1, confidence: "discovery", documentId: "doc:1", renderRef: "safe-ref" },
      parsedRenderRef: {
        workspaceId: "workspace:test", repoId: "repo:api", kind: "code",
        canonicalId: "code:repo:api:src/orders.ts:function:createOrder:1", path: "src/orders.ts", startLine: 10, endLine: 20,
      },
      document: {
        id: "doc:1", canonicalId: "code:repo:api:src/orders.ts:function:createOrder:1", workspaceId: "workspace:test",
        repoId: "repo:api", kind: "code", title: "createOrder", path: "src/orders.ts",
        searchableText: "SECRET_BODY", tokens: ["SECRET_TOKEN"], active: true,
        sourceHash: "SECRET_HASH", batchId: "SECRET_BATCH", renderRef: "safe-ref",
      },
    }],
    diagnostics,
    outcome: "succeeded",
  } as unknown as RetrievalResult;
}

describe("MCP ask_question", () => {
  it("accepts default and all explicit public options", () => {
    expect(ASK_QUESTION_INPUT_SCHEMA.parse({ question: "orders" })).toEqual({ question: "orders" });
    expect(ASK_QUESTION_INPUT_SCHEMA.parse({
      question: " orders ", lexical: false, semantic: false, topK: 100, graphHops: 5, contextBudget: 65_536,
    })).toEqual({ question: "orders", lexical: false, semantic: false, topK: 100, graphHops: 5, contextBudget: 65_536 });
  });

  it.each([
    { question: "x", unknown: true }, { question: "x", topK: 0 }, { question: "x", topK: 101 },
    { question: "x", graphHops: -1 }, { question: "x", graphHops: 6 },
    { question: "x", contextBudget: 255 }, { question: "x", contextBudget: 65_537 },
    { question: "x", topK: 1.5 }, { question: "x", topK: Number.NaN },
    { question: "x", topK: Number.POSITIVE_INFINITY }, { question: "x", topK: "5" },
  ])("strictly rejects invalid input %#", (input) => {
    expect(ASK_QUESTION_INPUT_SCHEMA.safeParse(input).success).toBe(false);
  });

  it("passes options exactly, retrieves once, and returns only safe selected evidence", async () => {
    const retrieve = vi.fn(async () => retrieval());
    const response = await handleAskQuestion({ retrieve } as never, {
      question: "orders", lexical: false, semantic: false, topK: 3, graphHops: 0, contextBudget: 512,
    });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith("orders", { lexical: false, semantic: false, topK: 3, graphHops: 0, contextBudget: 512 });
    expect(response).toMatchObject({
      outcome: "succeeded",
      selectedEvidence: [{ documentId: "doc:1", repoId: "repo:api", sourceKind: "code", path: "src/orders.ts", startLine: 10, endLine: 20, confidence: "discovery" }],
      diagnostics: { queries: { total: 2 }, routes: { lexical: { queryCount: 1 } } },
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toMatch(/SECRET_BODY|SECRET_TOKEN|SECRET_HASH|SECRET_BATCH|searchableText|tokens|sourceHash|batchId/u);
    expect(response.diagnostics.providers.lexical).toEqual({ status: "succeeded" });
    expect(serialized).not.toMatch(/providerVersion|projectionSchemaVersion|tokenizerVersion|indexStatus/u);
  });

  it("projects disabled provider query counts and remains compatible with freshness notices", () => {
    const value = retrieval();
    const disabled = {
      ...value,
      diagnostics: {
        ...value.diagnostics,
        routes: {
          ...value.diagnostics.routes,
          lexical: { status: "disabled", reason: "route-disabled", executed: false, queryCount: 0 },
          semantic: { status: "disabled", reason: "route-disabled", executed: false, queryCount: 0 },
        },
      },
    } as RetrievalResult;
    expect(projectAskQuestionResponse(disabled).diagnostics.routes.lexical.queryCount).toBe(0);
    const metadata = buildFreshnessMetadata({
      pending: [], watcherActive: false, degradedReason: "watch failed",
      indexQueue: { running: false, pendingJobs: [] } as never,
    });
    expect(buildFreshnessNotice(metadata)).toContain("Freshness: stale");
  });
});

describe("MCP lexical health boundary", () => {
  const queue = { running: false, pendingJobs: [] } as never;
  const healthy = {
    configuredProvider: "auto", effectiveProvider: "kuzu", status: "ready" as const,
    reasonCodes: [], providerVersion: "0.11.3", projectionSchemaVersion: "1",
    tokenizerVersion: "1", indexStatus: "healthy" as const
  };
  const unhealthy = {
    configuredProvider: "auto", effectiveProvider: "kuzu", status: "unavailable" as const,
    reasonCodes: ["index_unhealthy" as const], providerVersion: "0.11.3",
    projectionSchemaVersion: "1", tokenizerVersion: "1", indexStatus: "unhealthy" as const
  };

  it.each([
    [false, healthy, ""],
    [true, healthy, "Freshness: stale"],
    [false, unhealthy, "Lexical search: unavailable"],
    [true, unhealthy, "Freshness: stale"]
  ] as const)("diagnoses graph stale=%s independently from lexical health", (stale, lexical, expected) => {
    const metadata = buildFreshnessMetadata({
      pending: stale ? [{ repoName: "api", path: "src/a.ts", firstSeenMs: 1, lastSeenMs: 2, indexing: false }] : [],
      watcherActive: true,
      indexQueue: queue,
      lexical
    });
    const notice = buildFreshnessNotice(metadata);
    expect(metadata.stale).toBe(stale);
    expect(metadata.lexical).toEqual(lexical);
    if (expected) expect(notice).toContain(expected);
    else expect(notice).toBe("");
    if (lexical.status === "unavailable") expect(notice).toContain("Lexical search: unavailable");
  });

  it("returns a complete safe status while ordinary notices remain compact", () => {
    const watchStatus = {
      active: false, degraded: false, degradedReason: null, partial: false, partialReasons: [],
      mode: "off", installedWatchers: 0, coveredRepos: [], uncoveredRepos: [], uncoveredPaths: [],
      pendingFiles: [], pausedRepos: [], indexQueue: queue,
      catchUp: { mode: "off", running: false, completed: true, failed: false, pendingRepos: [], completedRepos: [] }
    } as never;
    const full = buildWorkspaceHealthStatus(watchStatus, unhealthy);
    expect(full.lexical).toEqual(unhealthy);
    expect(full.lexical).toMatchObject({
      configuredProvider: "auto", effectiveProvider: "kuzu", providerVersion: "0.11.3",
      projectionSchemaVersion: "1", tokenizerVersion: "1", indexStatus: "unhealthy",
      reasonCodes: ["index_unhealthy"]
    });

    const notice = buildFreshnessNotice(buildFreshnessMetadata({
      pending: [], watcherActive: false, indexQueue: queue, lexical: unhealthy
    }));
    expect(notice).toBe("Lexical search: unavailable (index_unhealthy). Call logiclens_get_watch_status for full details.");
    expect(notice).not.toMatch(/providerVersion|projectionSchemaVersion|tokenizerVersion|indexStatus|bolt:|password/u);
  });

  it("passes explicit refresh through and exposes changed lexical health", async () => {
    const getLexicalProviderStatus = vi.fn()
      .mockResolvedValueOnce(unhealthy)
      .mockResolvedValueOnce(healthy);
    const getWatchStatus = vi.fn(() => ({ active: false, indexQueue: queue }));
    const client = { getLexicalProviderStatus, getWatchStatus } as never;
    expect((await loadWorkspaceHealthStatus(client)).lexical.status).toBe("unavailable");
    expect((await loadWorkspaceHealthStatus(client, undefined, { refresh: true })).lexical.status).toBe("ready");
    expect(getLexicalProviderStatus).toHaveBeenNthCalledWith(2, { refresh: true });
  });
});
