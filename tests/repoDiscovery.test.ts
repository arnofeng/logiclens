import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverGitRepos } from "../src/repos/repoDiscovery.js";

describe("repo discovery", () => {
  it("discovers only first-level Git repositories in stable name order", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-discovery-"));
    await fs.mkdir(path.join(dir, "z-service", ".git"), { recursive: true });
    await fs.mkdir(path.join(dir, "a-service", ".git"), { recursive: true });
    await fs.mkdir(path.join(dir, "plain-dir"), { recursive: true });
    await fs.mkdir(path.join(dir, "plain-dir", "nested-repo", ".git"), { recursive: true });
    await fs.writeFile(path.join(dir, "README.md"), "# fixture", "utf8");

    const result = await discoverGitRepos(dir);

    expect(result.repos.map((repo) => repo.name)).toEqual(["a-service", "z-service"]);
    expect(result.repos.map((repo) => repo.absolutePath)).toEqual([
      path.join(dir, "a-service"),
      path.join(dir, "z-service")
    ]);
    expect(result.skipped).toEqual({ nonDirectories: 1, withoutGit: 1 });
  });
});
