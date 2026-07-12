import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLogicLensPlugin, loadDiscoveredLogicLensPlugins } from "@logiclens/plugin-runtime";
import { autoDetectAndRegisterPlugins, clearRegisteredPluginCapabilities } from "../src/core/plugins/register.js";
import { defaultConfig } from "../src/config/loadConfig.js";
import { scanAndParseRepo } from "../src/core/indexing/scanParse.js";
import { repoId } from "../src/shared/path.js";
import { contractExtractorRegistry, frameworkDetectorRegistry, parserRegistry } from "../src/core/registries/registry.js";

const pluginRoot = path.resolve("packages/plugin-csharp");

async function installLayout(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, "plugin.json"), "utf8"));
  manifest.entry = path.join(pluginRoot, "dist", "index.js");
  await fs.writeFile(path.join(directory, "plugin.json"), JSON.stringify(manifest), "utf8");
}

afterEach(() => clearRegisteredPluginCapabilities());

describe("C# plugin release acceptance", () => {
  it("discovers and loads workspace and user-level directory layouts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-csharp-install-"));
    const workspace = path.join(root, "workspace", ".logiclens", "plugins", "csharp");
    const user = path.join(root, "home", ".logiclens", "plugins", "csharp");
    await installLayout(workspace);
    await installLayout(user);
    for (const directory of [workspace, user]) {
      const discovered = await discoverLogicLensPlugin(directory);
      await expect(loadDiscoveredLogicLensPlugins([discovered], { failFast: true })).resolves.toHaveLength(1);
    }
  });

  it("indexes controller, minimal API, DTO and record source without a root include override", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-csharp-e2e-"));
    const repoPath = path.join(root, "web-api");
    await fs.cp(path.resolve("tests/fixtures/plugin-csharp/e2e/web-api"), repoPath, { recursive: true });
    await installLayout(path.join(root, ".logiclens", "plugins", "csharp"));
    const config = { ...defaultConfig(), repos: [{ name: "web-api", path: repoPath }] };
    expect(config.include).not.toContain("**/*.cs");
    const bootstrap = await autoDetectAndRegisterPlugins({ config, cwd: root, repoConfigs: config.repos });
    expect(bootstrap.activePluginSourceGlobsByRepo.get(repoPath)).toEqual(["**/*.cs"]);
    const result = await scanAndParseRepo({ repo: { id: repoId("web-api"), name: "web-api", path: repoPath, remoteUrl: "", branch: "", commitSha: "", language: "csharp", indexedAt: new Date().toISOString() },
      config, activePluginSourceGlobs: bootstrap.activePluginSourceGlobsByRepo.get(repoPath), createProgressBar: () => ({ tick() {}, complete() {} }) });
    expect(result.parsedFiles.map((file) => file.path)).toEqual(["Api.cs"]);
    const parsed = result.parsedFiles[0];
    expect(parsed && "symbols" in parsed ? parsed.symbols.map((symbol) => symbol.name) : []).toEqual(expect.arrayContaining(["CreateOrderRequest", "OrderResponse", "OrdersController", "Create"]));
  });

  it("activates marker-only repositories without parsing markers and does not load for non-C# repositories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-csharp-negative-"));
    const marker = path.join(root, "marker");
    const negative = path.join(root, "negative");
    await fs.cp(path.resolve("tests/fixtures/plugin-csharp/e2e/marker-only"), marker, { recursive: true });
    await fs.cp(path.resolve("tests/fixtures/plugin-csharp/e2e/non-csharp"), negative, { recursive: true });
    await installLayout(path.join(root, ".logiclens", "plugins", "csharp"));
    const config = { ...defaultConfig(), repos: [{ name: "marker", path: marker }, { name: "negative", path: negative }] };
    const first = await autoDetectAndRegisterPlugins({ config, cwd: root, repoConfigs: config.repos });
    expect(first.activePluginSourceGlobsByRepo.get(marker)).toEqual(["**/*.cs"]);
    expect(first.activePluginSourceGlobsByRepo.get(negative)).toBeUndefined();
    const second = await autoDetectAndRegisterPlugins({ config, cwd: root, repoConfigs: config.repos });
    expect(second.activePluginSourceGlobsByRepo).toEqual(first.activePluginSourceGlobsByRepo);
    expect(parserRegistry.parsers().filter((parser) => parser.language === "csharp")).toHaveLength(1);
    expect(contractExtractorRegistry.names().filter((name) => name.includes("csharp"))).toHaveLength(5);
    expect(frameworkDetectorRegistry.names().filter((name) => name.includes("csharp"))).toHaveLength(1);
    clearRegisteredPluginCapabilities();
    clearRegisteredPluginCapabilities();
    expect(parserRegistry.parsers().some((parser) => parser.language === "csharp")).toBe(false);
    expect(contractExtractorRegistry.names().some((name) => name.includes("csharp"))).toBe(false);
    expect(frameworkDetectorRegistry.names().some((name) => name.includes("csharp"))).toBe(false);
  });
});
