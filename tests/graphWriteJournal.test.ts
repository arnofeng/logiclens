import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import type { PublicGraphGenerationScope } from "../src/core/graph-model/publicGraphGeneration.js";
import type { FileNode, RepoNode } from "../src/core/parsing/types.js";

const tempDirs: string[] = [];
const workspaceId = "workspace:journal";
const parentScope: PublicGraphGenerationScope = { workspaceId, generation: "generation:parent" };
const pendingScope: PublicGraphGenerationScope = { workspaceId, generation: "generation:pending" };

async function tempGraph(): Promise<{ dir: string; db: KuzuGraphDB }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-graph-journal-"));
  tempDirs.push(dir);
  const db = await KuzuGraphDB.open(path.join(dir, "graph"));
  await db.initSchema("journal-test");
  return { dir, db };
}

function repo(): RepoNode {
  return {
    id: "repo:journal",
    name: "journal",
    path: "fixtures/journal",
    remoteUrl: "",
    branch: "main",
    commitSha: "abc123",
    language: "typescript",
    indexedAt: "2026-06-22T00:00:00.000Z"
  };
}

function file(batchId: string, hash = "parent-hash"): FileNode {
  return {
    id: "file:journal:index.ts",
    repoId: "repo:journal",
    path: "index.ts",
    directory: ".",
    language: "typescript",
    hash,
    loc: 1,
    batchId,
    indexedAt: "2026-06-22T00:00:00.000Z",
    active: true
  };
}

async function writeParent(db: KuzuGraphDB): Promise<void> {
  await db.upsertSystem("journal-test", parentScope);
  await db.upsertRepo(repo(), parentScope);
  await db.upsertFile(file("batch:parent"), parentScope);
  await db.addContains(repo().id, file("batch:parent").id, parentScope);
  await db.initializePublicGraphStats(parentScope, parentScope.generation, await db.computePublicGraphStats(parentScope));
}

async function writePendingBaseline(db: KuzuGraphDB, batchId: string): Promise<void> {
  await db.upsertSystem("journal-test", pendingScope);
  await db.upsertRepo(repo(), pendingScope);
  await db.upsertFile(file(batchId), pendingScope);
  await db.addContains(repo().id, file(batchId).id, pendingScope);
  await db.initializePublicGraphStats(pendingScope, pendingScope.generation, await db.computePublicGraphStats(pendingScope));
}

