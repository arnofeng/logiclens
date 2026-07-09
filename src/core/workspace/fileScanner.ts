import path from "node:path";
import fs from "node:fs/promises";
import fg from "fast-glob";
import ignore from "ignore";
import type { AppConfig } from "../../config/schema.js";
import { parserRegistry } from "../registries/registry.js";
import { toPosixPath } from "../../shared/path.js";
import { isGeneratedFile } from "../../shared/generatedFile.js";

export type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  language: string;
};

function languageForPath(relativePath: string): string | undefined {
  return parserRegistry.resolve({ relativePath })?.language;
}

async function isBinaryFile(absolutePath: string): Promise<boolean> {
  try {
    const handle = await fs.open(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(buffer, 0, 1024, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          return true;
        }
      }
      return false;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function filterAsync<T>(arr: T[], predicate: (item: T) => Promise<boolean>, concurrency = 32): Promise<T[]> {
  const results: boolean[] = new Array(arr.length);
  let index = 0;
  async function worker() {
    while (index < arr.length) {
      const i = index++;
      results[i] = await predicate(arr[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, arr.length) }, worker);
  await Promise.all(workers);
  return arr.filter((_, i) => results[i]);
}

export async function scanRepoFiles(repoPath: string, config: AppConfig): Promise<ScannedFile[]> {
  const ig = ignore();
  ig.add(config.exclude.map((entry) => entry.replace(/^\*\*\//, "")));
  const gitignore = path.join(repoPath, ".gitignore");
  try {
    ig.add(await fs.readFile(gitignore, "utf8"));
  } catch {
    // A repo without .gitignore is fine for MVP indexing.
  }

  const entries = await fg(config.include, {
    cwd: repoPath,
    absolute: false,
    onlyFiles: true,
    dot: true,
    ignore: config.exclude
  });

  const posixEntries = entries
    .map(toPosixPath)
    .sort()
    .filter((relativePath) => !ig.ignores(relativePath))
    // Skip auto-generated files (protobuf stubs, gRPC scaffolding, mocks, minified bundles)
    // so they don't pollute contract evidence with scaffolding noise.
    .filter((relativePath) => !isGeneratedFile(relativePath));

  const candidateEntries: { relativePath: string; language: string }[] = [];
  for (const relativePath of posixEntries) {
    const lang = languageForPath(relativePath);
    if (lang) {
      candidateEntries.push({ relativePath, language: lang });
    }
  }

  // Filter out binary files
  const textEntries = await filterAsync(candidateEntries, async (entry) => {
    const absolutePath = path.join(repoPath, entry.relativePath);
    return !(await isBinaryFile(absolutePath));
  }, 32);

  return textEntries.map(({ relativePath, language }) => ({
    absolutePath: path.join(repoPath, relativePath),
    relativePath,
    language
  }));
}
