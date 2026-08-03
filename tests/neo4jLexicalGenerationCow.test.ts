import { describe, expect, it, vi } from "vitest";
import type { GraphValue } from "../src/core/graph-model/db.js";
import { Neo4jWorkspaceLexicalStore } from "../src/adapters/graph-db/neo4j/Neo4jWorkspaceLexicalStore.js";
import type { Neo4jGraphDB } from "../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
import type { LexicalDocument } from "../src/core/retrieval/types.js";

type QueryCall = { cypher: string; params?: Record<string, GraphValue>; insideTransaction: boolean };

class RecordingNeo4jDB {
  readonly calls: QueryCall[] = [];
  private transactionDepth = 0;
  activeGeneration?: string;
  pendingGeneration?: string;
  readonly beginTransaction = vi.fn(async () => { this.transactionDepth += 1; });
  readonly commitTransaction = vi.fn(async () => { this.transactionDepth -= 1; });
  readonly rollbackTransaction = vi.fn(async () => { this.transactionDepth -= 1; });

  async query<T>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
    this.calls.push({ cypher, params, insideTransaction: this.transactionDepth > 0 });
    if (cypher.includes("SchemaGenerationState") && (this.activeGeneration || this.pendingGeneration)) {
      return [{
        activeGeneration: this.activeGeneration,
        pendingGeneration: this.pendingGeneration
      }] as T[];
    }
    if (cypher.includes("RETURN n.storageId AS storageId") && cypher.includes("$parentGeneration")) {
      return [{
        storageId: "parent-storage",
        documentId: "lexical:user",
        generation: "generation:parent",
        canonicalId: "schema:user",
        workspaceId: "workspace:one",
        repoId: "repo:one",
        kind: "contractSpec",
        title: "User",
        qualifiedName: "example.User",
        path: "src/models.ts",
        searchableText: "parentuniquex",
        tokens: ["parentuniquex"],
        active: true,
        sourceHash: "hash:parent",
        batchId: "batch:parent",
        renderRef: createRenderRef({
          workspaceId: "workspace:one",
          repoId: "repo:one",
          kind: "contractSpec",
          canonicalId: "schema:user",
          fileId: "file:models",
          path: "src/models.ts"
        }),
        ftsText: "parentuniquex",
        ftsSizeBytes: 13
      }] as T[];
    }
    if (cypher.includes("RETURN count(n) AS written")) {
      return [{ written: (params?.documents as GraphValue[]).length }] as T[];
    }
    return [];
  }
}

function document(): LexicalDocument {
  return {
    id: "lexical:user",
    canonicalId: "schema:user",
    workspaceId: "workspace:one",
    repoId: "repo:one",
    kind: "contractSpec",
    title: "User changed",
    qualifiedName: "example.User",
    path: "src/models.ts",
    searchableText: "pendinguniquex",
    tokens: ["pendinguniquex"],
    active: true,
    sourceHash: "hash:pending",
    batchId: "batch:pending",
    renderRef: createRenderRef({
      workspaceId: "workspace:one",
      repoId: "repo:one",
      kind: "contractSpec",
      canonicalId: "schema:user",
      fileId: "file:models",
      path: "src/models.ts"
    })
  };
}

