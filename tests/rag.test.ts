import { describe, expect, it, vi } from "vitest";
import { planQuestion } from "../src/rag/planner.js";
import { retrieveForQuestion } from "../src/rag/retrieve.js";
import { scoreCallResolution } from "../src/core/extraction/resolveReferences.js";
import { chunk } from "../src/shared/chunk.js";

describe("rag helpers", () => {
  it("detects workflow questions", () => {
    expect(planQuestion("Which code is involved in the order creation flow?").kind).toBe("workflow");
  });

  it("scores call resolution candidates", () => {
    expect(scoreCallResolution({ sameFile: true, imported: false, sameRepo: true, nameExact: true })).toBeGreaterThan(0.7);
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
        semantic: { provider: "json", jsonPath: ".logiclens/test-semantic-index.json" }
      } as never
    });

    expect(retrieval.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ repoName: "his-backend", role: "producer", key: "/smart/backorder" }),
      expect.objectContaining({ repoName: "his-fontend", role: "consumer", key: "/smart/backorder" })
    ]));
    expect(queries.some((sql) => sql.includes("MATCH (c:Contract) WHERE c.kind = $kind AND c.key = $key"))).toBe(true);
  });

  it("warns and degrades gracefully when the configured embedding provider is unregistered", async () => {
    const db = { async query() { return []; } };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const retrieval = await retrieveForQuestion(db as never, "anything?", {
      config: {
        embedding: { level: "file", provider: "does-not-exist" },
        semantic: { provider: "json", jsonPath: ".logiclens/test-missing-provider-index.json" }
      } as never
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Semantic search disabled"));
    expect(retrieval.semantic).toEqual([]);
    warnSpy.mockRestore();
  });
});
