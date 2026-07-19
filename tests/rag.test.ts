import { describe, expect, it, vi } from "vitest";
import { planQuestion } from "../src/features/ask/planner.js";
import { compatibilityEntityTargets, retrieveForQuestion } from "../src/features/ask/retrieve.js";
import { scoreCallResolution } from "../src/core/extraction/resolveReferences.js";
import { chunk } from "../src/shared/chunk.js";
import { BRAND } from "../src/shared/branding.js";

describe("rag helpers", () => {
  it.each([
    ["What is the impact of this ref?", "impact"],
    ["Which code is involved in the order creation flow?", "workflow"],
    ["Where is this class defined?", "symbol"],
    ["Show package dependencies", "dependency"],
    ["Debug this exception", "debugging"],
    ["Explain this repository", "general"]
  ] as const)("keeps question kind compatibility for %s", (question, kind) => {
    expect(planQuestion(question).kind).toBe(kind);
  });

  it("scores call resolution candidates", () => {
    expect(scoreCallResolution({ sameFile: true, imported: false, sameRepo: true, nameExact: true })).toBeGreaterThan(0.7);
  });

  it.each([
    "How does Order workflow work?",
    "Explain the Order workflow"
  ])("prioritizes the wrapped entity name for compatibility retrieval: %s", async (question) => {
    expect(compatibilityEntityTargets(planQuestion(question))[0]).toBe("Order");
    const tracedTerms: string[] = [];
    const db = {
      async query(sql: string, params?: Record<string, unknown>) {
        const entityTerms = Array.isArray(params?.values) ? params.values.filter((value): value is string => typeof value === "string") : [];
        if (entityTerms.length > 0 && (sql.includes("(e:Entity)") || sql.includes("PARTICIPATES_IN"))) tracedTerms.push(...entityTerms);
        if (sql.includes("PARTICIPATES_IN") && !sql.includes("WORKFLOW_STEP") && entityTerms.includes("order")) {
          return [{
            entityId: "entity:order", entityName: "Order", repoName: "orders", sourceKind: "operation",
            name: "create", filePath: "", line: 0, role: "producer", evidence: "creates orders", confidence: 1
          }];
        }
        return [];
      }
    };
    const retrieval = await retrieveForQuestion(db as never, question);
    expect(retrieval.entities).toEqual([expect.objectContaining({ entityName: "Order", sourceKind: "operation" })]);
    expect(new Set(tracedTerms)).toEqual(new Set(["order"]));
  });

  it("chunks arrays", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it("traces API contracts mentioned directly in questions", async () => {
    const queries: string[] = [];
    const db = {
      async query(sql: string, params?: Record<string, unknown>) {
        queries.push(sql);
        if (sql.includes("MATCH (c:Contract) WHERE c.kind = $kind AND c.key = $key")) {
          expect(params).toMatchObject({ kind: "api", key: "/smart/backorder" });
          return [{ id: "contract:api:/smart/backorder" }];
        }
        if (sql.includes("OWNS_PACKAGE") || sql.includes("PRODUCES") || sql.includes("CONSUMES") || sql.includes("SHARES_CONTRACT")) {
          if (sql.includes("PRODUCES")) {
            return [{
              contractId: "contract:api:/smart/backorder",
              kind: "api",
              key: "/smart/backorder",
              name: "/smart/backorder",
              role: "producer",
              repoName: "his-backend",
              filePath: "SmartBackorderController.java",
              line: 49,
              raw: '@RequestMapping("/smart/backorder")',
              rule: "spring-request-mapping-producer",
              confidence: 0.9
            }];
          }
          if (sql.includes("CONSUMES")) {
            return [{
              contractId: "contract:api:/smart/backorder",
              kind: "api",
              key: "/smart/backorder",
              name: "/smart/backorder",
              role: "consumer",
              repoName: "his-fontend",
              filePath: "src/api/smart/back_order.js",
              line: 30,
              raw: "request({ url: '/smart/backorder'",
              rule: "http-client-object-url-consumer",
              confidence: 0.85
            }];
          }
        }
        return [];
      }
    };

    const retrieval = await retrieveForQuestion(db as never, "Who calls /smart/backorder?", {
      config: {
        embedding: { level: "off", model: "test", apiKey: "", baseUrl: "" },
        semantic: { provider: "json", jsonPath: `${BRAND.configDirName}/test-semantic-index.json` }
      } as never
    });

    expect(retrieval.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ repoName: "his-backend", role: "producer", key: "/smart/backorder" }),
      expect.objectContaining({ repoName: "his-fontend", role: "consumer", key: "/smart/backorder" })
    ]));
    expect(queries.some((sql) => sql.includes("MATCH (c:Contract) WHERE c.kind = $kind AND c.key = $key"))).toBe(true);
  });

  it("degrades gracefully without warning when the configured embedding provider is unregistered", async () => {
    const db = { async query() { return []; } };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const retrieval = await retrieveForQuestion(db as never, "anything?", {
      config: {
        embedding: { level: "file", provider: "does-not-exist" },
        semantic: { provider: "json", jsonPath: `${BRAND.configDirName}/test-missing-provider-index.json` }
      } as never
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(retrieval.semantic).toEqual([]);
    warnSpy.mockRestore();
  });
});
