import { describe, expect, it, vi } from "vitest";
import type { GraphValue } from "../src/core/graph-model/db.js";
import { WorkspaceLexicalStoreError } from "../src/core/retrieval/provider.js";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
import {
  LEXICAL_PROJECTION_SCHEMA_VERSION,
  TOKENIZER_VERSION,
  type LexicalDocument
} from "../src/core/retrieval/types.js";
import {
  NEO4J_LEXICAL_ANALYZER,
  NEO4J_LEXICAL_STATS_SCHEMA_VERSION,
  NEO4J_LEXICAL_UPSERT_CHUNK_SIZE,
  NEO4J_WORKSPACE_FTS_INDEX,
  Neo4jWorkspaceLexicalStore,
  normalizeNeo4jFullTextQuery
} from "../src/adapters/graph-db/neo4j/Neo4jWorkspaceLexicalStore.js";
import type { Neo4jGraphDB } from "../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";

type QueryResult = Record<string, unknown>[];

class MockNeo4jGraphDB {
  readonly calls: Array<{ cypher: string; params?: Record<string, GraphValue> }> = [];
  readonly beginTransaction = vi.fn(async () => undefined);
  readonly commitTransaction = vi.fn(async () => undefined);
  readonly rollbackTransaction = vi.fn(async () => undefined);
  handler: (cypher: string, params?: Record<string, GraphValue>) => QueryResult | Promise<QueryResult> = () => [];
  interceptor?: (cypher: string, params?: Record<string, GraphValue>) => QueryResult | undefined;

  async query<T>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
    this.calls.push({ cypher, params });
    const intercepted = this.interceptor?.(cypher, params);
    if (intercepted !== undefined) return intercepted as T[];
    if (cypher.startsWith("UNWIND $documents AS document MERGE")) {
      return [{ written: (params?.documents as GraphValue[]).length }] as T[];
    }
    return await this.handler(cypher, params) as T[];
  }
}

const WORKSPACE = "workspace:test";
const GENERATION = "generation:test";

function statsId(revision: string): string {
  return `lexical-stats:${JSON.stringify([WORKSPACE, GENERATION, revision])}`;
}

function storeWith(db: MockNeo4jGraphDB): Neo4jWorkspaceLexicalStore {
  return new Neo4jWorkspaceLexicalStore(db as unknown as Neo4jGraphDB);
}

function document(overrides: Partial<LexicalDocument> = {}): LexicalDocument {
  const result: LexicalDocument = {
    id: "lexical:one",
    canonicalId: "code:one",
    workspaceId: WORKSPACE,
    repoId: "repo:one",
    kind: "code",
    title: "Order Service",
    qualifiedName: "OrderService.create",
    path: "src/order.ts",
    searchableText: "create order 创建订单",
    tokens: ["create", "order", "创建", "订单"],
    active: true,
    sourceHash: "hash:one",
    batchId: "batch:one",
    renderRef: "",
    ...overrides
  };
  result.renderRef = overrides.renderRef ?? createRenderRef({
    workspaceId: result.workspaceId,
    repoId: result.repoId,
    kind: result.kind,
    canonicalId: result.canonicalId,
    fileId: `file:${result.repoId}:one`,
    path: result.path ?? "src/orders/OrderService.ts"
  });
  return result;
}

function onlineIndex(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: NEO4J_WORKSPACE_FTS_INDEX,
    type: "FULLTEXT",
    state: "ONLINE",
    labelsOrTypes: ["LexicalDocument"],
    properties: ["ftsText"],
    options: {
      indexConfig: {
        "fulltext.analyzer": "standard-no-stop-words",
        "fulltext.eventually_consistent": false
      }
    },
    failureMessage: "",
    ...overrides
  };
}

function statsRevision(params?: Record<string, GraphValue>): string {
  const id = params?.id;
  if (typeof id !== "string" || !id.startsWith("lexical-stats:")) return GENERATION;
  const identity = JSON.parse(id.slice("lexical-stats:".length)) as [string, string, string];
  return identity[2];
}

function statsRow(revision: string, documentCount = 2, indexSizeBytes = 128) {
  return { workspaceId: WORKSPACE, generation: GENERATION, revision, documentCount, indexSizeBytes };
}

function healthyHandler(cypher: string, params?: Record<string, GraphValue>): QueryResult {
  if (cypher.includes("dbms.components")) return [{ version: "5.26.0" }];
  if (cypher.startsWith("SHOW INDEXES")) return [onlineIndex()];
  if (cypher.includes("MATCH (m:LexicalMetadata) RETURN")) {
    return [
      { key: "projectionSchemaVersion", value: LEXICAL_PROJECTION_SCHEMA_VERSION },
      { key: "tokenizerVersion", value: TOKENIZER_VERSION },
      { key: "lexicalStatsSchemaVersion", value: NEO4J_LEXICAL_STATS_SCHEMA_VERSION }
    ];
  }
  if (cypher.includes("MATCH (s:LexicalWorkspaceStats")) {
    return [statsRow(statsRevision(params))];
  }
  return [];
}

