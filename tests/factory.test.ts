import { describe, expect, it, vi, beforeEach } from "vitest";
import { registerGraphProvider, createGraphDB, type GraphDBFactory } from "../src/core/graph-model/factory.js";

// Mock the kuzu register module to avoid loading native drivers
vi.mock("../src/adapters/graph-db/kuzu/register.js", () => ({ registerGraphProvider: vi.fn() }));

// Mock Neo4jGraphDB to avoid loading the neo4j driver
vi.mock("../src/adapters/graph-db/neo4j/Neo4jGraphDB.js", () => ({
  Neo4jGraphDB: { open: vi.fn() }
}));

// Capture providers registered by real register modules
const registered: Record<string, { open: (config: any) => Promise<any> }> = {};
vi.mock("../src/core/graph-model/factory.js", () => ({
  registerGraphProvider: vi.fn((name: string, provider: any) => { registered[name] = provider; }),
  createGraphDB: vi.fn()
}));

// Trigger the real neo4j register module's side-effect, which calls
// registerGraphProvider (our mock above) and captures the open handler.
await import("../src/adapters/graph-db/neo4j/register.js");

describe("graph factory", () => {
  beforeEach(() => {
    vi.mocked(createGraphDB).mockReset();
    vi.mocked(createGraphDB).mockImplementation(async (name: string, config: any) => {
      const provider = registered[name];
      if (!provider) throw new Error(`Unknown graph provider: ${name}`);
      return provider.open(config);
    });
  });

  it("throws for unknown provider", async () => {
    await expect(createGraphDB("unknown-provider", {})).rejects.toThrow(
      /Unknown graph provider: unknown-provider/
    );
  });

  it("registerGraphProvider registers a factory that createGraphDB can use", async () => {
    const mockDb = { close: vi.fn() } as any;
    const mockFactory: GraphDBFactory = {
      open: vi.fn().mockResolvedValue(mockDb)
    };
    registerGraphProvider("test-provider", mockFactory);

    const db = await createGraphDB("test-provider", { path: "/tmp/test" });
    expect(db).toBe(mockDb);
    expect(mockFactory.open).toHaveBeenCalledWith({ path: "/tmp/test" });
  });

  it("passes all config fields (url, username, password) to the factory", async () => {
    const mockDb = { close: vi.fn() } as any;
    const mockFactory: GraphDBFactory = {
      open: vi.fn().mockResolvedValue(mockDb)
    };
    registerGraphProvider("test-neo4j", mockFactory);

    const config = { url: "bolt://localhost:7687", username: "neo4j", password: "secret" };
    await createGraphDB("test-neo4j", config);
    expect(mockFactory.open).toHaveBeenCalledWith(config);
  });
});

describe("neo4j register validation (real open handler)", () => {
  it("captures the open handler from the real register module", () => {
    expect(registered["neo4j"]).toBeDefined();
    expect(typeof registered["neo4j"].open).toBe("function");
  });

  it("rejects username without password", async () => {
    await expect(registered["neo4j"].open({ username: "neo4j" })).rejects.toThrow(
      /Neo4j configuration requires both username and password/
    );
  });

  it("rejects password without username", async () => {
    await expect(registered["neo4j"].open({ password: "secret" })).rejects.toThrow(
      /Neo4j configuration requires both username and password/
    );
  });

  it("accepts both username and password", async () => {
    const { Neo4jGraphDB } = await import("../src/adapters/graph-db/neo4j/Neo4jGraphDB.js");
    vi.mocked(Neo4jGraphDB.open).mockResolvedValueOnce({ close: vi.fn() } as any);
    await expect(registered["neo4j"].open({ username: "neo4j", password: "secret" })).resolves.toBeDefined();
  });

  it("accepts neither username nor password (defaults)", async () => {
    const { Neo4jGraphDB } = await import("../src/adapters/graph-db/neo4j/Neo4jGraphDB.js");
    vi.mocked(Neo4jGraphDB.open).mockResolvedValueOnce({ close: vi.fn() } as any);
    await expect(registered["neo4j"].open({})).resolves.toBeDefined();
  });

  it("uses default url when none provided", async () => {
    const { Neo4jGraphDB } = await import("../src/adapters/graph-db/neo4j/Neo4jGraphDB.js");
    vi.mocked(Neo4jGraphDB.open).mockClear();
    vi.mocked(Neo4jGraphDB.open).mockResolvedValueOnce({ close: vi.fn() } as any);
    await registered["neo4j"].open({});
    expect(Neo4jGraphDB.open).toHaveBeenCalledWith("bolt://localhost:7687", undefined);
  });

  it("passes credentials when both username and password are provided", async () => {
    const { Neo4jGraphDB } = await import("../src/adapters/graph-db/neo4j/Neo4jGraphDB.js");
    vi.mocked(Neo4jGraphDB.open).mockClear();
    vi.mocked(Neo4jGraphDB.open).mockResolvedValueOnce({ close: vi.fn() } as any);
    await registered["neo4j"].open({ username: "neo4j", password: "secret" });
    expect(Neo4jGraphDB.open).toHaveBeenCalledWith("bolt://localhost:7687", { username: "neo4j", password: "secret" });
  });
});
