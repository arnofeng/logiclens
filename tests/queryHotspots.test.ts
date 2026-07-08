import { describe, expect, it, vi, type Mock } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import { listLowConfidenceRelations, loadActiveSemanticGraph, traceContract } from "../src/core/graph-model/queries.js";

describe("query hotspots", () => {
  it("traces all matching contract ids with a bounded number of relationship queries", async () => {
    const query = vi.fn(async (cypher: string, _params?: Record<string, unknown>) => {
      if (cypher.includes("MATCH (c:Contract)")) return [{ id: "contract:one" }, { id: "contract:two" }];
      return [{
        contractId: "contract:one",
        kind: "api",
        key: "/api/a",
        name: "/api/a",
        role: "producer",
        repoName: "service-a",
        filePath: "src/a.ts",
        line: 1,
        raw: "fetch('/api/a')",
        rule: "test",
        confidence: 0.95
      }];
    });
    const db = { query } as unknown as GraphDB;

    const rows = await traceContract(db, "api", "/api/a");

    expect(rows).toHaveLength(4);
    expect(query).toHaveBeenCalledTimes(5);
    for (const call of (query as Mock).mock.calls.slice(1)) {
      expect(call[1]).toEqual({ contractIds: ["contract:one", "contract:two"] });
    }
  });

  it("loads active semantic graph through the shared query helper", async () => {
    const query = vi.fn(async (cypher: string) => {
      if (cypher.includes("MATCH (s:ContractSpec)")) {
        return [{
          id: "spec:one",
          contractId: "contract:schema:Order",
          specKind: "schema",
          repoId: "repo:service-a",
          fileId: "file:service-a:src/order.ts",
          evidenceId: "ev:one",
          sourceSymbolId: null,
          canonicalKey: "Order",
          httpMethod: null,
          pathTemplate: null,
          eventTopic: null,
          framework: null,
          version: null,
          specJson: "{\"kind\":\"schema\",\"name\":\"Order\",\"language\":\"typescript\",\"fields\":[]}",
          confidence: 0.95,
          batchId: null,
          indexedAt: null,
          active: true
        }];
      }
      if (cypher.includes("SEMANTIC_REL")) {
        return [{
          fromSpecId: "spec:caller",
          toSpecId: "spec:one",
          kind: "REQUEST_SCHEMA",
          evidenceId: "ev:rel",
          reason: "request body",
          confidence: 0.9
        }];
      }
      return [];
    });
    const db = { query } as unknown as GraphDB;

    const graph = await loadActiveSemanticGraph(db);

    expect(graph.specs).toHaveLength(1);
    expect(graph.specs[0]?.canonicalKey).toBe("Order");
    expect(graph.relations).toEqual([{
      fromSpecId: "spec:caller",
      toSpecId: "spec:one",
      kind: "REQUEST_SCHEMA",
      evidenceId: "ev:rel",
      reason: "request body",
      confidence: 0.9
    }]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("centralizes low-confidence relation queries", async () => {
    const query = vi.fn(async (_cypher: string, params?: Record<string, unknown>) => {
      expect(params).toEqual({ minConfidence: 0.8, limit: 10 });
      return [];
    });
    const db = { query } as unknown as GraphDB;

    await listLowConfidenceRelations(db, { minConfidence: 0.8, limit: 10 });

    expect(query).toHaveBeenCalledTimes(4);
  });
});
