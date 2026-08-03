import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { GraphDatabaseOperationalError, type GraphDB } from "../src/core/graph-model/db.js";
import type {
  CodeSearchRow,
  ContractTraceRow,
  EntityTraceRow,
  SectionSearchRow
} from "../src/core/graph-model/queries.js";
import {
  findExactCode,
  findSectionsAtExactPaths,
  traceContract,
  traceEntitiesExact
} from "../src/core/graph-model/queries.js";
import type { EdgeRow } from "../src/core/graph-model/subgraph.js";
import type { ContractKind } from "../src/core/parsing/types.js";
import { WorkspaceLexicalStoreError, type WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
import type { LexicalHit, LexicalIndexHealth } from "../src/core/retrieval/types.js";
import { FallbackSemanticIndex, SemanticProviderOperationalError, type SemanticIndex, type SemanticSearchResult } from "../src/core/semantic/semanticIndex.js";
import { EmbeddingProviderUnavailableError, type EmbeddingProvider } from "../src/core/semantic/embeddings.js";
import { createRetrievalCandidate } from "../src/features/ask/candidates.js";
import { reciprocalRankFusion } from "../src/features/ask/fusion.js";
import { selectCandidates } from "../src/features/ask/selection.js";
import type { QueryPlan, RetrievalRoute } from "../src/features/ask/planner.js";
import { normalizeExactPaths, retrieveExactTargets } from "../src/features/ask/retrievers/exact.js";
import { retrieveBoundedGraph } from "../src/features/ask/retrievers/graph.js";
import { retrieveWorkspaceLexical } from "../src/features/ask/retrievers/lexical.js";
import { retrieveOptionalSemantic } from "../src/features/ask/retrievers/semantic.js";

const PUBLIC_SCOPE = {
  workspaceId: "workspace:test",
  generation: "generation:test"
} as const;
const PUBLIC_SNAPSHOT = {
  ...PUBLIC_SCOPE,
  revision: "generation:test"
} as const;

const ROUTES: RetrievalRoute[] = ["exact", "contract", "entity", "lexical", "graph", "semantic"];

function plan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return {
    kind: "general",
    terms: [],
    exactIdentifiers: [],
    paths: [],
    contractTargets: [],
    normalizedLexicalQuery: "orders",
    enabledRoutes: [...ROUTES],
    budgets: {
      exact: { limit: 20 }, contract: { limit: 20 }, entity: { limit: 30 },
      lexical: { limit: 20 }, graph: { limit: 40 }, semantic: { limit: 10 }
    },
    ...overrides
  };
}

const HEALTHY: LexicalIndexHealth = {
  providerVersion: "test",
  projectionSchemaVersion: "1",
  tokenizerVersion: "1",
  status: "healthy",
  reasons: [],
  metrics: { documentCount: 2, indexSizeBytes: 10 }
};

function lexicalStore(input: {
  health?: LexicalIndexHealth;
  search?: (workspaceId: string, text: string, topK: number) => readonly LexicalHit[] | Promise<readonly LexicalHit[]>;
} = {}): { store: WorkspaceLexicalStore; search: ReturnType<typeof vi.fn> } {
  const search = vi.fn(async (query: { workspaceId: string; generation: string; text: string }, options: { topK: number }) =>
    input.search?.(query.workspaceId, query.text, options.topK) ?? []);
  const store = {
    health: vi.fn(async () => input.health ?? HEALTHY),
    search
  } as unknown as WorkspaceLexicalStore;
  return { store, search };
}

