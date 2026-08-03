import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
import { SchemaGenerationStore } from "../src/core/schema/generationStore.js";
import {
  LEXICAL_PROJECTION_SCHEMA_VERSION,
  type LexicalDocument
} from "../src/core/retrieval/types.js";
import { SCHEMA_INDEX_VERSION } from "../src/core/schema/model.js";

const WORKSPACE_ID = "workspace:lexical-generation-cow";
const PARENT_GENERATION = "schema-generation:parent";
const PENDING_GENERATION = "schema-generation:pending";

function document(searchableText: string, batchId: string): LexicalDocument {
  const result: LexicalDocument = {
    id: "lexical:contract-spec:user",
    canonicalId: "contract-spec:user",
    workspaceId: WORKSPACE_ID,
    repoId: "repo:one",
    kind: "contractSpec",
    title: "User",
    qualifiedName: "example.User",
    path: "src/models.ts",
    searchableText,
    tokens: searchableText.split(" "),
    active: true,
    sourceHash: `hash:${searchableText}`,
    batchId,
    renderRef: ""
  };
  result.renderRef = createRenderRef({
    workspaceId: result.workspaceId,
    repoId: result.repoId,
    kind: result.kind,
    canonicalId: result.canonicalId,
    fileId: "file:models",
    path: result.path!
  });
  return result;
}

