import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, writeConfig, loadConfig } from "../src/config/loadConfig.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { appVersion } from "../src/shared/version.js";
import { BRAND, configFilePath } from "../src/shared/branding.js";

describe("production hardening", () => {
  it(`uses a package-backed ${BRAND.displayName} version`, () => {
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("does not expose an MCP escape hatch for raw graph queries", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-config-hardening-"));
    await writeConfig(defaultConfig(), cwd);
    const config = await loadConfig(cwd);
    const legacyRawQueryFlag = ["allowUnsafe", "Cypher"].join("");
    expect((config.mcp as Record<string, unknown>)[legacyRawQueryFlag]).toBeUndefined();
  });

  it("preserves systemName in config even if it has the default value", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-config-hardening-"));
    const config = defaultConfig();
    expect(config.systemName).toBe("default-system");
    await writeConfig(config, cwd);
    
    const rawYaml = await fs.readFile(configFilePath(cwd), "utf8");
    expect(rawYaml).toContain("systemName: default-system");
    
    const loaded = await loadConfig(cwd);
    expect(loaded.systemName).toBe("default-system");
  });

  it("preserves environment variable references in API keys when writing config back", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-config-env-"));
    const file = configFilePath(cwd);

    // Create initial yaml with environment variable reference
    const initialYaml = `
llm:
  apiKey: \${TEST_SECRET_KEY}
`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, initialYaml, "utf8");

    // Set env var value
    process.env.TEST_SECRET_KEY = "sk-test-abc-123";

    try {
      // Load config (should resolve env var)
      const config = await loadConfig(cwd);
      expect(config.llm.apiKey).toBe("sk-test-abc-123");

      // Modify a different part of the config (e.g. add a repo) and write it back
      config.repos.push({ name: "test-repo", path: "./test-repo" });
      await writeConfig(config, cwd);

      // Verify raw YAML still has the env var reference instead of plaintext key
      const rawYaml = await fs.readFile(file, "utf8");
      expect(rawYaml).toContain("apiKey: ${TEST_SECRET_KEY}");
      expect(rawYaml).not.toContain("sk-test-abc-123");
    } finally {
      delete process.env.TEST_SECRET_KEY;
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves environment variable references in config even when environment variable is not defined", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-config-missing-env-"));
    const file = configFilePath(cwd);

    // Create initial yaml with environment variable reference that is not set in env
    const initialYaml = `
llm:
  apiKey: \${MISSING_SECRET_FOR_REVIEW}
`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, initialYaml, "utf8");

    // Make sure it is not in process.env
    delete process.env.MISSING_SECRET_FOR_REVIEW;

    try {
      // Load config (should resolve env var to empty string and parse/prune)
      const config = await loadConfig(cwd);
      expect(config.llm.apiKey).toBeUndefined();

      // Modify a different part of the config and write it back
      config.repos.push({ name: "test-repo", path: "./test-repo" });
      await writeConfig(config, cwd);

      // Verify raw YAML still has the env var reference instead of being deleted or plaintext
      const rawYaml = await fs.readFile(file, "utf8");
      expect(rawYaml).toContain("apiKey: ${MISSING_SECRET_FOR_REVIEW}");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("marks graph connections closed and rejects later queries", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "test-db-close-"));
    const db = await KuzuGraphDB.open(path.join(cwd, "graph"));
    await db.initSchema("close-test");
    await db.close();
    await expect(db.stats()).rejects.toThrow(/closed/);
    await expect(db.close()).resolves.toBeUndefined();
  });
});
