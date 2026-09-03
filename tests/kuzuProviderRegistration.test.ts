import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterState = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../src/adapters/graph-db/kuzu/KuzuGraphDB.js", () => ({
  KuzuGraphDB: { open: adapterState.open }
}));

describe("Kuzu graph provider registration", () => {
  beforeEach(() => {
    vi.resetModules();
    adapterState.open.mockReset().mockResolvedValue({ close: vi.fn() });
  });

  it("registers a graph-only factory and opens the configured database", async () => {
    const { getGraphProviderRegistration } = await import("../src/core/graph-model/factory.js");
    const registration = await getGraphProviderRegistration("kuzu");

    expect(Object.keys(registration)).toEqual(["factory"]);
    await registration.factory.open({ path: "/tmp/repohelix-graph" });
    expect(adapterState.open).toHaveBeenCalledWith("/tmp/repohelix-graph");
  });
});
