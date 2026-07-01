import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogicLens } from "../src/index.js";
import { defaultConfig, writeConfig } from "../src/config/loadConfig.js";
import { initCommand } from "../src/interfaces/cli/init.js";
import { uninitCommand } from "../src/interfaces/cli/uninit.js";
import { addRepoCommand } from "../src/interfaces/cli/addRepo.js";
import { loadConfig } from "../src/config/loadConfig.js";

async function makeTempWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-sdk-test-"));
}

describe("LogicLens SDK Client", () => {
  it("scaffolds a workspace via the init command", async () => {
    const cwd = await makeTempWorkspace();
    await initCommand(cwd);

    // Check files created
    const configExists = await fs.stat(path.join(cwd, ".logiclens", "config.yaml")).then(() => true).catch(() => false);
    expect(configExists).toBe(true);
  });

  it("does not overwrite an existing config when re-running init", async () => {
    const cwd = await makeTempWorkspace();
    await initCommand(cwd);
    const configFile = path.join(cwd, ".logiclens", "config.yaml");
    await fs.writeFile(configFile, "systemName: custom-system\nrepos: []\n", "utf8");

    await initCommand(cwd);

    expect(await fs.readFile(configFile, "utf8")).toContain("custom-system");
  });

  it("uninitializes a workspace and cleans up files", async () => {
    const cwd = await makeTempWorkspace();
    await initCommand(cwd);

    // Create a mock mcp.pid file
    const mcpPidPath = path.join(cwd, ".logiclens", "mcp.pid");
    await fs.writeFile(mcpPidPath, JSON.stringify({ pid: 999999, version: "0.1.0", startedAt: Date.now() }), "utf8");

    // Check they exist
    expect(await fs.stat(path.join(cwd, ".logiclens", "config.yaml")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(mcpPidPath).then(() => true).catch(() => false)).toBe(true);

    // Call uninit
    await uninitCommand(cwd);

    // Verify .logiclens directory is deleted
    const logiclensExists = await fs.stat(path.join(cwd, ".logiclens")).then(() => true).catch(() => false);
    expect(logiclensExists).toBe(false);
  });

  it("adds a repo to in-memory config without writing to disk", async () => {
    const cwd = await makeTempWorkspace();
    const client = await createLogicLens({ cwd });

    const result = await client.addRepo("./my-project", { name: "custom-name" });
    expect(result.name).toBe("custom-name");
    expect(result.storedPath).toBe("my-project");

    // In-memory config reflects the new repo...
    expect(client.getConfig().repos).toContainEqual({ name: "custom-name", path: "my-project" });

    // ...but the SDK must not persist it: config.yaml stays untouched.
    const configExists = await fs.stat(path.join(cwd, ".logiclens", "config.yaml")).then(() => true).catch(() => false);
    expect(configExists).toBe(false);

    await client.close();
  });

  it("persists the repo when added via the CLI command", async () => {
    const cwd = await makeTempWorkspace();
    await initCommand(cwd);
    await addRepoCommand("./my-project", { name: "custom-name" }, cwd);
    const config = await loadConfig(cwd);
    expect(config.repos).toContainEqual({ name: "custom-name", path: "my-project" });
  });

  it("performs stats, query, ask, trace, and impact on indexed graph data", async () => {
    const cwd = await makeTempWorkspace();
    const pathA = path.resolve("tests/fixtures/service-a").replace(/\\/g, "/");
    const pathB = path.resolve("tests/fixtures/service-b").replace(/\\/g, "/");
    
    await writeConfig({
      ...defaultConfig(),
      repos: [
        { name: "service-a", path: pathA },
        { name: "service-b", path: pathB }
      ]
    }, cwd);

    const client = await createLogicLens({ cwd });
    await client.ensureProviders();
    
    // Perform indexing
    const indexResult = await client.index({ changedOnly: false, writeMode: "auto" });
    expect(indexResult.filesScanned).toBeGreaterThan(0);
    
    // Test stats()
    const stats = await client.stats();
    expect(stats.repos).toBe(2);
    expect(stats.files).toBeGreaterThan(0);
    
    // Test dependencies()
    const deps = await client.dependencies();
    expect(deps.length).toBeGreaterThan(0);

    // Test dependencies with filters
    const strongDeps = await client.dependencies({ strength: "strong" });
    const weakDeps = await client.dependencies({ strength: "weak" });
    expect(strongDeps.length + weakDeps.length).toBe(deps.length);

    const apiDeps = await client.dependencies({ type: "api" });
    expect(apiDeps.every(d => d.dependencyType === "api")).toBe(true);
    
    // Test contracts()
    const contracts = await client.contracts();
    expect(contracts.length).toBeGreaterThan(0);
    
    // Test trace()
    const traceResult = await client.trace("api:/api/order/:id");
    expect(traceResult.type).toBe("contract");
    if (traceResult.type === "contract") {
      expect(traceResult.rows.length).toBeGreaterThan(0);
    }
    
    // Test impact()
    const impactResult = await client.impact("OrderCreatedEvent");
    expect(impactResult.seeds.length).toBeGreaterThan(0);
    expect(impactResult.recommendedFiles.length).toBeGreaterThan(0);
    
    // Test ask()
    const answer = await client.ask("OrderCreatedEvent");
    expect(answer).toContain("Matched code:");
    
    await client.close();
  }, 25000);
});
