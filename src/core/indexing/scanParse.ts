import fs from "node:fs/promises";
import type { GraphDB } from "../graph-model/db.js";
import { parseSourceFile } from "../parsing/parserRegistry.js";
import type { ParsedGraphFile, RepoNode } from "../parsing/types.js";
import { scanRepoFiles, type ScannedFile } from "../workspace/fileScanner.js";
import { hashText } from "../../shared/hash.js";
import { fileId } from "../../shared/path.js";
import type { AppConfig } from "../../config/schema.js";
import { runIndexPhase } from "./phases.js";
import type { PublicGraphGenerationScope } from "../graph-model/publicGraphGeneration.js";

type ParseProgress = {
  tick(label?: string): void;
  complete(label?: string): void;
};

export type ScanParseRepoResult = {
  repo: RepoNode;
  scannedFiles: ScannedFile[];
  parsedFiles: ParsedGraphFile[];
  // All currently present source file ids, including unchanged files skipped
  // by changed-only mode. Stale marking depends on this complete active set.
  activeFileIds: string[];
  // Stable logical IDs that existed in the pinned active revision but no
  // longer exist in the scanned source tree. An empty set is still meaningful
  // for no-op detection and avoids querying internal facts during staging.
  removedFileIds: string[];
  filesScanned: number;
  filesChanged: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function knownFileHashes(db: GraphDB, repoId: string, scope: PublicGraphGenerationScope): Promise<Map<string, string>> {
  return db.knownFileHashes(repoId, scope);
}

export async function scanAndParseRepo(input: {
  db?: GraphDB;
  repo: RepoNode;
  config: AppConfig;
  changedOnly?: boolean;
  trackRemovedFiles?: boolean;
  maxFiles?: number;
  additionalIndexFiles?: readonly string[];
  activePluginSourceGlobs?: readonly string[];
  publicGraphScope?: PublicGraphGenerationScope;
  createProgressBar: (label: string, total: number) => ParseProgress;
}): Promise<ScanParseRepoResult> {
  const { db, repo, config, changedOnly, createProgressBar } = input;
  const maxFiles = input.maxFiles ?? config.indexing.maxFilesPerRun;
  const scannedFiles = (await runIndexPhase({ phase: "scan", repoName: repo.name, repoId: repo.id }, async () => {
    return (await scanRepoFiles(repo.path, config, {
      additionalPaths: input.additionalIndexFiles,
      activePluginSourceGlobs: input.activePluginSourceGlobs,
      repoId: repo.id
    })).slice(0, maxFiles);
  })).result;

  const parseProgress = createProgressBar(`Files ${repo.name}`, scannedFiles.length);
  // Known hashes are only needed for changed-only runs. Full imports parse
  // every scanned file and leave stale handling to later phases.
  const needsKnownFiles = Boolean(changedOnly || input.trackRemovedFiles);
  if (needsKnownFiles && db && !input.publicGraphScope) {
    throw new Error("Changed-only indexing requires an active public graph generation.");
  }
  const known = needsKnownFiles && db && input.publicGraphScope
    ? await knownFileHashes(db, repo.id, input.publicGraphScope)
    : new Map<string, string>();
  const parsedFiles: ParsedGraphFile[] = [];
  const activeFileIds: string[] = [];

  for (const file of scannedFiles) {
    const currentFileId = fileId(repo.id, file.relativePath);
    activeFileIds.push(currentFileId);

    if (changedOnly) {
      // Hash comparison happens before parsing so unchanged files do not enter
      // parse, graph write, or semantic write phases.
      const source = await fs.readFile(file.absolutePath, "utf8");
      const currentHash = hashText(source);
      if (known.get(currentFileId) === currentHash) {
        parseProgress.tick(`skip ${file.relativePath}`);
        continue;
      }
    }

    const parsedFile = (await runIndexPhase({
      phase: "parse",
      repoName: repo.name,
      repoId: repo.id,
      filePath: file.relativePath
    }, async () => {
      try {
        return await parseSourceFile({
          repoId: repo.id,
          absolutePath: file.absolutePath,
          relativePath: file.relativePath,
          language: file.language
        });
      } catch (error) {
        throw new Error(`Failed to parse ${repo.name}/${file.relativePath}: ${errorMessage(error)}`);
      }
    })).result;

    parsedFiles.push(parsedFile);
    parseProgress.tick(file.relativePath);
  }

  parseProgress.complete();
  const activeFileIdSet = new Set(activeFileIds);
  const removedFileIds = [...known.keys()]
    .filter((knownFileId) => !activeFileIdSet.has(knownFileId))
    .sort((left, right) => left.localeCompare(right));
  return {
    repo,
    scannedFiles,
    parsedFiles,
    activeFileIds,
    removedFileIds,
    filesScanned: scannedFiles.length,
    filesChanged: parsedFiles.length
  };
}
