import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterState = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../src/adapters/graph-db/neo4j/Neo4jGraphDB.js", () => ({
  Neo4jGraphDB: { open: adapterState.open }
}));

describe("Neo4j graph provider registration", () => {
  beforeEach(() => {
    vi.resetModules();
    adapterState.open.mockReset().mockResolvedValue({ close: vi.fn() });
  });

  it("registers a graph-only factory and forwards database credentials", async () => {
    const { getGraphProviderRegistration } = await import("../src/core/graph-model/factory.js");
    const registration = await getGraphProviderRegistration("neo4j");

    expect(Object.keys(registration)).toEqual(["factory"]);
    await registration.factory.open({
      url: "bolt://graph.example:7687",
      username: "neo4j",
      password: "secret",
      database: "repohelix"
    });
    expect(adapterState.open).toHaveBeenCalledWith("bolt://graph.example:7687", {
      username: "neo4j",
      password: "secret",
      database: "repohelix"
    });
  });
});
