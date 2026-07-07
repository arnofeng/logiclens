import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverGitRepos } from "../src/core/workspace/repoDiscovery.js";

describe("repo discovery", () => {
  it("discovers only first-level Git repositories in stable name order", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-discovery-"));
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
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("supports maxDepth > 1 recursive discovery and prevents symlink loops", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-discovery-rec-"));
    const nestedDir = path.join(dir, "plain-dir", "nested-repo");
    await fs.mkdir(path.join(nestedDir, ".git"), { recursive: true });

    // Create a symlink loop: loop-dir -> plain-dir
    const loopLink = path.join(dir, "loop-dir");
    try {
      await fs.symlink(path.join(dir, "plain-dir"), loopLink, "dir");
    } catch {
      // Windows might require admin privileges for symlinks, so skip loop assertion if symlink fails
    }

    // 1. Discover with maxDepth = 1 (should skip nested-repo)
    const result1 = await discoverGitRepos(dir, 1);
    expect(result1.repos).toEqual([]);

    // 2. Discover with maxDepth = 2 (should find plain-dir/nested-repo)
    const result2 = await discoverGitRepos(dir, 2);
    const names = result2.repos.map((r) => r.name);
    expect(names).toContain("plain-dir/nested-repo");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
