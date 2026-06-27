import path from "node:path";
import fs from "node:fs/promises";
import fg from "fast-glob";
import ignore from "ignore";
import type { LogicLensConfig } from "../../config/schema.js";
import { builtinLanguageForPath, registerBuiltinParsers } from "../parsing/parserRegistry.js";
import { parserRegistry } from "../../plugins/registry.js";
import { toPosixPath } from "../../shared/path.js";
import { isGeneratedFile } from "../../shared/generatedFile.js";

export type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  language: string;
};

function languageForPath(relativePath: string): string | undefined {
  // Parsers resolved here after lazy-load registration in scanRepoFiles.
  return parserRegistry.resolve({ relativePath })?.language;
}

export async function scanRepoFiles(repoPath: string, config: LogicLensConfig): Promise<ScannedFile[]> {
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

  // P1-2: Lazy grammar loading — detect which languages appear in this repo
  // before registering grammars, so we only load what is actually needed.
  // File-level-only parsers (yaml/toml/properties) have no grammar overhead
  // and are always included via registerBuiltinParsers.
  const languageSet = new Set<string>();
  for (const relativePath of posixEntries) {
    // Preserve custom parsers with more specific extensions, then fall back to
    // builtin extension inference without loading grammar modules.
    const lang = parserRegistry.resolve({ relativePath })?.language;
    const inferred = lang ?? builtinLanguageForPath(relativePath);
    if (inferred) languageSet.add(inferred);
  }

  // Register only the grammars we actually need (P1-2 lazy loading).
  registerBuiltinParsers(languageSet);

  return posixEntries
    .map((relativePath) => ({ relativePath, language: languageForPath(relativePath) }))
    .filter((entry): entry is { relativePath: string; language: string } => Boolean(entry.language))
    .map(({ relativePath, language }) => ({ absolutePath: path.join(repoPath, relativePath), relativePath, language }));
}
