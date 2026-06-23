import { describe, expect, it, vi, type Mock } from "vitest";
import type { GraphDB } from "../src/graph/db.js";
import { traceContract } from "../src/graph/queries.js";

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
});
