import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addReposCommand } from "../src/commands/addRepos.js";
import { defaultConfig, loadConfig, writeConfig } from "../src/config/loadConfig.js";
import type { IndexOptions } from "../src/commands/index.js";

async function makeWorkspace(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-add-repos-"));
  await writeConfig(defaultConfig(), cwd);
  return cwd;
}

describe("add-repos command", () => {
  it("upserts first-level Git repos while preserving unrelated configured repos", async () => {
    const cwd = await makeWorkspace();
    await writeConfig({
      ...defaultConfig(),
      repos: [
        { name: "existing", path: "../old-existing" },
        { name: "manual", path: "../manual" }
      ]
    }, cwd);
    await fs.mkdir(path.join(cwd, "projects", "existing", ".git"), { recursive: true });
    await fs.mkdir(path.join(cwd, "projects", "new-service", ".git"), { recursive: true });
    await fs.mkdir(path.join(cwd, "projects", "not-a-repo"), { recursive: true });

    await addReposCommand("projects", {}, cwd);

    const config = await loadConfig(cwd);
    expect(config.repos).toEqual([
      { name: "existing", path: "projects/existing" },
      { name: "manual", path: "../manual" },
      { name: "new-service", path: "projects/new-service" }
    ]);
  });

  it("indexes only discovered repos when --index is set and forwards index options", async () => {
    const cwd = await makeWorkspace();
    await writeConfig({
      ...defaultConfig(),
      repos: [{ name: "manual", path: "../manual" }]
    }, cwd);
    await fs.mkdir(path.join(cwd, "projects", "b-service", ".git"), { recursive: true });
    await fs.mkdir(path.join(cwd, "projects", "a-service", ".git"), { recursive: true });
    const runIndex = vi.fn(async (_options: IndexOptions, _cwd?: string) => {});

    await addReposCommand("projects", {
      index: true,
      changedOnly: true,
      maxFiles: 25,
      writeMode: "merge"
    }, cwd, runIndex);

    expect(runIndex).toHaveBeenCalledTimes(2);
    expect(runIndex).toHaveBeenNthCalledWith(1, {
      repo: "a-service",
      changedOnly: true,
      maxFiles: 25,
      writeMode: "merge",
      batchSize: undefined
    }, cwd);
    expect(runIndex).toHaveBeenNthCalledWith(2, {
      repo: "b-service",
      changedOnly: true,
      maxFiles: 25,
      writeMode: "merge",
      batchSize: undefined
    }, cwd);
  });

  it("indexes discovered repos in one batched run when --batch-size is set", async () => {
    const cwd = await makeWorkspace();
    await fs.mkdir(path.join(cwd, "projects", "b-service", ".git"), { recursive: true });
    await fs.mkdir(path.join(cwd, "projects", "a-service", ".git"), { recursive: true });
    const runIndex = vi.fn(async (_options: IndexOptions, _cwd?: string) => {});

    await addReposCommand("projects", {
      index: true,
      maxFiles: 25,
      writeMode: "auto",
      batchSize: 50
    }, cwd, runIndex);

    expect(runIndex).toHaveBeenCalledTimes(1);
    expect(runIndex).toHaveBeenCalledWith({
      repos: ["a-service", "b-service"],
      changedOnly: undefined,
      maxFiles: 25,
      writeMode: "auto",
      batchSize: 50
    }, cwd);
  });
});
