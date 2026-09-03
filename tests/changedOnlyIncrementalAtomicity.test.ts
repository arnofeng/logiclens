import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import type { GraphValue } from "../src/core/graph-model/db.js";
import type { EntityNode, RepoNode } from "../src/core/parsing/types.js";
import { SchemaGenerationStore } from "../src/core/schema/generationStore.js";
import { SCHEMA_INDEX_VERSION } from "../src/core/schema/model.js";

type FailurePhase = "graph-delete" | "graph-upsert" | "schema-facts" | "revision-advance";

function declaration(id: string, repoId: string, fileId: string, canonicalName: string) {
  return {
    id,
    repoId,
    sourceFileId: fileId,
    identity: {
      languageId: "typescript",
      repoId,
      resolutionScopeId: "module:src",
      canonicalName
    }
  };
}

describe("changed-only provider transaction atomicity", () => {
  let directory = "";
  let previousCloseMode: string | undefined;
  let db: KuzuGraphDB;

  beforeAll(async () => {
    previousCloseMode = process.env.REPOHELIX_KUZU_CLOSE_MODE;
    process.env.REPOHELIX_KUZU_CLOSE_MODE = "explicit";
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-changed-only-atomicity-"));
    db = await KuzuGraphDB.open(path.join(directory, "graph.kuzu"));
    await db.initSchema("changed-only-atomicity");
  });

  afterAll(async () => {
    await db?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    if (previousCloseMode === undefined) delete process.env.REPOHELIX_KUZU_CLOSE_MODE;
    else process.env.REPOHELIX_KUZU_CLOSE_MODE = previousCloseMode;
  });

  async function snapshot(workspaceId: string, generation: string, repoId: string, entityIds: string[]) {
    return {
      repos: await db.query<Record<string, GraphValue>>(
        "MATCH (r:Repo) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND r.id=$repoId RETURN r.id AS id, r.name AS name, r.path AS path, r.commitSha AS commitSha, r.indexedAt AS indexedAt;",
        { workspaceId, generation, repoId }
      ),
      entities: await db.query<Record<string, GraphValue>>(
        "MATCH (e:Entity) WHERE e.workspaceId=$workspaceId AND e.generation=$generation AND e.id IN $entityIds RETURN e.id AS id, e.name AS name, e.kind AS kind, e.description AS description ORDER BY id;",
        { workspaceId, generation, entityIds }
      ),
      declarations: await db.query<Record<string, GraphValue>>(
        "MATCH (f:TypeDeclarationFact) WHERE f.generation=$generation AND f.repoId=$repoId RETURN f.factId AS factId, f.fileId AS fileId, f.canonicalName AS canonicalName, f.payload AS payload ORDER BY factId;",
        { generation, repoId }
      ),
      replacements: await db.query<Record<string, GraphValue>>(
        "MATCH (r:SchemaSourceReplacement) WHERE r.generation=$generation AND r.repoId=$repoId RETURN r.id AS id, r.revision AS revision, r.fileId AS fileId, r.factKind AS factKind, r.tombstone AS tombstone ORDER BY id;",
        { generation, repoId }
      ),
      generationState: await db.query<Record<string, GraphValue>>(
        "MATCH (s:SchemaGenerationState {id:$stateId}) RETURN s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision, s.pendingGeneration AS pendingGeneration, s.pendingRevision AS pendingRevision, s.pendingParentGeneration AS pendingParentGeneration, s.pendingParentRevision AS pendingParentRevision, s.pendingLeaseUntil AS pendingLeaseUntil, s.schemaIndexVersion AS schemaIndexVersion, s.protocolNonce AS protocolNonce;",
        { stateId: `schema-generation-state:${workspaceId}` }
      ),
      stats: await db.query<Record<string, GraphValue>>(
        "MATCH (s:PublicGraphStats) WHERE s.workspaceId=$workspaceId AND s.generation=$generation RETURN s.revision AS revision, s.repos AS repos, s.files AS files, s.codeNodes AS codeNodes, s.sectionNodes AS sectionNodes, s.callEdges AS callEdges, s.importEdges AS importEdges, s.entities AS entities;",
        { workspaceId, generation }
      )
    };
  }

  it.each<FailurePhase>(["graph-delete", "graph-upsert", "schema-facts", "revision-advance"])(
    "rolls graph facts and revision state back after %s failure",
    async (phase) => {
      const suffix = phase;
      const workspaceId = `workspace:changed-only-atomicity:${suffix}`;
      const generation = `generation:changed-only-atomicity:${suffix}`;
      const nextRevision = `revision:changed-only-atomicity:${suffix}`;
      const repoId = `repo:changed-only-atomicity:${suffix}`;
      const fileId = `file:changed-only-atomicity:${suffix}`;
      const generations = new SchemaGenerationStore(db, workspaceId);
      const scope = { workspaceId, generation };
      const oldRepo: RepoNode = { id: repoId, name: "Old Repo", path: "C:/workspace/old", remoteUrl: "", branch: "main", commitSha: "old-commit", language: "typescript", indexedAt: "2026-08-02T00:00:00.000Z" };
      const newRepo: RepoNode = { ...oldRepo, name: "New Repo", path: "C:/workspace/new", commitSha: "new-commit", indexedAt: "2026-08-02T01:00:00.000Z" };
      const oldEntity: EntityNode = { id: `entity:old:${suffix}`, name: "Old Entity", kind: "schema", description: "active before mutation" };
      const newEntity: EntityNode = { id: `entity:new:${suffix}`, name: "New Entity", kind: "schema", description: "must roll back" };

      await generations.beginFull({ generation, createdAt: "2026-08-02T00:00:00.000Z", expectedActiveGeneration: null, expectedActiveRevision: null });
      await db.upsertSystem("changed-only-atomicity", scope);
      await db.upsertRepo(oldRepo, scope);
      await db.upsertEntity(oldEntity, scope);
      await generations.appendFullGenerationBatch({
        generation,
        facts: {
          declarations: [declaration(`declaration:old:${suffix}`, repoId, fileId, "example.OldModel")],
          resolutionContexts: [], resolutionScopeDependencies: [], roots: [], dependencies: [],
          provenance: [], diagnostics: [], fingerprints: []
        },
        contributions: []
      });
      await db.initializePublicGraphStats(scope, generation, await db.computePublicGraphStats(scope));
      await generations.validateFull(generation);
      await generations.commitFull(generation);
      await generations.reserveIncremental({ revision: nextRevision, expectedActiveGeneration: generation, expectedActiveRevision: generation });

      const before = await snapshot(workspaceId, generation, repoId, [oldEntity.id, newEntity.id]);
      const failure = db.applyIncrementalIndexMutation({
        workspaceId,
        expectedActiveGeneration: generation,
        expectedActiveRevision: generation,
        nextRevision,
        schemaIndexVersion: SCHEMA_INDEX_VERSION
      }, async () => {
        await db.query(
          "MATCH (e:Entity) WHERE e.workspaceId=$workspaceId AND e.generation=$generation AND e.id=$entityId DELETE e;",
          { workspaceId, generation, entityId: oldEntity.id }
        );
        if (phase === "graph-delete") throw new Error("injected failure after graph delete");
        await db.upsertEntity(newEntity, scope);
        await db.upsertRepo(newRepo, scope);
        if (phase === "graph-upsert") throw new Error("injected failure after graph upsert");
        await generations.applyActiveReplacementBatch({
          generation,
          revision: nextRevision,
          sourceReplacements: [{
            kind: "declarations",
            repoId,
            fileId,
            facts: [declaration(`declaration:new:${suffix}`, repoId, fileId, "example.NewModel")]
          }],
          behaviorFingerprintReplacements: [],
          contributionReplacements: []
        });
        if (phase === "schema-facts") throw new Error("injected failure after schema facts");
        await db.applyPublicGraphStatsDelta(scope, {
          expectedRevision: generation,
          nextRevision,
          delta: {
            repos: 0,
            files: 0,
            codeNodes: 0,
            sectionNodes: 0,
            callEdges: 0,
            importEdges: 0,
            entities: 0
          }
        });
        await db.query(
          "MATCH (s:SchemaGenerationState {id:$stateId}) SET s.pendingRevision=$lostRevision;",
          { stateId: `schema-generation-state:${workspaceId}`, lostRevision: `revision:lost:${suffix}` }
        );
      });

      await expect(failure).rejects.toThrow(phase === "revision-advance" ? "final compare-and-swap" : `injected failure after ${phase.replace("-", " ")}`);
      expect(await snapshot(workspaceId, generation, repoId, [oldEntity.id, newEntity.id])).toEqual(before);
      expect(await generations.activeGeneration()).toBe(generation);
      expect(await generations.activeRevision()).toBe(generation);
      await db.query("CHECKPOINT;");
    },
    30_000
  );
});
