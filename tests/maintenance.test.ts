import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { writeGraphFactsWithKuzuBulkUpsert } from "../src/core/graph-model/bulkWriter.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { listCode, listDependencies, searchCode, traceContract } from "../src/core/graph-model/queries.js";
import { rejectEvidence } from "../src/features/quality/quality.js";
import { rebuildRepoDependencies } from "../src/core/graph-model/rebuildRelations.js";
import { upsertParsedFiles } from "../src/core/graph-model/upsert.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { repoId } from "../src/shared/path.js";
import { runIndexing } from "../src/core/indexing/run.js";
import { defaultConfig } from "../src/config/loadConfig.js";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";

describe("maintenance lifecycle", () => {
  it("keeps changed-only lexical content, rename, delete, empty-repo, and repo isolation conformant", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-lexical-maintenance-"));
    const repoAPath = path.join(dir, "service-a");
    const repoBPath = path.join(dir, "service-b");
    await fs.cp(path.resolve("tests/fixtures/service-a"), repoAPath, { recursive: true });
    await fs.cp(path.resolve("tests/fixtures/service-b"), repoBPath, { recursive: true });
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("lexical-maintenance-test");
      const base = defaultConfig();
      const config = {
        ...base,
        systemName: "lexical-maintenance-test",
        repos: [
          { name: "service-a", path: repoAPath.replace(/\\/g, "/") },
          { name: "service-b", path: repoBPath.replace(/\\/g, "/") }
        ]
      };
      const workspaceId = deriveWorkspaceId(config.systemName);
      const store = new KuzuWorkspaceLexicalStore(db);
      await runIndexing(db, config, { cwd: dir, writeMode: "auto" });
      const before = await db.query<{ id: string; canonicalId: string; kind: string; sourceHash: string }>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.path = 'src/OrderService.ts' AND n.active = true RETURN n.id AS id, n.canonicalId AS canonicalId, n.kind AS kind, n.sourceHash AS sourceHash ORDER BY n.id;",
        { workspaceId }
      );
      const repoBActive = (await db.query<{ count: number }>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.repoId = $repoId AND n.active = true RETURN count(n) AS count;",
        { workspaceId, repoId: repoId("service-b") }
      ))[0]?.count ?? 0;

      const originalPath = path.join(repoAPath, "src", "OrderService.ts");
      const originalSource = await fs.readFile(originalPath, "utf8");
      await fs.writeFile(originalPath, originalSource.replace("export class OrderService", "/** lexicaldeleteproof */\nexport class OrderService"), "utf8");
      await runIndexing(db, config, { cwd: dir, repo: "service-a", changedOnly: true, writeMode: "auto" });
      const afterModify = await db.query<{ id: string; canonicalId: string; kind: string; sourceHash: string }>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.path = 'src/OrderService.ts' AND n.active = true RETURN n.id AS id, n.canonicalId AS canonicalId, n.kind AS kind, n.sourceHash AS sourceHash ORDER BY n.id;",
        { workspaceId }
      );
      const beforeFile = before.find((row) => row.kind === "file");
      const afterFile = afterModify.find((row) => row.kind === "file");
      expect(afterFile?.canonicalId).toBe(beforeFile?.canonicalId);
      expect(afterFile?.id).toBe(beforeFile?.id);
      expect(afterFile?.sourceHash).not.toBe(beforeFile?.sourceHash);
      const markerDocuments = await db.query<{ id: string; title: string; searchableText: string }>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.active = true AND n.searchableText CONTAINS 'lexical' RETURN n.id AS id, n.title AS title, n.searchableText AS searchableText;",
        { workspaceId }
      );
      expect(markerDocuments).not.toEqual([]);
      expect(await store.search({ workspaceId, text: "lexicaldeleteproof" }, { topK: 10 })).not.toHaveLength(0);

      const renamedPath = path.join(repoAPath, "src", "RenamedOrderService.ts");
      await fs.rename(originalPath, renamedPath);
      await runIndexing(db, config, { cwd: dir, repo: "service-a", changedOnly: true, writeMode: "auto" });
      const renameStates = await db.query<{ path: string; active: boolean }>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.path IN ['src/OrderService.ts', 'src/RenamedOrderService.ts'] RETURN n.path AS path, n.active AS active;",
        { workspaceId }
      );
      expect(renameStates.filter((row) => row.path === "src/OrderService.ts").every((row) => !row.active)).toBe(true);
      expect(renameStates.some((row) => row.path === "src/RenamedOrderService.ts" && row.active)).toBe(true);

      await fs.rm(renamedPath);
      const deletion = await runIndexing(db, config, { cwd: dir, repo: "service-a", changedOnly: true, writeMode: "auto" });
      expect(deletion.filesChanged).toBe(0);
      const activeDeletedRows = await db.query<{ id: string; fileId: string; path: string }>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.path = 'src/RenamedOrderService.ts' AND n.active = true RETURN n.id AS id, n.fileId AS fileId, n.path AS path;",
        { workspaceId }
      );
      expect(activeDeletedRows).toEqual([]);
      const activeMarkerRows = await db.query<{ id: string; path: string | null; kind: string }>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.active = true AND n.searchableText CONTAINS 'lexicaldeleteproof' RETURN n.id AS id, n.path AS path, n.kind AS kind;",
        { workspaceId }
      );
      expect(activeMarkerRows).toEqual([]);
      expect(await store.search({ workspaceId, text: "lexicaldeleteproof" }, { topK: 10 })).toHaveLength(0);

      await fs.rm(repoAPath, { recursive: true, force: true });
      await fs.mkdir(repoAPath, { recursive: true });
      await runIndexing(db, config, { cwd: dir, repo: "service-a", changedOnly: true, writeMode: "auto" });
      await runIndexing(db, config, { cwd: dir, repo: "service-a", changedOnly: true, writeMode: "auto" });
      expect((await db.query<{ count: number }>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.repoId = $repoId AND n.fileId IS NOT NULL AND n.active = true RETURN count(n) AS count;",
        { workspaceId, repoId: repoId("service-a") }
      ))[0]?.count ?? 0).toBe(0);
      expect((await db.query<{ count: number }>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.repoId = $repoId AND n.active = true RETURN count(n) AS count;",
        { workspaceId, repoId: repoId("service-b") }
      ))[0]?.count ?? 0).toBe(repoBActive);
    } finally {
      await db.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("marks missing files stale and excludes stale graph facts from default queries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-maintenance-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("maintenance-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      await db.upsertRepo(repoA);
      await db.upsertRepo(repoB);
      const parsed = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
      ]);
      await upsertParsedFiles(db, parsed, { semantic: true, batchId: "batch:initial" }, [repoA, repoB]);
      await rebuildRepoDependencies(db, { batchId: "batch:deps" });
      expect((await traceContract(db, "api", "/api/order/:id")).length).toBeGreaterThanOrEqual(2);

      const staleCount = await db.markRepoArtifactsStale({
        repoId: repoB.id,
        activeFileIds: [],
        batchId: "batch:stale",
        indexedAt: new Date().toISOString()
      });
      expect(staleCount).toBeGreaterThan(0);
      expect(await searchCode(db, "PaymentService")).toHaveLength(0);
      expect((await traceContract(db, "api", "/api/order/:id")).map((row) => row.repoName)).not.toContain("service-b");
      expect((await listDependencies(db)).map((row) => row.fromRepo)).not.toContain("service-b");

      await db.upsertIndexState({
        repoId: repoB.id,
        repoName: repoB.name,
        lastBatchId: "batch:stale",
        lastIndexedAt: new Date().toISOString(),
        lastCommitSha: "",
        filesScanned: 0,
        filesChanged: 0,
        filesStale: staleCount,
        status: "succeeded"
      });
      const states = await db.query<{ filesStale: number; status: string }>("MATCH (s:IndexState) WHERE s.repoId = $repoId RETURN s.filesStale AS filesStale, s.status AS status;", { repoId: repoB.id });
      expect(Number(states[0]?.filesStale ?? 0)).toBe(staleCount);
      expect(states[0]?.status).toBe("succeeded");
    } finally {
      await db.close();
    }
  }, 20000);

  it("rejects false-positive evidence from contract traces", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-quality-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("quality-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      await db.upsertRepo(repoA);
      const parsed = [
        await parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" })
      ];
      await upsertParsedFiles(db, parsed, { semantic: true, batchId: "batch:quality" }, [repoA]);
      const trace = await traceContract(db, "api", "/api/order/:id");
      const evidenceId = trace[0]?.contractId
        ? (await db.query<{ evidenceId: string }>(
          `MATCH (:Repo)-[p:PRODUCES]->(c:Contract)
           WHERE c.id = $contractId
           RETURN p.evidenceId AS evidenceId
           LIMIT 1;`,
          { contractId: trace[0].contractId }
        ))[0]?.evidenceId
        : undefined;
      expect(evidenceId).toBeTruthy();
      await rejectEvidence(db, { evidenceId: evidenceId!, reason: "test false positive" });
      expect(await traceContract(db, "api", "/api/order/:id")).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 20000);

  it("marks renamed files stale and exposes only the replacement path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-rename-lifecycle-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("rename-lifecycle-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      await db.upsertRepo(repoA);

      const original = await parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" });
      await upsertParsedFiles(db, [original], { semantic: true, batchId: "batch:rename-original" }, [repoA]);
      expect((await listCode(db, 1000)).map((row) => row.filePath)).toContain("src/OrderController.ts");

      const renamed = await parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/controllers/OrderController.ts", language: "typescript" });
      await upsertParsedFiles(db, [renamed], { semantic: true, batchId: "batch:rename-new" }, [repoA]);
      const staleCount = await db.markRepoArtifactsStale({
        repoId: repoA.id,
        activeFileIds: [renamed.fileId],
        batchId: "batch:rename-stale",
        indexedAt: new Date().toISOString()
      });

      expect(staleCount).toBe(1);
      const paths = (await listCode(db, 1000)).map((row) => row.filePath);
      expect(paths).toContain("src/controllers/OrderController.ts");
      expect(paths).not.toContain("src/OrderController.ts");
      expect((await searchCode(db, "OrderController")).map((row) => row.filePath)).not.toContain("src/OrderController.ts");
    } finally {
      await db.close();
    }
  }, 20000);

  it("updates moved repo metadata and repeated indexing does not duplicate public graph facts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-repeat-lifecycle-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("repeat-lifecycle-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      await db.upsertRepo(repoA);
      const parsed = [
        await parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" })
      ];
      await upsertParsedFiles(db, parsed, { semantic: true, batchId: "batch:repeat-first" }, [repoA]);
      const firstStats = await db.stats();
      const firstCode = await listCode(db, 1000);

      const movedRepo = { ...repoA, path: path.join(dir, "moved-service-a"), indexedAt: new Date().toISOString() };
      await db.upsertRepo(movedRepo);
      await upsertParsedFiles(db, parsed, { semantic: true, batchId: "batch:repeat-second" }, [movedRepo]);

      expect(await db.stats()).toEqual(firstStats);
      expect(await listCode(db, 1000)).toHaveLength(firstCode.length);
      const repos = await db.query<{ path: string; contains: number }>(
        "MATCH (s:System)-[r:CONTAINS]->(repo:Repo {id: $repoId}) RETURN repo.path AS path, count(r) AS contains;",
        { repoId: repoA.id }
      );
      expect(repos[0]?.path).toBe(movedRepo.path);
      expect(Number(repos[0]?.contains ?? 0)).toBe(1);
    } finally {
      await db.close();
    }
  }, 20000);

  it("keeps stale lifecycle semantics after bulk upsert writes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-bulk-upsert-maintenance-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("bulk-upsert-maintenance-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const parsed = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
      ]);
      const facts = await buildGraphFactsBatch({ batchId: "batch:bulk-upsert-maintenance", indexedAt: new Date().toISOString(), repos: [repoA, repoB], parsedFiles: parsed, semantic: true });
      await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot: path.join(dir, "staging") });
      await rebuildRepoDependencies(db, { batchId: "batch:deps" });
      expect((await traceContract(db, "api", "/api/order/:id")).map((row) => row.repoName)).toEqual(expect.arrayContaining(["service-a", "service-b"]));

      const staleCount = await db.markRepoArtifactsStale({
        repoId: repoB.id,
        activeFileIds: [],
        batchId: "batch:bulk-upsert-stale",
        indexedAt: new Date().toISOString()
      });
      expect(staleCount).toBeGreaterThan(0);
      await rebuildRepoDependencies(db, { repoIds: [repoB.id], batchId: "batch:deps-after-stale" });
      expect((await traceContract(db, "api", "/api/order/:id")).map((row) => row.repoName)).not.toContain("service-b");
      expect((await listDependencies(db)).map((row) => row.fromRepo)).not.toContain("service-b");
    } finally {
      await db.close();
    }
  }, 20000);
});