describe("workspace lexical retriever", () => {
  it("does not search when disabled, empty, unavailable, or unhealthy", async () => {
    const fake = lexicalStore();
    expect((await retrieveWorkspaceLexical(fake.store, plan({ enabledRoutes: ["exact"] }), PUBLIC_SNAPSHOT)).reason).toBe("route-disabled");
    expect((await retrieveWorkspaceLexical(fake.store, plan(), { ...PUBLIC_SNAPSHOT, enabled: false })).reason).toBe("route-disabled");
    expect((await retrieveWorkspaceLexical(fake.store, plan({ normalizedLexicalQuery: "" }), PUBLIC_SNAPSHOT)).reason).toBe("query-empty");
    expect((await retrieveWorkspaceLexical(undefined, plan(), PUBLIC_SNAPSHOT)).status).toBe("unavailable");
    const unhealthy = lexicalStore({ health: { ...HEALTHY, status: "unhealthy", reasons: ["version-mismatch"] } });
    expect((await retrieveWorkspaceLexical(unhealthy.store, plan(), PUBLIC_SNAPSHOT)).reason).toBe("version-mismatch");
    expect(fake.search).not.toHaveBeenCalled();
    expect(unhealthy.search).not.toHaveBeenCalled();
  });

  it("performs one globally ranked search, passes the budget, and preserves render provenance", async () => {
    const workspaceId = "workspace:test";
    const hits: LexicalHit[] = [
      {
        canonicalId: "code:repo:b:src/B.ts:function:B:1", documentId: "doc:b", repoId: "repo:b", kind: "code", rank: 1,
        matchReasons: ["qualifiedName"],
        renderRef: createRenderRef({ workspaceId, repoId: "repo:b", kind: "code", canonicalId: "code:repo:b:src/B.ts:function:B:1", fileId: "file:repo:b:src/B.ts", path: "src/B.ts", startLine: 1 })
      },
      {
        canonicalId: "code:repo:a:src/A.ts:function:A:2", documentId: "doc:a", repoId: "repo:a", kind: "code", rank: 2,
        matchReasons: ["title"],
        renderRef: createRenderRef({ workspaceId, repoId: "repo:a", kind: "code", canonicalId: "code:repo:a:src/A.ts:function:A:2", fileId: "file:repo:a:src/A.ts", path: "src/A.ts", startLine: 2 })
      }
    ];
    const fake = lexicalStore({ search: (_workspaceId, _text, topK) => hits.slice(0, topK) });
    const result = await retrieveWorkspaceLexical(fake.store, plan({
      paths: ["src\\B.ts"],
      budgets: { ...plan().budgets, lexical: { limit: 2 } }
    }), { workspaceId, generation: PUBLIC_SNAPSHOT.generation });
    expect(fake.search).toHaveBeenCalledTimes(1);
    expect(fake.search).toHaveBeenCalledWith({ workspaceId, generation: PUBLIC_SNAPSHOT.generation, text: "orders" }, { topK: 2 });
    expect(result.candidates.map((candidate) => candidate.repoId)).toEqual(["repo:b", "repo:a"]);
    expect(result.candidates[0]).toMatchObject({
      canonicalId: hits[0]!.canonicalId,
      confidence: "corroborated",
      renderRef: hits[0]!.renderRef,
      location: { fileId: "file:repo:b:src/B.ts", path: "src/B.ts", startLine: 1 },
      provenance: [expect.objectContaining({ route: "lexical", rank: 1, documentId: "doc:b", renderRef: hits[0]!.renderRef })]
    });
    expect(result.candidates[0]?.matchReasons).toContain("exact-path");
  });

  it("verifies repo-prefixed paths only for the targeted repository", async () => {
    const workspaceId = "workspace:test";
    const hit = (repo: string, rank: number): LexicalHit => {
      const repoId = `repo:${repo}`;
      const canonicalId = `file:${repoId}:src/contracts/orders.ts`;
      return {
        canonicalId, documentId: `doc:${repo}`, repoId, kind: "file", rank, matchReasons: ["full-text"],
        renderRef: createRenderRef({ workspaceId, repoId, kind: "file", canonicalId, fileId: canonicalId, path: "src/contracts/orders.ts" }),
      };
    };
    const fake = lexicalStore({ search: () => [hit("api", 2), hit("worker", 3)] });
    const result = await retrieveWorkspaceLexical(fake.store, plan({
      paths: ["api/src/contracts/orders.ts"],
      scopedPaths: [{ repoId: "repo:api", path: "src/contracts/orders.ts", raw: "api/src/contracts/orders.ts" }],
    }), { workspaceId, generation: PUBLIC_SNAPSHOT.generation });
    expect(result.candidates[0]).toMatchObject({
      canonicalId: "file:repo:api:src/contracts/orders.ts",
      confidence: "exact",
      location: { path: "src/contracts/orders.ts" },
    });
    expect(result.candidates[0]?.matchReasons).toContain("exact-path");
    expect(result.candidates[1]).toMatchObject({
      canonicalId: "file:repo:worker:src/contracts/orders.ts",
      confidence: "discovery",
    });
    expect(result.candidates[1]?.matchReasons).not.toContain("exact-path");
  });

  it("does not corroborate an unrelated low-ranked contract by kind alone", async () => {
    const workspaceId = "workspace:test";
    const canonicalId = "contract:event:orders.created";
    const fake = lexicalStore({ search: () => [{
      canonicalId, documentId: "doc:orders", repoId: "repo:worker", kind: "contract", rank: 20, matchReasons: ["full-text"],
      renderRef: createRenderRef({ workspaceId, repoId: "repo:worker", kind: "contract", canonicalId, fileId: "file:repo:worker:src/worker.ts", path: "src/worker.ts" }),
    }] });
    const result = await retrieveWorkspaceLexical(fake.store, plan({
      contractTargets: [{ kind: "event", value: "payment.failed" }],
    }), { workspaceId, generation: PUBLIC_SNAPSHOT.generation });
    expect(result.candidates[0]).toMatchObject({ confidence: "discovery", matchReasons: ["full-text"] });
    const fused = reciprocalRankFusion(result.candidates);
    expect(selectCandidates(fused, { workspaceId }).selectedCandidates).toEqual([]);
  });

  it("returns structured provider failures but propagates unexpected errors", async () => {
    const expected = lexicalStore({ search: async () => { throw new WorkspaceLexicalStoreError("search_failed", { operation: "search" }); } });
    await expect(retrieveWorkspaceLexical(expected.store, plan(), PUBLIC_SNAPSHOT)).resolves.toMatchObject({ status: "failed", reason: "search-failed", queryCount: 1 });
    const unexpected = lexicalStore({ search: async () => { throw new TypeError("corrupt hit"); } });
    await expect(retrieveWorkspaceLexical(unexpected.store, plan(), PUBLIC_SNAPSHOT)).rejects.toThrow("corrupt hit");
  });
});

const CODE_ROW: CodeSearchRow = {
  repoName: "api", filePath: "src/orders.ts", codeId: "code:repo:api:src/orders.ts:function:createOrder:1",
  kind: "function", name: "createOrder", qualifiedName: "createOrder", summary: "", signature: "createOrder()"
};
const SECTION_ROW: SectionSearchRow = {
  repoName: "api", filePath: "docs/orders.md", sectionId: "section:repo:api:docs/orders.md:orders:1",
  heading: "Orders", level: 1, startLine: 1, endLine: 4, summary: "", text: "orders"
};
const CONTRACT_ROW: ContractTraceRow = {
  contractId: "contract:api:post-orders", kind: "api", key: "POST:/orders", name: "POST /orders", role: "producer",
  repoName: "api", filePath: "src/orders.ts", line: 5, evidenceId: "evidence:post-orders",
  raw: "POST /orders", rule: "route", confidence: 0.9, resolution: "exact"
};
const ENTITY_ROW: EntityTraceRow = {
  entityId: "entity:order", entityName: "Order", repoName: "worker", sourceKind: "workflow", name: "OrderFlow",
  filePath: "", line: 1, role: "consumer", evidence: "flow", confidence: 0.9
};

