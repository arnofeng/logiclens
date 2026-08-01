import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDB } from "../src/core/graph-model/db.js";
import type {
  GraphDBFactory,
  GraphProviderRegistration
} from "../src/core/graph-model/factory.js";

const adapterState = vi.hoisted(() => ({
  kuzuLoads: 0,
  neo4jLoads: 0,
  kuzuOpen: vi.fn(),
  neo4jOpen: vi.fn()
}));

vi.mock("../src/adapters/graph-db/kuzu/KuzuGraphDB.js", () => {
  adapterState.kuzuLoads += 1;
  return { KuzuGraphDB: { open: adapterState.kuzuOpen } };
});

vi.mock("../src/adapters/graph-db/neo4j/Neo4jGraphDB.js", () => {
  adapterState.neo4jLoads += 1;
  return { Neo4jGraphDB: { open: adapterState.neo4jOpen } };
});

const fakeDb = { close: vi.fn() } as unknown as GraphDB;

function registration(factory?: GraphDBFactory): GraphProviderRegistration {
  return {
    factory: factory ?? { open: vi.fn().mockResolvedValue(fakeDb) },
    capabilities: {}
  };
}

async function loadFactory() {
  return import("../src/core/graph-model/factory.js");
}

describe("graph provider registry", () => {
  beforeEach(() => {
    vi.resetModules();
    adapterState.kuzuOpen.mockReset();
    adapterState.neo4jOpen.mockReset();
  });

  it("registers and creates an arbitrary non-empty custom provider", async () => {
    const { createGraphDB, registerGraphProvider } = await loadFactory();
    const open = vi.fn().mockResolvedValue(fakeDb);
    registerGraphProvider("custom/provider:v1", registration({ open }));

    await expect(createGraphDB("custom/provider:v1", { path: "/tmp/test" })).resolves.toBe(fakeDb);
    expect(open).toHaveBeenCalledWith({ path: "/tmp/test" });
  });

  it.each(["", " ", "\t\r\n"])("rejects an empty or whitespace provider ID", async (provider) => {
    const { registerGraphProvider } = await loadFactory();
    expect(() => registerGraphProvider(provider, registration())).toThrow(
      "Graph provider ID must contain at least one non-whitespace character"
    );
  });

  it("rejects duplicate registrations deterministically", async () => {
    const { registerGraphProvider } = await loadFactory();
    registerGraphProvider("duplicate", registration());
    expect(() => registerGraphProvider("duplicate", registration())).toThrow(
      "Graph provider already registered: duplicate"
    );
  });

  it("rejects capability and binder mismatches", async () => {
    const { registerGraphProvider } = await loadFactory();
    const nativeFullText = {
      scope: "workspace" as const,
      updateConsistency: "transactional" as const,
      supportsFieldBoost: false,
      supportsPrefix: false
    };

    expect(() => registerGraphProvider("capability-only", {
      ...registration(),
      capabilities: { nativeFullText }
    })).toThrow(/nativeFullText capability and bindLexical must be provided together/);

    expect(() => registerGraphProvider("binder-only", {
      ...registration(),
      bindLexical: vi.fn()
    })).toThrow(/nativeFullText capability and bindLexical must be provided together/);
  });

  it("returns registrations through the asynchronous resolver", async () => {
    const { getGraphProviderRegistration, registerGraphProvider } = await loadFactory();
    const expected = registration();
    registerGraphProvider("resolved", expected);
    await expect(getGraphProviderRegistration("resolved")).resolves.toBe(expected);
  });

  it("reports an unknown provider with a stably sorted registry", async () => {
    const { getGraphProviderRegistration, registerGraphProvider } = await loadFactory();
    registerGraphProvider("z-provider", registration());
    registerGraphProvider("a-provider", registration());

    await expect(getGraphProviderRegistration("missing-provider")).rejects.toThrow(
      "Unknown graph provider: missing-provider. Registered: a-provider, z-provider"
    );
  });

  it("does not load either built-in adapter for a registered custom provider", async () => {
    const loadsBefore = { kuzu: adapterState.kuzuLoads, neo4j: adapterState.neo4jLoads };
    const { createGraphDB, registerGraphProvider } = await loadFactory();
    registerGraphProvider("external", registration());
    await createGraphDB("external", {});

    expect(adapterState.kuzuLoads).toBe(loadsBefore.kuzu);
    expect(adapterState.neo4jLoads).toBe(loadsBefore.neo4j);
  });

  it("does not load built-in adapters for an unknown third-party provider", async () => {
    const loadsBefore = { kuzu: adapterState.kuzuLoads, neo4j: adapterState.neo4jLoads };
    const { getGraphProviderRegistration } = await loadFactory();
    await expect(getGraphProviderRegistration("third-party")).rejects.toThrow(/Unknown graph provider/);
    expect(adapterState.kuzuLoads).toBe(loadsBefore.kuzu);
    expect(adapterState.neo4jLoads).toBe(loadsBefore.neo4j);
  });

  it("loads Kuzu only when Kuzu is requested", async () => {
    const loadsBefore = { kuzu: adapterState.kuzuLoads, neo4j: adapterState.neo4jLoads };
    const { getGraphProviderRegistration } = await loadFactory();
    const resolved = await getGraphProviderRegistration("kuzu");

    expect(resolved.capabilities.nativeFullText).toMatchObject({ scope: "workspace" });
    expect(resolved.bindLexical).toBeTypeOf("function");
    expect(adapterState.kuzuLoads).toBe(loadsBefore.kuzu + 1);
    expect(adapterState.neo4jLoads).toBe(loadsBefore.neo4j);
  });

  it("loads Neo4j only when Neo4j is requested", async () => {
    const loadsBefore = { kuzu: adapterState.kuzuLoads, neo4j: adapterState.neo4jLoads };
    const { getGraphProviderRegistration } = await loadFactory();
    const resolved = await getGraphProviderRegistration("neo4j");

    expect(resolved.capabilities.nativeFullText).toMatchObject({ scope: "workspace" });
    expect(resolved.bindLexical).toBeTypeOf("function");
    expect(adapterState.neo4jLoads).toBe(loadsBefore.neo4j + 1);
    expect(adapterState.kuzuLoads).toBe(loadsBefore.kuzu);
  });

  it("reports a built-in module that completes without registering", async () => {
    vi.doMock("../src/adapters/graph-db/kuzu/register.js", () => ({}));
    try {
      const { getGraphProviderRegistration } = await loadFactory();
      await expect(getGraphProviderRegistration("kuzu")).rejects.toThrow(
        "Built-in graph provider failed to register: kuzu"
      );
    } finally {
      vi.doUnmock("../src/adapters/graph-db/kuzu/register.js");
    }
  });
});

