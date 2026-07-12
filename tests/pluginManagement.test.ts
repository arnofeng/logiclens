import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOGICLENS_PLUGIN_API_VERSION } from "@logiclens/plugin-sdk";
import {
  classifyPluginSource,
  globalPluginScope,
  inspectInstalledPlugins,
  installPlugin,
  projectPluginScopes,
  removePlugin,
  resolveProjectPluginScope,
  safePluginDirectoryName,
  type CommandRunner
} from "../src/core/plugins/management.js";
import { defaultConfig } from "../src/config/loadConfig.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-plugin-management-"));
  roots.push(root);
  return root;
}

async function fixturePlugin(directory: string, name = "@fixture/plugin", version = "1.2.3"): Promise<void> {
  const manifest = {
    name, version, logiclensPluginApiVersion: LOGICLENS_PLUGIN_API_VERSION,
    capabilities: ["language"], entry: "./index.js",
    languages: [{ id: "fixture", extensions: [".fixture"], detect: { extensions: [".fixture"] } }]
  };
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "plugin.json"), JSON.stringify(manifest), "utf8");
  await fs.writeFile(path.join(directory, "index.js"), `export default { manifest: ${JSON.stringify(manifest)}, languages: [{ id: "fixture", extensions: [".fixture"], parse() { return {}; } }] };`, "utf8");
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version, type: "module", main: "./index.js" }), "utf8");
}

