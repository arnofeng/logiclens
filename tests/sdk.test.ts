import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/index.js";
import { defaultConfig, writeConfig } from "../src/config/loadConfig.js";
import { initCommand } from "../src/interfaces/cli/init.js";
import { uninitCommand } from "../src/interfaces/cli/uninit.js";
import { addRepoCommand } from "../src/interfaces/cli/addRepo.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { BRAND, BRAND_PATHS, brandedTempDirPrefix } from "../src/shared/branding.js";
import type { GraphDB } from "../src/core/graph-model/db.js";
import {
  registerGraphProvider,
  type GraphProviderRegistration
} from "../src/core/graph-model/factory.js";
import type { WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";

async function makeTempWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), brandedTempDirPrefix("sdk-test")));
}

const nativeFullText = {
  scope: "workspace" as const,
  updateConsistency: "transactional" as const,
  supportsFieldBoost: false,
  supportsPrefix: false
};

function fakeGraphDb(): GraphDB {
  return {
    initSchema: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined)
  } as unknown as GraphDB;
}

function fakeLexicalStore(): WorkspaceLexicalStore {
  return {
    ensureSchema: vi.fn(),
    commitVersions: vi.fn(),
    upsertDocuments: vi.fn(),
    reconcileRepoDocuments: vi.fn(),
    cleanupBatch: vi.fn(),
    search: vi.fn(),
    loadDocuments: vi.fn(),
    health: vi.fn()
  } as unknown as WorkspaceLexicalStore;
}

function lexicalRegistration(
  db: GraphDB,
  bindLexical = vi.fn(() => fakeLexicalStore())
): GraphProviderRegistration {
  return {
    factory: { open: vi.fn().mockResolvedValue(db) },
    capabilities: { nativeFullText },
    bindLexical
  };
}

function resolveLexicalStore(client: Awaited<ReturnType<typeof createClient>>): Promise<WorkspaceLexicalStore> {
  return (client as unknown as {
    resolveLexicalStore(): Promise<WorkspaceLexicalStore>;
  }).resolveLexicalStore();
}

