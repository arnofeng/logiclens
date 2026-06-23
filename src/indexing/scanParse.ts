import fs from "node:fs/promises";
import type { KuzuGraphDB } from "../graph/db.js";
import { parseSourceFile } from "../parsers/parserRegistry.js";
import type { ParsedGraphFile, RepoNode } from "../parsers/types.js";
import { scanRepoFiles, type ScannedFile } from "../repos/fileScanner.js";
import { hashText } from "../utils/hash.js";
import { fileId } from "../utils/path.js";
import type { LogicLensConfig } from "../config/schema.js";
import { runIndexPhase } from "./phases.js";

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
  filesScanned: number;
  filesChanged: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function knownFileHashes(db: KuzuGraphDB, repoId: string): Promise<Map<string, string>> {
  const rows = await db.query<{ id: string; hash: string }>(
    "MATCH (f:File) WHERE f.repoId = $repoId RETURN f.id AS id, f.hash AS hash;",
    { repoId }
  );
  return new Map(rows.map((row) => [row.id, row.hash]));
}

export async function scanAndParseRepo(input: {
  db?: KuzuGraphDB;
  repo: RepoNode;
  config: LogicLensConfig;
  changedOnly?: boolean;
  maxFiles?: number;
  createProgressBar: (label: string, total: number) => ParseProgress;
}): Promise<ScanParseRepoResult> {
  const { db, repo, config, changedOnly, createProgressBar } = input;
  const maxFiles = input.maxFiles ?? config.indexing.maxFilesPerRun;
  const scannedFiles = (await runIndexPhase({ phase: "scan", repoName: repo.name, repoId: repo.id }, async () => {
    return (await scanRepoFiles(repo.path, config)).slice(0, maxFiles);
  })).result;

  const parseProgress = createProgressBar(`Files ${repo.name}`, scannedFiles.length);
  // Known hashes are only needed for changed-only runs. Full imports parse
  // every scanned file and leave stale handling to later phases.
  const known = changedOnly && db ? await knownFileHashes(db, repo.id) : new Map<string, string>();
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
  return {
    repo,
    scannedFiles,
    parsedFiles,
    activeFileIds,
    filesScanned: scannedFiles.length,
    filesChanged: parsedFiles.length
  };
}