describe("exact contract and entity retriever", () => {
  it("normalizes relative Windows paths and maps absolute paths only through configured repo roots", () => {
    expect(normalizeExactPaths([
      "src\\main.ts",
      "src/main.ts",
      "C:\\work\\repo\\src\\windows.ts",
      "\\\\server\\share\\repo\\src\\unc.ts",
      "/workspace/repo/src/posix.ts",
      "C:\\outside\\secret.ts",
      "..\\escape.ts"
    ], ["C:\\work\\repo", "\\\\server\\share\\repo", "/workspace/repo"])).toEqual([
      "src/main.ts",
      "src/posix.ts",
      "src/unc.ts",
      "src/windows.ts"
    ]);
  });

  it("keeps every nested repo-root path variant independent of root order", () => {
    const file = "C:\\workspace\\repo\\src\\a.ts";
    const roots = ["C:\\workspace", "C:\\workspace\\repo"];
    const expected = ["repo/src/a.ts", "src/a.ts"];
    expect(normalizeExactPaths([file], roots)).toEqual(expected);
    expect(normalizeExactPaths([file], [...roots].reverse())).toEqual(expected);
  });

  it("does not erase a repository-looking prefix from an unscoped path", () => {
    expect(normalizeExactPaths(["api/src/contracts/orders.ts"], ["C:\\workspace\\api"]))
      .toEqual(["api/src/contracts/orders.ts"]);
  });

  it("binds exact graph path predicates to repository identity", async () => {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const db = { query: vi.fn(async (sql: string, params?: Record<string, unknown>) => {
      calls.push({ sql, params });
      return [];
    }) } as unknown as GraphDB;
    const scopedPaths = [{ repoId: "repo:api", path: "src/contracts/orders.ts" }];
    await findExactCode(db, PUBLIC_SNAPSHOT, { identifiers: [], paths: [], scopedPaths, limit: 5 });
    await findSectionsAtExactPaths(db, PUBLIC_SNAPSHOT, [], 5, scopedPaths);
    for (const call of calls) {
      expect(call.sql).toContain("r.id = $scopedRepo0 AND f.path = $scopedPath0");
      expect(call.params).toEqual({ scopedRepo0: "repo:api", scopedPath0: "src/contracts/orders.ts", ...PUBLIC_SCOPE });
    }
  });

  it("uses parameterized exact graph semantics and keeps method-specific contracts exact", async () => {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const db = {
      async query(sql: string, params?: Record<string, unknown>) {
        calls.push({ sql, params });
        if (sql.includes("PARTICIPATES_IN") && !sql.includes("WORKFLOW_STEP")) return [ENTITY_ROW];
        return [];
      }
    } as unknown as GraphDB;
    await findExactCode(db, PUBLIC_SNAPSHOT, { identifiers: ["createOrder"], paths: ["src/orders.ts"], limit: 3 });
    await findSectionsAtExactPaths(db, PUBLIC_SNAPSHOT, ["docs/orders.md"], 2);
    await traceContract(db, PUBLIC_SNAPSHOT, "api", "/orders", "POST");
    const entities = await traceEntitiesExact(db, PUBLIC_SNAPSHOT, ["Order"], 1);
    expect(calls[0]?.sql).toContain("c.name IN $identifiers");
    expect(calls[0]?.sql).not.toContain("CONTAINS $term");
    expect(calls[0]?.params).toEqual({ identifiers: ["createOrder"], paths: ["src/orders.ts"], ...PUBLIC_SCOPE });
    expect(calls[1]?.sql).toContain("f.path IN $paths");
    const contractCall = calls.find(({ sql }) => sql.includes("c.key = $methodKey"));
    expect(contractCall?.sql).toContain("c.key = $key OR c.key = $methodKey");
    expect(contractCall?.params).toMatchObject({ kind: "api", methodKey: "POST:/orders" });
    expect(entities).toEqual([ENTITY_ROW]);
  });

  it("uses only structured targets, preserves methods, deduplicates rows, and bounds each route", async () => {
    const exactCode = vi.fn(async (_db: GraphDB, input: { identifiers: readonly string[]; paths: readonly string[]; limit: number }) => {
      expect(input).toEqual({ identifiers: ["createOrder"], paths: ["docs/orders.md"], limit: 1 });
      return [CODE_ROW, CODE_ROW];
    });
    const sections = vi.fn(async () => [SECTION_ROW]);
    const contract = vi.fn(async (_db: GraphDB, kind: ContractKind, value: string, method?: string, limit = 100) => {
      expect({ kind, value, method }).toEqual({ kind: "api", value: "/orders", method: "POST" });
      expect(limit).toBe(1);
      return { rows: [CONTRACT_ROW, CONTRACT_ROW], queryCount: 5 };
    });
    const entity = vi.fn(async (_db: GraphDB, values: readonly string[], limit = 100) => {
      expect(values).toEqual(["createOrder"]);
      expect(limit).toBe(1);
      return { rows: [ENTITY_ROW, ENTITY_ROW], queryCount: 4 };
    });
    const result = await retrieveExactTargets({} as GraphDB, plan({
      terms: ["where", "is", "order"],
      exactIdentifiers: ["createOrder", "createOrder"],
      paths: ["docs/orders.md", "docs/orders.md"],
      contractTargets: [{ kind: "api", value: "/orders", method: "POST" }],
      budgets: { ...plan().budgets, exact: { limit: 1 }, contract: { limit: 1 }, entity: { limit: 1 } }
    }), { workspaceId: "workspace:test", dependencies: {
      findExactCode: exactCode, findSectionsAtExactPaths: sections, traceContract: contract, traceEntitiesExact: entity
    } });
    expect(exactCode).toHaveBeenCalledTimes(1);
    expect(sections).not.toHaveBeenCalled();
    expect(contract).toHaveBeenCalledTimes(1);
    expect(entity).toHaveBeenCalledTimes(1);
    expect(result.exact.legacyRows).toHaveLength(1);
    expect(result.contract.legacyRows).toHaveLength(1);
    expect(result.entity.legacyRows).toHaveLength(1);
    expect(result.contract.queryCount).toBe(5);
    expect(result.entity.queryCount).toBe(4);
    expect(result.entity.candidates[0]?.location).toBeUndefined();
  });

  it("isolates exact, contract, and entity failures with truthful execution counts", async () => {
    const contract = vi.fn(async () => ({ rows: [CONTRACT_ROW], queryCount: 5 }));
    const entity = vi.fn(async () => ({ rows: [ENTITY_ROW], queryCount: 4 }));
    const result = await retrieveExactTargets({} as GraphDB, plan({
      exactIdentifiers: ["createOrder"],
      contractTargets: [{ kind: "api", value: "/orders", method: "POST" }]
    }), {
      workspaceId: "workspace:test",
      dependencies: {
        findExactCode: vi.fn(async () => { throw new GraphDatabaseOperationalError({ cause: new Error("exact database unavailable") }); }),
        findSectionsAtExactPaths: vi.fn(),
        traceContract: contract,
        traceEntitiesExact: entity
      }
    });
    expect(contract).toHaveBeenCalledTimes(1);
    expect(entity).toHaveBeenCalledTimes(1);
    expect(result.exact).toMatchObject({ status: "failed", executed: true, queryCount: 1, reason: "query-failed" });
    expect(result.contract).toMatchObject({ status: "succeeded", executed: true, queryCount: 5 });
    expect(result.entity).toMatchObject({ status: "succeeded", executed: true, queryCount: 4 });
  });

  it("propagates ordinary exact query programming errors", async () => {
    await expect(retrieveExactTargets({} as GraphDB, plan({ exactIdentifiers: ["createOrder"] }), {
      workspaceId: "workspace:test",
      dependencies: {
        findExactCode: vi.fn(async () => { throw new Error("exact invariant failed"); }),
        findSectionsAtExactPaths: vi.fn(), traceContract: vi.fn(), traceEntitiesExact: vi.fn()
      }
    })).rejects.toThrow("exact invariant failed");
  });

  it("preserves contract role and entity middle-query failure counts", async () => {
    let contractCalls = 0;
    const contractDb = { query: vi.fn(async () => {
      contractCalls += 1;
      if (contractCalls === 1) return [{ id: CONTRACT_ROW.contractId }];
      if (contractCalls === 3) throw new GraphDatabaseOperationalError({ cause: new Error("role query failed") });
      return [];
    }) } as unknown as GraphDB;
    const contractResult = await retrieveExactTargets(contractDb, plan({
      enabledRoutes: ["contract"], contractTargets: [{ kind: "api", value: "/orders", method: "POST" }]
    }), { workspaceId: "workspace:test", snapshot: PUBLIC_SNAPSHOT });
    expect(contractResult.contract).toMatchObject({ status: "failed", executed: true, queryCount: 3, reason: "query-failed" });

    let entityCalls = 0;
    const entityDb = { query: vi.fn(async () => {
      entityCalls += 1;
      if (entityCalls === 4) throw new GraphDatabaseOperationalError({ cause: new Error("entity query failed") });
      return [];
    }) } as unknown as GraphDB;
    const entityResult = await retrieveExactTargets(entityDb, plan({ enabledRoutes: ["entity"], exactIdentifiers: ["Order"] }), {
      workspaceId: "workspace:test",
      snapshot: PUBLIC_SNAPSHOT
    });
    expect(entityResult.entity).toMatchObject({ status: "failed", executed: true, queryCount: 4, reason: "query-failed" });
  });

  it("does not issue graph queries without structured targets", async () => {
    const exactCode = vi.fn();
    const sections = vi.fn();
    const contract = vi.fn();
    const entity = vi.fn();
    const result = await retrieveExactTargets({} as GraphDB, plan({ exactIdentifiers: [], paths: [], contractTargets: [] }), {
      workspaceId: "workspace:test",
      dependencies: { findExactCode: exactCode, findSectionsAtExactPaths: sections, traceContract: contract, traceEntitiesExact: entity }
    });
    expect([exactCode, sections, contract, entity].every((mock) => mock.mock.calls.length === 0)).toBe(true);
    expect(result.exact.reason).toBe("no-structured-targets");
    expect(result.entity.reason).toBe("no-structured-targets");
  });

  it("keeps distinct entities that share the same source identity", async () => {
    const customer = { ...ENTITY_ROW, entityId: "entity:customer", entityName: "Customer" };
    const result = await retrieveExactTargets({} as GraphDB, plan({
      exactIdentifiers: ["Order", "Customer"],
      budgets: { ...plan().budgets, entity: { limit: 2 } }
    }), {
      workspaceId: "workspace:test",
      dependencies: {
        findExactCode: vi.fn(async () => []),
        findSectionsAtExactPaths: vi.fn(async () => []),
        traceContract: vi.fn(),
        traceEntitiesExact: vi.fn(async () => ({ rows: [ENTITY_ROW, customer], queryCount: 8 }))
      }
    });
    expect(result.entity.legacyRows.map((row) => row.entityId)).toEqual(["entity:customer", "entity:order"]);
  });
});

