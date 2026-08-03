import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";

const adapterState = vi.hoisted(() => ({ open: vi.fn(), retainNativeHandleOnClose: vi.fn() }));

vi.mock("../src/adapters/graph-db/kuzu/KuzuGraphDB.js", () => {
  class KuzuGraphDB {
    static open = adapterState.open;
    retainNativeHandleOnClose() {
      adapterState.retainNativeHandleOnClose();
    }
  }
  return { KuzuGraphDB };
});

async function resolveRegistration() {
  const { getGraphProviderRegistration } = await import("../src/core/graph-model/factory.js");
  return getGraphProviderRegistration("kuzu");
}

describe("Kuzu lexical provider registration", () => {
  beforeEach(() => {
    vi.resetModules();
    adapterState.open.mockReset();
    adapterState.retainNativeHandleOnClose.mockReset();
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
    expect(adapterState.retainNativeHandleOnClose).toHaveBeenCalledOnce();
    expect(adapterState.open).not.toHaveBeenCalled();
  });

  it("rejects an incompatible graph DB deterministically", async () => {
    const registration = await resolveRegistration();
    const incompatible = { close: vi.fn() } as unknown as GraphDB;

    expect(() => registration.bindLexical!(incompatible)).toThrow(
      "Kuzu lexical binder requires the current KuzuGraphDB instance"
    );
  });

  it("wraps adapter failures with the registered lifecycle error boundary", async () => {
    const registration = await resolveRegistration();
    const { KuzuGraphDB } = await import("../src/adapters/graph-db/kuzu/KuzuGraphDB.js");
    const { WorkspaceLexicalStoreError } = await import("../src/core/retrieval/provider.js");
    const db = Object.assign(Object.create(KuzuGraphDB.prototype), {
      query: vi.fn().mockRejectedValue(new Error("adapter unavailable"))
    }) as GraphDB;
    const store = registration.bindLexical!(db);
    const call = store.ensureSchema();

    await expect(call).rejects.toMatchObject({
      name: "WorkspaceLexicalStoreError",
      code: "schema_failed",
      context: { operation: "ensureSchema" }
    });
    await expect(call).rejects.toBeInstanceOf(WorkspaceLexicalStoreError);
  });
});
