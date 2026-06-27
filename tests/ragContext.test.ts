import { describe, expect, it } from "vitest";
import { buildAnswerContext } from "../src/features/ask/context.js";
import type { RetrievalResult } from "../src/features/ask/retrieve.js";

describe("RAG answer context", () => {
  it("keeps high-confidence evidence first when context budget is low", () => {
    const retrieval: RetrievalResult = {
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
