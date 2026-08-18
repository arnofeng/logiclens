import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import type { GraphValue } from "../src/core/graph-model/db.js";
import type { EntityNode, RepoNode } from "../src/core/parsing/types.js";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
import {
  LEXICAL_PROJECTION_SCHEMA_VERSION,
  type LexicalDocument
} from "../src/core/retrieval/types.js";
import { SchemaGenerationStore } from "../src/core/schema/generationStore.js";
import { SCHEMA_INDEX_VERSION } from "../src/core/schema/model.js";

type FailurePhase =
  | "graph-delete"
  | "graph-upsert"
  | "schema-facts"
  | "lexical-delete"
  | "lexical-upsert"
  | "revision-advance";

type AtomicSnapshot = {
  publicGraph: {
    repos: Array<Record<string, GraphValue>>;
    entities: Array<Record<string, GraphValue>>;
  };
  declarations: Array<Record<string, GraphValue>>;
  sourceReplacements: Array<Record<string, GraphValue>>;
  lexicalDocuments: readonly LexicalDocument[];
  lexicalStats: Array<Record<string, GraphValue>>;
  generation: Array<Record<string, GraphValue>>;
  revisionState: Array<Record<string, GraphValue>>;
};

function lexicalDocument(input: {
  workspaceId: string;
  repoId: string;
  fileId: string;
  id: string;
  token: string;
  batchId: string;
}): LexicalDocument {
  return {
    id: input.id,
    canonicalId: input.fileId,
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    kind: "file",
    title: "model.ts",
    qualifiedName: "src/model.ts",
    path: "src/model.ts",
    searchableText: `${input.token} stable lexical text`,
    tokens: [input.token, "stable", "lexical", "text"],
    active: true,
    sourceHash: `hash:${input.token}`,
    batchId: input.batchId,
    renderRef: createRenderRef({
      workspaceId: input.workspaceId,
      repoId: input.repoId,
      kind: "file",
      canonicalId: input.fileId,
      fileId: input.fileId,
      path: "src/model.ts"
    })
  };
}

function declaration(input: {
  id: string;
  repoId: string;
  fileId: string;
  canonicalName: string;
}) {
  return {
    id: input.id,
    repoId: input.repoId,
    sourceFileId: input.fileId,
    identity: {
      languageId: "typescript",
      repoId: input.repoId,
      resolutionScopeId: "module:src",
      canonicalName: input.canonicalName
    }
  };
}

