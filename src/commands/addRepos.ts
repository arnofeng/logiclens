import path from "node:path";
import { createLogicLens } from "../sdk/client.js";
import { writeConfig } from "../config/loadConfig.js";
import { indexCommand, type IndexOptions } from "./index.js";

export type AddReposOptions = {
  index?: boolean;
  changedOnly?: boolean;
  maxFiles?: number;
  writeMode?: IndexOptions["writeMode"];
  batchSize?: number;
};

export type IndexRunner = (options: IndexOptions, cwd?: string) => Promise<void>;

export async function addReposCommand(
  directory: string,
  options: AddReposOptions,
  cwd = process.cwd(),
  runIndex: IndexRunner = indexCommand
): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    const result = await client.addRepos(directory, { ...options, index: false });
    await writeConfig(client.getConfig(), cwd);
    const storedDir = path.relative(cwd, path.resolve(cwd, directory)).replace(/\\/g, "/") || ".";

    console.log(`Added ${result.discovered.length} repos from ${storedDir}`);
    console.log(`Skipped ${result.skipped.nonDirectories} non-directories; ${result.skipped.withoutGit} directories without .git`);

    if (!options.index) return;

    if (options.batchSize && options.batchSize > 0 && !options.changedOnly) {
      await runIndex({
        repos: result.discovered.map((repo) => repo.name),
        changedOnly: options.changedOnly,
        maxFiles: options.maxFiles,
        writeMode: options.writeMode,
        batchSize: options.batchSize
      }, cwd);
      return;
    }

    for (const repo of result.discovered) {
      await runIndex({
        repo: repo.name,
        changedOnly: options.changedOnly,
        maxFiles: options.maxFiles,
        writeMode: options.writeMode,
        batchSize: options.batchSize
      }, cwd);
    }
  } finally {
    await client.close();
  }
}