describe("Neo4j workspace lexical lifecycle", () => {
  it("uses an O(1) schema fast path for the current lexical version", async () => {
    const db = new MockNeo4jGraphDB();
    db.handler = (cypher, params) => {
      if (cypher.startsWith("SHOW INDEXES")) return [onlineIndex()];
      if (cypher.includes("MATCH (m:LexicalMetadata {key: $key}) RETURN")) {
        const versions: Record<string, string> = {
          projectionSchemaVersion: LEXICAL_PROJECTION_SCHEMA_VERSION,
          tokenizerVersion: TOKENIZER_VERSION,
          lexicalStatsSchemaVersion: NEO4J_LEXICAL_STATS_SCHEMA_VERSION
        };
        const value = versions[String(params?.key)];
        return value ? [{ value }] : [];
      }
      return [];
    };

    await storeWith(db).ensureSchema();

    expect(db.calls.some((call) => /^(CREATE|DROP)/u.test(call.cypher))).toBe(false);
    expect(db.calls.some((call) => call.cypher.includes("MATCH (n:LexicalDocument) SET"))).toBe(false);
    expect(db.calls.some((call) => call.cypher.includes("ftsSizeBytes IS NULL"))).toBe(false);
    expect(db.calls.some((call) => call.cypher.includes("fileId IS NULL"))).toBe(false);
  });

  it("applies exact lexical deltas without owning a transaction or invoking clone, DDL, or corpus scans", async () => {
    const db = new MockNeo4jGraphDB();
    const existingId = (documentId: string) => `lexical-storage:${JSON.stringify([WORKSPACE, GENERATION, documentId])}`;
    db.handler = (cypher, params) => {
      if (cypher.includes("WHERE n.storageId IN $storageIds") && cypher.includes("RETURN n.storageId")) {
        return (params?.storageIds as string[]).map((storageId) => ({
          storageId,
          workspaceId: WORKSPACE,
          active: true,
          ftsSizeBytes: 10
        }));
      }
      if (cypher.includes("MATCH (s:LexicalWorkspaceStats {id: $id})") && cypher.includes("RETURN s.workspaceId")) {
        return [{
          workspaceId: WORKSPACE,
          generation: GENERATION,
          revision: "revision:base",
          documentCount: 2,
          indexSizeBytes: 20
        }];
      }
      if (cypher.includes("RETURN n.documentId AS documentId ORDER BY n.documentId")) {
        return [{ documentId: "lexical:z" }, { documentId: "lexical:a" }, { documentId: "lexical:a" }];
      }
      return [];
    };
    const store = storeWith(db);
    const replacement = document({ title: "Updated Order Service", sourceHash: "hash:updated", batchId: "batch:delta" });
    await store.applyIncrementalMutation({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      expectedRevision: "revision:base",
      nextRevision: "revision:delta",
      upsertDocuments: [replacement],
      deleteDocumentIds: ["lexical:deleted"]
    });

    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.cypher.includes("RETURN count(*)"))).toBe(false);
    expect(db.calls.some((call) => /^(?:CREATE\s+(?:CONSTRAINT|INDEX|FULLTEXT)|DROP|ALTER)\b|\b(?:COPY|LOAD FROM)\b/u.test(call.cypher))).toBe(false);
    expect(db.calls.some((call) => call.cypher.includes("initializeGeneration"))).toBe(false);
    expect(db.calls.find((call) => call.cypher.includes("DELETE n"))?.params).toEqual({
      storageIds: [existingId("lexical:deleted")]
    });
    expect(db.calls.filter((call) => call.cypher.startsWith("UNWIND $documents AS document"))).toHaveLength(1);
    expect(db.calls.find((call) => call.cypher.startsWith("CREATE (:LexicalWorkspaceStats"))?.params)
      .toMatchObject({
        id: statsId("revision:delta"),
        workspaceId: WORKSPACE,
        generation: GENERATION,
        revision: "revision:delta",
        documentCount: 1
      });

    await expect(store.documentIdsForSources({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      repoId: "repo:one",
      fileIds: ["file:repo:one:one"]
    })).resolves.toEqual(["lexical:a", "lexical:z"]);
    const sourceLookup = db.calls.find((call) => call.cypher.includes("n.fileId IN $fileIds"));
    expect(sourceLookup?.params).toMatchObject({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      repoId: "repo:one",
      fileIds: ["file:repo:one:one"]
    });
  });

  it("retries a rolled-back incremental write through a distinct revision stats row", async () => {
    const db = new MockNeo4jGraphDB();
    const statsWrites: string[] = [];
    const committedStats = new Map<string, ReturnType<typeof statsRow>>();
    db.handler = (cypher, params) => {
      if (cypher.includes("RETURN n.storageId AS storageId")) return [];
      if (cypher.includes("MATCH (s:LexicalWorkspaceStats {id: $id})")
        && cypher.includes("RETURN s.workspaceId")) {
        const id = String(params?.id);
        if (id === statsId("revision:base")) return [statsRow("revision:base", 2, 20)];
        const stats = committedStats.get(id);
        return stats ? [stats] : [];
      }
      if (cypher.startsWith("CREATE (:LexicalWorkspaceStats")) {
        const id = String(params?.id);
        statsWrites.push(id);
        committedStats.set(id, statsRow(
          String(params?.revision),
          Number(params?.documentCount),
          Number(params?.indexSizeBytes)
        ));
        return [];
      }
      if (cypher.includes("MATCH (s:LexicalWorkspaceStats {id: $id})")) {
        const stats = committedStats.get(String(params?.id));
        return stats ? [stats] : [];
      }
      return healthyHandler(cypher, params);
    };
    const store = storeWith(db);
    const replacement = document({
      id: "lexical:retry",
      canonicalId: "code:retry",
      sourceHash: "hash:retry",
      batchId: "batch:retry"
    });

    await expect((async () => {
      await store.applyIncrementalMutation({
        workspaceId: WORKSPACE,
        generation: GENERATION,
        expectedRevision: "revision:base",
        nextRevision: "revision:failed",
        upsertDocuments: [replacement],
        deleteDocumentIds: []
      });
      throw new Error("injected outer transaction rollback");
    })()).rejects.toThrow("injected outer transaction rollback");
    committedStats.delete(statsId("revision:failed"));

    await store.applyIncrementalMutation({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      expectedRevision: "revision:base",
      nextRevision: "revision:retry",
      upsertDocuments: [replacement],
      deleteDocumentIds: []
    });

    expect(statsWrites).toEqual([
      statsId("revision:failed"),
      statsId("revision:retry")
    ]);
    expect(statsWrites).not.toContain(statsId("revision:base"));
    const health = await store.health({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      revision: "revision:retry"
    });
    const committedRetryStats = committedStats.get(statsId("revision:retry"));
    expect(health.metrics).toEqual({
      documentCount: committedRetryStats?.documentCount,
      indexSizeBytes: committedRetryStats?.indexSizeBytes
    });
    expect(db.calls.some((call) => call.cypher.includes("SchemaGenerationState"))).toBe(false);
  });

  it("derives active health stats by revision and keeps pending health on the generation revision", async () => {
    const db = new MockNeo4jGraphDB();
    const requestedStatsIds: string[] = [];
    db.handler = (cypher, params) => {
      if (cypher.includes("MATCH (s:SchemaGenerationState")) {
        return [{ activeGeneration: GENERATION, activeRevision: "revision:active" }];
      }
      if (cypher.includes("MATCH (s:LexicalWorkspaceStats {id: $id})")) {
        requestedStatsIds.push(String(params?.id));
        return [statsRow(statsRevision(params))];
      }
      return healthyHandler(cypher, params);
    };
    const store = storeWith(db);

    await store.health({ workspaceId: WORKSPACE, generation: GENERATION });
    await store.pendingHealth({ workspaceId: WORKSPACE, generation: GENERATION });
    await store.health({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      revision: "revision:explicit"
    });

    expect(requestedStatsIds).toEqual([
      statsId("revision:active"),
      statsId(GENERATION),
      statsId("revision:explicit")
    ]);
    expect(db.calls.filter((call) => call.cypher.includes("SchemaGenerationState"))).toHaveLength(1);
  });

  it("reports a missing lexical statistics revision as unhealthy", async () => {
    const db = new MockNeo4jGraphDB();
    db.handler = (cypher, params) => cypher.includes("MATCH (s:LexicalWorkspaceStats {id: $id})")
      ? []
      : healthyHandler(cypher, params);

    const health = await storeWith(db).health({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      revision: "revision:missing"
    });

    expect(health).toMatchObject({
      status: "unhealthy",
      reasons: expect.arrayContaining(["lexical_stats_revision_missing"]),
      metrics: { documentCount: 0, indexSizeBytes: 0 }
    });
  });

  it("deletes every revisioned stats row owned by a removed generation", async () => {
    const db = new MockNeo4jGraphDB();
    db.handler = (cypher) => cypher.includes("SET s.protocolNonce=$nonce")
      ? [{ activeGeneration: "generation:other", pendingGeneration: "" }]
      : [];

    await storeWith(db).deleteGeneration({ workspaceId: WORKSPACE, generation: GENERATION });

    const statsDelete = db.calls.find((call) => call.cypher.includes("MATCH (s:LexicalWorkspaceStats)"));
    expect(statsDelete?.cypher).toContain("s.workspaceId = $workspaceId AND s.generation = $generation DELETE s");
    expect(statsDelete?.params).toEqual({ workspaceId: WORKSPACE, generation: GENERATION });
    expect(statsDelete?.params).not.toHaveProperty("id");
  });

  it("creates idempotent schema and exactly one workspace full-text index", async () => {
    const db = new MockNeo4jGraphDB();
    let indexExists = false;
    db.handler = (cypher) => {
      if (cypher.startsWith("SHOW INDEXES")) return indexExists ? [onlineIndex()] : [];
      if (cypher.startsWith("CREATE FULLTEXT INDEX")) indexExists = true;
      if (cypher.includes("MATCH (m:LexicalMetadata {key: $key}) RETURN")) {
        return [{ value: NEO4J_LEXICAL_STATS_SCHEMA_VERSION }];
      }
      return [];
    };
    const store = storeWith(db);

    await store.ensureSchema();
    await store.ensureSchema();

    const ddl = db.calls.filter((call) => /^(CREATE|DROP)/u.test(call.cypher));
    expect(ddl.filter((call) => call.cypher.startsWith("CREATE"))
      .every((call) => call.cypher.includes("IF NOT EXISTS"))).toBe(true);
    expect(ddl.filter((call) => call.cypher.startsWith("DROP"))
      .every((call) => call.cypher.includes("IF EXISTS"))).toBe(true);
    expect(ddl.filter((call) => call.cypher.startsWith("CREATE FULLTEXT INDEX"))).toHaveLength(1);
    expect(ddl.some((call) => /fulltext.*repo|repo.*fulltext/iu.test(call.cypher))).toBe(false);
    expect(db.calls.some((call) => call.cypher.includes("ON EACH [n.ftsText]"))).toBe(true);
    expect(db.calls.find((call) => call.cypher.startsWith("CREATE FULLTEXT INDEX"))?.cypher)
      .toContain("`fulltext.analyzer`: 'standard-no-stop-words'");
  });

  it("does not advance old projection metadata until commitVersions", async () => {
    const db = new MockNeo4jGraphDB();
    db.handler = (cypher) => {
      if (cypher.startsWith("SHOW INDEXES")) return [onlineIndex()];
      if (cypher.includes("RETURN m.value AS value")) return [{ value: NEO4J_LEXICAL_STATS_SCHEMA_VERSION }];
      return [];
    };
    const store = storeWith(db);
    await store.ensureSchema();
    const ensureMetadata = db.calls.filter((call) => call.cypher.includes("LexicalMetadata"));
    expect(ensureMetadata.filter((call) => call.params?.key === "projectionSchemaVersion" && call.cypher.includes("MERGE"))
      .every((call) => call.cypher.includes("ON CREATE SET"))).toBe(true);
    expect(ensureMetadata.filter((call) => call.params?.key === "tokenizerVersion" && call.cypher.includes("MERGE"))
      .every((call) => call.cypher.includes("ON CREATE SET"))).toBe(true);

    db.calls.length = 0;
    await store.commitVersions();
    expect(db.calls.filter((call) => call.params?.key === "projectionSchemaVersion")[0]?.cypher)
      .toContain("SET m.value = $value");
    expect(db.calls.filter((call) => call.params?.key === "tokenizerVersion")[0]?.cypher)
      .toContain("SET m.value = $value");
  });

  it("repairs an invalid target or additional lexical full-text index idempotently", async () => {
    const db = new MockNeo4jGraphDB();
    let repaired = false;
    db.handler = (cypher) => {
      if (cypher.startsWith("SHOW INDEXES")) return repaired ? [onlineIndex()] : [
        onlineIndex({ type: "RANGE" }),
        onlineIndex({ name: "workspace_lexical_repo_one" })
      ];
      if (cypher.startsWith("CREATE FULLTEXT INDEX")) repaired = true;
      if (cypher.includes("RETURN m.value AS value")) return [{ value: NEO4J_LEXICAL_STATS_SCHEMA_VERSION }];
      return [];
    };
    const store = storeWith(db);
    await store.ensureSchema();
    await store.ensureSchema();
    const drops = db.calls.filter((call) => call.cypher.startsWith("DROP INDEX"));
    expect(drops.map((call) => call.cypher)).toEqual([
      "DROP INDEX `workspace_lexical` IF EXISTS",
      "DROP INDEX `workspace_lexical_repo_one` IF EXISTS"
    ]);
    expect(db.calls.filter((call) => call.cypher.startsWith("CREATE FULLTEXT INDEX"))).toHaveLength(1);
  });

  it("rebuilds eventually-consistent indexes and waits until the replacement is ONLINE", async () => {
    const db = new MockNeo4jGraphDB();
    let created = false;
    let online = false;
    db.handler = (cypher) => {
      if (cypher.startsWith("SHOW INDEXES")) {
        if (!created) return [onlineIndex({
          options: { indexConfig: { "fulltext.eventually_consistent": true } }
        })];
        return [onlineIndex({ state: online ? "ONLINE" : "POPULATING" })];
      }
      if (cypher.startsWith("CREATE FULLTEXT INDEX")) created = true;
      if (cypher.startsWith("CALL db.awaitIndex")) online = true;
      if (cypher.includes("RETURN m.value AS value")) return [{ value: NEO4J_LEXICAL_STATS_SCHEMA_VERSION }];
      return [];
    };
    await storeWith(db).ensureSchema();
    expect(db.calls.some((call) => call.cypher === "DROP INDEX `workspace_lexical` IF EXISTS")).toBe(true);
    expect(db.calls.find((call) => call.cypher.startsWith("CREATE FULLTEXT INDEX"))?.cypher)
      .toContain("`fulltext.eventually_consistent`: false");
    expect(db.calls.find((call) => call.cypher.startsWith("CALL db.awaitIndex"))?.params)
      .toEqual({ indexName: NEO4J_WORKSPACE_FTS_INDEX, timeoutSeconds: 300 });
  });

  it.each([
    [undefined, "missing"],
    ["english", "wrong"]
  ])("rebuilds an index with %s analyzer configuration", async (analyzer, _case) => {
    const db = new MockNeo4jGraphDB();
    let created = false;
    let online = false;
    db.handler = (cypher) => {
      if (cypher.startsWith("SHOW INDEXES")) {
        if (!created) return [onlineIndex({
          options: {
            indexConfig: {
              ...(analyzer === undefined ? {} : { "fulltext.analyzer": analyzer }),
              "fulltext.eventually_consistent": false
            }
          }
        })];
        return [onlineIndex({ state: online ? "ONLINE" : "POPULATING" })];
      }
      if (cypher.startsWith("CREATE FULLTEXT INDEX")) created = true;
      if (cypher.startsWith("CALL db.awaitIndex")) online = true;
      if (cypher.includes("RETURN m.value AS value")) return [{ value: NEO4J_LEXICAL_STATS_SCHEMA_VERSION }];
      return [];
    };

    await storeWith(db).ensureSchema();
    expect(db.calls.some((call) => call.cypher === "DROP INDEX `workspace_lexical` IF EXISTS")).toBe(true);
    expect(db.calls.find((call) => call.cypher.startsWith("CREATE FULLTEXT INDEX"))?.cypher)
      .toContain(`\`fulltext.analyzer\`: '${NEO4J_LEXICAL_ANALYZER}'`);
    expect(db.calls.some((call) => call.cypher.startsWith("CALL db.awaitIndex"))).toBe(true);
  });

  it("wraps an index ONLINE wait timeout as schema_failed", async () => {
    const db = new MockNeo4jGraphDB();
    db.handler = (cypher) => {
      if (cypher.startsWith("SHOW INDEXES")) return [];
      if (cypher.startsWith("CALL db.awaitIndex")) throw new Error("Index did not come online");
      return [];
    };
    await expect(storeWith(db).ensureSchema()).rejects.toMatchObject({
      code: "schema_failed",
      context: { operation: "ensureSchema" }
    });
  });

  it("writes deterministic bounded UNWIND chunks outside the final pointer transaction", async () => {
    const db = new MockNeo4jGraphDB();
    const store = storeWith(db);
    const documents = Array.from({ length: NEO4J_LEXICAL_UPSERT_CHUNK_SIZE + 1 }, (_, index) =>
      document({ id: `lexical:${String(index).padStart(4, "0")}`, canonicalId: `code:${index}` }));

    await store.upsertDocuments({ workspaceId: WORKSPACE, generation: GENERATION, documents });
    const chunks = db.calls.filter((call) => call.cypher.startsWith("UNWIND $documents"));
    expect(chunks).toHaveLength(2);
    expect((chunks[0]?.params?.documents as GraphValue[])).toHaveLength(NEO4J_LEXICAL_UPSERT_CHUNK_SIZE);
    expect((chunks[1]?.params?.documents as GraphValue[])).toHaveLength(1);
    expect(chunks[0]?.params?.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: "lexical:0000",
        generation: GENERATION,
        workspaceId: WORKSPACE,
        ftsText: expect.any(String),
        ftsSizeBytes: expect.any(Number)
      })
    ]));
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();

    const failed = new MockNeo4jGraphDB();
    let chunk = 0;
    failed.interceptor = (cypher) => {
      if (cypher.startsWith("UNWIND $documents") && ++chunk === 2) throw new Error("chunk failed");
      return undefined;
    };
    await expect(storeWith(failed).upsertDocuments({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      documents
    })).rejects.toMatchObject({
      code: "write_failed",
      context: {
        operation: "upsertDocuments",
        workspaceId: WORKSPACE,
        generation: GENERATION,
        batchId: "batch:one"
      }
    });
    expect(failed.commitTransaction).not.toHaveBeenCalled();
    expect(failed.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("deduplicates identical ids and rejects conflicting or cross-workspace ids", async () => {
    const db = new MockNeo4jGraphDB();
    const store = storeWith(db);
    const one = document();
    await store.upsertDocuments({ workspaceId: WORKSPACE, generation: GENERATION, documents: [one, one] });
    const rows = db.calls.find((call) => call.cypher.startsWith("UNWIND $documents"))?.params?.documents as GraphValue[];
    expect(rows).toHaveLength(1);

    await expect(store.upsertDocuments({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      documents: [one, { ...one, title: "conflict" }]
    })).rejects.toMatchObject({ code: "write_failed" });
    const foreign = new MockNeo4jGraphDB();
    foreign.handler = (cypher, params) => cypher.includes("WHERE n.storageId IN $storageIds")
      ? [{
        storageId: (params?.storageIds as string[])[0],
        workspaceId: "workspace:foreign",
        active: true,
        ftsSizeBytes: 1
      }]
      : [];
    await expect(storeWith(foreign).upsertDocuments({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      documents: [one]
    })).rejects.toMatchObject({ code: "write_failed" });
    expect(foreign.rollbackTransaction).not.toHaveBeenCalled();

    const raced = new MockNeo4jGraphDB();
    raced.interceptor = (cypher) => cypher.startsWith("UNWIND $documents AS document MERGE")
      ? [{ written: 0 }]
      : undefined;
    await expect(storeWith(raced).upsertDocuments({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      documents: [one]
    })).rejects.toMatchObject({ code: "write_failed" });
    expect(raced.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("scopes reconcile and cleanup, supports empty active sets, and is retry-safe", async () => {
    const db = new MockNeo4jGraphDB();
    db.handler = (cypher) => cypher.includes("RETURN documentCount, indexSizeBytes")
      ? [{ documentCount: 0, indexSizeBytes: 0 }]
      : [];
    const store = storeWith(db);
    await store.reconcileRepoDocuments({ workspaceId: WORKSPACE, generation: GENERATION, repoId: "repo:one", batchId: "batch:one", activeDocumentIds: [] });
    await store.reconcileRepoDocuments({ workspaceId: WORKSPACE, generation: GENERATION, repoId: "repo:one", batchId: "batch:one", activeDocumentIds: [] });
    await store.cleanupBatch({ workspaceId: WORKSPACE, batchId: "batch:failed" });
    await store.cleanupBatch({ workspaceId: WORKSPACE, batchId: "batch:failed" });

    const reconcile = db.calls.filter((call) => call.cypher.includes("n.repoId = $repoId"));
    expect(reconcile).toHaveLength(2);
    expect(reconcile.every((call) => call.cypher.includes("n.workspaceId = $workspaceId")
      && call.cypher.includes("n.generation = $generation")
      && call.cypher.includes("n.active = true")
      && call.params?.generation === GENERATION
      && call.params?.activeDocumentIds instanceof Array)).toBe(true);
    const cleanup = db.calls.filter((call) => call.cypher.includes("LexicalGenerationBatch")
      && call.cypher.includes("b.batchId = $batchId"));
    expect(cleanup).toHaveLength(2);
    expect(cleanup.every((call) => call.cypher.includes("b.workspaceId = $workspaceId"))).toBe(true);
    const deltas = db.calls.filter((call) => call.cypher.includes("documentCountDelta"));
    expect(deltas.every((call) => call.params?.documentCountDelta === 0 && call.params?.indexSizeBytesDelta === 0)).toBe(true);
  });

  it("performs one workspace-global native search with stable ordering and rank", async () => {
    const db = new MockNeo4jGraphDB();
    db.handler = (cypher) => cypher.includes("db.index.fulltext.queryNodes") ? [
      { canonicalId: "code:a", documentId: "lexical:a", repoId: "repo:a", kind: "code", renderRef: "render:a", score: 1 },
      { canonicalId: "code:b", documentId: "lexical:b", repoId: "repo:b", kind: "code", renderRef: "render:b", score: 1 }
    ] : [];
    const store = storeWith(db);
    const hits = await store.search({ workspaceId: WORKSPACE, generation: GENERATION, text: "order" }, { topK: 2 });
    expect(db.calls.filter((call) => call.cypher.includes("db.index.fulltext.queryNodes"))).toHaveLength(1);
    const query = db.calls.find((call) => call.cypher.includes("db.index.fulltext.queryNodes"))!;
    expect(query.cypher).toContain("node.workspaceId = $workspaceId AND node.generation = $generation AND node.active = true");
    expect(query.cypher).toContain("ORDER BY score DESC, documentId ASC LIMIT toInteger($topK)");
    expect(query.params).toMatchObject({
      indexName: NEO4J_WORKSPACE_FTS_INDEX,
      text: "order",
      workspaceId: WORKSPACE,
      generation: GENERATION,
      topK: 2
    });
    expect(hits.map((hit) => [hit.documentId, hit.rank])).toEqual([["lexical:a", 1], ["lexical:b", 2]]);
    db.calls.length = 0;
    await expect(store.search({ workspaceId: WORKSPACE, generation: GENERATION, text: "   " }, { topK: 2 })).resolves.toEqual([]);
    expect(db.calls).toHaveLength(0);
    await expect(store.search({ workspaceId: WORKSPACE, generation: GENERATION, text: "order" }, { topK: 0 })).rejects.toMatchObject({ code: "search_failed" });
  });

  it.each([
    ["src\\orders\\OrderService.ts", "ident_src_orders_orderservice_ts"],
    ["Find api/src/contracts/orders.ts", "ident_src_contracts_orders_ts"],
    ["GET /orders/{orderId}", "ident_orderid"],
    ["order-created", "ident_order_created"],
    ["谁消费库存同步事件？", "cjk_库存"],
    ["哪个 worker consumes OrderCreatedEvent 订单事件", "ordercreatedevent"],
    ["CatalogItemSchema 的稳定字段是什么？", "catalogitemschema"],
    ["+ - && || ! ( ) { } [ ] ^ \" ~ * ? : \\ /", ""]
  ])("normalizes Neo4j Lucene query text %j safely", (text, expected) => {
    const normalized = normalizeNeo4jFullTextQuery(text);
    expect(normalized).toBe(expected);
    expect(Array.from("+-&|!(){}[]^\"~*?:\\/").some((character) => normalized.includes(character))).toBe(false);
  });

  it("passes only normalized text to the native procedure and skips empty normalization", async () => {
    const db = new MockNeo4jGraphDB();
    const store = storeWith(db);
    await store.search({ workspaceId: WORKSPACE, generation: GENERATION, text: "order-created" }, { topK: 5 });
    expect(db.calls.find((call) => call.cypher.includes("db.index.fulltext.queryNodes"))?.params?.text)
      .toBe("ident_order_created");
    db.calls.length = 0;
    await expect(store.search({ workspaceId: WORKSPACE, generation: GENERATION, text: "+ && !" }, { topK: 5 })).resolves.toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it("loads only requested workspace documents, sorts by id, and skips empty ids", async () => {
    const db = new MockNeo4jGraphDB();
    db.handler = (cypher) => cypher.includes("RETURN n.storageId AS storageId") ? [
      {
        ...document({ id: "lexical:a" }),
        storageId: "storage:a",
        documentId: "lexical:a",
        generation: GENERATION,
        qualifiedName: null,
        path: null
      }
    ] : [];
    const store = storeWith(db);
    const expected = document({ id: "lexical:a" });
    delete expected.qualifiedName;
    delete expected.path;
    expect(await store.loadDocuments({ workspaceId: WORKSPACE, generation: GENERATION, documentIds: ["lexical:a", "lexical:a"] }))
      .toEqual([expected]);
    const query = db.calls.find((call) => call.cypher.includes("RETURN n.storageId AS storageId"))!;
    expect(query.cypher).toContain("n.workspaceId = $workspaceId");
    expect(query.cypher).toContain("n.generation = $generation AND n.documentId IN $documentIds");
    expect(query.cypher).toContain("ORDER BY n.documentId");
    expect(query.params?.documentIds).toEqual(["lexical:a"]);
    expect(query.params?.generation).toBe(GENERATION);
    db.calls.length = 0;
    await expect(store.loadDocuments({ workspaceId: WORKSPACE, generation: GENERATION, documentIds: [] })).resolves.toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it.each([
    ["POPULATING", "fts_index_populating"],
    ["FAILED", "fts_index_failed"],
    ["OFFLINE", "fts_index_not_online"]
  ])("reports %s full-text state as structured unhealthy", async (state, reason) => {
    const db = new MockNeo4jGraphDB();
    db.handler = (cypher) => cypher.startsWith("SHOW INDEXES")
      ? [onlineIndex({ state })]
      : healthyHandler(cypher);
    const health = await storeWith(db).health({ workspaceId: WORKSPACE, generation: GENERATION });
    expect(health.status).toBe("unhealthy");
    expect(health.reasons).toContain(reason);
  });

  it("reports healthy logical payload metrics and stable index/version/metadata failures", async () => {
    const healthyDb = new MockNeo4jGraphDB();
    healthyDb.handler = healthyHandler;
    expect(await storeWith(healthyDb).health({ workspaceId: WORKSPACE, generation: GENERATION })).toEqual({
      providerVersion: "5.26.0",
      projectionSchemaVersion: LEXICAL_PROJECTION_SCHEMA_VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
      status: "healthy",
      reasons: [],
      metrics: { documentCount: 2, indexSizeBytes: 128 }
    });
    expect(healthyDb.calls.some((call) => call.cypher.includes("MATCH (n:LexicalDocument)"))).toBe(false);

    const cases: Array<[QueryResult, string, string?]> = [
      [[], "fts_index_missing"],
      [[onlineIndex({ type: "RANGE" })], "fts_index_type_mismatch"],
      [[onlineIndex({ properties: ["searchableText"] })], "fts_index_definition_mismatch"],
      [[onlineIndex({ options: { indexConfig: { "fulltext.eventually_consistent": false } } })], "fts_index_analyzer_mismatch"],
      [[onlineIndex({ options: { indexConfig: {
        "fulltext.analyzer": "english",
        "fulltext.eventually_consistent": false
      } } })], "fts_index_analyzer_mismatch"],
      [[onlineIndex({ options: { indexConfig: { "fulltext.eventually_consistent": true } } })], "fts_index_consistency_mismatch"]
    ];
    for (const [indexes, reason] of cases) {
      const db = new MockNeo4jGraphDB();
      db.handler = (cypher) => cypher.startsWith("SHOW INDEXES") ? indexes : healthyHandler(cypher);
      expect((await storeWith(db).health({ workspaceId: WORKSPACE, generation: GENERATION })).reasons).toContain(reason);
    }

    const badMetadata = new MockNeo4jGraphDB();
    badMetadata.handler = (cypher) => {
      if (cypher.startsWith("SHOW INDEXES")) return [onlineIndex()];
      if (cypher.includes("dbms.components")) return [{ version: "4.4.0" }];
      if (cypher.includes("MATCH (m:LexicalMetadata) RETURN")) return [];
      return [];
    };
    const unhealthy = await storeWith(badMetadata).health({ workspaceId: WORKSPACE, generation: GENERATION });
    expect(unhealthy.reasons).toEqual(expect.arrayContaining([
      "provider_version_incompatible",
      "projection_schema_version_mismatch",
      "tokenizer_version_mismatch",
      "lexical_stats_version_mismatch"
    ]));
  });

  it("keeps interrupted metadata/stat initialization retryable and wraps provider errors with context", async () => {
    const metadataDb = new MockNeo4jGraphDB();
    let metadataFailure = true;
    metadataDb.handler = (cypher, params) => {
      if (cypher.startsWith("SHOW INDEXES")) return [onlineIndex()];
      if (params?.key === "tokenizerVersion" && cypher.includes("ON CREATE SET") && metadataFailure) {
        metadataFailure = false;
        throw new Error("metadata initialization interrupted");
      }
      if (cypher.includes("RETURN m.value AS value")) return [{ value: NEO4J_LEXICAL_STATS_SCHEMA_VERSION }];
      return [];
    };
    const metadataStore = storeWith(metadataDb);
    await expect(metadataStore.ensureSchema()).rejects.toMatchObject({ code: "schema_failed" });
    await expect(metadataStore.ensureSchema()).resolves.toBeUndefined();
    expect(metadataDb.rollbackTransaction).toHaveBeenCalledTimes(1);

    const db = new MockNeo4jGraphDB();
    let fail = true;
    db.handler = (cypher) => {
      if (cypher.startsWith("SHOW INDEXES")) return [onlineIndex()];
      if (cypher.includes("MATCH (m:LexicalMetadata {key: $key}) RETURN")) return [];
      if (cypher.includes("MATCH (s:LexicalWorkspaceStats) DELETE") && fail) {
        fail = false;
        throw new Error("stats rebuild interrupted");
      }
      return [];
    };
    const store = storeWith(db);
    await expect(store.ensureSchema()).rejects.toMatchObject({ code: "schema_failed", context: { operation: "ensureSchema" } });
    await expect(store.ensureSchema()).resolves.toBeUndefined();
    expect(db.calls.filter((call) => call.params?.key === "lexicalStatsSchemaVersion"
      && call.params?.value === NEO4J_LEXICAL_STATS_SCHEMA_VERSION)).toHaveLength(1);

    const broken = new MockNeo4jGraphDB();
    broken.handler = () => { throw new Error("neo4j unavailable"); };
    const call = storeWith(broken).cleanupBatch({ workspaceId: WORKSPACE, batchId: "batch:failed" });
    await expect(call).rejects.toBeInstanceOf(WorkspaceLexicalStoreError);
    await expect(call).rejects.toMatchObject({
      code: "cleanup_failed",
      context: { operation: "cleanupBatch", workspaceId: WORKSPACE, batchId: "batch:failed" }
    });
  });
});