describe("SDK lexical provider resolution", () => {
  it("uses the graph provider registration in auto mode", async () => {
    const db = fakeGraphDb();
    const store = fakeLexicalStore();
    const bindLexical = vi.fn(() => store);
    registerGraphProvider("sdk-auto-graph", lexicalRegistration(db, bindLexical));
    const client = await createClient({
      config: {
        ...defaultConfig(),
        graph: { ...defaultConfig().graph, provider: "sdk-auto-graph" }
      }
    });

    await expect(resolveLexicalStore(client)).resolves.toBe(store);
    expect(bindLexical).toHaveBeenCalledWith(db);
    await client.close();
  });

  it("does not resolve an unrelated provider in auto mode", async () => {
    const graphDb = fakeGraphDb();
    const unrelatedBinder = vi.fn(() => fakeLexicalStore());
    registerGraphProvider("sdk-auto-selected", lexicalRegistration(graphDb));
    registerGraphProvider("sdk-auto-unrelated", lexicalRegistration(fakeGraphDb(), unrelatedBinder));
    const client = await createClient({
      config: {
        ...defaultConfig(),
        graph: { ...defaultConfig().graph, provider: "sdk-auto-selected" }
      }
    });

    await resolveLexicalStore(client);
    expect(unrelatedBinder).not.toHaveBeenCalled();
    await client.close();
  });

  it("uses an explicit companion provider and binds the current graph DB", async () => {
    const graphDb = fakeGraphDb();
    const companionStore = fakeLexicalStore();
    const companionBinder = vi.fn(() => companionStore);
    registerGraphProvider("sdk-companion-graph", {
      factory: { open: vi.fn().mockResolvedValue(graphDb) },
      capabilities: {}
    });
    registerGraphProvider(
      "sdk-explicit-companion",
      lexicalRegistration(fakeGraphDb(), companionBinder)
    );
    const client = await createClient({
      config: {
        ...defaultConfig(),
        graph: { ...defaultConfig().graph, provider: "sdk-companion-graph" },
        retrieval: {
          lexical: { provider: "sdk-explicit-companion", scope: "workspace" }
        }
      }
    });

    await expect(resolveLexicalStore(client)).resolves.toBe(companionStore);
    expect(companionBinder).toHaveBeenCalledWith(graphDb);
    await client.close();
  });

  it("rejects an unknown explicit provider without opening or falling back to the graph provider", async () => {
    const graphDb = fakeGraphDb();
    const graphRegistration = lexicalRegistration(graphDb);
    registerGraphProvider("sdk-unknown-fallback-graph", graphRegistration);
    const client = await createClient({
      config: {
        ...defaultConfig(),
        graph: { ...defaultConfig().graph, provider: "sdk-unknown-fallback-graph" },
        retrieval: {
          lexical: { provider: "sdk-missing-companion", scope: "workspace" }
        }
      }
    });

    await expect(resolveLexicalStore(client)).rejects.toThrow(
      /Unknown graph provider: sdk-missing-companion/
    );
    expect(graphRegistration.factory.open).not.toHaveBeenCalled();
    expect(graphRegistration.bindLexical).not.toHaveBeenCalled();
    await expect(client.retrieve("orders")).rejects.toThrow(/Unknown graph provider: sdk-missing-companion/);
    expect(graphRegistration.factory.open).toHaveBeenCalledTimes(1);
    expect(graphRegistration.bindLexical).not.toHaveBeenCalled();
    await client.close();
  });

  it("fails clearly when the provider lacks native full-text support", async () => {
    const graphDb = fakeGraphDb();
    registerGraphProvider("sdk-no-native-full-text-graph", {
      factory: { open: vi.fn().mockResolvedValue(graphDb) },
      capabilities: {}
    });
    const client = await createClient({
      config: {
        ...defaultConfig(),
        graph: { ...defaultConfig().graph, provider: "sdk-no-native-full-text-graph" }
      }
    });

    await expect(resolveLexicalStore(client)).rejects.toThrow(
      'Lexical provider "sdk-no-native-full-text-graph" does not declare nativeFullText capability'
    );
    await expect(client.retrieve("orders")).rejects.toThrow("does not declare nativeFullText capability");
    await client.close();
  });

  it("fails clearly when the provider binder is unavailable", async () => {
    const registration = lexicalRegistration(fakeGraphDb());
    registerGraphProvider("sdk-missing-binder", registration);
    registration.bindLexical = undefined;
    const client = await createClient({
      config: {
        ...defaultConfig(),
        graph: { ...defaultConfig().graph, provider: "sdk-missing-binder" }
      }
    });

    await expect(resolveLexicalStore(client)).rejects.toThrow(
      'Lexical provider "sdk-missing-binder" does not provide bindLexical'
    );
    await client.close();
  });

  it("rejects a lexical provider with an incompatible capability scope", async () => {
    const registration = {
      ...lexicalRegistration(fakeGraphDb()),
      capabilities: {
        nativeFullText: { ...nativeFullText, scope: "repository" }
      }
    } as unknown as GraphProviderRegistration;
    registerGraphProvider("sdk-incompatible-scope", registration);
    const client = await createClient({
      config: {
        ...defaultConfig(),
        graph: { ...defaultConfig().graph, provider: "sdk-incompatible-scope" }
      }
    });

    await expect(resolveLexicalStore(client)).rejects.toThrow(
      'Lexical provider "sdk-incompatible-scope" does not support configured scope "workspace" (supports "repository")'
    );
    await client.close();
  });

  it("preserves binder errors without degrading to another provider", async () => {
    const binderError = new Error("companion binder failed");
    const bindLexical = vi.fn(() => {
      throw binderError;
    });
    registerGraphProvider(
      "sdk-binder-error",
      lexicalRegistration(fakeGraphDb(), bindLexical)
    );
    const client = await createClient({
      config: {
        ...defaultConfig(),
        graph: { ...defaultConfig().graph, provider: "sdk-binder-error" }
      }
    });

    await expect(resolveLexicalStore(client)).rejects.toBe(binderError);
    await expect(client.retrieve("orders")).rejects.toBe(binderError);
    expect(bindLexical).toHaveBeenCalledTimes(2);
    await client.close();
  });
});

