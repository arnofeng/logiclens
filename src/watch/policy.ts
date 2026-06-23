import fs from "node:fs";

export type PolicyResult = {
  allowed: boolean;
  reason?: string;
};

let cachedWsl: boolean | undefined;

export function detectWsl(): boolean {
  if (cachedWsl !== undefined) return cachedWsl;
  if (process.platform !== "linux") {
    cachedWsl = false;
    return cachedWsl;
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    cachedWsl = true;
    return cachedWsl;
  }
  try {
    const version = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    cachedWsl = version.includes("microsoft") || version.includes("wsl");
  } catch {
    cachedWsl = false;
  }
  return cachedWsl;
}

export function __resetWslCacheForTests(): void {
  cachedWsl = undefined;
}

function isWslWindowsDriveMount(repoPath: string): boolean {
  const posixPath = repoPath.replace(/\\/g, "/");
  return /^\/mnt\/[a-z](\/|$)/i.test(posixPath);
}

/**
 * Checks if a specific repository path is allowed to be watched.
 */
export function shouldWatchRepo(repoPath: string): PolicyResult {
  if (process.env.LOGICLENS_NO_WATCH === "1") {
    return { allowed: false, reason: "LOGICLENS_NO_WATCH env var is set" };
  }

  if (process.env.LOGICLENS_FORCE_WATCH === "1") {
    return { allowed: true };
  }

  // Detect WSL Windows-drive mounts only. Normal Linux /mnt/data-style mounts are valid.
  if (process.platform === "linux" && detectWsl()) {
    if (isWslWindowsDriveMount(repoPath)) {
      return {
        allowed: false,
        reason: `WSL Windows-drive path "${repoPath}" detected. Watching is disabled due to high filesystem latency, unless LOGICLENS_FORCE_WATCH=1 is set.`
      };
    }
  }

  return { allowed: true };
}

/**
 * Checks if the file watcher should be enabled overall for a list of repository paths.
 */
export function shouldEnableWatcher(repoPaths: string[]): PolicyResult {
  if (process.env.LOGICLENS_NO_WATCH === "1") {
    return { allowed: false, reason: "LOGICLENS_NO_WATCH env var is set" };
  }

  if (process.env.LOGICLENS_FORCE_WATCH === "1") {
    return { allowed: true };
  }

  if (repoPaths.length === 0) {
    return { allowed: false, reason: "No repositories configured in the workspace" };
  }

  return { allowed: true };
}
