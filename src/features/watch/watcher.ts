import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import fg from "fast-glob";
import { GraphClient } from "../../interfaces/sdk/client.js";
import { shouldWatchRepo } from "./policy.js";
import { isGeneratedFile } from "../../shared/generatedFile.js";
import { brandedWorkspaceDirNames } from "../../shared/branding.js";
import { builtinLanguageForPath } from "../../core/parsing/parserRegistry.js";
import { parserRegistry } from "../../core/registries/registry.js";
import { toRepoNode } from "../../core/workspace/repoRegistry.js";
import type { IndexQueueStatusSnapshot } from "../../core/indexing/scheduler.js";

export type PendingFile = {
  repoName: string;
  path: string;
  firstSeenMs: number;
  lastSeenMs: number;
  indexing: boolean;
};

export type WatchMode = "auto" | "repo-roots" | "common-root" | "off";
export type WatchCatchUpMode = "blocking" | "background" | "off";

export type WatchOptions = {
  debounceMs?: number;
  repo?: string;
  mode?: WatchMode;
  maxRoots?: number;
  maxLinuxDirs?: number;
  syncConcurrency?: number;
  catchUp?: WatchCatchUpMode;
};

export type WatchStatus = {
  active: boolean;
  degraded: boolean;
  degradedReason: string | null;
  partial: boolean;
  partialReasons: string[];
  mode: WatchMode;
  installedWatchers: number;
  coveredRepos: string[];
  uncoveredRepos: string[];
  uncoveredPaths: string[];
  pendingFiles: PendingFile[];
  pausedRepos: string[];
  indexQueue: IndexQueueStatusSnapshot;
  catchUp: {
    mode: WatchCatchUpMode;
    running: boolean;
    completed: boolean;
    failed: boolean;
    error?: string;
    pendingRepos: string[];
    completedRepos: string[];
    currentRepos?: string[];
    lastStartedAt?: string;
    lastCompletedAt?: string;
    lastFailedAt?: string;
  };
};

type RepoWatchEntry = {
  name: string;
  root: string;
  matcher: FileMatcher;
};

export class FileMatcher {
  private igExclude: any;
  private igInclude: any;
  private repoPath: string;
  private exclude: string[];
  private matchedCorePaths = new Set<string>();
  private excludedDirSegments: Set<string>;
  private excludedDirPaths: Set<string>;
  private brandedWorkspaceDirs = new Set(brandedWorkspaceDirNames());

