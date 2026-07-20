import { describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import {
  registerGraphProvider,
  type GraphProviderRegistration
} from "../src/core/graph-model/factory.js";
import {
  LexicalProviderNotReadyError,
  WorkspaceLexicalStoreError,
  assertLexicalProviderReady,
  resolveLexicalProvider,
  summarizeLexicalProviderGate,
  type WorkspaceLexicalStore
} from "../src/core/retrieval/provider.js";
import type { LexicalIndexHealth } from "../src/core/retrieval/types.js";

const capability = {
  scope: "workspace" as const,
  updateConsistency: "synchronous" as const,
  supportsFieldBoost: false,
  supportsPrefix: false
};

function health(overrides: Partial<LexicalIndexHealth> = {}): LexicalIndexHealth {
  return {
    providerVersion: "1.2.3",
    projectionSchemaVersion: "1",
    tokenizerVersion: "1",
    status: "healthy",
    reasons: [],
    metrics: { documentCount: 2, indexSizeBytes: 20 },
    ...overrides
  };
}

function store(result: LexicalIndexHealth | Error = health()): WorkspaceLexicalStore {
  return {
    ensureSchema: vi.fn(), commitVersions: vi.fn(), upsertDocuments: vi.fn(),
    reconcileRepoDocuments: vi.fn(), reconcileRepoFileDocuments: vi.fn(), cleanupBatch: vi.fn(),
    search: vi.fn(), loadDocuments: vi.fn(),
    health: vi.fn(async () => { if (result instanceof Error) throw result; return result; })
  } as unknown as WorkspaceLexicalStore;
}

function registration(
  lexicalStore: WorkspaceLexicalStore,
  overrides: Partial<GraphProviderRegistration> = {}
): GraphProviderRegistration {
  return {
    factory: { open: vi.fn() },
    capabilities: { nativeFullText: capability },
    bindLexical: vi.fn(() => lexicalStore),
    ...overrides
  };
}

function input(provider: string, overrides: Partial<Parameters<typeof resolveLexicalProvider>[0]> = {}) {
  return {
    db: {} as GraphDB,
    graphProvider: provider,
    lexicalProvider: "auto" as const,
    scope: "workspace",
    workspaceId: "workspace:test",
    ...overrides
  };
}

describe("lexical provider release gate", () => {
  it("selects only the current graph provider in auto mode", async () => {
    const selectedStore = store();
    const selected = registration(selectedStore);
    const unrelated = registration(store());
    registerGraphProvider("gate-auto-selected", selected);
    registerGraphProvider("gate-auto-unrelated", unrelated);

    const result = await resolveLexicalProvider(input("gate-auto-selected"));

    expect(result.status).toBe("ready");
    expect(result.effectiveProvider).toBe("gate-auto-selected");
    expect(selected.bindLexical).toHaveBeenCalledOnce();
    expect(unrelated.bindLexical).not.toHaveBeenCalled();
  });

  it("binds an explicit companion provider to the current graph DB", async () => {
    const db = {} as GraphDB;
    const companion = registration(store());
    registerGraphProvider("gate-companion", companion);
    const result = await resolveLexicalProvider(input("unused-graph", {
      db, lexicalProvider: "gate-companion"
    }));
    expect(result.status).toBe("ready");
    expect(companion.bindLexical).toHaveBeenCalledWith(db);
  });

  it("returns stable capability and configuration rejection codes", async () => {
    const unsupported = { factory: { open: vi.fn() }, capabilities: {} };
    registerGraphProvider("gate-no-capability", unsupported);
    expect(await resolveLexicalProvider(input("missing-provider"))).toMatchObject({
      status: "unavailable", reason: "provider_not_registered", reasonCodes: ["provider_not_registered"]
    });
    expect(await resolveLexicalProvider(input("gate-no-capability"))).toMatchObject({
      status: "unavailable", reason: "native_full_text_unsupported"
    });

    const missingBinder = registration(store());
    registerGraphProvider("gate-missing-binder", missingBinder);
    missingBinder.bindLexical = undefined;
    expect(await resolveLexicalProvider(input("gate-missing-binder"))).toMatchObject({
      status: "unavailable", reason: "lexical_binder_missing"
    });

    const wrongCapability = registration(store());
    registerGraphProvider("gate-wrong-capability-scope", wrongCapability);
    wrongCapability.capabilities.nativeFullText = { ...capability, scope: "repository" } as never;
    expect(await resolveLexicalProvider(input("gate-wrong-capability-scope"))).toMatchObject({
      status: "unavailable", reason: "capability_scope_mismatch"
    });
    expect(await resolveLexicalProvider(input("gate-wrong-capability-scope", { scope: "repository" }))).toMatchObject({
      status: "unavailable", reason: "configuration_scope_mismatch"
    });
  });

  it.each([
    [health({ providerVersion: "unknown", status: "unhealthy", reasons: ["provider_version_unknown"] }), "provider_version_unknown"],
    [health({ status: "unhealthy", reasons: ["provider_version_incompatible"] }), "provider_version_incompatible"],
    [health({ status: "unavailable" }), "index_unavailable"],
    [health({ projectionSchemaVersion: "old", status: "unhealthy" }), "projection_schema_version_mismatch"],
    [health({ tokenizerVersion: "old", status: "unhealthy" }), "tokenizer_version_mismatch"],
    [health({ status: "unhealthy", reasons: ["fts_index_failed"] }), "index_unhealthy"]
  ] as const)("classifies provider-neutral health as %s", async (providerHealth, reason) => {
    const provider = `gate-health-${reason}`;
    registerGraphProvider(provider, registration(store(providerHealth)));
    expect(await resolveLexicalProvider(input(provider))).toMatchObject({
      status: "unavailable", reason, health: providerHealth
    });
  });

  it("safely classifies operational health failures and rethrows programming errors", async () => {
    const cause = new Error("password=hunter2 url=bolt://secret internal metadata");
    const operational = "gate-health-operational";
    registerGraphProvider(operational, registration(store(new WorkspaceLexicalStoreError(
      "health_check_failed", { operation: "health", workspaceId: "workspace:test" }, { cause }
    ))));
    const result = await resolveLexicalProvider(input(operational));
    expect(result).toMatchObject({ status: "unavailable", reason: "health_check_failed" });
    expect(JSON.stringify(summarizeLexicalProviderGate(result))).not.toMatch(/hunter2|bolt|metadata/);

    const programming = new Error("health invariant failed");
    registerGraphProvider("gate-health-programming", registration(store(programming)));
    await expect(resolveLexicalProvider(input("gate-health-programming"))).rejects.toBe(programming);
  });

  it("uses deterministic reason priority and asserts readiness", async () => {
    const providerHealth = health({
      providerVersion: "unknown", projectionSchemaVersion: "old", tokenizerVersion: "old",
      status: "unhealthy", reasons: ["tokenizer_version_mismatch", "provider_version_unknown"]
    });
    registerGraphProvider("gate-priority", registration(store(providerHealth)));
    const rejected = await resolveLexicalProvider(input("gate-priority"));
    expect(rejected).toMatchObject({ reason: "provider_version_unknown", reasonCodes: ["provider_version_unknown"] });
    expect(() => assertLexicalProviderReady(rejected)).toThrow(LexicalProviderNotReadyError);

    registerGraphProvider("gate-ready", registration(store()));
    const ready = await resolveLexicalProvider(input("gate-ready"));
    assertLexicalProviderReady(ready);
    expect(ready).toMatchObject({ status: "ready", reasonCodes: [], effectiveProvider: "gate-ready" });
  });
});
