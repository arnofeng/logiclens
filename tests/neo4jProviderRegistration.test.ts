import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";

const adapterState = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../src/adapters/graph-db/neo4j/Neo4jGraphDB.js", () => {
  class Neo4jGraphDB {
    static open = adapterState.open;
  }
  return { Neo4jGraphDB };
});

async function resolveRegistration() {
  const { getGraphProviderRegistration } = await import("../src/core/graph-model/factory.js");
  return getGraphProviderRegistration("neo4j");
}

describe("Neo4j lexical provider registration", () => {
  beforeEach(() => {
    vi.resetModules();
    adapterState.open.mockReset();
  });

  it("registers conservative workspace full-text capability together with its binder", async () => {
    const registration = await resolveRegistration();

    expect(registration.capabilities.nativeFullText).toEqual({
      scope: "workspace",
      updateConsistency: "synchronous",
      supportsFieldBoost: false,
      supportsPrefix: false
    });
    expect(registration.bindLexical).toBeTypeOf("function");
  });

  it("binds the current Neo4j DB without opening another driver", async () => {
    const registration = await resolveRegistration();
    const { Neo4jGraphDB } = await import("../src/adapters/graph-db/neo4j/Neo4jGraphDB.js");
    const { Neo4jWorkspaceLexicalStore } = await import(
      "../src/adapters/graph-db/neo4j/Neo4jWorkspaceLexicalStore.js"
    );
    const db = Object.create(Neo4jGraphDB.prototype) as GraphDB;

    const store = registration.bindLexical!(db);

    expect(store).toBeInstanceOf(Neo4jWorkspaceLexicalStore);
    expect((store as unknown as { db: unknown }).db).toBe(db);
    expect(adapterState.open).not.toHaveBeenCalled();
  });

  it("preserves URL defaults and paired credential validation", async () => {
    const { factory } = await resolveRegistration();
    adapterState.open.mockResolvedValue({ close: vi.fn() });

    await factory.open({});
    expect(adapterState.open).toHaveBeenLastCalledWith("bolt://localhost:7687", undefined);

    await factory.open({ url: "bolt://graph.example:7687", username: "logiclens", password: "secret" });
    expect(adapterState.open).toHaveBeenLastCalledWith(
      "bolt://graph.example:7687",
      { username: "logiclens", password: "secret" }
    );

    await expect(factory.open({ username: "logiclens" })).rejects.toThrow(/both username and password/);
    await expect(factory.open({ password: "secret" })).rejects.toThrow(/both username and password/);
  });

  it("keeps stable full-text compatibility requirements inside the adapter", async () => {
    const {
      NEO4J_WORKSPACE_LEXICAL_REQUIREMENTS,
      supportsNeo4jWorkspaceLexical
    } = await import("../src/adapters/graph-db/neo4j/Neo4jWorkspaceLexicalStore.js");

    expect(NEO4J_WORKSPACE_LEXICAL_REQUIREMENTS).toEqual({
      versionPolicy: "runtime-capability-check",
      requiredIndexType: "FULLTEXT",
      requiredQueryProcedure: "db.index.fulltext.queryNodes"
    });
    expect(supportsNeo4jWorkspaceLexical({
      indexTypes: ["FULLTEXT"],
      procedures: ["db.index.fulltext.queryNodes"]
    })).toBe(true);
    expect(supportsNeo4jWorkspaceLexical({ indexTypes: [], procedures: [] })).toBe(false);
  });

  it("rejects incompatible DBs and never reports lifecycle success", async () => {
    const registration = await resolveRegistration();
    const incompatible = { close: vi.fn() } as unknown as GraphDB;
    expect(() => registration.bindLexical!(incompatible)).toThrow(
      "Neo4j lexical binder requires the current Neo4jGraphDB instance"
    );

    const { Neo4jGraphDB } = await import("../src/adapters/graph-db/neo4j/Neo4jGraphDB.js");
    const { WorkspaceLexicalStoreError } = await import("../src/core/retrieval/provider.js");
    const store = registration.bindLexical!(Object.create(Neo4jGraphDB.prototype) as GraphDB);
    const calls = [
      ["schema_failed", "ensureSchema", store.ensureSchema()],
      ["write_failed", "upsertDocuments", store.upsertDocuments([])],
      ["reconcile_failed", "reconcileRepoDocuments", store.reconcileRepoDocuments({
        workspaceId: "workspace:1", repoId: "repo:1", batchId: "batch:1", activeDocumentIds: []
      })],
      ["cleanup_failed", "cleanupBatch", store.cleanupBatch({ workspaceId: "workspace:1", batchId: "batch:1" })],
      ["search_failed", "search", store.search({ workspaceId: "workspace:1", text: "order" }, { topK: 5 })],
      ["load_failed", "loadDocuments", store.loadDocuments({ workspaceId: "workspace:1", documentIds: [] })],
      ["health_check_failed", "health", store.health("workspace:1")]
    ] as const;

    for (const [code, operation, call] of calls) {
      await expect(call).rejects.toBeInstanceOf(WorkspaceLexicalStoreError);
      await expect(call).rejects.toMatchObject({ code, context: expect.objectContaining({ operation }) });
    }
  });
});
