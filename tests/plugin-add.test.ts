import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, writeConfig } from "../src/config/loadConfig.js";
import { pluginAddCommand, pluginRemoveCommand, parseNpmSpec } from "../src/commands/plugin.js";
import { detectPackageManager, isSafePackageSpec } from "../src/plugins/packageManager.js";

const FIXTURE_PLUGIN = path.resolve("tests/fixtures/plugins/grpc-plugin.mjs");

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
});
