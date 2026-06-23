import fs from "node:fs/promises";
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

export async function discoverGitRepos(directory: string): Promise<RepoDiscoveryResult> {
  const absoluteRoot = path.resolve(directory);
  const entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  const repos: DiscoveredRepo[] = [];
  const skipped = { nonDirectories: 0, withoutGit: 0 };

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      skipped.nonDirectories += 1;
      continue;
    }

    const absolutePath = path.join(absoluteRoot, entry.name);
    if (!(await hasGitMarker(absolutePath))) {
      skipped.withoutGit += 1;
      continue;
    }

    repos.push({ name: entry.name, absolutePath });
  }

  repos.sort((left, right) => left.name.localeCompare(right.name));
  return { repos, skipped };
}