describe("Neo4j registration", () => {
  beforeEach(() => {
    vi.resetModules();
    adapterState.neo4jOpen.mockReset().mockResolvedValue(fakeDb);
  });

  async function neo4jFactory(): Promise<GraphDBFactory> {
    const { getGraphProviderRegistration } = await loadFactory();
    return (await getGraphProviderRegistration("neo4j")).factory;
  }

  it("rejects username without password", async () => {
    await expect((await neo4jFactory()).open({ username: "neo4j" })).rejects.toThrow(
      /Neo4j configuration requires both username and password/
    );
  });

  it("rejects password without username", async () => {
    await expect((await neo4jFactory()).open({ password: "secret" })).rejects.toThrow(
      /Neo4j configuration requires both username and password/
    );
  });

  it("uses the default URL and default credentials", async () => {
    await (await neo4jFactory()).open({});
    expect(adapterState.neo4jOpen).toHaveBeenCalledWith("bolt://localhost:7687", undefined);
  });

  it("passes an explicit URL and paired credentials", async () => {
    await (await neo4jFactory()).open({
      url: "bolt://graph.example:7687",
      username: "neo4j",
      password: "secret",
      database: "repohelix-test"
    });
    expect(adapterState.neo4jOpen).toHaveBeenCalledWith(
      "bolt://graph.example:7687",
      { username: "neo4j", password: "secret", database: "repohelix-test" }
    );
  });
});