describe("changed-only provider transaction atomicity", () => {
  let directory = "";
  let previousCloseMode: string | undefined;
  let db: KuzuGraphDB;
  let lexical: KuzuWorkspaceLexicalStore;

  beforeAll(async () => {
    previousCloseMode = process.env.REPOHELIX_KUZU_CLOSE_MODE;
    process.env.REPOHELIX_KUZU_CLOSE_MODE = "explicit";
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-changed-only-atomicity-"));
    db = await KuzuGraphDB.open(path.join(directory, "graph.kuzu"));
    await db.initSchema("changed-only-atomicity");
    lexical = new KuzuWorkspaceLexicalStore(db);
    await lexical.ensureSchema();
  });

  afterAll(async () => {
    await db?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    if (previousCloseMode === undefined) delete process.env.REPOHELIX_KUZU_CLOSE_MODE;
    else process.env.REPOHELIX_KUZU_CLOSE_MODE = previousCloseMode;
  });

  async function snapshot(input: {
    db: KuzuGraphDB;
    lexical: KuzuWorkspaceLexicalStore;
    workspaceId: string;
    generation: string;
    repoId: string;
    entityIds: readonly string[];
    documentIds: readonly string[];
  }): Promise<AtomicSnapshot> {
    const graphParams = {
      workspaceId: input.workspaceId,
      generation: input.generation,
      repoId: input.repoId
    };
    return {
      publicGraph: {
        repos: await input.db.query(
          "MATCH (r:Repo) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND r.id=$repoId " +
          "RETURN r.id AS id, r.name AS name, r.path AS path, r.commitSha AS commitSha, r.indexedAt AS indexedAt;",
          graphParams
        ),
        entities: await input.db.query(
          "MATCH (e:Entity) WHERE e.workspaceId=$workspaceId AND e.generation=$generation AND e.id IN $entityIds " +
          "RETURN e.id AS id, e.name AS name, e.kind AS kind, e.description AS description ORDER BY id;",
          {
            workspaceId: input.workspaceId,
            generation: input.generation,
            entityIds: [...input.entityIds]
          }
        )
      },
      declarations: await input.db.query(
        "MATCH (f:TypeDeclarationFact) WHERE f.generation=$generation AND f.repoId=$repoId " +
        "RETURN f.factId AS factId, f.fileId AS fileId, f.canonicalName AS canonicalName, f.payload AS payload ORDER BY factId;",
        { generation: input.generation, repoId: input.repoId }
      ),
      sourceReplacements: await input.db.query(
        "MATCH (r:SchemaSourceReplacement) WHERE r.generation=$generation AND r.repoId=$repoId " +
        "RETURN r.id AS id, r.revision AS revision, r.fileId AS fileId, r.factKind AS factKind, r.tombstone AS tombstone ORDER BY id;",
        { generation: input.generation, repoId: input.repoId }
      ),
      lexicalDocuments: await input.lexical.loadDocuments({
        workspaceId: input.workspaceId,
        generation: input.generation,
        documentIds: input.documentIds
      }),
      lexicalStats: await input.db.query(
        "MATCH (s:LexicalWorkspaceStats) WHERE s.workspaceId=$workspaceId AND s.generation=$generation " +
        "RETURN s.documentCount AS documentCount, s.indexSizeBytes AS indexSizeBytes;",
        { workspaceId: input.workspaceId, generation: input.generation }
      ),
      generation: await input.db.query(
        "MATCH (g:SchemaGeneration {id: $generation}) " +
        "RETURN g.status AS status, g.activeRevision AS activeRevision, " +
        "g.schemaIndexVersion AS schemaIndexVersion, g.lexicalProjectionVersion AS lexicalProjectionVersion;",
        { generation: input.generation }
      ),
      revisionState: await input.db.query(
        "MATCH (s:SchemaGenerationState {id: $stateId}) " +
        "RETURN s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision, " +
        "s.pendingGeneration AS pendingGeneration, s.pendingRevision AS pendingRevision, " +
        "s.pendingParentGeneration AS pendingParentGeneration, " +
        "s.pendingParentRevision AS pendingParentRevision, s.pendingLeaseUntil AS pendingLeaseUntil, " +
        "s.schemaIndexVersion AS schemaIndexVersion, s.lexicalProjectionVersion AS lexicalProjectionVersion, " +
        "s.protocolNonce AS protocolNonce;",
        { stateId: `schema-generation-state:${input.workspaceId}` }
      )
    };
  }

  it.each<FailurePhase>([
    "graph-delete",
    "graph-upsert",
    "schema-facts",
    "lexical-delete",
    "lexical-upsert",
    "revision-advance"
  ])(
    "rolls public graph, internal facts, lexical data, stats, and revision back after %s failure",
    async (phase) => {
      const suffix = phase;
      const tokenSuffix = phase.replaceAll("-", "");
      const workspaceId = `workspace:changed-only-atomicity:${suffix}`;
      const generation = `generation:changed-only-atomicity:${suffix}`;
      const nextRevision = `revision:changed-only-atomicity:${suffix}`;
      const repoId = `repo:changed-only-atomicity:${suffix}`;
      const fileId = `file:changed-only-atomicity:${suffix}`;
      const oldDocumentId = `lexical:changed-only-old:${suffix}`;
      const newDocumentId = `lexical:changed-only-new:${suffix}`;
      const oldToken = `rollbackoldtoken${tokenSuffix}`;
      const newToken = `rollbacknewtoken${tokenSuffix}`;
      const generations = new SchemaGenerationStore(db, workspaceId);
      const scope = { workspaceId, generation };
      const oldRepo: RepoNode = {
        id: repoId,
        name: "Old Repo",
        path: "C:/workspace/old",
        remoteUrl: "",
        branch: "main",
        commitSha: "old-commit",
        language: "typescript",
        indexedAt: "2026-08-02T00:00:00.000Z"
      };
      const newRepo: RepoNode = {
        ...oldRepo,
        name: "New Repo",
        path: "C:/workspace/new",
        commitSha: "new-commit",
        indexedAt: "2026-08-02T01:00:00.000Z"
      };
      const oldEntity: EntityNode = {
        id: `entity:old:${suffix}`,
        name: "Old Entity",
        kind: "schema",
        description: "active before the incremental mutation"
      };
      const newEntity: EntityNode = {
        id: `entity:new:${suffix}`,
        name: "New Entity",
        kind: "schema",
        description: "must roll back with the failed incremental mutation"
      };
      const oldDocument = lexicalDocument({
        workspaceId,
        repoId,
        fileId,
        id: oldDocumentId,
        token: oldToken,
        batchId: `batch:old:${suffix}`
      });
      const newDocument = lexicalDocument({
        workspaceId,
        repoId,
        fileId,
        id: newDocumentId,
        token: newToken,
        batchId: `batch:new:${suffix}`
      });

      await generations.beginFull({
        generation,
        createdAt: "2026-08-02T00:00:00.000Z",
        expectedActiveGeneration: null,
        expectedActiveRevision: null
      });
      await lexical.initializeGeneration(scope);
      await db.upsertSystem("changed-only-atomicity", scope);
      await db.upsertRepo(oldRepo, scope);
      await db.upsertEntity(oldEntity, scope);
      await generations.appendFullGenerationBatch({
        generation,
        facts: {
          declarations: [declaration({ id: `declaration:old:${suffix}`, repoId, fileId, canonicalName: "example.OldModel" })],
          resolutionContexts: [], resolutionScopeDependencies: [], roots: [], dependencies: [],
          provenance: [], diagnostics: [], fingerprints: []
        },
        contributions: []
      });
      await lexical.upsertDocuments({
        workspaceId,
        generation,
        documents: [oldDocument]
      });
      await db.initializePublicGraphStats(scope, generation, await db.computePublicGraphStats(scope));
      await generations.validateFull(generation);
      await generations.commitFull(generation);
      await generations.reserveIncremental({
        revision: nextRevision,
        expectedActiveGeneration: generation,
        expectedActiveRevision: generation
      });

      const before = await snapshot({
        db,
        lexical,
        workspaceId,
        generation,
        repoId,
        entityIds: [oldEntity.id, newEntity.id],
        documentIds: [oldDocumentId, newDocumentId]
      });

      const failure = db.applyIncrementalIndexMutation({
        workspaceId,
        expectedActiveGeneration: generation,
        expectedActiveRevision: generation,
        nextRevision,
        schemaIndexVersion: SCHEMA_INDEX_VERSION,
        lexicalProjectionVersion: LEXICAL_PROJECTION_SCHEMA_VERSION
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
            facts: [declaration({ id: `declaration:new:${suffix}`, repoId, fileId, canonicalName: "example.NewModel" })]
          }],
          behaviorFingerprintReplacements: [],
          contributionReplacements: []
        });
        if (phase === "schema-facts") throw new Error("injected failure after schema facts");
        await lexical.applyIncrementalMutation({
          workspaceId,
          generation,
          expectedRevision: generation,
          nextRevision: `${nextRevision}:lexical-delete`,
          upsertDocuments: [],
          deleteDocumentIds: [oldDocumentId]
        });
        if (phase === "lexical-delete") throw new Error("injected failure after lexical delete");
        await lexical.applyIncrementalMutation({
          workspaceId,
          generation,
          expectedRevision: `${nextRevision}:lexical-delete`,
          nextRevision,
          upsertDocuments: [newDocument],
          deleteDocumentIds: []
        });
        if (phase === "lexical-upsert") throw new Error("injected failure after lexical upsert");
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
          "MATCH (s:SchemaGenerationState {id: $stateId}) SET s.pendingRevision=$lostRevision;",
          {
            stateId: `schema-generation-state:${workspaceId}`,
            lostRevision: `revision:lost:${suffix}`
          }
        );
      });
      await expect(failure).rejects.toThrow(
        phase === "revision-advance"
          ? "final compare-and-swap"
          : `injected failure after ${phase.replace("-", " ")}`
      );

      const after = await snapshot({
        db,
        lexical,
        workspaceId,
        generation,
        repoId,
        entityIds: [oldEntity.id, newEntity.id],
        documentIds: [oldDocumentId, newDocumentId]
      });
      expect(after).toEqual(before);
      expect(await generations.activeGeneration()).toBe(generation);
      expect(await generations.activeRevision()).toBe(generation);
      expect((await lexical.search(
        { workspaceId, generation, text: oldToken },
        { topK: 10 }
      )).map((hit) => hit.documentId)).toEqual([oldDocumentId]);
      expect(await lexical.search(
        { workspaceId, generation, text: newToken },
        { topK: 10 }
      )).toEqual([]);
      await db.query("CHECKPOINT;");
    },
    30_000
  );
});