describe("lexical generation isolation", () => {
  let directory = "";
  let previousCloseMode: string | undefined;
  let db: KuzuGraphDB;
  let store: KuzuWorkspaceLexicalStore;

  beforeAll(async () => {
    previousCloseMode = process.env.REPOHELIX_KUZU_CLOSE_MODE;
    process.env.REPOHELIX_KUZU_CLOSE_MODE = "explicit";
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-lexical-cow-"));
    db = await KuzuGraphDB.open(path.join(directory, "graph.kuzu"));
    await db.initSchema("lexical-generation-cow");
    store = new KuzuWorkspaceLexicalStore(db);
    await store.ensureSchema();
  });

  afterAll(async () => {
    await db?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    if (previousCloseMode === undefined) delete process.env.REPOHELIX_KUZU_CLOSE_MODE;
    else process.env.REPOHELIX_KUZU_CLOSE_MODE = previousCloseMode;
  });

  it("keeps parent and pending documents isolated until the caller switches generations", async () => {
    const parent = document("parentuniquex stable-user", "batch:parent");
    const pending = document("pendinguniquex changed-user", "batch:pending");

    await store.initializeGeneration({ workspaceId: WORKSPACE_ID, generation: PARENT_GENERATION });
    await store.upsertDocuments({
      workspaceId: WORKSPACE_ID,
      generation: PARENT_GENERATION,
      documents: [parent]
    });
    await store.initializeGeneration({
      workspaceId: WORKSPACE_ID,
      generation: PENDING_GENERATION
    });
    await store.upsertDocuments({
      workspaceId: WORKSPACE_ID,
      generation: PENDING_GENERATION,
      documents: [pending]
    });

    expect(await store.loadDocuments({
      workspaceId: WORKSPACE_ID,
      generation: PARENT_GENERATION,
      documentIds: [parent.id]
    })).toEqual([parent]);
    expect(await store.loadDocuments({
      workspaceId: WORKSPACE_ID,
      generation: PENDING_GENERATION,
      documentIds: [pending.id]
    })).toEqual([pending]);
    expect(await store.search(
      { workspaceId: WORKSPACE_ID, generation: PARENT_GENERATION, text: "pendinguniquex" },
      { topK: 10 }
    )).toEqual([]);
    expect((await store.search(
      { workspaceId: WORKSPACE_ID, generation: PENDING_GENERATION, text: "pendinguniquex" },
      { topK: 10 }
    )).map((hit) => hit.documentId)).toEqual([pending.id]);
    expect((await store.pendingHealth({
      workspaceId: WORKSPACE_ID,
      generation: PENDING_GENERATION
    })).metrics.documentCount).toBe(1);
    expect((await store.health({
      workspaceId: WORKSPACE_ID,
      generation: PARENT_GENERATION
    })).metrics.documentCount).toBe(1);
    expect(await db.query<{ count: number | bigint }>(
      "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.documentId = $documentId RETURN count(*) AS count;",
      { workspaceId: WORKSPACE_ID, documentId: parent.id }
    )).toEqual([{ count: 2 }]);
  });

  it("deletes a failed pending generation without changing the parent", async () => {
    await store.deleteGeneration({ workspaceId: WORKSPACE_ID, generation: PENDING_GENERATION });

    expect(await store.loadDocuments({
      workspaceId: WORKSPACE_ID,
      generation: PENDING_GENERATION,
      documentIds: ["lexical:contract-spec:user"]
    })).toEqual([]);
    expect((await store.pendingHealth({
      workspaceId: WORKSPACE_ID,
      generation: PENDING_GENERATION
    })).metrics.documentCount).toBe(0);
    expect((await store.search(
      { workspaceId: WORKSPACE_ID, generation: PARENT_GENERATION, text: "parentuniquex" },
      { topK: 10 }
    )).map((hit) => hit.documentId)).toEqual(["lexical:contract-spec:user"]);
    expect((await store.health({
      workspaceId: WORKSPACE_ID,
      generation: PARENT_GENERATION
    })).metrics.documentCount).toBe(1);
  });

  it("matches a clean full lexical view when a cross-file root disappears but its declaration remains", async () => {
    const workspaceId = "workspace:cross-file-root-gc";
    const parentGeneration = "generation:cross-file-parent";
    const pendingRevision = "revision:cross-file-root-removed";
    const cleanGeneration = "generation:cross-file-clean";
    const generations = new SchemaGenerationStore(db, workspaceId);
    const rootDocument = {
      ...document("crossfilerootuniquex", "batch:cross-file-parent"),
      workspaceId,
      renderRef: createRenderRef({
        workspaceId,
        repoId: "repo:one",
        kind: "contractSpec",
        canonicalId: "contract-spec:user",
        fileId: "file:declaration",
        path: "src/models.ts"
      })
    };

    await generations.beginFull({
      generation: parentGeneration,
      createdAt: "2026-08-02T00:00:00.000Z",
      expectedActiveGeneration: null,
      expectedActiveRevision: null
    });
    await store.initializeGeneration({ workspaceId, generation: parentGeneration });
    await store.upsertDocuments({ workspaceId, generation: parentGeneration, documents: [rootDocument] });
    await generations.replaceSourceFacts({
      generation: parentGeneration,
      kind: "declarations",
      repoId: "repo:one",
      fileId: "file:declaration",
      facts: [{ id: "declaration:user", repoId: "repo:one", sourceFileId: "file:declaration" }]
    });
    await generations.replaceContributions({
      generation: parentGeneration,
      rootReferenceId: "root:file:publisher",
      contributions: [{
        entityKind: "lexical-document",
        entityId: rootDocument.id,
        payload: rootDocument
      }]
    });
    await generations.validateFull(parentGeneration);
    await db.initializePublicGraphStats(
      { workspaceId, generation: parentGeneration },
      parentGeneration,
      await db.computePublicGraphStats({ workspaceId, generation: parentGeneration })
    );
    await generations.commitFull(parentGeneration);
    await store.initializeGeneration({ workspaceId, generation: cleanGeneration });

    await generations.reserveIncremental({
      revision: pendingRevision,
      expectedActiveGeneration: parentGeneration,
      expectedActiveRevision: parentGeneration
    });
    const visibility = await generations.contributionVisibilityForReplacements({
      generation: parentGeneration,
      replacements: [{
        rootReferenceId: "root:file:publisher",
        contributions: []
      }]
    });
    expect(visibility).toEqual([expect.objectContaining({
      entityKind: "lexical-document",
      entityId: rootDocument.id,
      previousCount: 1,
      nextCount: 0
    })]);

    await db.applyIncrementalIndexMutation({
      workspaceId,
      expectedActiveGeneration: parentGeneration,
      expectedActiveRevision: parentGeneration,
      nextRevision: pendingRevision,
      schemaIndexVersion: SCHEMA_INDEX_VERSION,
      lexicalProjectionVersion: LEXICAL_PROJECTION_SCHEMA_VERSION
    }, async () => {
      await generations.replaceActiveContributions({
        generation: parentGeneration,
        rootReferenceId: "root:file:publisher",
        contributions: []
      });
      await store.applyIncrementalMutation({
        workspaceId,
        generation: parentGeneration,
        expectedRevision: parentGeneration,
        nextRevision: pendingRevision,
        upsertDocuments: [],
        deleteDocumentIds: [rootDocument.id]
      });
      await db.applyPublicGraphStatsDelta({ workspaceId, generation: parentGeneration }, {
        expectedRevision: parentGeneration,
        nextRevision: pendingRevision,
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
    });

    expect(await generations.activeGeneration()).toBe(parentGeneration);
    expect(await generations.activeRevision()).toBe(pendingRevision);
    expect(await db.query<{ count: number | bigint }>(
      "MATCH (n:TypeDeclarationFact) WHERE n.generation = $generation RETURN count(*) AS count;",
      { generation: parentGeneration }
    )).toEqual([{ count: 1 }]);

    expect(await store.loadDocuments({
      workspaceId,
      generation: parentGeneration,
      documentIds: [rootDocument.id]
    })).toEqual(await store.loadDocuments({
      workspaceId,
      generation: cleanGeneration,
      documentIds: [rootDocument.id]
    }));
    await expect(store.deleteGeneration({ workspaceId, generation: parentGeneration }))
      .rejects.toMatchObject({ code: "cleanup_failed" });
  });
});
