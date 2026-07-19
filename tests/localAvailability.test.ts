import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { traceContract } from "../src/core/graph-model/queries.js";
import { upsertParsedFiles } from "../src/core/graph-model/upsert.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { retrieveForQuestion } from "../src/features/ask/retrieve.js";
import { answerQuestion } from "../src/features/ask/answer.js";
import { repoId } from "../src/shared/path.js";
import { runIndexing } from "../src/core/indexing/run.js";
import { defaultConfig } from "../src/config/loadConfig.js";
import { KuzuWorkspaceLexicalStore, KUZU_WORKSPACE_FTS_INDEX } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { parseRenderRef } from "../src/core/retrieval/renderRef.js";

describe("local availability", () => {
  it("publishes graph and one workspace-wide lexical index through runIndexing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-local-indexing-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("local-indexing-test");
      const base = defaultConfig();
      const config = {
        ...base,
        systemName: "local-indexing-test",
        repos: ["service-a", "service-b"].map((name) => ({
          name,
          path: path.resolve("tests/fixtures", name).replace(/\\/g, "/")
        }))
      };
      const ensureSchema = vi.spyOn(KuzuWorkspaceLexicalStore.prototype, "ensureSchema");
      const result = await runIndexing(db, config, { cwd: dir, writeMode: "auto" });
      expect(ensureSchema).toHaveBeenCalledTimes(1);
      ensureSchema.mockRestore();
      const workspaceId = deriveWorkspaceId(config.systemName);
      const store = new KuzuWorkspaceLexicalStore(db);
      const health = await store.health(workspaceId);
      const hits = await store.search({ workspaceId, text: "order" }, { topK: 200 });
      const indexes = await db.query<{ index_name: string }>(
        "CALL SHOW_INDEXES() WHERE table_name = 'LexicalDocument' RETURN index_name;"
      );
      const states = await db.query<{ status: string; lexicalDocumentCount: number; lexicalIndexStatus: string }>(
        "MATCH (s:IndexState) RETURN s.status AS status, s.lexicalDocumentCount AS lexicalDocumentCount, s.lexicalIndexStatus AS lexicalIndexStatus;"
      );

      expect((await db.stats()).files).toBeGreaterThan(0);
      expect(result.lexicalDocumentCount).toBeGreaterThan(0);
      expect(health.metrics.documentCount).toBe(result.lexicalDocumentCount);
      expect(new Set(hits.map((hit) => hit.repoId)).size).toBeGreaterThan(1);
      expect(hits.every((hit) => parseRenderRef(hit.renderRef, workspaceId).repoId === hit.repoId)).toBe(true);
      expect(indexes).toEqual([{ index_name: KUZU_WORKSPACE_FTS_INDEX }]);
      expect(states).toHaveLength(2);
      expect(states.every((state) => state.status === "succeeded" && state.lexicalIndexStatus === "healthy" && state.lexicalDocumentCount > 0)).toBe(true);
      const preservedCount = states[0]!.lexicalDocumentCount;
      await db.upsertIndexState({
        repoId: repoId("service-a"), repoName: "service-a", lastBatchId: "batch:failed", lastIndexedAt: new Date().toISOString(),
        lastCommitSha: "", filesScanned: 0, filesChanged: 0, filesStale: 0, status: "failed", error: "injected"
      });
      expect(await db.query<{ lexicalDocumentCount: number; lexicalIndexStatus: string }>(
        "MATCH (s:IndexState {repoId: $repoId}) RETURN s.lexicalDocumentCount AS lexicalDocumentCount, s.lexicalIndexStatus AS lexicalIndexStatus;",
        { repoId: repoId("service-a") }
      )).toEqual([{ lexicalDocumentCount: preservedCount, lexicalIndexStatus: "healthy" }]);
    } finally {
      await db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("does not publish a successful journal or one-sided active graph when lexical write fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-local-lexical-failure-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    const writeFailure = vi.spyOn(KuzuWorkspaceLexicalStore.prototype, "upsertDocuments")
      .mockRejectedValue(new Error("injected lexical write failure"));
    try {
      await db.initSchema("local-lexical-failure-test");
      const base = defaultConfig();
      const config = {
        ...base,
        systemName: "local-lexical-failure-test",
        repos: [{ name: "service-a", path: path.resolve("tests/fixtures/service-a").replace(/\\/g, "/") }]
      };
      await expect(runIndexing(db, config, { cwd: dir, writeMode: "auto" })).rejects.toThrow("injected lexical write failure");
      const journals = await db.query<{ status: string }>("MATCH (b:GraphWriteBatch) RETURN b.status AS status;");
      const states = await db.query<{ status: string }>("MATCH (s:IndexState) RETURN s.status AS status;");
      const activeGraph = await db.query<{ count: number }>("MATCH (f:File) WHERE f.active = true RETURN count(f) AS count;");
      const activeLexical = await db.query<{ count: number }>("MATCH (n:LexicalDocument) WHERE n.active = true RETURN count(n) AS count;");
      expect(journals.some((journal) => journal.status === "committed")).toBe(false);
      expect(states).toEqual([{ status: "failed" }]);
      expect(activeGraph[0]?.count ?? 0).toBe(0);
      expect(activeLexical[0]?.count ?? 0).toBe(0);
    } finally {
      writeFailure.mockRestore();
      await db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("indexes and queries cross-repo graph data but refuses unvalidated graph-only answer context", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-local-"));
    try {
      const db = await KuzuGraphDB.open(path.join(dir, "graph"));
      try {
        await db.initSchema("local-test");
        const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
        const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
        const repoC = { id: repoId("service-c"), name: "service-c", path: path.resolve("tests/fixtures/service-c"), remoteUrl: "", branch: "", commitSha: "", language: "javascript", indexedAt: new Date().toISOString() };
        await db.upsertRepo(repoA);
        await db.upsertRepo(repoB);
        await db.upsertRepo(repoC);
        const parsed = await Promise.all([
          parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
          parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderService.ts"), relativePath: "src/OrderService.ts", language: "typescript" }),
          parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" }),
          parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/events/OrderCreatedEvent.ts"), relativePath: "src/events/OrderCreatedEvent.ts", language: "typescript" }),
          parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/README.md"), relativePath: "README.md", language: "markdown" }),
          parseSourceFile({ repoId: repoC.id, absolutePath: path.resolve("tests/fixtures/service-c/src/InventoryService.js"), relativePath: "src/InventoryService.js", language: "javascript" }),
          parseSourceFile({ repoId: repoC.id, absolutePath: path.resolve("tests/fixtures/service-c/src/InventoryPanel.jsx"), relativePath: "src/InventoryPanel.jsx", language: "jsx" })
        ]);
        await upsertParsedFiles(db, parsed, { semantic: true }, [repoA, repoB, repoC]);

        const dependencies = await db.query<{ count: number }>("MATCH (:Repo)-[d:DEPENDS_ON]->(:Repo) RETURN count(d) AS count;");
        expect(Number(dependencies[0]?.count ?? 0)).toBeGreaterThan(0);

        const apiTrace = await traceContract(db, "api", "/api/order/:id");
        expect(apiTrace).toEqual(expect.arrayContaining([
          expect.objectContaining({ repoName: "service-a", role: "producer" }),
          expect.objectContaining({ repoName: "service-b", role: "consumer" })
        ]));

        const retrieval = await retrieveForQuestion(db, "OrderCreatedEvent");
        const answer = await answerQuestion("OrderCreatedEvent", retrieval, "gpt-4.1-mini", undefined, undefined);
        expect(answer).toBe("no_reliable_evidence");

        const summaries = await db.query<{ repoSummary: string; systemSummary: string }>(
          "MATCH (r:Repo), (s:System) RETURN r.summary AS repoSummary, s.summary AS systemSummary LIMIT 1;"
        );
        expect(summaries[0]?.repoSummary.length ?? 0).toBeGreaterThan(0);
        expect(summaries[0]?.systemSummary).toContain("System contains 3 indexed repositories");
      } finally {
        await db.close();
      }
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  }, 20000);
});