describe("SDK Client", () => {
  it("scaffolds a workspace via the init command", async () => {
    const cwd = await makeTempWorkspace();
    await initCommand(cwd);

    // Check files created
    const configExists = await fs.stat(path.join(cwd, BRAND.configDirName, BRAND.configFileName)).then(() => true).catch(() => false);
    expect(configExists).toBe(true);
    expect(await fs.readFile(path.join(cwd, BRAND.configDirName, ".gitignore"), "utf8")).toBe(
      "graph/\ntmp/\nplugins/\nlogs/\nsemantic-index.json\nmcp.pid\n"
    );
  });

  it("does not overwrite an existing config when re-running init", async () => {
    const cwd = await makeTempWorkspace();
    await initCommand(cwd);
    const configFile = path.join(cwd, BRAND.configDirName, BRAND.configFileName);
    await fs.writeFile(configFile, "systemName: custom-system\nrepos: []\n", "utf8");

    await initCommand(cwd);

    expect(await fs.readFile(configFile, "utf8")).toContain("custom-system");
  });

  it("does not overwrite an existing workspace gitignore", async () => {
    const cwd = await makeTempWorkspace();
    await initCommand(cwd);
    const gitignoreFile = path.join(cwd, BRAND.configDirName, ".gitignore");
    await fs.writeFile(gitignoreFile, "custom-rule\n", "utf8");

    await initCommand(cwd);

    expect(await fs.readFile(gitignoreFile, "utf8")).toBe("custom-rule\n");
  });

  it("uninitializes a workspace and cleans up files", async () => {
    const cwd = await makeTempWorkspace();
    await initCommand(cwd);

    // Create a mock mcp.pid file
    const mcpPidPath = path.join(cwd, BRAND_PATHS.mcpPid);
    await fs.writeFile(mcpPidPath, JSON.stringify({ pid: 999999, cwd, version: "0.1.0", startedAt: Date.now() }), "utf8");

    // Check they exist
    expect(await fs.stat(path.join(cwd, BRAND.configDirName, BRAND.configFileName)).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(mcpPidPath).then(() => true).catch(() => false)).toBe(true);

    // Call uninit
    await uninitCommand(cwd);

    const workspaceExists = await fs.stat(path.join(cwd, BRAND.configDirName)).then(() => true).catch(() => false);
    expect(workspaceExists).toBe(false);
  });

  it("refuses to uninitialize configured graph paths outside the workspace", async () => {
    const cwd = await makeTempWorkspace();
    await writeConfig({
      ...defaultConfig(),
      graph: { ...defaultConfig().graph, path: path.parse(cwd).root }
    }, cwd);

    await expect(uninitCommand(cwd)).rejects.toThrow(/Refusing to remove filesystem root/);
  });

  it("ignores stale or untrusted MCP pid files", async () => {
    const cwd = await makeTempWorkspace();
    await initCommand(cwd);
    const mcpPidPath = path.join(cwd, BRAND_PATHS.mcpPid);
    await fs.writeFile(mcpPidPath, JSON.stringify({ pid: process.pid, cwd: path.join(cwd, "other"), startedAt: Date.now() }), "utf8");
    const killSpy = vi.spyOn(process, "kill");

    await uninitCommand(cwd);

    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it("adds a repo to in-memory config without writing to disk", async () => {
    const cwd = await makeTempWorkspace();
    const client = await createClient({ cwd });

    const result = await client.addRepo("./my-project", { name: "custom-name" });
    expect(result.name).toBe("custom-name");
    expect(result.storedPath).toBe("my-project");

    // In-memory config reflects the new repo...
    expect(client.getConfig().repos).toContainEqual({ name: "custom-name", path: "my-project" });

    // ...but the SDK must not persist it: config.yaml stays untouched.
    const configExists = await fs.stat(path.join(cwd, BRAND.configDirName, BRAND.configFileName)).then(() => true).catch(() => false);
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

    const client = await createClient({ cwd });
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
    
    // Test trace() — multi-hop semantic trace
    const traceGraph = await client.trace("http GET /api/order/:id");
    expect(traceGraph.targets.length).toBeGreaterThan(0);
    expect(traceGraph.nodes.length).toBeGreaterThan(0);
    
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
