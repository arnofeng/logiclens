import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, writeConfig, loadConfig } from "../src/config/loadConfig.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { appVersion } from "../src/shared/version.js";

describe("production hardening", () => {
  it("uses a package-backed LogicLens version", () => {
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("does not expose an MCP escape hatch for raw graph queries", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-config-hardening-"));
    await writeConfig(defaultConfig(), cwd);
    const config = await loadConfig(cwd);
    const legacyRawQueryFlag = ["allowUnsafe", "Cypher"].join("");
    expect((config.mcp as Record<string, unknown>)[legacyRawQueryFlag]).toBeUndefined();
  });

  it("preserves systemName in config even if it has the default value", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-config-hardening-"));
    const config = defaultConfig();
    expect(config.systemName).toBe("default-system");
    await writeConfig(config, cwd);
    
    const rawYaml = await fs.readFile(path.join(cwd, ".logiclens", "config.yaml"), "utf8");
    expect(rawYaml).toContain("systemName: default-system");
    
    const loaded = await loadConfig(cwd);
    expect(loaded.systemName).toBe("default-system");
  });

  it("marks graph connections closed and rejects later queries", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-db-close-"));
    const db = await KuzuGraphDB.open(path.join(cwd, "graph"));
    await db.initSchema("close-test");
    await db.close();
    await expect(db.stats()).rejects.toThrow(/closed/);
    await expect(db.close()).resolves.toBeUndefined();
  });
});