async function beginPending(db: KuzuGraphDB, batchId: string, scope = pendingScope): Promise<void> {
  await db.beginGraphWriteBatch({
    batchId,
    generation: scope.generation,
    parentGeneration: parentScope.generation,
    repoIds: [repo().id],
    repoNames: [repo().name],
    writerMode: "generation-cow",
    atomicityMode: "journaled-recoverable",
    workspaceId: scope.workspaceId,
    startedAt: "2026-06-22T00:00:00.000Z"
  });
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("generation-scoped graph write journal", () => {
  it("removes an incomplete pending generation without changing its active parent", async () => {
    const { db } = await tempGraph();
    try {
      await writeParent(db);
      const batchId = "batch:journal-failed";
      await beginPending(db, batchId);
      await writePendingBaseline(db, batchId);
      await db.upsertFile(file(batchId, "pending-hash"), pendingScope);

      expect((await db.stats(parentScope)).files).toBe(1);
      expect((await db.stats(pendingScope)).files).toBe(1);
      expect(await db.query<{ count: number }>(
        "MATCH (f:File) WHERE f.id = $id AND f.workspaceId = $workspaceId RETURN count(f) AS count;",
        { id: file(batchId).id, workspaceId }
      )).toEqual([{ count: 2 }]);

      await db.recoverIncompleteGraphWriteBatches({
        workspaceId,
        updatedAt: "2026-06-22T00:01:00.000Z"
      });

      expect((await db.stats(parentScope)).files).toBe(1);
      expect((await db.computePublicGraphStats(pendingScope)).files).toBe(0);
      expect(await db.query<{ hash: string; batchId: string }>(
        "MATCH (f:File) WHERE f.workspaceId = $workspaceId AND f.generation = $generation RETURN f.hash AS hash, f.batchId AS batchId;",
        parentScope
      )).toEqual([{ hash: "parent-hash", batchId: "batch:parent" }]);
    } finally {
      await db.close();
    }
  });

  it("does not clean a committed generation", async () => {
    const { db } = await tempGraph();
    try {
      await writeParent(db);
      const batchId = "batch:journal-committed";
      await beginPending(db, batchId);
      await writePendingBaseline(db, batchId);
      await db.commitGraphWriteBatch({ batchId, updatedAt: "2026-06-22T00:00:01.000Z" });

      expect(await db.recoverIncompleteGraphWriteBatches({
        workspaceId,
        updatedAt: "2026-06-22T00:01:00.000Z"
      })).toEqual([]);
      expect((await db.stats(parentScope)).files).toBe(1);
      expect((await db.stats(pendingScope)).files).toBe(1);
      await expect(db.cleanupGraphWriteBatch(batchId)).rejects.toThrow("Refusing to clean committed");
      expect((await db.stats(pendingScope)).files).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("refuses cleanup when the journal generation is already active", async () => {
    const { db } = await tempGraph();
    try {
      await writeParent(db);
      const batchId = "batch:journal-active-guard";
      await beginPending(db, batchId);
      await writePendingBaseline(db, batchId);
      await db.query(
        "MERGE (s:SchemaGenerationState {id: $id}) SET s.workspaceId = $workspaceId, s.activeGeneration = $generation, s.pendingGeneration = '', s.schemaIndexVersion = $version;",
        {
          id: `schema-generation-state:${workspaceId}`,
          workspaceId,
          generation: pendingScope.generation,
          version: "test"
        }
      );

      await expect(db.cleanupGraphWriteBatch(batchId)).rejects.toThrow("Refusing to clean active public graph generation");
      expect((await db.stats(parentScope)).files).toBe(1);
      expect((await db.stats(pendingScope)).files).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("recovers only the requested workspace", async () => {
    const { db } = await tempGraph();
    try {
      await beginPending(db, "batch:requested");
      await beginPending(db, "batch:other", {
        workspaceId: "workspace:other",
        generation: "generation:other"
      });
      const recovered = await db.recoverIncompleteGraphWriteBatches({
        workspaceId,
        updatedAt: "2026-06-22T00:01:00.000Z"
      });
      expect(recovered.map((journal) => journal.batchId)).toEqual(["batch:requested"]);
      expect(await db.query<{ batchId: string; status: string }>(
        "MATCH (b:GraphWriteBatch) RETURN b.batchId AS batchId, b.status AS status;"
      )).toEqual(expect.arrayContaining([
        { batchId: "batch:requested", status: "recovered" },
        { batchId: "batch:other", status: "started" }
      ]));
    } finally {
      await db.close();
    }
  });

  it("recovers only the requested abandoned generation within a workspace", async () => {
    const { db } = await tempGraph();
    try {
      await beginPending(db, "batch:requested-generation");
      await beginPending(db, "batch:other-generation", {
        workspaceId,
        generation: "generation:other-pending"
      });

      const recovered = await db.recoverIncompleteGraphWriteBatches({
        workspaceId,
        generation: pendingScope.generation,
        updatedAt: "2026-06-22T00:01:00.000Z"
      });

      expect(recovered.map((journal) => journal.batchId)).toEqual(["batch:requested-generation"]);
      expect(await db.query<{ batchId: string; status: string }>(
        "MATCH (b:GraphWriteBatch) RETURN b.batchId AS batchId, b.status AS status;"
      )).toEqual(expect.arrayContaining([
        { batchId: "batch:requested-generation", status: "recovered" },
        { batchId: "batch:other-generation", status: "started" }
      ]));
    } finally {
      await db.close();
    }
  });
});
