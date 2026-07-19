import { describe, expect, it } from "vitest";
import { buildAnswerContext } from "../src/features/ask/context.js";
import type { RetrievalResult } from "../src/features/ask/retrieve.js";

const retrievalExtensions: Pick<RetrievalResult, "fusedCandidates" | "selectedCandidates" | "diagnostics" | "outcome"> = {
  fusedCandidates: [], selectedCandidates: [], outcome: "no_results",
  diagnostics: {
    routes: Object.fromEntries(["exact", "contract", "entity", "lexical", "graph", "semantic"].map((route) => [route, { status: "disabled", reason: "fixture", executed: false, queryCount: 0 }])) as RetrievalResult["diagnostics"]["routes"],
    timings: {
      planning: { status: "completed", durationMs: 0 }, exactContractEntity: { status: "completed", durationMs: 0 },
      lexical: { status: "skipped", durationMs: 0 }, graphExpansion: { status: "skipped", durationMs: 0 }, semantic: { status: "skipped", durationMs: 0 },
      fusion: { status: "completed", durationMs: 0 }, selection: { status: "completed", durationMs: 0 }, sourceLoading: { status: "not_run", durationMs: 0 }, total: { status: "completed", durationMs: 0 }
    },
    queries: { total: 0, byRoute: { exact: 0, contract: 0, entity: 0, lexical: 0, graph: 0, semantic: 0 }, dependencies: 0 },
    compatibility: { dependencies: { status: "disabled", reason: "fixture", executed: false, queryCount: 0 } },
    providers: { lexical: { status: "disabled" }, semantic: { status: "disabled" } }
  }
};

describe("RAG answer context", () => {
  it("keeps high-confidence evidence first when context budget is low", () => {
    const retrieval: RetrievalResult = {
      ...retrievalExtensions,
      questionKind: "dependency",
      code: Array.from({ length: 10 }, (_, index) => ({
        repoName: "repo-a",
        filePath: `src/noise-${index}.ts`,
        codeId: `code:noise-${index}`,
        kind: "function",
        name: `noise${index}`,
        qualifiedName: `noise${index}`,
        summary: "low priority",
        signature: `function noise${index}()`
      })),
      sections: [],
      entities: [],
      contracts: [{
        contractId: "contract:api:/orders",
        kind: "api",
        key: "/orders",
        name: "/orders",
        role: "consumer",
        repoName: "consumer",
        filePath: "src/client.ts",
        line: 12,
        raw: "client.get('/orders')",
        rule: "http-client-api-consumer",
        confidence: 0.95,
        resolution: "exact"
      }],
      dependencies: [],
      semantic: [],
      edges: []
    };

    const context = buildAnswerContext(retrieval, { maxContextChars: 1200, maxItemChars: 500 });
    expect(context.items[0]?.kind).toBe("contract");
    expect(context.citations[0]).toEqual(expect.objectContaining({ id: "C1", filePath: "src/client.ts", line: 12 }));
    expect(context.budget.includedItems).toBeLessThan(context.budget.totalItems);
  });
});