  constructor(repoPath: string, include: string[], exclude: string[]) {
    this.repoPath = repoPath;
    this.exclude = exclude;
    this.igInclude = ignore().add(include);
    this.igExclude = ignore().add(exclude.map((entry) => entry.replace(/^\*\*\//, "")));
    const excludedDirs = exclude
      .map((entry) => entry.replace(/\\/g, "/").replace(/^\*\*\//, "").replace(/\/\*\*$/, "").replace(/\/$/, ""))
      .filter((entry) => entry && !entry.includes("*") && !entry.includes("?"));
    this.excludedDirPaths = new Set(excludedDirs);
    this.excludedDirSegments = new Set(excludedDirs.filter((entry) => !entry.includes("/")));
  }

  async init(): Promise<void> {
    const gitignorePath = path.join(this.repoPath, ".gitignore");
    try {
      this.igExclude.add(await fsPromises.readFile(gitignorePath, "utf8"));
    } catch {
      // Repositories without .gitignore are fine.
    }
    const candidates = await fg(["**/*.xml"], {
      cwd: this.repoPath,
      absolute: false,
      onlyFiles: true,
      dot: true,
      ignore: this.exclude
    });
    for (const relativePath of candidates) {
      const posixPath = relativePath.replace(/\\/g, "/");
      if (!this.isPathExcluded(posixPath) && await this.matchesCoreCandidate(posixPath)) {
        this.matchedCorePaths.add(posixPath);
      }
    }
  }

  isDirExcluded(relativeDirPath: string): boolean {
    const posixPath = relativeDirPath.split(path.sep).join("/");
    const dirPath = posixPath.endsWith("/") ? posixPath : `${posixPath}/`;
    if (
      posixPath === ".git" ||
      posixPath.startsWith(".git/") ||
      this.brandedWorkspaceDirs.has(posixPath) ||
      [...this.brandedWorkspaceDirs].some((dir) => posixPath.startsWith(`${dir}/`))
    ) {
      return true;
    }
    const segments = posixPath.split("/");
    if (segments.some((segment) => this.excludedDirSegments.has(segment))) return true;
    for (const excludedDir of this.excludedDirPaths) {
      if (posixPath === excludedDir || posixPath.startsWith(`${excludedDir}/`)) return true;
    }
    return this.igExclude.ignores(posixPath) || this.igExclude.ignores(dirPath);
  }

  async match(relativePath: string): Promise<boolean> {
    const posixPath = relativePath.split(path.sep).join("/");
    if (
      posixPath.startsWith(".git/") ||
      [...this.brandedWorkspaceDirs].some((dir) => posixPath.startsWith(`${dir}/`)) ||
      posixPath.includes("/.git/") ||
      [...this.brandedWorkspaceDirs].some((dir) => posixPath.includes(`/${dir}/`))
    ) {
      return false;
    }
    if (this.isPathExcluded(posixPath)) return false;
    if (isGeneratedFile(posixPath)) return false;
    if (this.igInclude.ignores(posixPath)) {
      const lang = parserRegistry.resolve({ relativePath: posixPath })?.language;
      const inferred = lang ?? builtinLanguageForPath(posixPath);
      if (inferred) return true;
    }
    if (!isCoreCandidatePath(posixPath)) return false;

    const previouslyMatched = this.matchedCorePaths.has(posixPath);
    const currentlyMatches = await this.matchesCoreCandidate(posixPath);
    if (currentlyMatches) this.matchedCorePaths.add(posixPath);
    else this.matchedCorePaths.delete(posixPath);
    return previouslyMatched || currentlyMatches;
  }

  private isPathExcluded(posixPath: string): boolean {
    return this.igExclude.ignores(posixPath);
  }

  private async matchesCoreCandidate(relativePath: string): Promise<boolean> {
    if (isJavaBuildMarker(relativePath)) return true;
    const absolutePath = path.join(this.repoPath, relativePath);
    const stat = await fsPromises.stat(absolutePath).catch(() => undefined);
    if (!stat?.isFile() || stat.size > 512 * 1024) return false;
    const source = await fsPromises.readFile(absolutePath, "utf8").catch(() => "");
    return /<dubbo:(?:service|reference)\b/i.test(source) ||
      /xmlns:dubbo\s*=\s*["'][^"']*dubbo[^"']*["']/i.test(source);
  }
}

const JAVA_BUILD_MARKERS = new Set([
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradlew"
]);

function isCoreCandidatePath(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith(".xml") || isJavaBuildMarker(relativePath);
}

function isJavaBuildMarker(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return parts.length <= 4 && JAVA_BUILD_MARKERS.has(parts[parts.length - 1] ?? "");
}

export class WatchRepoIndex {
  private entries: RepoWatchEntry[];

  constructor(entries: RepoWatchEntry[]) {
    this.entries = [...entries]
      .map((entry) => ({ ...entry, root: path.resolve(entry.root) }))
      .sort((a, b) => b.root.length - a.root.length);
  }

  static commonRoot(paths: string[]): string | undefined {
    if (paths.length === 0) return undefined;
    const resolved = paths.map((item) => path.resolve(item));
    const split = resolved.map((item) => item.split(path.sep).filter(Boolean));
    const first = split[0] ?? [];
    const parts: string[] = [];
    const isCaseInsensitive = process.platform === "win32" || process.platform === "darwin";
    for (let i = 0; i < first.length; i++) {
      const match = split.every((segments) => {
        const seg = segments[i];
        if (seg === undefined) return false;
        return isCaseInsensitive
          ? seg.toLowerCase() === first[i]!.toLowerCase()
          : seg === first[i]!;
      });
      if (match) {
        parts.push(first[i]!);
      } else {
        break;
      }
    }
    const root = path.parse(resolved[0]!).root;
    return parts.length === 0 ? root : path.join(root, ...parts.slice(root ? root.split(path.sep).filter(Boolean).length : 0));
  }

  matchAbsolute(absolutePath: string): { repo: RepoWatchEntry; relativePath: string } | undefined {
    const resolved = path.resolve(absolutePath);
    for (const entry of this.entries) {
      const relative = path.relative(entry.root, resolved);
      if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return { repo: entry, relativePath: relative || "." };
      }
    }
    return undefined;
  }
}

export function planRecursiveWatchRoots(repoRoots: string[], mode: WatchMode, maxRoots: number): { roots: string[]; uncoveredRoots: string[] } {
  const resolved = repoRoots.map((root) => path.resolve(root));
  let roots: string[];
  if (mode === "repo-roots") {
    roots = resolved;
  } else {
    const commonRoot = WatchRepoIndex.commonRoot(resolved);
    roots = commonRoot ? [commonRoot] : resolved;
  }
  return {
    roots: roots.slice(0, maxRoots),
    uncoveredRoots: roots.slice(maxRoots)
  };
}

export class FileWatcher {
  private client: InstanceType<typeof GraphClient>;
  private options: Required<Omit<WatchOptions, "repo">> & { repo?: string };
  private watchers: fs.FSWatcher[] = [];
  private repoIndex?: WatchRepoIndex;
  private repoEntries: RepoWatchEntry[] = [];
  private pendingFiles = new Map<string, PendingFile>();
  private debounceTimer?: NodeJS.Timeout;
  private syncPromise?: Promise<void>;
  private failureCounts = new Map<string, number>();
  private pausedRepos = new Set<string>();
  private degraded = false;
  private degradedReason: string | null = null;
  private partialReasons: string[] = [];
  private coveredRepos = new Set<string>();
  private uncoveredRepos = new Set<string>();
  private uncoveredPaths = new Set<string>();
  private active = false;
  private installedWatchers = 0;

  constructor(client: InstanceType<typeof GraphClient>, options: WatchOptions = {}) {
    this.client = client;
    const config = client.getConfig().watch;
    const debounceMs = options.debounceMs ?? config.debounceMs;
    this.options = {
      mode: options.mode ?? config.mode,
      debounceMs: Math.max(100, Math.min(60000, debounceMs)),
      maxRoots: options.maxRoots ?? config.maxRoots,
      maxLinuxDirs: options.maxLinuxDirs ?? config.maxLinuxDirs,
      syncConcurrency: Math.max(1, options.syncConcurrency ?? config.syncConcurrency),
      catchUp: options.catchUp ?? config.catchUp,
      repo: options.repo
    };
  }

  isWatching(): boolean {
    return this.active;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getDegradedReason(): string | null {
    return this.degradedReason;
  }

  getPendingFiles(): PendingFile[] {
    return [...this.pendingFiles.values()];
  }

  getStatus(catchUp?: WatchStatus["catchUp"]): WatchStatus {
    return {
      active: this.active,
      degraded: this.degraded,
      degradedReason: this.degradedReason,
      partial: this.partialReasons.length > 0,
      partialReasons: [...this.partialReasons],
      mode: this.options.mode,
      installedWatchers: this.installedWatchers,
      coveredRepos: [...this.coveredRepos].sort(),
      uncoveredRepos: [...this.uncoveredRepos].sort(),
      uncoveredPaths: [...this.uncoveredPaths].sort(),
      pendingFiles: this.getPendingFiles(),
      pausedRepos: [...this.pausedRepos].sort(),
      indexQueue: this.client.getIndexQueueStatus(),
      catchUp: catchUp ?? {
        mode: this.options.catchUp,
        running: false,
        completed: false,
        failed: false,
        pendingRepos: [],
        completedRepos: []
      }
    };
  }

  private degrade(reason: string): void {
    if (this.degraded) return;
    this.degraded = true;
    this.degradedReason = reason;
    this.client.warn(`[Watcher] ${reason}`);
    this.stop();
  }

  private markPartial(reason: string, repoName?: string, uncoveredPath?: string): void {
    if (!this.partialReasons.includes(reason)) this.partialReasons.push(reason);
    if (repoName) this.uncoveredRepos.add(repoName);
    if (uncoveredPath) this.uncoveredPaths.add(uncoveredPath);
    this.client.warn(`[Watcher] ${reason}`);
  }

  async start(): Promise<boolean> {
    if (this.active) return true;
    this.resetRuntimeState();
    if (this.options.mode === "off" || !this.client.getConfig().watch.enabled) {
      this.client.warn("[Watcher] File watching is disabled by configuration.");
      return false;
    }

    const config = this.client.getConfig();
    const repos = config.repos.filter((repo) => !this.options.repo || repo.name === this.options.repo);
    if (repos.length === 0) {
      this.client.warn(this.options.repo ? `[Watcher] Repository "${this.options.repo}" is not configured.` : "[Watcher] No repositories configured.");
      return false;
    }

    for (const repoConfig of repos) {
      const repoNode = toRepoNode(repoConfig, this.client.getCwd());
      const root = path.resolve(repoNode.path);
      const policy = shouldWatchRepo(root);
      if (!policy.allowed) {
        this.markPartial(`Skipping repository "${repoConfig.name}": ${policy.reason}`, repoConfig.name, root);
        continue;
      }
      const matcher = new FileMatcher(root, config.include, config.exclude);
      await matcher.init();
      this.repoEntries.push({ name: repoConfig.name, root, matcher });
    }

    if (this.repoEntries.length === 0) return false;
    this.repoIndex = new WatchRepoIndex(this.repoEntries);

    if (process.platform === "win32" || process.platform === "darwin") {
      await this.startRecursive();
    } else {
      await this.startLinux();
    }

    if (this.installedWatchers === 0 || this.degraded) {
      if (!this.degraded) this.client.warn("[Watcher] No file watchers were installed.");
      this.stop();
      return false;
    }

    this.active = true;
    return true;
  }

  private resetRuntimeState(): void {
    this.degraded = false;
    this.degradedReason = null;
    this.partialReasons = [];
    this.coveredRepos.clear();
    this.uncoveredRepos.clear();
    this.uncoveredPaths.clear();
    this.pausedRepos.clear();
    this.pendingFiles.clear();
    this.failureCounts.clear();
    this.repoEntries = [];
    this.repoIndex = undefined;
    this.installedWatchers = 0;
  }

  private async startRecursive(): Promise<void> {
    const plan = planRecursiveWatchRoots(
      this.repoEntries.map((entry) => entry.root),
      this.options.mode,
      this.options.maxRoots
    );
    for (const root of plan.uncoveredRoots) {
      this.markPartial(`Watcher root limit reached; "${root}" is not live-watched.`, undefined, root);
    }
    await this.installRecursiveRoots(plan.roots);
  }

  private async installRecursiveRoots(roots: string[]): Promise<void> {
    for (const root of roots) {
      try {
        const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          void this.handleAbsoluteEvent(path.resolve(root, String(filename)));
        });
        watcher.on("error", (err) => this.handleWatchError(err, root));
        this.watchers.push(watcher);
        this.installedWatchers++;
        for (const entry of this.repoEntries) {
          const relative = path.relative(root, entry.root);
          if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) this.coveredRepos.add(entry.name);
        }
      } catch (error) {
        this.handleWatchError(error, root);
      }
    }
  }

  private async startLinux(): Promise<void> {
    let dirBudget = this.options.maxLinuxDirs;
    for (const entry of this.repoEntries) {
      if (this.degraded) break;
      if (dirBudget <= 0) {
        this.markPartial("Linux directory watcher limit reached; remaining repositories are not live-watched.", entry.name, entry.root);
        continue;
      }
      const before = this.installedWatchers;
      dirBudget = await this.watchLinuxTree(entry, entry.root, dirBudget);
      if (this.installedWatchers > before) this.coveredRepos.add(entry.name);
      else this.uncoveredRepos.add(entry.name);
    }
  }

  private async watchLinuxTree(entry: RepoWatchEntry, dirToWatch: string, remainingBudget: number): Promise<number> {
    if (this.degraded || remainingBudget <= 0) {
      this.markPartial("Linux directory watcher limit reached; subtree is not live-watched.", entry.name, dirToWatch);
      return remainingBudget;
    }

    const relative = path.relative(entry.root, dirToWatch);
    if (relative && entry.matcher.isDirExcluded(relative)) return remainingBudget;

    try {
      const watcher = fs.watch(dirToWatch, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(dirToWatch, String(filename));
        void this.handleAbsoluteEvent(fullPath);
        if (eventType === "rename") void this.handleLinuxDirectoryMutation(entry, fullPath);
      });
      watcher.on("error", (err) => this.handleWatchError(err, dirToWatch, entry.name));
      this.watchers.push(watcher);
      this.installedWatchers++;
      remainingBudget--;
    } catch (error) {
      this.handleWatchError(error, dirToWatch, entry.name);
      return remainingBudget;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(dirToWatch, { withFileTypes: true });
    } catch {
      return remainingBudget;
    }
    for (const child of entries) {
      if (!child.isDirectory()) continue;
      remainingBudget = await this.watchLinuxTree(entry, path.join(dirToWatch, child.name), remainingBudget);
      if (remainingBudget <= 0) break;
    }
    return remainingBudget;
  }

  private async handleLinuxDirectoryMutation(entry: RepoWatchEntry, targetPath: string): Promise<void> {
    try {
      const stat = await fsPromises.stat(targetPath);
      if (stat.isDirectory()) await this.watchLinuxTree(entry, targetPath, Math.max(0, this.options.maxLinuxDirs - this.installedWatchers));
    } catch {
      // Directory deletions do not need eager cleanup; closed paths will error and are harmlessly ignored.
    }
  }

  private handleWatchError(error: unknown, location: string, repoName?: string): void {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EMFILE" || err.code === "ENFILE") {
      this.degrade(`Too many open files or descriptor limit reached (${err.code}) while watching "${location}".`);
      return;
    }
    if (err.code === "ENOSPC") {
      this.markPartial(`System watcher limit reached (ENOSPC); "${location}" is not live-watched.`, repoName, location);
      return;
    }
    this.markPartial(`Failed to watch "${location}": ${err.message ?? String(error)}`, repoName, location);
  }

  private async handleAbsoluteEvent(absolutePath: string): Promise<void> {
    if (!this.active || this.degraded || !this.repoIndex) return;
    const match = this.repoIndex.matchAbsolute(absolutePath);
    if (!match) return;
    await this.handleRepoEvent(match.repo, match.relativePath);
  }

  private async handleRepoEvent(repo: RepoWatchEntry, relativePath: string): Promise<void> {
    if (!this.active || this.degraded || this.pausedRepos.has(repo.name)) return;
    const normalizedPath = relativePath.replace(/\\/g, "/");
    if (!await repo.matcher.match(normalizedPath)) return;

    const key = `${repo.name}:${normalizedPath}`;
    const now = Date.now();
    const existing = this.pendingFiles.get(key);
    this.pendingFiles.set(key, {
      repoName: repo.name,
      path: normalizedPath,
      firstSeenMs: existing?.firstSeenMs ?? now,
      lastSeenMs: now,
      indexing: false
    });
    this.scheduleSync();
  }

  async ingestEventForTests(repoName: string, relativePath: string): Promise<void> {
    const repo = this.repoEntries.find((entry) => entry.name === repoName);
    if (repo) await this.handleRepoEvent(repo, relativePath);
  }

  async ingestAbsoluteEventForTests(absolutePath: string): Promise<void> {
    await this.handleAbsoluteEvent(absolutePath);
  }

  private scheduleSync(): void {
    if (!this.active || this.degraded) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.triggerSync(), this.options.debounceMs);
  }

