import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import {
  publicNodeStorageId,
  type PublicGraphGenerationScope
} from "../src/core/graph-model/publicGraphGeneration.js";
import {
  pinPublicGraphReadSnapshot,
  releasePublicGraphReadSnapshot
} from "../src/core/graph-model/readSnapshot.js";
import { runIndexing } from "../src/core/indexing/run.js";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
import type { LexicalDocument } from "../src/core/retrieval/types.js";
import { SchemaGenerationStore } from "../src/core/schema/generationStore.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  db: KuzuGraphDB;
  generations: SchemaGenerationStore;
  lexical: KuzuWorkspaceLexicalStore;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-generation-cleanup-lease-"));
  directories.push(directory);
  const db = await KuzuGraphDB.open(path.join(directory, "graph"));
  await db.initSchema("generation-cleanup-lease");
  const lexical = new KuzuWorkspaceLexicalStore(db);
  await lexical.ensureSchema();
  return {
    db,
    generations: new SchemaGenerationStore(db, "workspace:lease-cleanup"),
    lexical
  };
}

function document(batchId: string): LexicalDocument {
  return {
    id: "lexical:lease-document",
    canonicalId: "schema:lease-document",
    workspaceId: "workspace:lease-cleanup",
    repoId: "repo:lease",
    kind: "contractSpec",
    title: "Lease document",
    searchableText: "lease cleanup guard",
    tokens: ["lease", "cleanup", "guard"],
    active: true,
    sourceHash: "hash:lease-document",
    batchId,
    renderRef: createRenderRef({
      workspaceId: "workspace:lease-cleanup",
      repoId: "repo:lease",
      kind: "contractSpec",
      canonicalId: "schema:lease-document",
      fileId: "file:lease-document",
      path: "src/lease-document.ts"
    })
  };
}