function seed(input: {
  canonicalId: string;
  kind?: "code" | "contract";
  confidence?: "exact" | "resolved-contract" | "corroborated" | "discovery";
  route?: "exact" | "contract" | "lexical";
  matchReasons?: string[];
}) {
  return createRetrievalCandidate({
    canonicalId: input.canonicalId,
    repoId: "repo:api",
    kind: input.kind ?? "code",
    routes: [{ route: input.route ?? (input.kind === "contract" ? "contract" : "exact"), rank: 1, documentIds: [] }],
    matchReasons: input.matchReasons ?? [],
    confidence: input.confidence ?? "exact"
  });
}

const EDGE: EdgeRow = {
  fromCodeId: CODE_ROW.codeId,
  toCodeId: "code:repo:api:src/store.ts:function:saveOrder:1",
  fromRepoId: "repo:api",
  toRepoId: "repo:api",
  fromPath: "src/orders.ts",
  toPath: "src/store.ts",
  fromName: "createOrder", toName: "saveOrder", fromFile: "api/src/orders.ts", toFile: "api/src/store.ts",
  confidence: 0.9, resolution: "exact", raw: "saveOrder()"
};

describe("bounded graph retriever", () => {
  it("does not query without eligible, code-identifiable seeds", async () => {
    const edges = vi.fn();
    const implementations = vi.fn();
    await expect(retrieveBoundedGraph({} as GraphDB, plan(), [], { workspaceId: "workspace:test", dependencies: { callEdgesAround: edges, findContractSourceSymbols: implementations } })).resolves.toMatchObject({ reason: "no-eligible-seeds" });
    await expect(retrieveBoundedGraph({} as GraphDB, plan(), [seed({ canonicalId: CODE_ROW.codeId, confidence: "discovery", route: "lexical", matchReasons: ["full-text"] })], { workspaceId: "workspace:test", dependencies: { callEdgesAround: edges, findContractSourceSymbols: implementations } })).resolves.toMatchObject({ reason: "no-eligible-seeds" });
    await expect(retrieveBoundedGraph({} as GraphDB, plan(), [seed({ canonicalId: "symbol-without-code-id" })], { workspaceId: "workspace:test", dependencies: { callEdgesAround: edges, findContractSourceSymbols: implementations } })).resolves.toMatchObject({ reason: "no-queryable-seeds" });
    expect(edges).not.toHaveBeenCalled();
    expect(implementations).not.toHaveBeenCalled();
  });

  it("expands a provider-neutral strong lexical seed but not an ordinary full-text discovery hit", async () => {
    const edges = vi.fn(async () => [EDGE]);
    const implementations = vi.fn();
    const low = seed({ canonicalId: CODE_ROW.codeId, confidence: "discovery", route: "lexical", matchReasons: ["full-text"] });
    const high = seed({ canonicalId: CODE_ROW.codeId, confidence: "discovery", route: "lexical", matchReasons: ["exact-identifier"] });
    expect((await retrieveBoundedGraph({} as GraphDB, plan(), [low], { workspaceId: "workspace:test", dependencies: { callEdgesAround: edges, findContractSourceSymbols: implementations } })).reason).toBe("no-eligible-seeds");
    const result = await retrieveBoundedGraph({} as GraphDB, plan(), [high], { workspaceId: "workspace:test", dependencies: { callEdgesAround: edges, findContractSourceSymbols: implementations } });
    expect(result.status).toBe("succeeded");
    expect(edges).toHaveBeenCalledTimes(1);
    expect(implementations).not.toHaveBeenCalled();
  });

  it("turns both call-edge endpoints into locatable graph candidates that fuse with an exact seed", async () => {
    const edges = vi.fn(async () => [EDGE]);
    const exactSeed = seed({ canonicalId: CODE_ROW.codeId, confidence: "exact", route: "exact" });
    const result = await retrieveBoundedGraph({} as GraphDB, plan(), [exactSeed], {
      workspaceId: "workspace:test",
      dependencies: { callEdgesAround: edges, findContractSourceSymbols: vi.fn() }
    });
    expect(result.candidates.map((candidate) => candidate.canonicalId)).toEqual([EDGE.fromCodeId, EDGE.toCodeId]);
    expect(result.candidates[1]).toMatchObject({
      repoId: EDGE.toRepoId,
      location: { fileId: "file:repo:api:src/store.ts", path: EDGE.toPath },
      routes: [{ route: "graph", rank: 1 }]
    });
    const fused = reciprocalRankFusion([exactSeed, ...result.candidates]);
    expect(fused.find((candidate) => candidate.canonicalId === exactSeed.canonicalId)?.routes.map(({ route }) => route)).toEqual(["exact", "graph"]);
  });

  it.each([2, 3] as const)("reports %s attempted graph queries when that query fails", async (failAt) => {
    let calls = 0;
    const operational = async <T>(value: T): Promise<T> => {
      calls += 1;
      if (calls === failAt) throw new GraphDatabaseOperationalError({ cause: new Error("graph provider failed") });
      return value;
    };
    const promise = retrieveBoundedGraph({ query: vi.fn() } as unknown as GraphDB, plan(), [seed({
      canonicalId: CONTRACT_ROW.contractId, kind: "contract", confidence: "resolved-contract", route: "contract"
    })], { workspaceId: "workspace:test", dependencies: {
      findContractSourceSymbols: async () => operational([CODE_ROW]),
      callEdgesAround: async () => operational([EDGE]),
      sectionsDocumentingCode: async () => operational([SECTION_ROW])
    } });
    await expect(promise).rejects.toMatchObject({
      route: "graph", attemptedQueryCount: failAt, reason: "query-failed"
    });
  });

  it("propagates ordinary graph query programming errors", async () => {
    await expect(retrieveBoundedGraph({} as GraphDB, plan(), [seed({ canonicalId: CODE_ROW.codeId })], {
      workspaceId: "workspace:test",
      dependencies: { callEdgesAround: vi.fn(async () => { throw new Error("graph invariant failed"); }), findContractSourceSymbols: vi.fn() }
    })).rejects.toThrow("graph invariant failed");
  });

  it.each(["probable", "heuristic"] as const)("keeps %s call-edge endpoints at discovery confidence", async (resolution) => {
    const edge = { ...EDGE, resolution };
    const result = await retrieveBoundedGraph({} as GraphDB, plan(), [seed({ canonicalId: CODE_ROW.codeId })], {
      workspaceId: "workspace:test",
      dependencies: { callEdgesAround: vi.fn(async () => [edge]), findContractSourceSymbols: vi.fn() }
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((candidate) => candidate.confidence === "discovery")).toBe(true);
    expect(result.candidates.every((candidate) => candidate.matchReasons.includes(`call-edge-resolution-${resolution}`))).toBe(true);
  });

  it("merges implementation and call-edge evidence for the same graph identity", async () => {
    const result = await retrieveBoundedGraph({} as GraphDB, plan(), [seed({
      canonicalId: CONTRACT_ROW.contractId,
      kind: "contract",
      confidence: "resolved-contract",
      route: "contract"
    })], {
      workspaceId: "workspace:test",
      dependencies: {
        findContractSourceSymbols: vi.fn(async () => [CODE_ROW]),
        callEdgesAround: vi.fn(async () => [EDGE])
      }
    });
    const merged = result.candidates.filter((candidate) => candidate.canonicalId === CODE_ROW.codeId);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ confidence: "corroborated", routes: [{ route: "graph", rank: 1 }] });
    expect(merged[0]?.matchReasons).toEqual(expect.arrayContaining([
      "contract-implementation", "call-edge-from", "call-edge-resolution-exact"
    ]));
    expect(merged[0]?.provenance).toHaveLength(1);
    expect(merged[0]?.provenance[0]?.documentId).toMatch(/^lexical:code:/u);
  });

  it("deduplicates and sorts seeds, applies seed/result budgets, and bounds contract expansion", async () => {
    const edges = vi.fn(async (_db: GraphDB, ids: string[], limit = 100) => {
      expect(ids).toEqual([CODE_ROW.codeId]);
      expect(limit).toBe(1);
      return [EDGE, EDGE];
    });
    const implementations = vi.fn(async (_db: GraphDB, ids: string[], limit = 100) => {
      expect(ids).toEqual([CONTRACT_ROW.contractId]);
      expect(limit).toBe(2);
      return [CODE_ROW, CODE_ROW];
    });
    const inputs = [seed({ canonicalId: CONTRACT_ROW.contractId, kind: "contract", confidence: "resolved-contract" }), seed({ canonicalId: CONTRACT_ROW.contractId, kind: "contract", confidence: "resolved-contract" })];
    const graphPlan = plan({ budgets: { ...plan().budgets, graph: { limit: 2 } } });
    const first = await retrieveBoundedGraph({} as GraphDB, graphPlan, inputs, { workspaceId: "workspace:test", seedLimit: 1, dependencies: { callEdgesAround: edges, findContractSourceSymbols: implementations } });
    const second = await retrieveBoundedGraph({} as GraphDB, graphPlan, [...inputs].reverse(), { workspaceId: "workspace:test", seedLimit: 1, dependencies: { callEdgesAround: edges, findContractSourceSymbols: implementations } });
    expect(implementations).toHaveBeenCalledTimes(2);
    expect(edges).toHaveBeenCalledTimes(2);
    expect(first.legacyRows).toHaveLength(2);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("selects the strongest seed before applying the seed budget", async () => {
    const selectedIds: string[][] = [];
    const edges = vi.fn(async (_db: GraphDB, ids: string[]) => {
      selectedIds.push(ids);
      return [];
    });
    const implementations = vi.fn();
    const exact = seed({ canonicalId: "code:repo:api:src/z.ts:function:z:1", confidence: "exact", route: "exact" });
    const lexical = seed({ canonicalId: "code:repo:api:src/a.ts:function:a:1", confidence: "corroborated", route: "lexical", matchReasons: ["exact-identifier"] });
    const dependencies = { callEdgesAround: edges, findContractSourceSymbols: implementations };
    await retrieveBoundedGraph({} as GraphDB, plan(), [lexical, exact], { workspaceId: "workspace:test", seedLimit: 1, dependencies });
    await retrieveBoundedGraph({} as GraphDB, plan(), [exact, lexical], { workspaceId: "workspace:test", seedLimit: 1, dependencies });
    expect(selectedIds).toEqual([[exact.canonicalId], [exact.canonicalId]]);
  });

  it("expands deterministically by newly discovered unvisited code ids for bounded hops", async () => {
    const second: EdgeRow = {
      ...EDGE,
      fromCodeId: EDGE.toCodeId,
      toCodeId: "code:repo:api:src/audit.ts:function:auditOrder:1",
      fromPath: EDGE.toPath,
      toPath: "src/audit.ts",
      fromFile: EDGE.toFile,
      toFile: "api/src/audit.ts",
      fromName: EDGE.toName,
      toName: "auditOrder",
      raw: "auditOrder()",
    };
    const calls: string[][] = [];
    const callEdgesAround = vi.fn(async (_db: GraphDB, ids: string[]) => {
      calls.push([...ids]);
      return ids.includes(CODE_ROW.codeId) ? [EDGE] : [second, EDGE];
    });
    const result = await retrieveBoundedGraph({} as GraphDB, plan(), [seed({ canonicalId: CODE_ROW.codeId })], {
      workspaceId: "workspace:test",
      graphHops: 5,
      dependencies: { callEdgesAround, findContractSourceSymbols: vi.fn() },
    });
    expect(calls).toEqual([[CODE_ROW.codeId], [EDGE.toCodeId], [second.toCodeId]]);
    expect(new Set(result.legacyRows.filter((row) => row.kind === "edge").map((row) => JSON.stringify(row.row))).size).toBe(2);
    expect(result.queryCount).toBe(3);
    expect(result.candidates.map((candidate) => candidate.canonicalId)).toContain(second.toCodeId);
  });

  it("over-fetches known edges before provider truncation without exceeding the final graph budget", async () => {
    const second: EdgeRow = {
      ...EDGE,
      fromCodeId: EDGE.toCodeId,
      toCodeId: "code:repo:api:src/audit.ts:function:auditOrder:1",
      fromPath: EDGE.toPath,
      toPath: "src/audit.ts",
      fromFile: EDGE.toFile,
      toFile: "api/src/audit.ts",
      fromName: EDGE.toName,
      toName: "auditOrder",
      raw: "auditOrder()",
    };
    const limits: number[] = [];
    const callEdgesAround = vi.fn(async (_db: GraphDB, ids: string[], limit = 100) => {
      limits.push(limit);
      const providerOrdered = ids.includes(CODE_ROW.codeId) ? [EDGE] : [EDGE, second];
      return providerOrdered.slice(0, limit);
    });
    const graphPlan = plan({ budgets: { ...plan().budgets, graph: { limit: 2 } } });
    const result = await retrieveBoundedGraph({} as GraphDB, graphPlan, [seed({ canonicalId: CODE_ROW.codeId })], {
      workspaceId: "workspace:test",
      graphHops: 2,
      dependencies: { callEdgesAround, findContractSourceSymbols: vi.fn() },
    });
    expect(limits).toEqual([2, 2]);
    expect(result.legacyRows.filter((row) => row.kind === "edge").map((row) => row.row)).toEqual([EDGE, second]);
    expect(result.legacyRows.filter((row) => row.kind === "edge")).toHaveLength(2);
    expect(result.queryCount).toBe(2);
  });
});

describe("optional semantic retriever", () => {
  const enabledConfig = configSchema.parse({
    embedding: { provider: "test", level: "file", retry: { maxRetries: 4 }, budget: { maxRequests: 2 }, rateLimit: { minDelayMs: 5 } }
  });
  const provider: EmbeddingProvider = { name: "test", async embedText() { return [1]; }, async embedTexts() { return [[1]]; } };
  const semanticRow: SemanticSearchResult = {
    nodeId: CODE_ROW.codeId, nodeKind: "Code", repoId: "repo:api", title: "createOrder", sourceText: "createOrder",
    sourceHash: "hash", updatedAt: "now", score: 0.9
  };

  it("does not resolve or search when the route or provider is off", async () => {
    const resolveProvider = vi.fn();
    const createIndex = vi.fn();
    expect((await retrieveOptionalSemantic(plan({ enabledRoutes: ["exact"] }), "orders", enabledConfig, { dependencies: { resolveProvider, createIndex } })).reason).toBe("route-disabled");
    expect((await retrieveOptionalSemantic(plan(), "orders", configSchema.parse({ embedding: { provider: "off", level: "off" } }), { dependencies: { resolveProvider, createIndex } })).reason).toBe("provider-off");
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(createIndex).not.toHaveBeenCalled();
  });

  it("distinguishes unavailable providers, resolution failures, failed search, empty success, and hit success", async () => {
    const unavailable = await retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: { resolveProvider: () => undefined } });
    expect(unavailable).toMatchObject({ status: "unavailable", reason: "provider-unavailable", queryCount: 0 });
    const resolveFailed = await retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: { resolveProvider: () => { throw new EmbeddingProviderUnavailableError("test"); } } });
    expect(resolveFailed).toMatchObject({ status: "unavailable", reason: "provider-resolve-failed", queryCount: 0 });

    const search = vi.fn(async (_question: string, options?: Parameters<SemanticIndex["search"]>[1]) => {
      expect(options).toMatchObject({
        embeddingProvider: provider,
        limit: 1,
        providerPolicy: { retry: expect.objectContaining({ maxRetries: 4 }), budget: { maxRequests: 2 }, rateLimit: { minDelayMs: 5 } }
      });
      return [semanticRow, { ...semanticRow, nodeId: "extra" }];
    });
    const index = { search, records: vi.fn(), upsert: vi.fn() } as unknown as SemanticIndex;
    const success = await retrieveOptionalSemantic(plan({ budgets: { ...plan().budgets, semantic: { limit: 1 } } }), "orders", enabledConfig, {
      dependencies: { resolveProvider: () => provider, createIndex: () => index }
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(success).toMatchObject({ status: "succeeded", queryCount: 1 });
    expect(success.legacyRows).toHaveLength(1);

    const empty = await retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: {
      resolveProvider: () => provider,
      createIndex: () => ({ search: vi.fn(async () => []), records: vi.fn(), upsert: vi.fn() } as unknown as SemanticIndex)
    } });
    expect(empty).toMatchObject({ status: "succeeded", queryCount: 1, legacyRows: [] });
    const failed = await retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: {
      resolveProvider: () => provider,
      createIndex: () => ({ search: vi.fn(async () => { throw new SemanticProviderOperationalError({ cause: new Error("search broke") }); }), records: vi.fn(), upsert: vi.fn() } as unknown as SemanticIndex)
    } });
    expect(failed).toMatchObject({ status: "failed", reason: "search-failed", queryCount: 1 });

    await expect(retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: {
      resolveProvider: () => { throw new Error("semantic registry invariant"); }
    } })).rejects.toThrow("semantic registry invariant");
    await expect(retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: {
      resolveProvider: () => provider,
      createIndex: () => ({ search: vi.fn(async () => { throw new Error("semantic search invariant"); }), records: vi.fn(), upsert: vi.fn() } as unknown as SemanticIndex)
    } })).rejects.toThrow("semantic search invariant");
  });

  it("returns fallback hits with degraded primary-provider metadata", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-semantic-fallback-"));
    const secret = "secret-chroma-host";
    const primary = {
      search: vi.fn(async () => { throw new SemanticProviderOperationalError({ cause: new Error(secret) }); }),
      records: vi.fn(),
      upsert: vi.fn()
    } as unknown as SemanticIndex;
    const fallback = {
      search: vi.fn(async () => [semanticRow]),
      records: vi.fn(),
      upsert: vi.fn()
    } as unknown as SemanticIndex;
    try {
      const result = await retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: {
        resolveProvider: () => provider,
        createIndex: () => new FallbackSemanticIndex(primary, fallback, cwd, { primary: "chroma", fallback: "json" })
      } });

      expect(result).toMatchObject({
        status: "unhealthy",
        reason: "primary-provider-failed",
        queryCount: 2,
        providerMetadata: {
          primaryProvider: "chroma",
          effectiveProvider: "json",
          fallbackUsed: true,
          fallbackReason: "primary-search-failed",
          primaryStatus: "failed"
        }
      });
      expect(primary.search).toHaveBeenCalledTimes(1);
      expect(fallback.search).toHaveBeenCalledTimes(1);
      expect(result.legacyRows).toEqual([semanticRow]);
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("counts primary-only and primary-empty fallback semantic searches", async () => {
    const primaryHit = {
      search: vi.fn(async () => [semanticRow]), records: vi.fn(), upsert: vi.fn()
    } as unknown as SemanticIndex;
    const unusedFallback = {
      search: vi.fn(async () => []), records: vi.fn(), upsert: vi.fn()
    } as unknown as SemanticIndex;
    const hit = await retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: {
      resolveProvider: () => provider,
      createIndex: () => new FallbackSemanticIndex(primaryHit, unusedFallback)
    } });
    expect(hit).toMatchObject({ status: "succeeded", queryCount: 1 });
    expect(primaryHit.search).toHaveBeenCalledTimes(1);
    expect(unusedFallback.search).not.toHaveBeenCalled();

    const emptyPrimary = {
      search: vi.fn(async () => []), records: vi.fn(), upsert: vi.fn()
    } as unknown as SemanticIndex;
    const fallback = {
      search: vi.fn(async () => [semanticRow]), records: vi.fn(), upsert: vi.fn()
    } as unknown as SemanticIndex;
    const fallbackHit = await retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: {
      resolveProvider: () => provider,
      createIndex: () => new FallbackSemanticIndex(emptyPrimary, fallback, process.cwd(), { primary: "chroma", fallback: "json" })
    } });
    expect(fallbackHit).toMatchObject({
      status: "succeeded",
      queryCount: 2,
      providerMetadata: { fallbackUsed: true, fallbackReason: "primary-empty", primaryStatus: "succeeded" }
    });
    expect(emptyPrimary.search).toHaveBeenCalledTimes(1);
    expect(fallback.search).toHaveBeenCalledTimes(1);
  });

  it("preserves two attempted searches when primary and fallback both fail operationally", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-semantic-double-failure-"));
    const primary = {
      search: vi.fn(async () => { throw new SemanticProviderOperationalError(); }), records: vi.fn(), upsert: vi.fn()
    } as unknown as SemanticIndex;
    const fallback = {
      search: vi.fn(async () => { throw new SemanticProviderOperationalError(); }), records: vi.fn(), upsert: vi.fn()
    } as unknown as SemanticIndex;
    try {
      const result = await retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: {
        resolveProvider: () => provider,
        createIndex: () => new FallbackSemanticIndex(primary, fallback, cwd, { primary: "chroma", fallback: "json" })
      } });
      expect(result).toMatchObject({
        status: "failed",
        reason: "search-failed",
        queryCount: 2,
        providerMetadata: {
          primaryProvider: "chroma",
          effectiveProvider: "json",
          fallbackUsed: true,
          fallbackReason: "primary-search-failed",
          primaryStatus: "failed"
        }
      });
      expect(primary.search).toHaveBeenCalledTimes(1);
      expect(fallback.search).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not hide ordinary primary semantic programming errors behind fallback", async () => {
    const invariant = new Error("semantic result conversion invariant");
    const primary = {
      search: vi.fn(async () => { throw invariant; }), records: vi.fn(), upsert: vi.fn()
    } as unknown as SemanticIndex;
    const fallback = {
      search: vi.fn(async () => [semanticRow]), records: vi.fn(), upsert: vi.fn()
    } as unknown as SemanticIndex;

    await expect(retrieveOptionalSemantic(plan(), "orders", enabledConfig, { dependencies: {
      resolveProvider: () => provider,
      createIndex: () => new FallbackSemanticIndex(primary, fallback)
    } })).rejects.toBe(invariant);
    expect(fallback.search).not.toHaveBeenCalled();
  });
});
