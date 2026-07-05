import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getGitMetadata } from "../src/core/workspace/git.js";
import { brandedTempDirPrefix } from "../src/shared/branding.js";

describe("getGitMetadata", () => {
  it("reads metadata for the current git repository", async () => {
    const metadata = await getGitMetadata(process.cwd());
    expect(metadata.commitSha).toMatch(/^[a-f0-9]{40}$/);
  });

  it("returns empty metadata outside a git repository", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), brandedTempDirPrefix("git-metadata-")));
    try {
      await expect(getGitMetadata(dir)).resolves.toEqual({ remoteUrl: "", branch: "", commitSha: "" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
