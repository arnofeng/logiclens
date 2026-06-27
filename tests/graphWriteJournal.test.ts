import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import type { FileNode, RepoNode } from "../src/core/parsing/types.js";

const tempDirs: string[] = [];

async function tempGraph(): Promise<{ dir: string; db: KuzuGraphDB }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-graph-journal-"));
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

function file(batchId: string): FileNode {
  return {
    id: "file:journal:index.ts",
    repoId: "repo:journal",
    path: "index.ts",
    language: "typescript",
    hash: "hash",
    loc: 1,
    batchId,
    indexedAt: "2026-06-22T00:00:00.000Z",
    active: true
  };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("graph write journal", () => {
  it("recovers incomplete batches by hiding batch-owned active artifacts", async () => {
    const { db } = await tempGraph();
    try {
      const batchId = "batch:journal-failed";
      await db.upsertRepo(repo());
      await db.upsertFile(file(batchId));
      await db.addContains("repo:journal", "file:journal:index.ts");
      await db.beginGraphWriteBatch({
        batchId,
        repoIds: ["repo:journal"],
        repoNames: ["journal"],
        writerMode: "bulk-upsert",
        atomicityMode: "journaled-recoverable",
        startedAt: "2026-06-22T00:00:00.000Z"
      });

      const before = await db.stats();
      expect(before.files).toBe(1);

      const recovered = await db.recoverIncompleteGraphWriteBatches({
        repoIds: ["repo:journal"],
        updatedAt: "2026-06-22T00:01:00.000Z"
      });

      expect(recovered.map((journal) => journal.batchId)).toEqual([batchId]);
      const after = await db.stats();
      expect(after.files).toBe(0);
      const states = await db.query<{ status: string; completedStage: string }>(
        "MATCH (b:GraphWriteBatch) WHERE b.batchId = $batchId RETURN b.status AS status, b.completedStage AS completedStage;",
        { batchId }
      );
      expect(states[0]).toEqual({ status: "recovered", completedStage: "recovered-cleanup" });
    } finally {
      await db.close();
    }
  });

  it("does not recover committed batches for the same repo", async () => {
    const { db } = await tempGraph();
    try {
      const batchId = "batch:journal-committed";
      await db.upsertRepo(repo());
      await db.upsertFile(file(batchId));
      await db.beginGraphWriteBatch({
        batchId,
        repoIds: ["repo:journal"],
        repoNames: ["journal"],
        writerMode: "merge",
        atomicityMode: "journaled-recoverable",
        startedAt: "2026-06-22T00:00:00.000Z"
      });
      await db.commitGraphWriteBatch({ batchId, updatedAt: "2026-06-22T00:00:01.000Z" });

      const recovered = await db.recoverIncompleteGraphWriteBatches({
        repoIds: ["repo:journal"],
        updatedAt: "2026-06-22T00:01:00.000Z"
      });

      expect(recovered).toEqual([]);
      expect((await db.stats()).files).toBe(1);
    } finally {
      await db.close();
    }
  });
});
