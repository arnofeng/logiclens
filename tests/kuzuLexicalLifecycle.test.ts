import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLexicalStoreError } from "../src/core/retrieval/provider.js";
import {
  LEXICAL_PROJECTION_SCHEMA_VERSION,
  TOKENIZER_VERSION,
  type LexicalDocument
} from "../src/core/retrieval/types.js";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import {
  KUZU_WORKSPACE_FTS_INDEX,
  KuzuWorkspaceLexicalStore
} from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";

const WORKSPACE = "workspace:lifecycle";
const FOREIGN_WORKSPACE = "workspace:foreign";

function document(overrides: Partial<LexicalDocument> = {}): LexicalDocument {
  return {
    id: "lexical:code:one",
    canonicalId: "code:one",
    workspaceId: WORKSPACE,
    repoId: "repo:one",
    kind: "code",
    title: "OrderService",
    qualifiedName: "Orders.OrderService",
    path: "src/orders/OrderService.ts",
    searchableText: "OrderService 创建订单 create_order src/orders/OrderService.ts",
    tokens: ["orderservice", "order", "service", "create_order", "ident_create_order", "cjk_创建"],
    active: true,
    sourceHash: "hash:one",
    batchId: "batch:one",
    renderRef: "render:one",
    ...overrides
  };
}

