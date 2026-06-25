import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, writeConfig } from "../src/config/loadConfig.js";
import { pluginAddCommand, pluginRemoveCommand, parseNpmSpec, type PluginAddDeps } from "../src/commands/plugin.js";
import { detectPackageManager, isSafePackageSpec, type PackageManager } from "../src/plugins/packageManager.js";
import { importPluginModule } from "../src/plugins/loader.js";

const FIXTURE_PLUGIN = path.resolve("tests/fixtures/plugins/grpc-plugin.mjs");
const NOT_A_PLUGIN = path.resolve("tests/fixtures/plugins/not-a-plugin.mjs");
const BAD_API_PLUGIN = path.resolve("tests/fixtures/plugins/bad-api-version.mjs");

/** Records install calls without spawning a package manager. */
function recordingInstaller(): { calls: Array<{ cwd: string; spec: string; pm: PackageManager }>; deps: PluginAddDeps } {
  const calls: Array<{ cwd: string; spec: string; pm: PackageManager }> = [];
  return {
    calls,
    deps: { installPackage: async (cwd, spec, pm) => { calls.push({ cwd, spec, pm }); } }
  };
}

async function makeWorkspace(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-plugin-add-"));
  await writeConfig({ ...defaultConfig() }, cwd);
  return cwd;
}

describe("parseNpmSpec", () => {
  it("splits unscoped specs into name and version", () => {
    expect(parseNpmSpec("pkg")).toEqual({ spec: "pkg", packageName: "pkg" });
    expect(parseNpmSpec("pkg@1.2.3")).toEqual({ spec: "pkg@1.2.3", packageName: "pkg" });
  });

  it("keeps the scope when splitting scoped specs", () => {
    expect(parseNpmSpec("@scope/pkg")).toEqual({ spec: "@scope/pkg", packageName: "@scope/pkg" });
    expect(parseNpmSpec("@scope/pkg@^1.0.0")).toEqual({ spec: "@scope/pkg@^1.0.0", packageName: "@scope/pkg" });
  });
});

describe("isSafePackageSpec", () => {
  it("accepts well-formed npm specs", () => {
    expect(isSafePackageSpec("pkg")).toBe(true);
    expect(isSafePackageSpec("pkg@1.2.3")).toBe(true);
    expect(isSafePackageSpec("@scope/pkg@^1.0.0")).toBe(true);
  });

  it("rejects specs with shell metacharacters", () => {
    expect(isSafePackageSpec("pkg; rm -rf /")).toBe(false);
    expect(isSafePackageSpec("pkg && echo hi")).toBe(false);
    expect(isSafePackageSpec("$(whoami)")).toBe(false);
  });
});

describe("detectPackageManager", () => {
  it("detects pnpm, yarn, and defaults to npm", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-pm-"));
    expect(await detectPackageManager(cwd)).toBe("npm");
    await fs.writeFile(path.join(cwd, "yarn.lock"), "", "utf8");
    expect(await detectPackageManager(cwd)).toBe("yarn");
    await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), "", "utf8");
    expect(await detectPackageManager(cwd)).toBe("pnpm");
  });
});