describe("Neo4j lexical generation isolation", () => {
  it("uses distinct physical keys and generation-pinned reads for one logical document", async () => {
    const db = new RecordingNeo4jDB();
    const store = new Neo4jWorkspaceLexicalStore(db as unknown as Neo4jGraphDB);

    await store.initializeGeneration({
      workspaceId: "workspace:one",
      generation: "generation:pending"
    });
    await store.upsertDocuments({
      workspaceId: "workspace:one",
      generation: "generation:pending",
      documents: [document()]
    });
    await store.loadDocuments({
      workspaceId: "workspace:one",
      generation: "generation:parent",
      documentIds: ["lexical:user"]
    });
    await store.search(
      { workspaceId: "workspace:one", generation: "generation:parent", text: "parentuniquex" },
      { topK: 5 }
    );

    const writtenRows = db.calls
      .filter((call) => call.cypher.includes("RETURN count(n) AS written"))
      .flatMap((call) => call.params?.documents as Array<Record<string, GraphValue>>);
    expect(writtenRows).toHaveLength(1);
    expect(new Set(writtenRows.map((row) => row.storageId)).size).toBe(1);
    expect(writtenRows[0]?.storageId).not.toBe("parent-storage");
    expect(writtenRows[0]).toMatchObject({
      documentId: "lexical:user",
      generation: "generation:pending"
    });
    expect(db.calls.filter((call) => call.cypher.includes("RETURN count(n) AS written"))
      .every((call) => !call.insideTransaction)).toBe(true);
    expect(db.calls.some((call) => call.cypher.includes("$parentGeneration"))).toBe(false);
    expect(db.calls.find((call) => call.cypher.includes("n.documentId IN $documentIds")))
      .toMatchObject({ params: { generation: "generation:parent" } });
    expect(db.calls.find((call) => call.cypher.includes("db.index.fulltext.queryNodes"))?.cypher)
      .toContain("node.generation = $generation");
  });

  it("deletes only the failed physical generation", async () => {
    const db = new RecordingNeo4jDB();
    const store = new Neo4jWorkspaceLexicalStore(db as unknown as Neo4jGraphDB);

    await store.deleteGeneration({ workspaceId: "workspace:one", generation: "generation:pending" });

    const documentDelete = db.calls.find((call) =>
      call.cypher.includes("MATCH (n:LexicalDocument)") && call.cypher.includes("DELETE n")
    );
    expect(documentDelete?.cypher).toContain("n.generation = $generation");
    expect(documentDelete?.params).toEqual({
      workspaceId: "workspace:one",
      generation: "generation:pending"
    });
  });

  it("deduplicates exact pending-document GC and never targets another generation", async () => {
    const db = new RecordingNeo4jDB();
    const store = new Neo4jWorkspaceLexicalStore(db as unknown as Neo4jGraphDB);

    await store.deleteDocuments({
      workspaceId: "workspace:one",
      generation: "generation:pending",
      documentIds: ["lexical:z", "lexical:a", "lexical:z"]
    });
    await store.deleteDocuments({
      workspaceId: "workspace:one",
      generation: "generation:pending",
      documentIds: ["lexical:z", "lexical:a"]
    });

    const deletes = db.calls.filter((call) =>
      call.cypher.includes("n.documentId IN $documentIds DELETE n")
    );
    expect(deletes).toHaveLength(2);
    expect(deletes.every((call) => call.cypher.includes("n.workspaceId = $workspaceId")
      && call.cypher.includes("n.generation = $generation"))).toBe(true);
    expect(deletes[0]?.params).toEqual({
      workspaceId: "workspace:one",
      generation: "generation:pending",
      documentIds: ["lexical:a", "lexical:z"]
    });
  });

  it("refuses to delete the generation named by the active pointer", async () => {
    const db = new RecordingNeo4jDB();
    db.activeGeneration = "generation:active";
    const store = new Neo4jWorkspaceLexicalStore(db as unknown as Neo4jGraphDB);

    await expect(store.deleteGeneration({
      workspaceId: "workspace:one",
      generation: "generation:active"
    })).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(db.calls.some((call) =>
      call.cypher.includes("MATCH (n:LexicalDocument)") && call.cypher.includes("DELETE n")
    )).toBe(false);
  });

  it("refuses to delete the generation held by the pending reservation", async () => {
    const db = new RecordingNeo4jDB();
    db.activeGeneration = "generation:parent";
    db.pendingGeneration = "generation:pending";
    const store = new Neo4jWorkspaceLexicalStore(db as unknown as Neo4jGraphDB);

    await expect(store.deleteGeneration({
      workspaceId: "workspace:one",
      generation: "generation:pending"
    })).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(db.calls.some((call) =>
      call.cypher.includes("MATCH (n:LexicalDocument)") && call.cypher.includes("DELETE n")
    )).toBe(false);
  });
});
