import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import type { LexicalDocument } from "../src/core/retrieval/types.js";

const adapterState = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../src/adapters/graph-db/kuzu/KuzuGraphDB.js", () => {
  class KuzuGraphDB {
    static open = adapterState.open;
  }
  return { KuzuGraphDB };
});

async function resolveRegistration() {
  const { getGraphProviderRegistration } = await import("../src/core/graph-model/factory.js");
  return getGraphProviderRegistration("kuzu");
}

function document(): LexicalDocument {
  return {
    id: "document:1",
    canonicalId: "code:1",
    workspaceId: "workspace:1",
    repoId: "repo:1",
    kind: "code",
    title: "OrderService",
    searchableText: "OrderService creates an order",
    tokens: ["OrderService", "order"],
    active: true,
    sourceHash: "hash:1",
    batchId: "batch:1",
    renderRef: "src/OrderService.ts:1"
  };
}

describe("Kuzu lexical provider registration", () => {
  beforeEach(() => {
    vi.resetModules();
    adapterState.open.mockReset();
  });

  it("lazily exposes the conservative workspace full-text capability and binder", async () => {
    const registration = await resolveRegistration();

    expect(registration.capabilities.nativeFullText).toEqual({
      scope: "workspace",
      updateConsistency: "synchronous",
      supportsFieldBoost: false,
      supportsPrefix: false
    });
    expect(registration.bindLexical).toBeTypeOf("function");
  });

  it("binds the current Kuzu DB without opening a second database", async () => {
    const registration = await resolveRegistration();
    const { KuzuGraphDB } = await import("../src/adapters/graph-db/kuzu/KuzuGraphDB.js");
    const { KuzuWorkspaceLexicalStore } = await import(
      "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js"
    );
    const db = Object.create(KuzuGraphDB.prototype) as GraphDB;

    const store = registration.bindLexical!(db);

    expect(store).toBeInstanceOf(KuzuWorkspaceLexicalStore);
    expect((store as unknown as { db: unknown }).db).toBe(db);
    expect(adapterState.open).not.toHaveBeenCalled();
  });

  it("rejects an incompatible graph DB deterministically", async () => {
    const registration = await resolveRegistration();
    const incompatible = { close: vi.fn() } as unknown as GraphDB;

    expect(() => registration.bindLexical!(incompatible)).toThrow(
      "Kuzu lexical binder requires the current KuzuGraphDB instance"
    );
  });

  it("fails every unimplemented lifecycle operation explicitly", async () => {
    const registration = await resolveRegistration();
    const { KuzuGraphDB } = await import("../src/adapters/graph-db/kuzu/KuzuGraphDB.js");
    const { WorkspaceLexicalStoreError } = await import("../src/core/retrieval/provider.js");
    const store = registration.bindLexical!(Object.create(KuzuGraphDB.prototype) as GraphDB);
    const doc = document();
    const calls = [
      ["schema_failed", "ensureSchema", store.ensureSchema()],
      ["write_failed", "upsertDocuments", store.upsertDocuments([doc])],
      ["reconcile_failed", "reconcileRepoDocuments", store.reconcileRepoDocuments({
        workspaceId: doc.workspaceId,
        repoId: doc.repoId,
        batchId: doc.batchId,
        activeDocumentIds: [doc.id]
      })],
      ["cleanup_failed", "cleanupBatch", store.cleanupBatch({
        workspaceId: doc.workspaceId,
        batchId: doc.batchId
      })],
      ["search_failed", "search", store.search({ workspaceId: doc.workspaceId, text: "order" }, { topK: 5 })],
      ["load_failed", "loadDocuments", store.loadDocuments({ workspaceId: doc.workspaceId, documentIds: [doc.id] })],
      ["health_check_failed", "health", store.health(doc.workspaceId)]
    ] as const;

    for (const [code, operation, call] of calls) {
      await expect(call).rejects.toMatchObject({
        name: "WorkspaceLexicalStoreError",
        code,
        context: expect.objectContaining({ operation })
      });
      await expect(call).rejects.toBeInstanceOf(WorkspaceLexicalStoreError);
    }
  });
});