describe("plugin add/remove command", () => {
  it("adds a local plugin to config after verifying it", async () => {
    const cwd = await makeWorkspace();
    await pluginAddCommand(FIXTURE_PLUGIN, {}, cwd);
    const config = await loadConfig(cwd);
    expect(config.plugins).toEqual([{ name: FIXTURE_PLUGIN }]);
  });

  it("stores parsed --options with the plugin entry", async () => {
    const cwd = await makeWorkspace();
    await pluginAddCommand(FIXTURE_PLUGIN, { options: '{"team":"platform"}' }, cwd);
    const config = await loadConfig(cwd);
    expect(config.plugins).toEqual([{ name: FIXTURE_PLUGIN, options: { team: "platform" } }]);
  });

  it("replaces an existing entry instead of duplicating on re-add", async () => {
    const cwd = await makeWorkspace();
    await pluginAddCommand(FIXTURE_PLUGIN, { options: '{"team":"a"}' }, cwd);
    await pluginAddCommand(FIXTURE_PLUGIN, { options: '{"team":"b"}' }, cwd);
    const config = await loadConfig(cwd);
    expect(config.plugins).toEqual([{ name: FIXTURE_PLUGIN, options: { team: "b" } }]);
  });

  it("writes an npm plugin entry without installing when --no-install --skip-verify", async () => {
    const cwd = await makeWorkspace();
    await pluginAddCommand("@scope/some-plugin@1.2.3", { install: false, skipVerify: true }, cwd);
    const config = await loadConfig(cwd);
    expect(config.plugins).toEqual([{ name: "@scope/some-plugin" }]);
  });

  it("rejects invalid --options JSON before touching config", async () => {
    const cwd = await makeWorkspace();
    await expect(pluginAddCommand(FIXTURE_PLUGIN, { options: "{not json" }, cwd)).rejects.toThrow(/Invalid --options JSON/);
    const config = await loadConfig(cwd);
    expect(config.plugins).toEqual([]);
  });

  it("removes a plugin entry from config", async () => {
    const cwd = await makeWorkspace();
    await pluginAddCommand(FIXTURE_PLUGIN, {}, cwd);
    await pluginRemoveCommand(FIXTURE_PLUGIN, cwd);
    const config = await loadConfig(cwd);
    expect(config.plugins).toEqual([]);
  });

  it("aborts without writing config when verification fails", async () => {
    const cwd = await makeWorkspace();
    await expect(pluginAddCommand(NOT_A_PLUGIN, {}, cwd)).rejects.toThrow(/failed verification/);
    expect((await loadConfig(cwd)).plugins).toEqual([]);
  });

  it("writes config for an invalid plugin when --skip-verify is set", async () => {
    const cwd = await makeWorkspace();
    await pluginAddCommand(NOT_A_PLUGIN, { skipVerify: true }, cwd);
    expect((await loadConfig(cwd)).plugins).toEqual([{ name: NOT_A_PLUGIN }]);
  });

  it("does not rewrite config when removing a plugin that is absent", async () => {
    const cwd = await makeWorkspace();
    const before = await fs.readFile(path.join(cwd, ".logiclens", "config.yaml"), "utf8");
    await pluginRemoveCommand("not-installed", cwd);
    const after = await fs.readFile(path.join(cwd, ".logiclens", "config.yaml"), "utf8");
    expect(after).toBe(before);
    expect((await loadConfig(cwd)).plugins).toEqual([]);
  });
});

describe("plugin add install orchestration", () => {
  it("installs npm packages with the detected package manager, then writes config", async () => {
    const cwd = await makeWorkspace();
    await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), "", "utf8");
    const { calls, deps } = recordingInstaller();

    await pluginAddCommand("@scope/some-plugin@1.2.3", { skipVerify: true }, cwd, deps);

    expect(calls).toEqual([{ cwd, spec: "@scope/some-plugin@1.2.3", pm: "pnpm" }]);
    expect((await loadConfig(cwd)).plugins).toEqual([{ name: "@scope/some-plugin" }]);
  });

  it("skips install for local-path plugins", async () => {
    const cwd = await makeWorkspace();
    const { calls, deps } = recordingInstaller();

    await pluginAddCommand(FIXTURE_PLUGIN, {}, cwd, deps);

    expect(calls).toEqual([]);
    expect((await loadConfig(cwd)).plugins).toEqual([{ name: FIXTURE_PLUGIN }]);
  });

  it("skips install when --no-install is set", async () => {
    const cwd = await makeWorkspace();
    const { calls, deps } = recordingInstaller();

    await pluginAddCommand("@scope/some-plugin@1.2.3", { install: false, skipVerify: true }, cwd, deps);

    expect(calls).toEqual([]);
    expect((await loadConfig(cwd)).plugins).toEqual([{ name: "@scope/some-plugin" }]);
  });
});

describe("importPluginModule", () => {
  it("loads and validates a well-formed local plugin", async () => {
    const { plugin } = await importPluginModule(FIXTURE_PLUGIN, process.cwd());
    expect(plugin).toMatchObject({ name: "grpc-fixture-plugin", version: "1.0.0" });
  });

  it("rejects a module that is not a LogicLensPlugin", async () => {
    await expect(importPluginModule(NOT_A_PLUGIN, process.cwd())).rejects.toThrow(/does not export a LogicLensPlugin/);
  });

  it("rejects a plugin declaring an unsupported pluginApiVersion", async () => {
    await expect(importPluginModule(BAD_API_PLUGIN, process.cwd())).rejects.toThrow(/unsupported pluginApiVersion/);
  });
});