describe("plugin management", () => {
  it("classifies sources and creates filesystem-safe names", async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, "local-plugin"));
    expect(classifyPluginSource("@scope/plugin@1.0.0").kind).toBe("npm");
    expect(classifyPluginSource("./plugin").kind).toBe("directory");
    expect(classifyPluginSource("local-plugin", root).kind).toBe("directory");
    expect(classifyPluginSource("./plugin.tgz").kind).toBe("tarball");
    expect(safePluginDirectoryName("@scope/plugin")).toBe("scope+plugin");
    expect(() => safePluginDirectoryName("../")).toThrow(/Invalid plugin name/);
  });

  it("resolves project and global scopes deterministically", async () => {
    const root = await temporaryRoot();
    const config = { ...defaultConfig(), repos: [{ name: "one", path: "repos/one" }, { name: "two", path: "repos/two" }] };
    expect(projectPluginScopes(config, root)).toHaveLength(2);
    expect(resolveProjectPluginScope(config, root, "two")).toMatchObject({ kind: "project", repoName: "two" });
    expect(() => resolveProjectPluginScope(config, root)).toThrow(/Multiple repositories/);
    expect(resolveProjectPluginScope(config, root, undefined, path.join(root, "repos", "two", "src"))).toMatchObject({ repoName: "two" });
    expect(globalPluginScope(root).root).toBe(path.join(root, ".logiclens", "plugins"));
  });

  it("accepts in-root names beginning with two dots and rejects unsafe npm shell input", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    await fixturePlugin(source, "dot-fixture");
    await fs.mkdir(path.join(source, "..config"));
    await fs.rename(path.join(source, "index.js"), path.join(source, "..config", "index.js"));
    const manifest = JSON.parse(await fs.readFile(path.join(source, "plugin.json"), "utf8"));
    manifest.entry = "./..config/index.js";
    await fs.writeFile(path.join(source, "plugin.json"), JSON.stringify(manifest), "utf8");
    const scope = { kind: "global" as const, root: path.join(root, "installed") };
    await expect(installPlugin(source, scope)).resolves.toMatchObject({ name: "dot-fixture" });
    let called = false;
    await expect(installPlugin("plugin&whoami", scope, {}, { run: async () => { called = true; return ""; } })).rejects.toThrow(/Unsupported npm plugin specifier/);
    expect(called).toBe(false);
  });

  it("installs, inspects, rejects duplicates, replaces atomically, and removes a directory plugin", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source");
    await fixturePlugin(source);
    const scope = { kind: "global" as const, root: path.join(root, "installed") };
    const installed = await installPlugin(source, scope, {}, { now: () => new Date("2026-01-02T03:04:05.000Z") });
    expect(installed.path).toBe(path.join(scope.root, "fixture+plugin"));
    expect(JSON.parse(await fs.readFile(path.join(installed.path, ".logiclens-install.json"), "utf8"))).toMatchObject({ source, resolvedVersion: "1.2.3", scope: "global" });
    await expect(installPlugin(source, scope)).rejects.toThrow(/already installed/);
    await installPlugin(source, scope, { force: true });
    expect((await inspectInstalledPlugins([scope]))[0]).toMatchObject({ name: "@fixture/plugin", status: "valid" });
    expect(await removePlugin("@fixture/plugin", scope)).toBe(installed.path);
    expect(await inspectInstalledPlugins([scope])).toEqual([]);
  });

  it("rolls back invalid installs and diagnoses malformed and duplicate plugins", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "bad-source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "plugin.json"), JSON.stringify({ name: "bad", entry: "../escape.js" }), "utf8");
    const scopeA = { kind: "global" as const, root: path.join(root, "a") };
    await expect(installPlugin(source, scopeA)).rejects.toThrow(/inside the plugin directory/);
    expect((await fs.readdir(scopeA.root)).filter((name) => !name.startsWith(".install-"))).toEqual([]);

    const pluginA = path.join(scopeA.root, "same");
    const scopeB = { kind: "project" as const, repoName: "repo", root: path.join(root, "b") };
    const pluginB = path.join(scopeB.root, "same");
    await fixturePlugin(pluginA, "same"); await fixturePlugin(pluginB, "same");
    const records = await inspectInstalledPlugins([scopeA, scopeB]);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.status === "invalid" && record.error?.includes("Duplicate"))).toBe(true);
  });

  it("installs an npm source through an injected npm pack runner", async () => {
    const root = await temporaryRoot();
    const packageDir = path.join(root, "pack-source", "package");
    await fixturePlugin(packageDir, "npm-fixture");
    const run: CommandRunner = async (_command, args) => {
      expect(args).toContain("pack");
      const destination = args[args.indexOf("--pack-destination") + 1]!;
      const filename = "npm-fixture-1.2.3.tgz";
      const tar = await import("tar");
      await tar.c({ file: path.join(destination, filename), cwd: path.dirname(packageDir), gzip: true }, ["package"]);
      return JSON.stringify([{ filename }]);
    };
    const scope = { kind: "global" as const, root: path.join(root, "npm-installed") };
    const result = await installPlugin("npm-fixture@1.2.3", scope, { cwd: root }, { run });
    expect(result).toMatchObject({ name: "npm-fixture", source: "npm-fixture@1.2.3", status: "valid" });
  });

  it("keeps list and remove static while doctor explicitly imports plugin code", async () => {
    const root = await temporaryRoot();
    const scope = { kind: "global" as const, root: path.join(root, "installed") };
    const pluginDir = path.join(scope.root, "side-effect");
    await fixturePlugin(pluginDir, "side-effect");
    await fs.appendFile(path.join(pluginDir, "index.js"), "\nglobalThis.__logiclensPluginInspectionExecuted = true;\n", "utf8");
    delete (globalThis as any).__logiclensPluginInspectionExecuted;
    expect((await inspectInstalledPlugins([scope]))[0]?.status).toBe("valid");
    expect((globalThis as any).__logiclensPluginInspectionExecuted).toBeUndefined();
    expect((await inspectInstalledPlugins([scope], { loadEntry: true }))[0]?.status).toBe("valid");
    expect((globalThis as any).__logiclensPluginInspectionExecuted).toBe(true);

    const brokenDir = path.join(scope.root, "broken");
    await fixturePlugin(brokenDir, "broken");
    await fs.writeFile(path.join(brokenDir, "index.js"), "this is not valid javascript {{{", "utf8");
    expect((await inspectInstalledPlugins([scope])).find((record) => record.name === "broken")?.status).toBe("valid");
    expect((await inspectInstalledPlugins([scope], { loadEntry: true })).find((record) => record.name === "broken")?.status).toBe("invalid");
    await expect(removePlugin("broken", scope)).resolves.toBe(brokenDir);
  });
});
