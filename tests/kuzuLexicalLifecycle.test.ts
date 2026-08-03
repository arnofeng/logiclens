import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLexicalStoreError } from "../src/core/retrieval/provider.js";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
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
const GENERATION = "generation:lifecycle";

function document(overrides: Partial<LexicalDocument> = {}): LexicalDocument {
  const result: LexicalDocument = {
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

class GenerationPinnedKuzuStore {
  generation = GENERATION;

  constructor(private readonly store: KuzuWorkspaceLexicalStore) {}

  ensureSchema(): Promise<void> { return this.store.ensureSchema(); }
  commitVersions(): Promise<void> { return this.store.commitVersions(); }
  cleanupBatch(request: { workspaceId: string; batchId: string }): Promise<void> {
    return this.store.cleanupBatch(request);
  }
  upsertDocuments(documents: readonly LexicalDocument[]): Promise<void> {
    return this.store.upsertDocuments({
      workspaceId: documents[0]?.workspaceId ?? WORKSPACE,
      generation: this.generation,
      documents
    });
  }
  deleteDocuments(request: { workspaceId: string; documentIds: readonly string[] }): Promise<void> {
    return this.store.deleteDocuments({ ...request, generation: this.generation });
  }
  reconcileRepoDocuments(request: {
    workspaceId: string;
    repoId: string;
    batchId: string;
    activeDocumentIds: readonly string[];
  }): Promise<void> {
    return this.store.reconcileRepoDocuments({ ...request, generation: this.generation });
  }
  reconcileRepoFileDocuments(request: {
    workspaceId: string;
    repoId: string;
    batchId: string;
    activeFileIds: readonly string[];
  }): Promise<void> {
    return this.store.reconcileRepoFileDocuments({ ...request, generation: this.generation });
  }
  loadDocuments(request: { workspaceId: string; documentIds: readonly string[] }): Promise<readonly LexicalDocument[]> {
    return this.store.loadDocuments({ ...request, generation: this.generation });
  }
  search(query: { workspaceId: string; text: string }, options: { topK: number }) {
    return this.store.search({ ...query, generation: this.generation }, options);
  }
  health(workspaceId: string) {
    return this.store.health({ workspaceId, generation: this.generation });
  }
}

describe("Kuzu workspace lexical lifecycle", () => {
  let directory = "";
  let db: KuzuGraphDB;
  let store: GenerationPinnedKuzuStore;
  let previousCloseMode: string | undefined;
  let schemaInitialized = false;

  beforeAll(async () => {
    previousCloseMode = process.env.REPOHELIX_KUZU_CLOSE_MODE;
    // Reuse one physical database and close it exactly once. This avoids the
    // native repeated FTS shutdown issue without leaking seven temp folders.
    process.env.REPOHELIX_KUZU_CLOSE_MODE = "explicit";
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-kuzu-lexical-"));
    db = await KuzuGraphDB.open(path.join(directory, "graph.kuzu"));
  });

  beforeEach(async () => {
    store = new GenerationPinnedKuzuStore(new KuzuWorkspaceLexicalStore(db));
    if (schemaInitialized) {
      await db.query("MATCH (n:LexicalDocument) DELETE n;");
      await db.query("MATCH (s:LexicalWorkspaceStats) DELETE s;");
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    schemaInitialized = true;
  });

  afterAll(async () => {
    await db?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    if (previousCloseMode === undefined) delete process.env.REPOHELIX_KUZU_CLOSE_MODE;
    else process.env.REPOHELIX_KUZU_CLOSE_MODE = previousCloseMode;
  });

  it("retries interrupted stats migration and keeps schema and the workspace FTS index idempotent", async () => {
    store.generation = "legacy";
    const legacyRenderRef = createRenderRef({
      workspaceId: WORKSPACE,
      repoId: "repo:legacy",
      kind: "code",
      canonicalId: "code:legacy",
      fileId: "file:legacy",
      path: "src/legacy.ts"
    });
    await db.query(
      "CREATE NODE TABLE LexicalDocument(" +
      "id STRING, canonicalId STRING, workspaceId STRING, repoId STRING, kind STRING, renderRef STRING, searchableText STRING, active BOOL, ftsText STRING, PRIMARY KEY(id));"
    );
    await db.query(
      "CREATE (:LexicalDocument {id: 'legacy:one', canonicalId: 'code:legacy', workspaceId: $workspaceId, repoId: 'repo:legacy', kind: 'code', renderRef: $renderRef, " +
      "searchableText: 'legacy text', active: true, ftsText: 'legacy text'});",
      { workspaceId: WORKSPACE, renderRef: legacyRenderRef }
    );
    await db.query(
      "CREATE NODE TABLE LexicalMetadata(key STRING, value STRING, PRIMARY KEY(key));"
    );
    await db.query(
      "CREATE (:LexicalMetadata {key: 'lexicalStatsSchemaVersion', value: '1'});"
    );
    const originalQuery = db.query.bind(db);
    const interrupted = vi.spyOn(db, "query").mockImplementation(async (cypher, params) => {
      if (cypher === "MATCH (n:LexicalDocument {storageId: $storageId}) SET n.ftsSizeBytes = $ftsSizeBytes;") {
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
      "MATCH (n:LexicalDocument {storageId: 'legacy:one'}) RETURN n.ftsSizeBytes AS ftsSizeBytes;"
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
      "storageId", "documentId", "generation", "canonicalId", "workspaceId", "repoId", "kind", "title", "qualifiedName", "path",
      "searchableText", "tokens", "active", "sourceHash", "batchId", "renderRef", "fileId", "ftsText", "ftsSizeBytes"
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

    await db.query("MATCH (n:LexicalDocument {storageId: 'legacy:one'}) SET n.fileId = NULL, n.renderRef = 'corrupted-render-ref';");
    // Once the clean-cut schema marker is current, ordinary startup is O(1)
    // and deliberately does not scan/backfill document rows again.
    await expect(store.ensureSchema()).resolves.toBeUndefined();
    expect(await db.query<{ fileId: string | null }>(
      "MATCH (n:LexicalDocument {storageId: 'legacy:one'}) RETURN n.fileId AS fileId;"
    )).toEqual([{ fileId: null }]);
    await db.query("MATCH (n:LexicalDocument {storageId: 'legacy:one'}) SET n.renderRef = $renderRef;", { renderRef: legacyRenderRef });
    await db.query("MATCH (n:LexicalDocument {storageId: 'legacy:one'}) SET n.fileId = 'file:legacy';");
    expect(await db.query<{ fileId: string }>("MATCH (n:LexicalDocument {storageId: 'legacy:one'}) RETURN n.fileId AS fileId;"))
      .toEqual([{ fileId: "file:legacy" }]);
    await store.reconcileRepoFileDocuments({ workspaceId: WORKSPACE, repoId: "repo:legacy", batchId: "batch:legacy-delete", activeFileIds: [] });
    expect(await db.query<{ active: boolean }>("MATCH (n:LexicalDocument {storageId: 'legacy:one'}) RETURN n.active AS active;"))
      .toEqual([{ active: false }]);
  });

  it("uses the current-schema fast path and applies rollback-safe exact lexical deltas", async () => {
    const lexical = new KuzuWorkspaceLexicalStore(db);
    await lexical.ensureSchema();
    const schemaSpy = vi.spyOn(db, "query");
    await lexical.ensureSchema();
    const schemaQueries = schemaSpy.mock.calls.map(([cypher]) => cypher);
    schemaSpy.mockRestore();
    expect(schemaQueries.some((cypher) => /^(?:CREATE|DROP|ALTER)\b|\b(?:COPY|LOAD FROM)\b/u.test(cypher))).toBe(false);
    expect(schemaQueries.some((cypher) => cypher.includes("MATCH (n:LexicalDocument) WHERE n.ftsSizeBytes IS NULL"))).toBe(false);
    expect(schemaQueries.some((cypher) => cypher.includes("MATCH (n:LexicalDocument) WHERE n.fileId IS NULL"))).toBe(false);

    await lexical.initializeGeneration({ workspaceId: WORKSPACE, generation: GENERATION });
    const retained = document({ batchId: "batch:initial" });
    const removed = document({
      id: "lexical:code:removed",
      canonicalId: "code:removed",
      title: "RemovedService",
      sourceHash: "hash:removed",
      batchId: "batch:initial"
    });
    await lexical.upsertDocuments({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      documents: [retained, removed]
    });

    const updated = document({
      title: "Updated OrderService",
      searchableText: "updated-order-service exact-delta",
      tokens: ["updated", "order", "service", "exact", "delta"],
      sourceHash: "hash:updated",
      batchId: "batch:delta"
    });
    const mutationSpy = vi.spyOn(db, "query");
    await db.transaction(() => lexical.applyIncrementalMutation({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      expectedRevision: GENERATION,
      nextRevision: "revision:delta",
      upsertDocuments: [updated],
      deleteDocumentIds: [removed.id]
    }));
    const mutationQueries = mutationSpy.mock.calls.map(([cypher]) => cypher);
    mutationSpy.mockRestore();
    expect(mutationQueries.some((cypher) => cypher === "MATCH (n:LexicalDocument) RETURN count(*) AS count;")).toBe(false);
    expect(mutationQueries.some((cypher) => /^(?:CREATE|DROP|ALTER)\b|\b(?:COPY|LOAD FROM)\b/u.test(cypher))).toBe(false);
    expect(await lexical.loadDocuments({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      documentIds: [retained.id, removed.id]
    })).toEqual([updated]);
    expect(await lexical.documentIdsForSources({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      repoId: retained.repoId,
      fileIds: [`file:${retained.repoId}:one`]
    })).toEqual([retained.id]);
    expect((await lexical.health({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      revision: "revision:delta"
    })).metrics.documentCount).toBe(1);
    expect(await lexical.health({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      revision: "revision:missing"
    })).toMatchObject({
      status: "unhealthy",
      reasons: expect.arrayContaining(["lexical_stats_revision_missing"]),
      metrics: { documentCount: 0, indexSizeBytes: 0 }
    });

    const beforeRollback = await lexical.loadDocuments({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      documentIds: [retained.id]
    });
    await expect(db.transaction(async () => {
      await lexical.applyIncrementalMutation({
        workspaceId: WORKSPACE,
        generation: GENERATION,
        expectedRevision: "revision:delta",
        nextRevision: "revision:rollback",
        upsertDocuments: [],
        deleteDocumentIds: [retained.id]
      });
      throw new Error("injected outer transaction failure");
    })).rejects.toThrow("injected outer transaction failure");
    expect(await lexical.loadDocuments({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      documentIds: [retained.id]
    })).toEqual(beforeRollback);
    expect((await lexical.health({
      workspaceId: WORKSPACE,
      generation: GENERATION,
      revision: "revision:delta"
    })).metrics.documentCount).toBe(1);
  });

  async function verifyUpsertAndRollbackBoundaries(): Promise<void> {
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
      renderRef: undefined
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
      document({ id: "lexical:code:a", canonicalId: "code:a", tokens: ["unsafe,token"] }),
      document({ id: "lexical:code:b", canonicalId: "code:b", tokens: ["unsafe,token"] })
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
  }

  it("bulk-copies all-new documents once and keeps CSV, FTS, and stats semantics intact", async () => {
    await store.ensureSchema();
    const documents = [
      document({
        id: "lexical:copy:a",
        canonicalId: "code:copy:a",
        title: "Quoted \"title\"\nsecond line",
        searchableText: "bulkcopymarker unicode 中文\nnext line",
        tokens: ["bulkcopymarker", "cjk_中", "src/orders.ts"],
        qualifiedName: undefined,
        path: undefined
      }),
      document({
        id: "lexical:copy:b",
        canonicalId: "code:copy:b",
        title: "Empty tokens",
        searchableText: "secondary marker",
        tokens: [],
        active: false
      })
    ];
    const query = vi.spyOn(db, "query");

    await store.upsertDocuments(documents);

    const statements = query.mock.calls.map(([cypher]) => String(cypher));
    expect(statements.filter((cypher) => cypher.startsWith("COPY LexicalDocument ("))).toHaveLength(1);
    expect(statements.some((cypher) => cypher.startsWith("MERGE (n:LexicalDocument"))).toBe(false);
    query.mockRestore();

    expect(await store.loadDocuments({
      workspaceId: WORKSPACE,
      documentIds: documents.map((entry) => entry.id)
    })).toEqual([...documents].sort((left, right) => left.id.localeCompare(right.id)));
    expect((await store.search({ workspaceId: WORKSPACE, text: "bulkcopymarker" }, { topK: 5 }))[0]?.documentId)
      .toBe("lexical:copy:a");
    expect((await store.health(WORKSPACE)).metrics).toEqual({
      documentCount: 1,
      indexSizeBytes: Buffer.byteLength([documents[0]!.searchableText, ...documents[0]!.tokens].join(" "), "utf8")
    });
  });

  it("append-loads an all-new batch into a nonempty store without changing existing documents", async () => {
    await store.ensureSchema();
    const existing = document({
      id: "lexical:append:existing",
      canonicalId: "code:append:existing",
      repoId: "repo:one",
      title: "Existing Repo",
      searchableText: "existing repository marker",
      tokens: ["existing", "repository"],
      batchId: "batch:existing"
    });
    await store.upsertDocuments([existing]);
    const appended = [
      document({
        id: "lexical:append:new-active",
        canonicalId: "code:append:new-active",
        repoId: "repo:two",
        title: "Quoted \"append title\"\n中文第二行",
        searchableText: "appendloadmarker 中文 Unicode, comma\nnext line",
        tokens: ["appendloadmarker", "cjk_追加", "src/append.ts"],
        qualifiedName: undefined,
        path: "src/中文,append.ts",
        batchId: "batch:append"
      }),
      document({
        id: "lexical:append:new-inactive",
        canonicalId: "code:append:new-inactive",
        repoId: "repo:two",
        title: "Inactive append",
        searchableText: "inactive append marker",
        tokens: [],
        qualifiedName: undefined,
        path: undefined,
        active: false,
        batchId: "batch:append"
      })
    ];
    const query = vi.spyOn(db, "query");

    await store.upsertDocuments(appended);

    const statements = query.mock.calls.map(([cypher]) => String(cypher));
    expect(statements.filter((cypher) => cypher.startsWith("LOAD FROM ") && cypher.includes("MERGE (n:LexicalDocument")))
      .toHaveLength(1);
    expect(statements.some((cypher) => cypher.startsWith("COPY LexicalDocument ("))).toBe(false);
    expect(statements.some((cypher) => cypher.startsWith("MERGE (n:LexicalDocument {storageId: $storageId})"))).toBe(false);
    query.mockRestore();

    expect(await store.loadDocuments({
      workspaceId: WORKSPACE,
      documentIds: [existing.id, ...appended.map((entry) => entry.id)]
    })).toEqual([existing, ...appended].sort((left, right) => left.id.localeCompare(right.id)));
    expect((await store.search({ workspaceId: WORKSPACE, text: "appendloadmarker" }, { topK: 5 }))[0]?.documentId)
      .toBe("lexical:append:new-active");
    expect((await store.health(WORKSPACE)).metrics).toEqual({
      documentCount: 2,
      indexSizeBytes: Buffer.byteLength([existing.searchableText, ...existing.tokens].join(" "), "utf8") +
        Buffer.byteLength([appended[0]!.searchableText, ...appended[0]!.tokens].join(" "), "utf8")
    });
  });

  it("keeps existing-id batches on the transactional merge path", async () => {
    await store.ensureSchema();
    const existing = document({
      id: "lexical:append:update",
      canonicalId: "code:append:update",
      searchableText: "before update",
      tokens: ["before"],
      active: false
    });
    await store.upsertDocuments([existing]);
    const updated = { ...existing, searchableText: "after update", tokens: ["after"], active: true };
    const query = vi.spyOn(db, "query");

    await store.upsertDocuments([updated]);

    const statements = query.mock.calls.map(([cypher]) => String(cypher));
    expect(statements.some((cypher) => cypher.startsWith("LOAD FROM ") && cypher.includes("MERGE (n:LexicalDocument")))
      .toBe(false);
    expect(statements.filter((cypher) => cypher.startsWith("MERGE (n:LexicalDocument {storageId: $storageId})"))).toHaveLength(1);
    query.mockRestore();
    expect(await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [updated.id] })).toEqual([updated]);
  });

  it("falls back to transactional merges for unsafe token lists", async () => {
    await store.ensureSchema();
    const baseline = document({
      id: "lexical:unsafe-baseline",
      canonicalId: "code:unsafe-baseline",
      tokens: ["baseline"]
    });
    await store.upsertDocuments([baseline]);
    const unsafe = document({
      id: "lexical:unsafe-token",
      canonicalId: "code:unsafe-token",
      tokens: ["token,with,commas"]
    });
    const query = vi.spyOn(db, "query");

    await store.upsertDocuments([unsafe]);

    const statements = query.mock.calls.map(([cypher]) => String(cypher));
    expect(statements.some((cypher) => cypher.startsWith("COPY LexicalDocument ("))).toBe(false);
    expect(statements.filter((cypher) => cypher.startsWith("MERGE (n:LexicalDocument"))).toHaveLength(1);
    query.mockRestore();
    expect(await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [baseline.id, unsafe.id] }))
      .toEqual([baseline, unsafe].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it("rolls back a failed append LOAD and removes its temporary staging directory", async () => {
    await store.ensureSchema();
    const existing = document({ id: "lexical:append-load-existing", canonicalId: "code:append-load-existing" });
    await store.upsertDocuments([existing]);
    const prefix = "repohelix-lexical-append-load-";
    const before = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(prefix)));
    const originalQuery = db.query.bind(db);
    const query = vi.spyOn(db, "query").mockImplementation(async (cypher, params) => {
      if (cypher.startsWith("LOAD FROM ") && cypher.includes("MERGE (n:LexicalDocument")) {
        throw new Error("injected append LOAD failure");
      }
      return originalQuery(cypher, params) as ReturnType<typeof db.query>;
    });
    const appended = document({
      id: "lexical:append-load-failed",
      canonicalId: "code:append-load-failed",
      repoId: "repo:two",
      batchId: "batch:append-load-failed"
    });

    await expect(store.upsertDocuments([appended])).rejects.toMatchObject({
      code: "write_failed",
      context: { operation: "upsertDocuments", workspaceId: WORKSPACE, batchId: appended.batchId }
    });
    query.mockRestore();

    expect(await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [existing.id, appended.id] }))
      .toEqual([existing]);
    expect((await store.health(WORKSPACE)).metrics).toEqual({
      documentCount: 1,
      indexSizeBytes: Buffer.byteLength([existing.searchableText, ...existing.tokens].join(" "), "utf8")
    });
    const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(prefix) && !before.has(name));
    expect(after).toEqual([]);

    await store.upsertDocuments([appended]);
    expect(await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [existing.id, appended.id] }))
      .toEqual([existing, appended].sort((left, right) => left.id.localeCompare(right.id)));
    expect((await store.health(WORKSPACE)).metrics).toEqual({
      documentCount: 2,
      indexSizeBytes: Buffer.byteLength([existing.searchableText, ...existing.tokens].join(" "), "utf8") +
        Buffer.byteLength([appended.searchableText, ...appended.tokens].join(" "), "utf8")
    });
  });

  it("rolls back a failed COPY and removes its temporary staging directory", async () => {
    await store.ensureSchema();
    const prefix = "repohelix-lexical-copy-";
    const before = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(prefix)));
    const originalQuery = db.query.bind(db);
    const query = vi.spyOn(db, "query").mockImplementation(async (cypher, params) => {
      if (cypher.startsWith("COPY LexicalDocument (")) throw new Error("injected COPY failure");
      return originalQuery(cypher, params) as ReturnType<typeof db.query>;
    });
    const failed = document({ id: "lexical:copy-failed", canonicalId: "code:copy-failed" });

    await expect(store.upsertDocuments([failed])).rejects.toMatchObject({
      code: "write_failed",
      context: { operation: "upsertDocuments", workspaceId: WORKSPACE, batchId: failed.batchId }
    });
    query.mockRestore();

    expect(await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [failed.id] })).toEqual([]);
    expect((await store.health(WORKSPACE)).metrics).toEqual({ documentCount: 0, indexSizeBytes: 0 });
    const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(prefix) && !before.has(name));
    expect(after).toEqual([]);
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
    await store.deleteDocuments({ workspaceId: WORKSPACE, documentIds: [failed.id, failed.id] });
    const local = await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [failed.id, successful.id] });
    expect(local.find((entry) => entry.id === failed.id)).toBeUndefined();
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

  it("handles empty, update, load, conflict, and rollback upsert boundaries", verifyUpsertAndRollbackBoundaries);
});
