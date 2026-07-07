import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

export type DiscoveredRepo = {
  name: string;
  absolutePath: string;
};

export type RepoDiscoveryResult = {
  repos: DiscoveredRepo[];
  skipped: {
    nonDirectories: number;
    withoutGit: number;
  };
};

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    await fs.stat(path.join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function discoverGitRepos(
  directory: string,
  maxDepth = 1
): Promise<RepoDiscoveryResult> {
  const absoluteRoot = path.resolve(directory);
  const repos: DiscoveredRepo[] = [];
  const skipped = { nonDirectories: 0, withoutGit: 0 };
  const visitedRealPaths = new Set<string>();

  async function scan(currentDir: string, currentDepth: number) {
    let realPath: string;
    try {
      realPath = await fs.realpath(currentDir);
    } catch {
      return;
    }

    if (visitedRealPaths.has(realPath)) {
      return; // prevent symlink loop
    }
    visitedRealPaths.add(realPath);

    // If it's a git repo itself, we collect it and do NOT recurse further into it.
    if (currentDepth > 1 && await hasGitMarker(currentDir)) {
      const rel = path.relative(absoluteRoot, currentDir).replace(/\\/g, "/") || path.basename(currentDir);
      repos.push({ name: rel, absolutePath: path.resolve(currentDir) });
      return;
    }

    if (currentDepth > maxDepth) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      // Determine if directory. (Need to resolve symlinks if any)
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(entryPath);
          isDir = stat.isDirectory();
        } catch {
          isDir = false;
        }
      }

      if (!isDir) {
        if (currentDepth === 1) {
          skipped.nonDirectories += 1;
        }
        continue;
      }

      // Check if it's a git repo
      const hasGit = await hasGitMarker(entryPath);
      if (hasGit) {
        const rel = path.relative(absoluteRoot, entryPath).replace(/\\/g, "/") || entry.name;
        repos.push({ name: rel, absolutePath: path.resolve(entryPath) });
      } else {
        if (currentDepth === 1) {
          skipped.withoutGit += 1;
        }
        // Recurse into directory
        await scan(entryPath, currentDepth + 1);
      }
    }
  }

  await scan(absoluteRoot, 1);
  repos.sort((left, right) => left.name.localeCompare(right.name));
  return { repos, skipped };
}