async function stagePublicGeneration(
  db: KuzuGraphDB,
  scope: PublicGraphGenerationScope,
  batchId: string
): Promise<void> {
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

async function beginFullGeneration(
  generations: SchemaGenerationStore,
  generation: string,
  createdAt: string
): Promise<string | undefined> {
  return generations.beginFull({
    generation,
    createdAt,
    expectedActiveGeneration: (await generations.activeGeneration()) ?? null,
    expectedActiveRevision: (await generations.activeRevision()) ?? null
  });
}

describe("generation cleanup lease guards", () => {
  it("does not let graph journal recovery delete a live leased pending generation", async () => {
    const { db, generations } = await fixture();
    try {
      const scope = { workspaceId: "workspace:lease-cleanup", generation: "generation:live-public" };
      await beginFullGeneration(generations, scope.generation, "2026-08-02T00:00:00.000Z");
      await stagePublicGeneration(db, scope, "batch:live-public");

      await expect(db.cleanupGraphWriteBatch("batch:live-public"))
        .rejects.toThrow(/pending|lease/u);
      expect(await db.query<{ count: number }>(
        "MATCH (n:System) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN count(n) AS count;",
        scope
      )).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  });

  it("does not let lexical initialization target the active generation", async () => {
    const { db, generations, lexical } = await fixture();
    try {
      const scope = { workspaceId: "workspace:lease-cleanup", generation: "generation:active-clone-guard" };
      await beginFullGeneration(generations, scope.generation, "2026-08-02T00:00:00.000Z");
      await db.upsertSystem("generation-cleanup-lease", scope);
      await generations.commitFull(scope.generation);

      await expect(lexical.initializeGeneration(scope)).rejects.toMatchObject({ code: "write_failed" });
      expect(await db.query<{ count: number }>(
        "MATCH (n:System) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN count(n) AS count;",
        scope
      )).toEqual([{ count: 1 }]);
      expect(await generations.activeGeneration()).toBe(scope.generation);
    } finally {
      await db.close();
    }
  });

  it("does not let lexical cleanup delete a live leased pending generation", async () => {
    const { db, generations, lexical } = await fixture();
    try {
      const scope = { workspaceId: "workspace:lease-cleanup", generation: "generation:live-lexical" };
      await beginFullGeneration(generations, scope.generation, "2026-08-02T00:00:00.000Z");
      await lexical.initializeGeneration(scope);
      await lexical.upsertDocuments({ ...scope, documents: [document("batch:live-lexical")] });

      await expect(lexical.deleteGeneration(scope)).rejects.toMatchObject({ code: "cleanup_failed" });
      expect(await lexical.loadDocuments({ ...scope, documentIds: ["lexical:lease-document"] }))
        .toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it("allows journal recovery after the pending lease has expired and been reclaimed", async () => {
    const { db, generations, lexical } = await fixture();
    try {
      const scope = { workspaceId: "workspace:lease-cleanup", generation: "generation:expired" };
      const batchId = "batch:expired";
      await beginFullGeneration(generations, scope.generation, "2026-08-02T00:00:00.000Z");
      await stagePublicGeneration(db, scope, batchId);
      await lexical.initializeGeneration(scope);
      await lexical.upsertDocuments({ ...scope, documents: [document(batchId)] });
      await db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) SET s.pendingLeaseUntil=$leaseUntil;",
        {
          id: "schema-generation-state:workspace:lease-cleanup",
          leaseUntil: "2026-08-02T00:01:00.000Z"
        }
      );

      expect(await generations.recoverExpiredReservation(new Date("2026-08-02T00:02:00.000Z")))
        .toEqual(expect.objectContaining({ kind: "full", generation: scope.generation }));
      await db.recoverIncompleteGraphWriteBatches({
        workspaceId: scope.workspaceId,
        updatedAt: "2026-08-02T00:03:00.000Z",
        cleanupBatch: async (journal) => {
          await lexical.deleteGeneration({ workspaceId: journal.workspaceId, generation: journal.generation });
          await lexical.cleanupBatch({ workspaceId: journal.workspaceId, batchId: journal.batchId });
        }
      });
      await generations.rollback(scope.generation);

      expect(await db.query<{ count: number }>(
        "MATCH (n:System) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN count(n) AS count;",
        scope
      )).toEqual([{ count: 0 }]);
      expect(await lexical.loadDocuments({ ...scope, documentIds: ["lexical:lease-document"] }))
        .toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it("recovers only crash-abandoned generation journals during the next real index run", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-generation-crash-recovery-"));
    directories.push(directory);
    const repoPath = path.join(directory, "repo");
    const sourcePath = path.join(repoPath, "src", "index.ts");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "crash-recovery-repo", version: "1.0.0" }), "utf8");
    await fs.writeFile(sourcePath, "export const crashRecovery = true;\n", "utf8");
    const config = {
      ...defaultConfig(),
      systemName: `generation-crash-recovery-${path.basename(directory)}`,
      repos: [{ name: "crash-recovery-repo", path: repoPath }]
    };
    const workspaceId = deriveWorkspaceId(config.systemName);
    const db = await KuzuGraphDB.open(path.join(directory, "graph"));
    try {
      await db.initSchema(config.systemName);
      await runIndexing(db, config, { cwd: directory, writeMode: "auto" });
      const generations = new SchemaGenerationStore(db, workspaceId);
      const lexical = new KuzuWorkspaceLexicalStore(db);
      const parentGeneration = await generations.activeGeneration();
      expect(parentGeneration).toBeDefined();

      const abandonedGeneration = "generation:crash-abandoned";
      const abandonedBatchId = "batch:crash-abandoned";
      const abandonedScope = { workspaceId, generation: abandonedGeneration };
      await beginFullGeneration(generations, abandonedGeneration, "2026-08-02T00:01:00.000Z");
      await lexical.initializeGeneration(abandonedScope);
      const orphanRepo = {
        id: "repo:crash-orphan",
        name: "crash-orphan",
        path: "fixtures/crash-orphan",
        remoteUrl: "",
        branch: "main",
        commitSha: "",
        language: "typescript",
        indexedAt: "2026-08-02T00:01:00.000Z"
      };
      await db.upsertRepo(orphanRepo, abandonedScope);
      const orphanDocument: LexicalDocument = {
        ...document(abandonedBatchId),
        id: "lexical:crash-orphan",
        canonicalId: "schema:crash-orphan",
        workspaceId,
        repoId: orphanRepo.id,
        sourceHash: "hash:crash-orphan",
        batchId: abandonedBatchId,
        renderRef: createRenderRef({
          workspaceId,
          repoId: orphanRepo.id,
          kind: "contractSpec",
          canonicalId: "schema:crash-orphan",
          fileId: "file:crash-orphan",
          path: "src/crash-orphan.ts"
        })
      };
      await lexical.upsertDocuments({ ...abandonedScope, documents: [orphanDocument] });
      await lexical.stageBatch({
        ...abandonedScope,
        batchId: abandonedBatchId,
        repoIds: [orphanRepo.id]
      });
      await db.beginGraphWriteBatch({
        batchId: abandonedBatchId,
        generation: abandonedGeneration,
        parentGeneration,
        repoIds: [orphanRepo.id],
        repoNames: [orphanRepo.name],
        writerMode: "generation-cow",
        atomicityMode: "journaled-recoverable",
        workspaceId,
        startedAt: "2026-08-02T00:01:00.000Z"
      });

      const activeSentinelBatchId = "batch:active-sentinel";
      await db.beginGraphWriteBatch({
        batchId: activeSentinelBatchId,
        generation: parentGeneration!,
        repoIds: ["repo:crash-recovery-repo"],
        repoNames: ["crash-recovery-repo"],
        writerMode: "generation-cow",
        atomicityMode: "journaled-recoverable",
        workspaceId,
        startedAt: "2026-08-02T00:00:00.000Z"
      });
      await db.query(
        "MATCH (s:SchemaGenerationState {id: $id}) SET s.pendingLeaseUntil=$leaseUntil;",
        {
          id: `schema-generation-state:${workspaceId}`,
          leaseUntil: "2026-08-02T00:02:00.000Z"
        }
      );

      await runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true });

      expect(await generations.activeGeneration()).not.toBe(abandonedGeneration);
      expect(await db.query<{ status: string; completedStage: string }>(
        "MATCH (b:GraphWriteBatch {id: $id}) RETURN b.status AS status, b.completedStage AS completedStage;",
        { id: `graph-write:${abandonedBatchId}` }
      )).toEqual([{ status: "recovered", completedStage: "recovered-cleanup" }]);
      expect(await db.query<{ status: string }>(
        "MATCH (b:GraphWriteBatch {id: $id}) RETURN b.status AS status;",
        { id: `graph-write:${activeSentinelBatchId}` }
      )).toEqual([{ status: "started" }]);
      expect(await db.query<{ count: number | bigint }>(
        "MATCH (g:SchemaGeneration {id: $generation}) RETURN count(g) AS count;",
        { generation: abandonedGeneration }
      )).toEqual([{ count: 0 }]);
      expect(await db.query<{ count: number | bigint }>(
        "MATCH (n:Repo) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN count(n) AS count;",
        abandonedScope
      )).toEqual([{ count: 0 }]);
      expect(await lexical.loadDocuments({
        ...abandonedScope,
        documentIds: [orphanDocument.id]
      })).toEqual([]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("keeps one physical generation while changed-only advances logical revisions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-superseded-generation-gc-"));
    directories.push(directory);
    const repoPath = path.join(directory, "repo");
    const sourcePath = path.join(repoPath, "src", "index.ts");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "gc-repo", version: "1.0.0" }), "utf8");
    await fs.writeFile(sourcePath, "export const version = 1;\n", "utf8");
    const config = {
      ...defaultConfig(),
      systemName: `generation-gc-${path.basename(directory)}`,
      repos: [{ name: "gc-repo", path: repoPath }]
    };
    const workspaceId = deriveWorkspaceId(config.systemName);
    const db = await KuzuGraphDB.open(path.join(directory, "graph"));
    try {
      await db.initSchema(config.systemName);
      await runIndexing(db, config, { cwd: directory, writeMode: "auto" });
      const generations = new SchemaGenerationStore(db, workspaceId);
      const firstGeneration = await generations.activeGeneration();
      const firstRevision = await generations.activeRevision();
      expect(firstGeneration).toBeDefined();
      expect(firstRevision).toBeDefined();

      await fs.writeFile(sourcePath, "export const version = 2;\n", "utf8");
      await runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true });
      const secondGeneration = await generations.activeGeneration();
      const secondRevision = await generations.activeRevision();
      expect(secondGeneration).toBe(firstGeneration);
      expect(secondRevision).toBeDefined();
      expect(secondRevision).not.toBe(firstRevision);
      expect(await db.query<{ status: string }>(
        "MATCH (g:SchemaGeneration {id: $generation}) RETURN g.status AS status;",
        { generation: firstGeneration! }
      )).toEqual([{ status: "active" }]);

      const deletedGenerations: string[] = [];
      const originalDelete = db.deletePublicGraphGeneration.bind(db);
      db.deletePublicGraphGeneration = async (scope) => {
        deletedGenerations.push(scope.generation);
        await originalDelete(scope);
      };
      await fs.writeFile(sourcePath, "export const version = 3;\n", "utf8");
      await runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true });
      const thirdGeneration = await generations.activeGeneration();
      const thirdRevision = await generations.activeRevision();

      expect(thirdGeneration).toBe(firstGeneration);
      expect(thirdRevision).toBeDefined();
      expect(thirdRevision).not.toBe(secondRevision);
      expect(deletedGenerations).toEqual([]);
      expect(await db.query<{ count: number }>(
        "MATCH (g:SchemaGeneration) WHERE g.workspaceId=$workspaceId RETURN count(g) AS count;",
        { workspaceId }
      )).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("keeps a leased reader's generation intact across two later pointer switches", async () => {
    const { db, generations, lexical } = await fixture();
    const workspaceId = "workspace:lease-cleanup";
    const first = { workspaceId, generation: "generation:reader-first" } as const;
    const second = { workspaceId, generation: "generation:reader-second" } as const;
    const third = { workspaceId, generation: "generation:reader-third" } as const;
    try {
      await beginFullGeneration(generations, first.generation, "2026-08-02T00:00:00.000Z");
      await db.upsertSystem("generation-cleanup-lease", first);
      await lexical.initializeGeneration(first);
      await lexical.upsertDocuments({ ...first, documents: [document("batch:reader-first")] });
      await generations.commitFull(first.generation);
      const reader = await pinPublicGraphReadSnapshot(db, workspaceId);
      expect(reader.generation).toBe(first.generation);

      await beginFullGeneration(generations, second.generation, "2026-08-02T00:01:00.000Z");
      await db.upsertSystem("generation-cleanup-lease", second);
      await generations.commitFull(second.generation);
      await beginFullGeneration(generations, third.generation, "2026-08-02T00:02:00.000Z");
      await db.upsertSystem("generation-cleanup-lease", third);
      await generations.commitFull(third.generation);

      await expect(db.deletePublicGraphGeneration(first)).rejects.toThrow(/live read lease/u);
      await expect(lexical.deleteGeneration(first)).rejects.toMatchObject({ code: "cleanup_failed" });
      await expect(generations.rollback(first.generation)).rejects.toThrow(/live read lease/u);
      expect(await db.query<{ count: number }>(
        "MATCH (n:System) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN count(n) AS count;",
        first
      )).toEqual([{ count: 1 }]);
      expect(await lexical.loadDocuments({ ...first, documentIds: ["lexical:lease-document"] })).toHaveLength(1);

      await releasePublicGraphReadSnapshot(db, reader);
      await lexical.deleteGeneration(first);
      await db.deletePublicGraphGeneration(first);
      await generations.rollback(first.generation);
      expect(await db.query<{ count: number }>(
        "MATCH (n:System) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN count(n) AS count;",
        first
      )).toEqual([{ count: 0 }]);
      expect(await lexical.loadDocuments({ ...first, documentIds: ["lexical:lease-document"] })).toHaveLength(0);
      expect(await generations.activeGeneration()).toBe(third.generation);
    } finally {
      await db.close();
    }
  });

  it("starts a full pending generation without copying internal or public facts", async () => {
    const { db, generations } = await fixture();
    try {
      const parentGeneration = "generation:paging-parent";
      const pendingGeneration = "generation:paging-pending";
      const workspaceId = "workspace:lease-cleanup";
      const repoId = "repo:paging";
      await beginFullGeneration(generations, parentGeneration, "2026-08-02T00:00:00.000Z");

      const facts = Array.from({ length: 1001 }, (_, index) => {
        const id = `declaration:${index.toString().padStart(4, "0")}`;
        return {
          storageId: `parent-fact:${index.toString().padStart(4, "0")}`,
          generation: parentGeneration,
          repoId,
          fileId: `file:${index.toString().padStart(4, "0")}`,
          payload: JSON.stringify({ id, repoId, sourceFileId: `file:${index.toString().padStart(4, "0")}` })
        };
      });
      await db.query(
        "UNWIND $batch AS row CREATE (f:TypeDeclarationFact {id: row.storageId}) " +
        "SET f.generation=row.generation, f.repoId=row.repoId, f.fileId=row.fileId, f.payload=row.payload;",
        { batch: facts }
      );

      const repoStorageId = publicNodeStorageId(parentGeneration, repoId);
      await db.query(
        "CREATE (r:Repo {storageId: $storageId}) SET r.id=$repoId, r.workspaceId=$workspaceId, " +
        "r.generation=$generation, r.name=$name, r.path=$path, r.remoteUrl='', r.branch='', " +
        "r.commitSha='', r.language='typescript', r.indexedAt=$indexedAt, r.summary='';",
        {
          storageId: repoStorageId,
          repoId,
          workspaceId,
          generation: parentGeneration,
          name: "paging",
          path: "fixtures/paging",
          indexedAt: "2026-08-02T00:00:00.000Z"
        }
      );
      const files = Array.from({ length: 1001 }, (_, index) => {
        const id = `file:paging:${index.toString().padStart(4, "0")}`;
        return {
          storageId: publicNodeStorageId(parentGeneration, id),
          id,
          repoId,
          path: `src/${index.toString().padStart(4, "0")}.ts`,
          workspaceId,
          generation: parentGeneration
        };
      });
      await db.query(
        "UNWIND $batch AS row CREATE (f:File {storageId: row.storageId}) " +
        "SET f.id=row.id, f.repoId=row.repoId, f.path=row.path, f.workspaceId=row.workspaceId, " +
        "f.generation=row.generation, f.language='typescript', f.hash='hash', f.loc=1, " +
        "f.batchId='batch:paging-parent', f.indexedAt='2026-08-02T00:00:00.000Z', f.active=true;",
        { batch: files }
      );
      await db.query(
        "UNWIND $batch AS row MATCH (r:Repo {storageId: $repoStorageId}), (f:File {storageId: row.storageId}) " +
        "CREATE (r)-[:CONTAINS {workspaceId: row.workspaceId, generation: row.generation}]->(f);",
        { batch: files, repoStorageId }
      );
      await generations.commitFull(parentGeneration);

      await beginFullGeneration(generations, pendingGeneration, "2026-08-02T00:01:00.000Z");

      expect(await db.query<{ count: number }>(
        "MATCH (f:TypeDeclarationFact) WHERE f.generation=$generation RETURN count(f) AS count;",
        { generation: pendingGeneration }
      )).toEqual([{ count: 0 }]);
      expect(await db.query<{ count: number }>(
        "MATCH (f:File) WHERE f.workspaceId=$workspaceId AND f.generation=$generation RETURN count(f) AS count;",
        { workspaceId, generation: pendingGeneration }
      )).toEqual([{ count: 0 }]);
      expect(await db.query<{ count: number }>(
        "MATCH (:Repo)-[r:CONTAINS]->(:File) WHERE r.workspaceId=$workspaceId AND r.generation=$generation RETURN count(r) AS count;",
        { workspaceId, generation: pendingGeneration }
      )).toEqual([{ count: 0 }]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
