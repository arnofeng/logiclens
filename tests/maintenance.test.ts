import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { writeGraphFactsWithKuzuBulkUpsert } from "../src/core/graph-model/bulkWriter.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { findImpact, listCode, listDependencies, traceContract } from "../src/core/graph-model/queries.js";
import { rejectEvidence } from "../src/features/quality/quality.js";
import { rebuildRepoDependencies } from "../src/core/graph-model/rebuildRelations.js";
import { upsertParsedFiles } from "../src/core/graph-model/upsert.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { repoId } from "../src/shared/path.js";
import { runIndexing } from "../src/core/indexing/run.js";
import { defaultConfig } from "../src/config/loadConfig.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { stageAndActivatePublicGraphGeneration } from "./helpers/publicGraphGeneration.js";
import { pinPublicGraphReadSnapshot } from "../src/core/graph-model/readSnapshot.js";

describe("maintenance lifecycle", () => {
  it("keeps changed-only graph rename, delete, empty-repo, and repo isolation conformant", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-graph-maintenance-"));
    const repoAPath = path.join(dir, "service-a");
    const repoBPath = path.join(dir, "service-b");
    await fs.cp(path.resolve("tests/fixtures/service-a"), repoAPath, { recursive: true });
    await fs.cp(path.resolve("tests/fixtures/service-b"), repoBPath, { recursive: true });
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("graph-maintenance-test");
      const base = defaultConfig();
      const config = {
        ...base,
        systemName: "graph-maintenance-test",
        repos: [
          { name: "service-a", path: repoAPath.replace(/\\/g, "/") },
          { name: "service-b", path: repoBPath.replace(/\\/g, "/") }
        ]
      };
      const workspaceId = deriveWorkspaceId(config.systemName);
      await runIndexing(db, config, { cwd: dir, writeMode: "auto" });
      const initialSnapshot = await pinPublicGraphReadSnapshot(db, workspaceId);
      const before = await db.query<{ id: string; hash: string }>(
        "MATCH (n:File) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.path = 'src/OrderService.ts' AND n.active = true RETURN n.id AS id, n.hash AS hash;",
        initialSnapshot
      );
      const repoBActive = (await db.query<{ count: number }>(
        "MATCH (n:File) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.active = true RETURN count(n) AS count;",
        { ...initialSnapshot, repoId: repoId("service-b") }
      ))[0]?.count ?? 0;

      const originalPath = path.join(repoAPath, "src", "OrderService.ts");
      const originalSource = await fs.readFile(originalPath, "utf8");
      await fs.writeFile(originalPath, originalSource.replace("export class OrderService", "/** graph-change-proof */\nexport class OrderService"), "utf8");
      await runIndexing(db, config, { cwd: dir, repo: "service-a", changedOnly: true, writeMode: "auto" });
      const modifiedSnapshot = await pinPublicGraphReadSnapshot(db, workspaceId);
      const afterModify = await db.query<{ id: string; hash: string }>(
        "MATCH (n:File) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.path = 'src/OrderService.ts' AND n.active = true RETURN n.id AS id, n.hash AS hash;",
        modifiedSnapshot
      );
      expect(afterModify[0]?.id).toBe(before[0]?.id);
      expect(afterModify[0]?.hash).not.toBe(before[0]?.hash);

      const renamedPath = path.join(repoAPath, "src", "RenamedOrderService.ts");
      await fs.rename(originalPath, renamedPath);
      await runIndexing(db, config, { cwd: dir, repo: "service-a", changedOnly: true, writeMode: "auto" });
      const renamedSnapshot = await pinPublicGraphReadSnapshot(db, workspaceId);
      const renameStates = await db.query<{ path: string; active: boolean }>(
        "MATCH (n:File) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.path IN ['src/OrderService.ts', 'src/RenamedOrderService.ts'] RETURN n.path AS path, n.active AS active;",
        renamedSnapshot
      );
      expect(renameStates.filter((row) => row.path === "src/OrderService.ts").every((row) => !row.active)).toBe(true);
      expect(renameStates.some((row) => row.path === "src/RenamedOrderService.ts" && row.active)).toBe(true);

      await fs.rm(renamedPath);
      const deletion = await runIndexing(db, config, { cwd: dir, repo: "service-a", changedOnly: true, writeMode: "auto" });
      expect(deletion.filesChanged).toBe(0);
      const deletedSnapshot = await pinPublicGraphReadSnapshot(db, workspaceId);
      const activeDeletedRows = await db.query<{ id: string; fileId: string; path: string }>(
        "MATCH (n:File) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.path = 'src/RenamedOrderService.ts' AND n.active = true RETURN n.id AS id, n.path AS path;",
        deletedSnapshot
      );
      expect(activeDeletedRows).toEqual([]);

      await fs.rm(repoAPath, { recursive: true, force: true });
      await fs.mkdir(repoAPath, { recursive: true });
      await runIndexing(db, config, { cwd: dir, repo: "service-a", changedOnly: true, writeMode: "auto" });
      await runIndexing(db, config, { cwd: dir, repo: "service-a", changedOnly: true, writeMode: "auto" });
      const emptySnapshot = await pinPublicGraphReadSnapshot(db, workspaceId);
      expect((await db.query<{ count: number }>(
        "MATCH (n:File) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.active = true RETURN count(n) AS count;",
        { ...emptySnapshot, repoId: repoId("service-a") }
      ))[0]?.count ?? 0).toBe(0);
      expect((await db.query<{ count: number }>(
        "MATCH (n:File) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.active = true RETURN count(n) AS count;",
        { ...emptySnapshot, repoId: repoId("service-b") }
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
      const workspaceId = deriveWorkspaceId("maintenance-test");
      const scope = { workspaceId, generation: "generation:maintenance-stale" };
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const parsed = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
      ]);
      const { snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async (writeScope) => {
        await db.upsertRepo(repoA, writeScope);
        await db.upsertRepo(repoB, writeScope);
        await upsertParsedFiles(db, parsed, {
          semantic: true,
          batchId: "batch:initial",
          workspaceId,
          generation: writeScope.generation,
          systemName: "maintenance-test"
        }, [repoA, repoB]);
        await rebuildRepoDependencies(db, { scope: writeScope, batchId: "batch:deps" });
      });
      expect((await traceContract(db, snapshot, "api", "/api/order/:id")).length).toBeGreaterThanOrEqual(2);

      const staleCount = await db.markRepoArtifactsStale({
        repoId: repoB.id,
        activeFileIds: [],
        batchId: "batch:stale",
        indexedAt: new Date().toISOString()
      }, scope);
      expect(staleCount).toBeGreaterThan(0);
      expect(await findImpact(db, snapshot, "PaymentService")).toHaveLength(0);
      expect((await traceContract(db, snapshot, "api", "/api/order/:id")).map((row) => row.repoName)).not.toContain("service-b");
      expect((await listDependencies(db, snapshot)).map((row) => row.fromRepo)).not.toContain("service-b");

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
      const workspaceId = deriveWorkspaceId("quality-test");
      const scope = { workspaceId, generation: "generation:maintenance-quality" };
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const parsed = [
        await parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" })
      ];
      const { snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async (writeScope) => {
        await db.upsertRepo(repoA, writeScope);
        await upsertParsedFiles(db, parsed, {
          semantic: true,
          batchId: "batch:quality",
          workspaceId,
          generation: writeScope.generation,
          systemName: "quality-test"
        }, [repoA]);
      });
      const trace = await traceContract(db, snapshot, "api", "/api/order/:id");
      const evidenceId = trace[0]?.contractId
        ? (await db.query<{ evidenceId: string }>(
          `MATCH (r:Repo)-[p:PRODUCES]->(c:Contract)
           WHERE c.id = $contractId AND c.workspaceId = $workspaceId AND c.generation = $generation
             AND r.workspaceId = $workspaceId AND r.generation = $generation
             AND p.workspaceId = $workspaceId AND p.generation = $generation
           RETURN p.evidenceId AS evidenceId
           LIMIT 1;`,
          {
            contractId: trace[0].contractId,
            workspaceId: snapshot.workspaceId,
            generation: snapshot.generation
          }
        ))[0]?.evidenceId
        : undefined;
      expect(evidenceId).toBeTruthy();
      await rejectEvidence(db, workspaceId, { evidenceId: evidenceId!, reason: "test false positive" });
      expect(await traceContract(db, snapshot, "api", "/api/order/:id")).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 20000);

  it("marks renamed files stale and exposes only the replacement path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-rename-lifecycle-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("rename-lifecycle-test");
      const workspaceId = deriveWorkspaceId("rename-lifecycle-test");
      const scope = { workspaceId, generation: "generation:maintenance-rename" };
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const generations = await stageAndActivatePublicGraphGeneration(db, scope, async (writeScope) => {
        await db.upsertRepo(repoA, writeScope);

        const original = await parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" });
        await upsertParsedFiles(db, [original], {
          semantic: true,
          batchId: "batch:rename-original",
          workspaceId,
          generation: writeScope.generation,
          systemName: "rename-lifecycle-test"
        }, [repoA]);
      });
      expect((await listCode(db, generations.snapshot, 1000)).map((row) => row.filePath)).toContain("src/OrderController.ts");

      const renamed = await parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/controllers/OrderController.ts", language: "typescript" });
      await upsertParsedFiles(db, [renamed], {
        semantic: true,
        batchId: "batch:rename-new",
        workspaceId,
        generation: scope.generation,
        systemName: "rename-lifecycle-test"
      }, [repoA]);
      const staleCount = await db.markRepoArtifactsStale({
        repoId: repoA.id,
        activeFileIds: [renamed.fileId],
        batchId: "batch:rename-stale",
        indexedAt: new Date().toISOString()
      }, scope);

      expect(staleCount).toBe(1);
      const paths = (await listCode(db, generations.snapshot, 1000)).map((row) => row.filePath);
      expect(paths).toContain("src/controllers/OrderController.ts");
      expect(paths).not.toContain("src/OrderController.ts");
      expect((await findImpact(db, generations.snapshot, "OrderController")).map((row) => row.filePath)).not.toContain("src/OrderController.ts");
    } finally {
      await db.close();
    }
  }, 20000);

  it("updates moved repo metadata and repeated indexing does not duplicate public graph facts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-repeat-lifecycle-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("repeat-lifecycle-test");
      const workspaceId = deriveWorkspaceId("repeat-lifecycle-test");
      const scope = { workspaceId, generation: "generation:maintenance-repeat" };
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const parsed = [
        await parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" })
      ];
      const { snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async (writeScope) => {
        await db.upsertRepo(repoA, writeScope);
        await upsertParsedFiles(db, parsed, {
          semantic: true,
          batchId: "batch:repeat-first",
          workspaceId,
          generation: writeScope.generation,
          systemName: "repeat-lifecycle-test"
        }, [repoA]);
      });
      const firstStats = await db.stats(snapshot);
      const firstCode = await listCode(db, snapshot, 1000);

      const movedRepo = { ...repoA, path: path.join(dir, "moved-service-a"), indexedAt: new Date().toISOString() };
      await db.upsertRepo(movedRepo, scope);
      await upsertParsedFiles(db, parsed, {
        semantic: true,
        batchId: "batch:repeat-second",
        workspaceId,
        generation: scope.generation,
        systemName: "repeat-lifecycle-test"
      }, [movedRepo]);

      expect(await db.stats(snapshot)).toEqual(firstStats);
      expect(await listCode(db, snapshot, 1000)).toHaveLength(firstCode.length);
      const repos = await db.query<{ path: string; contains: number }>(
        "MATCH (s:System)-[r:CONTAINS]->(repo:Repo {id: $repoId}) WHERE s.workspaceId = $workspaceId AND s.generation = $generation AND repo.workspaceId = $workspaceId AND repo.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation RETURN repo.path AS path, count(r) AS contains;",
        { repoId: repoA.id, workspaceId: snapshot.workspaceId, generation: snapshot.generation }
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
      const workspaceId = deriveWorkspaceId("bulk-upsert-maintenance-test");
      const scope = { workspaceId, generation: "generation:maintenance-bulk" };
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const parsed = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
      ]);
      const facts = await buildGraphFactsBatch({
        batchId: "batch:bulk-upsert-maintenance",
        workspaceId,
        generation: scope.generation,
        systemName: "bulk-upsert-maintenance-test",
        indexedAt: new Date().toISOString(),
        repos: [repoA, repoB],
        parsedFiles: parsed,
        semantic: true
      });
      const { snapshot } = await stageAndActivatePublicGraphGeneration(db, scope, async (writeScope) => {
        await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot: path.join(dir, "staging") });
        await rebuildRepoDependencies(db, { scope: writeScope, batchId: "batch:deps" });
      });
      expect((await traceContract(db, snapshot, "api", "/api/order/:id")).map((row) => row.repoName)).toEqual(expect.arrayContaining(["service-a", "service-b"]));

      const staleCount = await db.markRepoArtifactsStale({
        repoId: repoB.id,
        activeFileIds: [],
        batchId: "batch:bulk-upsert-stale",
        indexedAt: new Date().toISOString()
      }, scope);
      expect(staleCount).toBeGreaterThan(0);
      await rebuildRepoDependencies(db, { scope, repoIds: [repoB.id], batchId: "batch:deps-after-stale" });
      expect((await traceContract(db, snapshot, "api", "/api/order/:id")).map((row) => row.repoName)).not.toContain("service-b");
      expect((await listDependencies(db, snapshot)).map((row) => row.fromRepo)).not.toContain("service-b");
    } finally {
      await db.close();
    }
  }, 20000);
});
