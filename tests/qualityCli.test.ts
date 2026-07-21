import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createGraphDB: vi.fn(),
  auditRelationQuality: vi.fn(),
}));

vi.mock("../src/config/loadConfig.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../src/core/graph-model/factory.js", () => ({ createGraphDB: mocks.createGraphDB }));
vi.mock("../src/features/quality/quality.js", () => ({
  auditRelationQuality: mocks.auditRelationQuality,
  rejectEvidence: vi.fn(),
  upsertAliasOverride: vi.fn(),
}));
vi.mock("../src/features/quality/qualityRules.js", () => ({ auditContractQuality: vi.fn() }));

import { qualityCommand } from "../src/interfaces/cli/quality.js";

describe("quality command graph profile", () => {
  const db = {
    initSchema: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createGraphDB.mockResolvedValue(db);
    mocks.auditRelationQuality.mockResolvedValue({ lowConfidence: [], conflicts: [] });
  });

  it("forwards the complete Neo4j graph configuration including database", async () => {
    const cwd = path.resolve("quality-command-workspace");
    mocks.loadConfig.mockResolvedValue({
      systemName: "quality-system",
      graph: {
        provider: "neo4j",
        path: ".logiclens/graph",
        url: "neo4j+s://example.invalid",
        username: "test-user",
        password: "test-password",
        database: "logiclens-test",
      },
    });

    await qualityCommand(undefined, undefined, cwd);

    expect(mocks.createGraphDB).toHaveBeenCalledWith("neo4j", {
      path: path.resolve(cwd, ".logiclens/graph"),
      url: "neo4j+s://example.invalid",
      username: "test-user",
      password: "test-password",
      database: "logiclens-test",
    });
    expect(db.initSchema).toHaveBeenCalledWith("quality-system");
    expect(db.close).toHaveBeenCalledOnce();
  });
});
