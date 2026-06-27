import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";
import type { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { scanAndParseRepo } from "../src/core/indexing/scanParse.js";
import type { RepoNode } from "../src/core/parsing/types.js";
import { parserRegistry } from "../src/core/plugins/registry.js";
import { hashText } from "../src/shared/hash.js";
import { fileId, repoId } from "../src/shared/path.js";

function createProgressBar() {
  return {
    tick() {},
    complete() {}
  };
}

function repoFor(name: string, repoPath: string): RepoNode {
  return {
    id: repoId(name),
    name,
    path: repoPath,
    remoteUrl: "",
    branch: "",
    commitSha: "",
    language: "typescript",
    indexedAt: new Date().toISOString()
  };
}

describe("scan/parse phase", () => {
  it("returns a shared scan/parse result structure for full indexing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-scan-parse-"));
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "index.ts"), "export function hello() { return 'hi'; }\n", "utf8");

    const repo = repoFor("scan-parse", cwd);
    const result = await scanAndParseRepo({
      repo,
      config: configSchema.parse({}),
      createProgressBar
    });

    expect(result.filesScanned).toBe(1);
    expect(result.filesChanged).toBe(1);
    expect(result.activeFileIds).toEqual([fileId(repo.id, "src/index.ts")]);
    expect(result.parsedFiles.map((file) => file.path)).toEqual(["src/index.ts"]);
  });

  it("skips unchanged files before parse when changedOnly is enabled", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-scan-parse-skip-"));
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    const source = "export const answer = 42;\n";
    await fs.writeFile(path.join(cwd, "src", "index.ts"), source, "utf8");

    const repo = repoFor("scan-parse-skip", cwd);
    const unchangedFileId = fileId(repo.id, "src/index.ts");
    const db = {
      query: async () => [{ id: unchangedFileId, hash: hashText(source) }],
      knownFileHashes: async () => new Map([[unchangedFileId, hashText(source)]])
    } as unknown as KuzuGraphDB;

    const result = await scanAndParseRepo({
      db,
      repo,
      config: configSchema.parse({}),
      changedOnly: true,
      createProgressBar
    });

    expect(result.filesScanned).toBe(1);
    expect(result.filesChanged).toBe(0);
    expect(result.activeFileIds).toEqual([unchangedFileId]);
    expect(result.parsedFiles).toEqual([]);
  });

  it("wraps parse failures with phase, repo, and file context", async () => {
    parserRegistry.register({
      name: "test:failing-parser",
      language: "failing-test",
      extensions: [".boom"],
      parse() {
        throw new Error("parser exploded");
      }
    });

    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-scan-parse-fail-"));
    await fs.writeFile(path.join(cwd, "bad.boom"), "boom\n", "utf8");
    const repo = repoFor("scan-parse-fail", cwd);

    await expect(scanAndParseRepo({
      repo,
      config: configSchema.parse({ include: ["**/*.boom"] }),
      createProgressBar
    })).rejects.toThrow(/phase=parse/);
    await expect(scanAndParseRepo({
      repo,
      config: configSchema.parse({ include: ["**/*.boom"] }),
      createProgressBar
    })).rejects.toThrow(/repo=scan-parse-fail/);
    await expect(scanAndParseRepo({
      repo,
      config: configSchema.parse({ include: ["**/*.boom"] }),
      createProgressBar
    })).rejects.toThrow(/file=bad\.boom/);
  });
});
