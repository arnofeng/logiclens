import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
import type { LexicalDocument } from "../src/core/retrieval/types.js";

const WORKSPACE = "workspace:append-stats-rollback";

function document(overrides: Partial<LexicalDocument>): LexicalDocument {
  const value: LexicalDocument = {
    id: "lexical:append-stats-existing",
    canonicalId: "code:append-stats-existing",
    workspaceId: WORKSPACE,
    repoId: "repo:one",
    kind: "code",
    title: "Append stats rollback",
    qualifiedName: "AppendStatsRollback",
    path: "src/append-stats.ts",
    searchableText: "append stats baseline",
    tokens: ["append", "stats", "baseline"],
    active: true,
    sourceHash: "hash:append-stats",
    batchId: "batch:existing",
    renderRef: "",
    ...overrides
  };
  value.renderRef = overrides.renderRef ?? createRenderRef({
    workspaceId: value.workspaceId,
    repoId: value.repoId,
    kind: value.kind,
    canonicalId: value.canonicalId,
    fileId: `file:${value.repoId}:append-stats`,
    path: value.path ?? "src/append-stats.ts"
  });
  return value;
}

describe("Kuzu lexical append stats rollback", () => {
  let directory = "";
  let db: KuzuGraphDB;
  let store: KuzuWorkspaceLexicalStore;

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-kuzu-append-stats-"));
    db = await KuzuGraphDB.open(path.join(directory, "graph.kuzu"));
    store = new KuzuWorkspaceLexicalStore(db);
    await store.ensureSchema();
  });

  afterAll(async () => {
    await db?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it("rolls back append-loaded documents when the stats update fails", async () => {
    const existing = document({});
    await store.upsertDocuments([existing]);
    const prefix = "repohelix-lexical-append-load-";
    const before = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(prefix)));
    const originalQuery = db.query.bind(db);
    const query = vi.spyOn(db, "query").mockImplementation(async (cypher, params) => {
      if (cypher.startsWith("MERGE (s:LexicalWorkspaceStats")) throw new Error("injected append stats failure");
      return originalQuery(cypher, params) as ReturnType<typeof db.query>;
    });
    const appended = document({
      id: "lexical:append-stats-failed",
      canonicalId: "code:append-stats-failed",
      repoId: "repo:two",
      searchableText: "appendstatsrollbackmarker",
      tokens: ["appendstatsrollbackmarker"],
      batchId: "batch:append-stats-failed"
    });

    await expect(store.upsertDocuments([appended])).rejects.toMatchObject({
      code: "write_failed",
      context: { operation: "upsertDocuments", workspaceId: WORKSPACE, batchId: appended.batchId }
    });
    query.mockRestore();

    expect(await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [existing.id, appended.id] }))
      .toEqual([existing]);
    expect(await store.search({ workspaceId: WORKSPACE, text: "appendstatsrollbackmarker" }, { topK: 5 }))
      .toEqual([]);
    expect((await store.health(WORKSPACE)).metrics).toEqual({
      documentCount: 1,
      indexSizeBytes: Buffer.byteLength([existing.searchableText, ...existing.tokens].join(" "), "utf8")
    });
    const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(prefix) && !before.has(name));
    expect(after).toEqual([]);

    await store.upsertDocuments([appended]);
    expect(await store.loadDocuments({ workspaceId: WORKSPACE, documentIds: [existing.id, appended.id] }))
      .toEqual([existing, appended].sort((left, right) => left.id.localeCompare(right.id)));
    expect((await store.search({ workspaceId: WORKSPACE, text: "appendstatsrollbackmarker" }, { topK: 5 }))[0]?.documentId)
      .toBe(appended.id);
    expect((await store.health(WORKSPACE)).metrics).toEqual({
      documentCount: 2,
      indexSizeBytes: Buffer.byteLength([existing.searchableText, ...existing.tokens].join(" "), "utf8") +
        Buffer.byteLength([appended.searchableText, ...appended.tokens].join(" "), "utf8")
    });
  });
});