describe("Kuzu workspace lexical lifecycle", () => {
  let directory = "";
  let db: KuzuGraphDB;
  let store: KuzuWorkspaceLexicalStore;
  let previousCloseMode: string | undefined;

  beforeEach(async () => {
    previousCloseMode = process.env.LOGICLENS_KUZU_CLOSE_MODE;
    process.env.LOGICLENS_KUZU_CLOSE_MODE = "explicit";
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-kuzu-lexical-"));
    db = await KuzuGraphDB.open(path.join(directory, "graph.kuzu"));
    store = new KuzuWorkspaceLexicalStore(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    if (previousCloseMode === undefined) delete process.env.LOGICLENS_KUZU_CLOSE_MODE;
    else process.env.LOGICLENS_KUZU_CLOSE_MODE = previousCloseMode;
  });

  it("retries interrupted stats migration and keeps schema and the workspace FTS index idempotent", async () => {
    await db.query(
      "CREATE NODE TABLE LexicalDocument(" +
      "id STRING, workspaceId STRING, searchableText STRING, active BOOL, ftsText STRING, PRIMARY KEY(id));"
    );
    await db.query(
      "CREATE (:LexicalDocument {id: 'legacy:one', workspaceId: $workspaceId, " +
      "searchableText: 'legacy text', active: true, ftsText: 'legacy text'});",
      { workspaceId: WORKSPACE }
    );
    await db.query(
      "CREATE NODE TABLE LexicalMetadata(key STRING, value STRING, PRIMARY KEY(key));"
    );
    await db.query(
      "CREATE (:LexicalMetadata {key: 'lexicalStatsSchemaVersion', value: '1'});"
    );
    const originalQuery = db.query.bind(db);
    const interrupted = vi.spyOn(db, "query").mockImplementation(async (cypher, params) => {
      if (cypher === "MATCH (n:LexicalDocument {id: $id}) SET n.ftsSizeBytes = $ftsSizeBytes;") {
        throw new Error("injected fts size backfill failure");
      }
      return originalQuery(cypher, params) as ReturnType<typeof db.query>;
    });
    await expect(store.ensureSchema()).rejects.toMatchObject({
      code: "schema_failed",
      context: { operation: "ensureSchema" }
    });
    interrupted.mockRestore();

    const interruptedHealth = await store.health(WORKSPACE);
    expect(interruptedHealth).toMatchObject({
      status: "unhealthy",
      reasons: expect.arrayContaining(["lexical_stats_version_mismatch"]),
      metrics: { documentCount: 0, indexSizeBytes: 0 }
    });
    expect(interruptedHealth.reasons).not.toContain("lexical_stats_table_missing");
    expect((await db.query<{ name: string }>("CALL table_info('LexicalDocument') RETURN name;"))
      .map((column) => column.name)).toContain("ftsSizeBytes");
    expect(await db.query<{ ftsSizeBytes: number | null }>(
      "MATCH (n:LexicalDocument {id: 'legacy:one'}) RETURN n.ftsSizeBytes AS ftsSizeBytes;"
    )).toEqual([{ ftsSizeBytes: null }]);

    await store.ensureSchema();
    await store.ensureSchema();
    expect(await store.health(WORKSPACE)).toMatchObject({
      status: "healthy",
      reasons: [],
      metrics: { documentCount: 1, indexSizeBytes: Buffer.byteLength("legacy text", "utf8") }
    });

    await db.query(
      "MATCH (m:LexicalMetadata {key: 'lexicalStatsSchemaVersion'}) SET m.value = 'incomplete';"
    );
    const rebuildInterrupted = vi.spyOn(db, "query").mockImplementation(async (cypher, params) => {
      if (cypher === "MATCH (s:LexicalWorkspaceStats) DELETE s;") {
        throw new Error("injected stats rebuild failure");
      }
      return originalQuery(cypher, params) as ReturnType<typeof db.query>;
    });
    await expect(store.ensureSchema()).rejects.toMatchObject({ code: "schema_failed" });
    rebuildInterrupted.mockRestore();
    expect((await store.health(WORKSPACE)).reasons).toContain("lexical_stats_version_mismatch");
    await store.ensureSchema();
    expect(await store.health(WORKSPACE)).toMatchObject({
      status: "healthy",
      metrics: { documentCount: 1, indexSizeBytes: Buffer.byteLength("legacy text", "utf8") }
    });
    await store.ensureSchema();

    const columns = await db.query<{ name: string }>("CALL table_info('LexicalDocument') RETURN name;");
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "id", "canonicalId", "workspaceId", "repoId", "kind", "title", "qualifiedName", "path",
      "searchableText", "tokens", "active", "sourceHash", "batchId", "renderRef", "ftsText", "ftsSizeBytes"
    ]));
    const indexes = await db.query<{
      table_name: string;
      index_name: string;
      index_type: string;
      property_names: string[];
    }>("CALL SHOW_INDEXES() RETURN table_name, index_name, index_type, property_names;");
    const lexicalIndexes = indexes.filter((index) => index.table_name === "LexicalDocument");
    expect(lexicalIndexes).toEqual([{
      table_name: "LexicalDocument",
      index_name: KUZU_WORKSPACE_FTS_INDEX,
      index_type: "FTS",
      property_names: ["ftsText"]
    }]);
    expect(lexicalIndexes.some((index) => /repo/i.test(index.index_name))).toBe(false);
  });

  it("handles empty, update, load, conflict, and rollback upsert boundaries", async () => {
    const untouched = vi.spyOn(db, "query");
    await expect(store.upsertDocuments([])).resolves.toBeUndefined();
    expect(untouched).not.toHaveBeenCalled();
    untouched.mockRestore();

    await store.ensureSchema();
    const created = document();
    const updated = document({
      title: "Updated Order Service",
      qualifiedName: undefined,
      path: undefined,
      searchableText: "updated unicode 搜索 tokenizedIdentifier",
      tokens: ["updated", "cjk_搜索", "tokenized", "identifier"],
      active: false,
      sourceHash: "hash:updated",
      renderRef: "render:updated"
    });
    await store.upsertDocuments([created]);
    await store.upsertDocuments([updated]);

    const rows = await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [created.id] });
    const counts = await db.query<{ count: number }>("MATCH (n:LexicalDocument) RETURN count(*) AS count;");
    expect(counts[0]?.count).toBe(1);
    expect(rows).toEqual([updated]);

    const foreign = document({
      id: "lexical:foreign-a",
      canonicalId: "code:foreign-a",
      workspaceId: FOREIGN_WORKSPACE
    });
    await store.upsertDocuments([foreign]);
    expect(await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [] })).toEqual([]);
    expect((await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [foreign.id, created.id] }))
      .map((entry) => entry.canonicalId)).toEqual([updated.canonicalId]);

    await expect(store.upsertDocuments([
      document({ id: "lexical:conflict:a" }),
      document({ id: "lexical:conflict:b", workspaceId: FOREIGN_WORKSPACE })
    ])).rejects.toMatchObject({
      name: "WorkspaceLexicalStoreError",
      code: "write_failed",
      context: { operation: "upsertDocuments", workspaceId: WORKSPACE, batchId: "batch:one" }
    });

    const originalQuery = db.query.bind(db);
    let writes = 0;
    const query = vi.spyOn(db, "query").mockImplementation(async (cypher, params) => {
      if (cypher.startsWith("MERGE (n:LexicalDocument")) {
        writes++;
        if (writes === 2) throw new Error("injected write failure");
      }
      return originalQuery(cypher, params) as ReturnType<typeof db.query>;
    });

    const call = store.upsertDocuments([
      document({ id: "lexical:code:a", canonicalId: "code:a" }),
      document({ id: "lexical:code:b", canonicalId: "code:b" })
    ]);
    await expect(call).rejects.toMatchObject({
      code: "write_failed",
      context: { operation: "upsertDocuments", workspaceId: WORKSPACE, batchId: "batch:one" }
    });
    query.mockRestore();
    expect(await store.loadDocuments({
      workspaceId: WORKSPACE,
      documentIds: ["lexical:code:a", "lexical:code:b"]
    })).toEqual([]);
  });

  it("reconciles only the requested repo and supports stale, delete, empty-set, and retry flows", async () => {
    await store.ensureSchema();
    const keep = document({ id: "lexical:code:keep", canonicalId: "code:keep" });
    const stale = document({ id: "lexical:code:stale", canonicalId: "code:stale" });
    const otherRepo = document({ id: "lexical:code:other", canonicalId: "code:other", repoId: "repo:two" });
    const otherWorkspace = document({
      id: "lexical:code:foreign",
      canonicalId: "code:foreign",
      workspaceId: FOREIGN_WORKSPACE
    });
    await store.upsertDocuments([keep, stale, otherRepo]);
    await store.upsertDocuments([otherWorkspace]);

    await store.reconcileRepoDocuments({
      workspaceId: WORKSPACE,
      repoId: "repo:one",
      batchId: "batch:one",
      activeDocumentIds: [keep.id]
    });
    expect(await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [keep.id, stale.id, otherRepo.id] }))
      .toEqual([keep, { ...stale, active: false }, otherRepo].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await store.loadDocuments({ workspaceId: FOREIGN_WORKSPACE, documentIds: [otherWorkspace.id] }))
      .toEqual([otherWorkspace]);

    await store.upsertDocuments([stale]);
    await store.reconcileRepoDocuments({
      workspaceId: WORKSPACE,
      repoId: "repo:one",
      batchId: "batch:one",
      activeDocumentIds: []
    });
    await store.reconcileRepoDocuments({
      workspaceId: WORKSPACE,
      repoId: "repo:one",
      batchId: "batch:one",
      activeDocumentIds: []
    });
    const deleted = await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [keep.id, stale.id] });
    expect(deleted.every((entry) => entry.active === false)).toBe(true);

    const failed = document({ id: "lexical:failed", canonicalId: "code:failed", batchId: "batch:failed" });
    const successful = document({ id: "lexical:successful", canonicalId: "code:successful", batchId: "batch:ok" });
    const foreign = document({
      id: "lexical:foreign",
      canonicalId: "code:foreign",
      workspaceId: FOREIGN_WORKSPACE,
      batchId: "batch:failed"
    });
    await store.upsertDocuments([failed]);
    await store.upsertDocuments([successful]);
    await store.upsertDocuments([foreign]);

    await store.cleanupBatch({ workspaceId: WORKSPACE, batchId: "batch:failed" });
    await store.cleanupBatch({ workspaceId: WORKSPACE, batchId: "batch:failed" });
    const local = await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [failed.id, successful.id] });
    expect(local.find((entry) => entry.id === failed.id)?.active).toBe(false);
    expect(local.find((entry) => entry.id === successful.id)?.active).toBe(true);
    expect(await store.loadDocuments({ workspaceId: FOREIGN_WORKSPACE, documentIds: [foreign.id] })).toEqual([foreign]);

    await store.upsertDocuments([{ ...failed, active: true }]);
    expect((await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [failed.id] }))[0]?.active).toBe(true);
  });

  it("runs one native query for a workspace-global top-k with stable ties and excludes inactive data", async () => {
    await store.ensureSchema();
    const docs = [
      document({ id: "lexical:a", canonicalId: "code:a", repoId: "repo:a", searchableText: "sharedmarker", tokens: ["sharedmarker"] }),
      document({ id: "lexical:b", canonicalId: "code:b", repoId: "repo:b", searchableText: "sharedmarker", tokens: ["sharedmarker"] }),
      document({ id: "lexical:c", canonicalId: "code:c", repoId: "repo:c", searchableText: "sharedmarker", tokens: ["sharedmarker"] }),
      document({ id: "lexical:inactive", canonicalId: "code:inactive", searchableText: "sharedmarker", tokens: ["sharedmarker"], active: false })
    ];
    await store.upsertDocuments(docs);
    await store.upsertDocuments([document({
      id: "lexical:foreign",
      canonicalId: "code:foreign",
      workspaceId: FOREIGN_WORKSPACE,
      searchableText: "sharedmarker",
      tokens: ["sharedmarker"]
    })]);
    let nativeCalls = 0;
    const originalQuery = db.query.bind(db);
    const query = vi.spyOn(db, "query").mockImplementation(async (cypher, params) => {
      if (cypher.includes("QUERY_FTS_INDEX")) nativeCalls++;
      return originalQuery(cypher, params) as ReturnType<typeof db.query>;
    });

    const hits = await store.search({ workspaceId: WORKSPACE, text: "sharedMarker" }, { topK: 2 });
    query.mockRestore();
    expect(nativeCalls).toBe(1);
    expect(hits.map((hit) => [hit.documentId, hit.repoId, hit.rank, hit.matchReasons])).toEqual([
      ["lexical:a", "repo:a", 1, ["full-text"]],
      ["lexical:b", "repo:b", 2, ["full-text"]]
    ]);

    await store.upsertDocuments([document()]);

    for (const text of ["创建", "OrderService", "create_order", "src/orders/OrderService.ts"]) {
      expect((await store.search({ workspaceId: WORKSPACE, text }, { topK: 5 }))[0]?.documentId).toBe("lexical:code:one");
    }
    const blankQuery = vi.spyOn(db, "query");
    await expect(store.search({ workspaceId: WORKSPACE, text: "   " }, { topK: 5 })).resolves.toEqual([]);
    expect(blankQuery.mock.calls.some(([cypher]) => String(cypher).includes("QUERY_FTS_INDEX"))).toBe(false);
    await expect(store.search({ workspaceId: WORKSPACE, text: "order" }, { topK: 0 })).rejects.toMatchObject({
      code: "search_failed",
      context: { operation: "search", workspaceId: WORKSPACE }
    });
  });

  it("reports healthy versions, document count, and a nonzero logical index size", async () => {
    await store.ensureSchema();
    const first = document({ id: "lexical:stats:a", canonicalId: "code:stats:a" });
    const second = document({
      id: "lexical:stats:b",
      canonicalId: "code:stats:b",
      searchableText: "统计 unicode bytes",
      tokens: ["统计", "unicode", "bytes"]
    });
    await store.upsertDocuments([first, second]);
    const expectedBytes = [first, second].reduce((total, entry) =>
      total + Buffer.byteLength([entry.searchableText, ...entry.tokens].join(" "), "utf8"), 0);

    const query = vi.spyOn(db, "query");
    const health = await store.health(WORKSPACE);
    expect(health).toMatchObject({
      providerVersion: "0.11.3",
      projectionSchemaVersion: LEXICAL_PROJECTION_SCHEMA_VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
      status: "healthy",
      reasons: [],
      metrics: { documentCount: 2, indexSizeBytes: expectedBytes }
    });
    expect(query.mock.calls.some(([cypher]) =>
      String(cypher).includes("MATCH (n:LexicalDocument)") || String(cypher).includes("n.ftsText")
    )).toBe(false);
    query.mockRestore();

    await store.upsertDocuments([{ ...second, active: false }]);
    expect((await store.health(WORKSPACE)).metrics).toEqual({
      documentCount: 1,
      indexSizeBytes: Buffer.byteLength([first.searchableText, ...first.tokens].join(" "), "utf8")
    });
    await store.upsertDocuments([second]);
    expect((await store.health(WORKSPACE)).metrics).toEqual({ documentCount: 2, indexSizeBytes: expectedBytes });
  });

  it("returns structured unhealthy reasons for metadata mismatch and missing or abnormal FTS state", async () => {
    await store.ensureSchema();
    const query = vi.spyOn(db, "query");
    query.mockResolvedValueOnce([{ version: "unknown" }] as never);
    expect(await store.health(WORKSPACE)).toMatchObject({
      providerVersion: "unknown",
      status: "unhealthy",
      reasons: expect.arrayContaining(["provider_version_unknown"])
    });
    query.mockResolvedValueOnce([{ version: "0.11.2" }] as never);
    expect(await store.health(WORKSPACE)).toMatchObject({
      providerVersion: "0.11.2",
      status: "unhealthy",
      reasons: expect.arrayContaining(["provider_version_incompatible"])
    });
    query.mockResolvedValueOnce([{ version: "0.12.0" }] as never);
    expect(await store.health(WORKSPACE)).toMatchObject({
      providerVersion: "0.12.0",
      status: "unhealthy",
      reasons: expect.arrayContaining(["provider_version_incompatible"])
    });
    query.mockRestore();

    await store.upsertDocuments([document()]);
    await db.query("MATCH (m:LexicalMetadata {key: 'projectionSchemaVersion'}) SET m.value = 'old';");
    await db.query("MATCH (m:LexicalMetadata {key: 'tokenizerVersion'}) SET m.value = 'old';");
    await store.ensureSchema();
    const beforeCommit = await store.health(WORKSPACE);
    expect(beforeCommit.status).toBe("unhealthy");
    expect(beforeCommit.reasons).toEqual(expect.arrayContaining([
      "projection_schema_version_mismatch",
      "tokenizer_version_mismatch"
    ]));

    await store.commitVersions();
    expect(await store.health(WORKSPACE)).toMatchObject({ status: "healthy", reasons: [] });
    await db.query("CALL DROP_FTS_INDEX('LexicalDocument', 'workspace_lexical');");

    const missing = await store.health(WORKSPACE);
    expect(missing.status).toBe("unhealthy");
    expect(missing.reasons).toContain("fts_index_missing");
    await db.query("CALL CREATE_FTS_INDEX('LexicalDocument', 'workspace_lexical', ['searchableText']);");
    const abnormal = await store.health(WORKSPACE);
    expect(abnormal.status).toBe("unhealthy");
    expect(abnormal.reasons).toContain("fts_index_definition_mismatch");
  });

  it("wraps genuine adapter failures in the provider-neutral health boundary", async () => {
    vi.spyOn(db, "query").mockRejectedValueOnce(new Error("adapter unavailable"));
    const call = store.health(WORKSPACE);
    await expect(call).rejects.toBeInstanceOf(WorkspaceLexicalStoreError);
    await expect(call).rejects.toMatchObject({
      code: "health_check_failed",
      context: { operation: "health", workspaceId: WORKSPACE }
    });
  });
});
