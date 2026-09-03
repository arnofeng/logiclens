import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { publicNodeStorageId, type PublicGraphGenerationScope } from "../src/core/graph-model/publicGraphGeneration.js";
import { pinPublicGraphReadSnapshot, releasePublicGraphReadSnapshot } from "../src/core/graph-model/readSnapshot.js";
import { SchemaGenerationStore } from "../src/core/schema/generationStore.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-generation-cleanup-lease-"));
  directories.push(directory);
  const db = await KuzuGraphDB.open(path.join(directory, "graph"));
  await db.initSchema("generation-cleanup-lease");
  return { db, generations: new SchemaGenerationStore(db, "workspace:lease-cleanup") };
}

async function beginFullGeneration(generations: SchemaGenerationStore, generation: string, createdAt: string) {
  return generations.beginFull({
    generation,
    createdAt,
    expectedActiveGeneration: (await generations.activeGeneration()) ?? null,
    expectedActiveRevision: (await generations.activeRevision()) ?? null
  });
}

async function stagePublicGeneration(db: KuzuGraphDB, scope: PublicGraphGenerationScope, batchId: string) {
  await db.upsertSystem("generation-cleanup-lease", scope);
  await db.beginGraphWriteBatch({
    batchId,
    generation: scope.generation,
    repoIds: ["repo:lease"],
    repoNames: ["lease"],
    writerMode: "generation-cow",
    atomicityMode: "journaled-recoverable",
    workspaceId: scope.workspaceId,
    startedAt: "2026-08-02T00:00:00.000Z"
  });
}

describe("generation cleanup lease guards", () => {
  it("does not let graph journal recovery delete a live leased pending generation", async () => {
    const { db, generations } = await fixture();
    try {
      const scope = { workspaceId: "workspace:lease-cleanup", generation: "generation:live-public" };
      await beginFullGeneration(generations, scope.generation, "2026-08-02T00:00:00.000Z");
      await stagePublicGeneration(db, scope, "batch:live-public");

      await expect(db.cleanupGraphWriteBatch("batch:live-public")).rejects.toThrow(/pending|lease/u);
      expect(await db.query<{ count: number }>(
        "MATCH (n:System) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN count(n) AS count;",
        scope
      )).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it("allows graph journal recovery after the pending lease is reclaimed", async () => {
    const { db, generations } = await fixture();
    try {
      const scope = { workspaceId: "workspace:lease-cleanup", generation: "generation:expired" };
      const batchId = "batch:expired";
      await beginFullGeneration(generations, scope.generation, "2026-08-02T00:00:00.000Z");
      await stagePublicGeneration(db, scope, batchId);
      await db.query(
        "MATCH (s:SchemaGenerationState {id:$id}) SET s.pendingLeaseUntil=$leaseUntil;",
        { id: "schema-generation-state:workspace:lease-cleanup", leaseUntil: "2026-08-02T00:01:00.000Z" }
      );

      expect(await generations.recoverExpiredReservation(new Date("2026-08-02T00:02:00.000Z")))
        .toEqual(expect.objectContaining({ kind: "full", generation: scope.generation }));
      await db.recoverIncompleteGraphWriteBatches({
        workspaceId: scope.workspaceId,
        updatedAt: "2026-08-02T00:03:00.000Z"
      });
      await generations.rollback(scope.generation);

      expect(await db.query<{ count: number }>(
        "MATCH (n:System) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN count(n) AS count;",
        scope
      )).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });

  it("keeps a leased reader generation intact across later pointer switches", async () => {
    const { db, generations } = await fixture();
    const workspaceId = "workspace:lease-cleanup";
    const first = { workspaceId, generation: "generation:reader-first" } as const;
    const second = { workspaceId, generation: "generation:reader-second" } as const;
    const third = { workspaceId, generation: "generation:reader-third" } as const;
    try {
      await beginFullGeneration(generations, first.generation, "2026-08-02T00:00:00.000Z");
      await db.upsertSystem("generation-cleanup-lease", first);
      await generations.commitFull(first.generation);
      const reader = await pinPublicGraphReadSnapshot(db, workspaceId);

      await beginFullGeneration(generations, second.generation, "2026-08-02T00:01:00.000Z");
      await db.upsertSystem("generation-cleanup-lease", second);
      await generations.commitFull(second.generation);
      await beginFullGeneration(generations, third.generation, "2026-08-02T00:02:00.000Z");
      await db.upsertSystem("generation-cleanup-lease", third);
      await generations.commitFull(third.generation);

      await expect(db.deletePublicGraphGeneration(first)).rejects.toThrow(/live read lease/u);
      await expect(generations.rollback(first.generation)).rejects.toThrow(/live read lease/u);
      await releasePublicGraphReadSnapshot(db, reader);
      await db.deletePublicGraphGeneration(first);
      await generations.rollback(first.generation);
      expect(await generations.activeGeneration()).toBe(third.generation);
    } finally {
      await db.close();
    }
  });

  it("starts a full pending generation without copying internal or public facts", async () => {
    const { db, generations } = await fixture();
    try {
      const workspaceId = "workspace:lease-cleanup";
      const parentGeneration = "generation:parent";
      const pendingGeneration = "generation:pending";
      const repoId = "repo:paging";
      await beginFullGeneration(generations, parentGeneration, "2026-08-02T00:00:00.000Z");
      await db.query(
        "CREATE (f:TypeDeclarationFact {id:$id}) SET f.generation=$generation, f.repoId=$repoId, f.fileId=$fileId, f.payload=$payload;",
        { id: "parent-fact", generation: parentGeneration, repoId, fileId: "file:parent", payload: "{}" }
      );
      await db.query(
        "CREATE (r:Repo {storageId:$storageId}) SET r.id=$repoId, r.workspaceId=$workspaceId, r.generation=$generation, r.name='paging', r.path='fixtures/paging', r.remoteUrl='', r.branch='', r.commitSha='', r.language='typescript', r.indexedAt=$indexedAt, r.summary='';",
        { storageId: publicNodeStorageId(parentGeneration, repoId), repoId, workspaceId, generation: parentGeneration, indexedAt: "2026-08-02T00:00:00.000Z" }
      );
      await generations.commitFull(parentGeneration);
      await beginFullGeneration(generations, pendingGeneration, "2026-08-02T00:01:00.000Z");

      expect(await db.query<{ count: number }>(
        "MATCH (f:TypeDeclarationFact) WHERE f.generation=$generation RETURN count(f) AS count;",
        { generation: pendingGeneration }
      )).toEqual([{ count: 0 }]);
      expect(await db.query<{ count: number }>(
        "MATCH (r:Repo) WHERE r.workspaceId=$workspaceId AND r.generation=$generation RETURN count(r) AS count;",
        { workspaceId, generation: pendingGeneration }
      )).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  });
});
