import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLogicLens, definePlugin } from "../src/index.js";
import { defaultConfig, writeConfig } from "../src/config/loadConfig.js";

async function makeTempWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-sdk-test-"));
}

describe("LogicLens SDK Client & Plugins", () => {
  it("initializes a client and initializes a workspace", async () => {
    const cwd = await makeTempWorkspace();
    const client = await createLogicLens({ cwd });
    
    await client.init();
    
    // Check files created
    const configExists = await fs.stat(path.join(cwd, ".logiclens", "config.yaml")).then(() => true).catch(() => false);
    expect(configExists).toBe(true);
    
    await client.close();
  });

  it("uninitializes a workspace and cleans up files", async () => {
    const cwd = await makeTempWorkspace();
    const client = await createLogicLens({ cwd });
    
    await client.init();
    
    // Create a mock mcp.pid file
    const mcpPidPath = path.join(cwd, ".logiclens", "mcp.pid");
    await fs.writeFile(mcpPidPath, JSON.stringify({ pid: 999999, version: "0.1.0", startedAt: Date.now() }), "utf8");
    
    // Check they exist
    expect(await fs.stat(path.join(cwd, ".logiclens", "config.yaml")).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(mcpPidPath).then(() => true).catch(() => false)).toBe(true);
    
    // Call uninit
    await client.uninit();
    
    // Verify .logiclens directory is deleted
    const logiclensExists = await fs.stat(path.join(cwd, ".logiclens")).then(() => true).catch(() => false);
    expect(logiclensExists).toBe(false);
  });

  it("adds a repo and updates config", async () => {
    const cwd = await makeTempWorkspace();
    const client = await createLogicLens({ cwd });
    await client.init();
    
    const result = await client.addRepo("./my-project", { name: "custom-name" });
    expect(result.name).toBe("custom-name");
    expect(result.storedPath).toBe("my-project");
    
    const config = client.getConfig();
    expect(config.repos).toContainEqual({ name: "custom-name", path: "my-project" });
    
    await client.close();
  });

  it("loads inline plugins and runs setup", async () => {
    const cwd = await makeTempWorkspace();
    let setupCalled = false;
    
    const dummyPlugin = definePlugin({
      name: "dummy-plugin",
      version: "1.2.3",
      pluginApiVersion: "1",
      setup(context) {
        setupCalled = true;
      }
    });

    const client = await createLogicLens({
      cwd,
      plugins: [dummyPlugin]
    });
    
    await client.ensurePlugins();
    expect(setupCalled).toBe(true);
    await client.close();
  });

  it("throws error for unsupported pluginApiVersion", async () => {
    const cwd = await makeTempWorkspace();
    const badPlugin = {
      name: "bad-plugin",
      version: "1.0.0",
      pluginApiVersion: "2",
      setup() {}
    } as any;

    const client = await createLogicLens({
      cwd,
      plugins: [badPlugin]
    });

    await expect(client.ensurePlugins()).rejects.toThrow(/declares unsupported pluginApiVersion/);
    await client.close();
  });

  it("respects plugin loading order and deduplicates", async () => {
    const cwd = await makeTempWorkspace();
    const calls: string[] = [];

    // Write a config plugin
    const configPluginPath = path.resolve("tests/fixtures/plugins/grpc-plugin.mjs");
    await writeConfig({
      ...defaultConfig(),
      plugins: [{ name: configPluginPath }]
    }, cwd);

    const inlinePlugin = definePlugin({
      name: "grpc-fixture-plugin", // Same name as config plugin to test deduplication
      version: "1.0.0",
      pluginApiVersion: "1",
      setup() {
        calls.push("inline");
      }
    });

    const client = await createLogicLens({
      cwd,
      plugins: [inlinePlugin],
      loadConfiguredPlugins: true
    });

    await client.ensurePlugins();
    // Config plugin was loaded first (registers grpc-fixture-plugin v1.0.0 with options: undefined).
    // The inline plugin has same name@version and options: undefined, so it should be deduplicated and NOT called!
    expect(calls).toEqual([]);
    await client.close();
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
    await client.ensurePlugins();
    
    // Perform indexing
    const indexResult = await client.index({ changedOnly: false, writeMode: "auto" });
    expect(indexResult.filesScanned).toBeGreaterThan(0);
    
    // Test stats()
    const stats = await client.stats();
    expect(stats.repos).toBe(2);
    expect(stats.files).toBeGreaterThan(0);
    
    // Test query()
    const reposRow = await client.query<{ name: string }>("MATCH (r:Repo) RETURN r.name AS name ORDER BY name;");
    expect(reposRow).toEqual([
      { name: "service-a" },
      { name: "service-b" }
    ]);
    
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