  private async triggerSync(): Promise<void> {
    if (!this.active || this.degraded || this.syncPromise) return;
    const files = [...this.pendingFiles.values()].filter((file) => !file.indexing && !this.pausedRepos.has(file.repoName));
    if (files.length === 0) return;
    for (const file of files) file.indexing = true;
    const repos = [...new Set(files.map((file) => file.repoName))];

    this.syncPromise = this.runRepoSyncQueue(repos)
      .catch((error) => this.client.error("[Watcher] Unhandled error during sync queue:", error))
      .finally(() => {
        this.syncPromise = undefined;
        const hasRunnablePending = [...this.pendingFiles.values()].some((file) => !this.pausedRepos.has(file.repoName));
        if (this.active && !this.degraded && hasRunnablePending) this.scheduleSync();
      });
  }

  private async runRepoSyncQueue(repos: string[]): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < repos.length) {
        const repoName = repos[cursor++]!;
        await this.syncRepo(repoName);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.syncConcurrency, repos.length) }, () => worker()));
  }

  private async syncRepo(repoName: string): Promise<void> {
    const startedAt = Date.now();
    this.client.log(`[Watcher] Auto-syncing changes in repo "${repoName}"...`);
    try {
      await this.client.index({ repo: repoName, changedOnly: true, writeMode: "merge", queueSource: "watch", queueLabel: `watch:${repoName}` });
      for (const [key, file] of this.pendingFiles) {
        if (file.repoName === repoName && file.lastSeenMs <= startedAt) this.pendingFiles.delete(key);
      }
      this.failureCounts.set(repoName, 0);
      this.client.log(`[Watcher] Auto-sync completed for repo "${repoName}".`);
    } catch (error) {
      const err = error as Error;
      this.client.warn(`[Watcher] Auto-sync failed for repo "${repoName}": ${err.message ?? String(error)}`);
      for (const file of this.pendingFiles.values()) {
        if (file.repoName === repoName) file.indexing = false;
      }
      const failures = (this.failureCounts.get(repoName) ?? 0) + 1;
      this.failureCounts.set(repoName, failures);
      if (failures >= 3) {
        this.pausedRepos.add(repoName);
        this.markPartial(`Repo "${repoName}" failed to index 3 consecutive times; auto-sync is paused for this repo.`, repoName);
      }
    }
  }

  stop(): void {
    if (!this.active && this.watchers.length === 0 && !this.debounceTimer) return;
    this.active = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    this.watchers = [];
    this.installedWatchers = 0;
    this.pendingFiles.clear();
  }
}
