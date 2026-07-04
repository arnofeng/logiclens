import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { shouldWatchRepo, shouldEnableWatcher, __resetWslCacheForTests } from "../src/features/watch/policy.js";
import { FileMatcher, FileWatcher, WatchRepoIndex, planRecursiveWatchRoots } from "../src/features/watch/watcher.js";
import { createClient } from "../src/index.js";
import { defaultConfig, writeConfig } from "../src/config/loadConfig.js";
import { buildFreshnessMetadata, buildFreshnessWarning } from "../src/interfaces/mcp/server.js";
import { SingleProcessIndexQueue } from "../src/core/indexing/scheduler.js";

async function makeTempWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-watch-test-"));
}

describe("LogicLens File Watcher Subsystem", () => {
  describe("Watch Policy", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      __resetWslCacheForTests();
    });

    afterEach(() => {
      process.env = originalEnv;
      __resetWslCacheForTests();
    });

    it("allows standard paths by default", () => {
      const res = shouldWatchRepo("/home/user/project");
      expect(res.allowed).toBe(true);
    });

    it("disallows when LOGICLENS_NO_WATCH=1 is set", () => {
      process.env.LOGICLENS_NO_WATCH = "1";
      const res = shouldWatchRepo("/home/user/project");
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain("LOGICLENS_NO_WATCH");
    });

    it("allows normal Linux /mnt/* mount paths when not running under WSL", () => {
      // Mock platform
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      try {
        const res = shouldWatchRepo("/mnt/data/project");
        expect(res.allowed).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });

    it("disallows WSL Windows-drive /mnt/* mount paths on Linux platform", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.WSL_DISTRO_NAME = "Ubuntu";
      __resetWslCacheForTests();

      try {
        const res = shouldWatchRepo("/mnt/c/project");
        expect(res.allowed).toBe(false);
        expect(res.reason).toContain("WSL Windows-drive");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });

    it("allows WSL /mnt/* mount paths if LOGICLENS_FORCE_WATCH=1 is set", () => {
      process.env.LOGICLENS_FORCE_WATCH = "1";
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      try {
        const res = shouldWatchRepo("/mnt/c/project");
        expect(res.allowed).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });

    it("does not disable the whole watcher for one repo-level policy miss", () => {
      const res = shouldEnableWatcher(["/workspace/repo-a", "/mnt/c/repo-b"]);
      expect(res.allowed).toBe(true);
    });
  });

  describe("FileMatcher Filters", () => {
    it("filters files based on includes, excludes, gitignore and language parsers", async () => {
      const tempDir = await makeTempWorkspace();
      await fs.writeFile(path.join(tempDir, ".gitignore"), "ignored.ts\n");

      const include = ["**/*.ts", "**/*.js", "**/*.md"];
      const exclude = ["**/node_modules/**", "**/dist/**"];

      const matcher = new FileMatcher(tempDir, include, exclude);
      await matcher.init();

      // Matches valid TypeScript file
      expect(matcher.match("src/index.ts")).toBe(true);

      // Matches valid Markdown document
      expect(matcher.match("README.md")).toBe(true);

      // Skips node_modules
      expect(matcher.match("node_modules/dep/index.ts")).toBe(false);

      // Skips path matched by gitignore
      expect(matcher.match("ignored.ts")).toBe(false);

      // Skips generated files
      expect(matcher.match("src/index.pb.ts")).toBe(false);

      // Skips unsupported parser file (e.g. random binary)
      expect(matcher.match("assets/logo.png")).toBe(false);

      // Skips .git and .logiclens internal folders
      expect(matcher.match(".git/config")).toBe(false);
      expect(matcher.match(".logiclens/graph/data.mdb")).toBe(false);
    });

    it("prunes ignored directories using directory semantics", async () => {
      const tempDir = await makeTempWorkspace();
      const matcher = new FileMatcher(tempDir, ["**/*.ts"], ["**/node_modules/**", "**/dist/**"]);
      await matcher.init();

      expect(matcher.isDirExcluded("node_modules")).toBe(true);
      expect(matcher.isDirExcluded("dist")).toBe(true);
      expect(matcher.isDirExcluded(".git")).toBe(true);
      expect(matcher.isDirExcluded(".logiclens")).toBe(true);
      expect(matcher.isDirExcluded("src")).toBe(false);
    });
  });

  describe("FileWatcher Instance Integration", () => {
    it("can start/stop cleanly and track pending files", async () => {
      const cwd = await makeTempWorkspace();
      const repoDir = path.join(cwd, "my-repo");
      await fs.mkdir(repoDir);
      await fs.writeFile(path.join(repoDir, "hello.ts"), "console.log('hello');");

      await writeConfig(
        {
          ...defaultConfig(),
          repos: [{ name: "my-repo", path: "./my-repo" }]
        },
        cwd
      );

      const client = await createClient({ cwd });
      const started = await client.watch({ debounceMs: 1000 });
      expect(started).toBe(true);
      expect(client.isWatching()).toBe(true);

      const watcher = (client as any).watcher as FileWatcher;
      watcher.ingestEventForTests("my-repo", "hello.ts");

      const pending = client.getPendingFiles();
      expect(pending.map((file) => `${file.repoName}/${file.path}`)).toContain("my-repo/hello.ts");
      expect(client.getWatchStatus().indexQueue.running).toBe(false);
      expect(client.getWatchStatus().indexQueue.pendingJobs).toEqual([]);

      client.unwatch();
      expect(client.isWatching()).toBe(false);
      await client.close();
    });

    it("uses explicit/configured debounce instead of LOGICLENS_WATCH_DEBOUNCE_MS", async () => {
      const cwd = await makeTempWorkspace();
      const repoDir = path.join(cwd, "my-repo");
      await fs.mkdir(repoDir);
      await fs.writeFile(path.join(repoDir, "hello.ts"), "console.log('hello');");
      await writeConfig({ ...defaultConfig(), repos: [{ name: "my-repo", path: "./my-repo" }], watch: { ...defaultConfig().watch, debounceMs: 1234 } }, cwd);

      const originalDebounce = process.env.LOGICLENS_WATCH_DEBOUNCE_MS;
      process.env.LOGICLENS_WATCH_DEBOUNCE_MS = "9999";
      try {
        const client = await createClient({ cwd });
        const watcher = new FileWatcher(client);
        expect((watcher as any).options.debounceMs).toBe(1234);

        const explicit = new FileWatcher(client, { debounceMs: 4321 });
        expect((explicit as any).options.debounceMs).toBe(4321);
        await client.close();
      } finally {
        if (originalDebounce === undefined) delete process.env.LOGICLENS_WATCH_DEBOUNCE_MS;
        else process.env.LOGICLENS_WATCH_DEBOUNCE_MS = originalDebounce;
      }
    });

    it("serializes long-lived index jobs and exposes queue state", async () => {
      const queue = new SingleProcessIndexQueue();
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const first = queue.enqueue({
        source: "watch",
        label: "watch:repo-a",
        run: async () => {
          order.push("first:start");
          await firstGate;
          order.push("first:end");
          return "first";
        }
      });
      const second = queue.enqueue({
        source: "manual",
        label: "manual:repo-b",
        run: async () => {
          order.push("second:start");
          return "second";
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(queue.getStatus().runningJob?.source).toBe("watch");
      expect(queue.getStatus().pendingJobs.map((job) => job.source)).toEqual(["manual"]);
      expect(order).toEqual(["first:start"]);

      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(order).toEqual(["first:start", "first:end", "second:start"]);
      expect(queue.getStatus().completedJobs).toBe(2);
      expect(queue.getStatus().pendingJobs).toEqual([]);
    });

    it("returns false for an unknown repo filter", async () => {
      const cwd = await makeTempWorkspace();
      const repoDir = path.join(cwd, "my-repo");
      await fs.mkdir(repoDir);
      await writeConfig(
        {
          ...defaultConfig(),
          repos: [{ name: "my-repo", path: "./my-repo" }]
        },
        cwd
      );

      const client = await createClient({ cwd });
      const started = await client.watch({ repo: "missing-repo" });
      expect(started).toBe(false);
      expect(client.isWatching()).toBe(false);
      await client.close();
    });

    it("pauses only the failing repo after 3 consecutive indexing failures", async () => {
      const cwd = await makeTempWorkspace();
      const repoDir = path.join(cwd, "my-repo");
      await fs.mkdir(repoDir);
      await fs.writeFile(path.join(repoDir, "hello.ts"), "console.log('hello');");

      await writeConfig(
        {
          ...defaultConfig(),
          repos: [{ name: "my-repo", path: "./my-repo" }]
        },
        cwd
      );

      const client = await createClient({ cwd });
      
      // Mock index to throw error
      let failCount = 0;
      client.index = async () => {
        failCount++;
        throw new Error("Simulated index failure");
      };

      const watcher = new FileWatcher(client, { debounceMs: 100 });
      expect(await watcher.start()).toBe(true);

      // Trigger change
      watcher.ingestEventForTests("my-repo", "hello.ts");

      // Wait for debounce retries to exhaust and degrade.
      await new Promise((resolve) => setTimeout(resolve, 450));

      expect(failCount).toBe(3);
      expect(watcher.isDegraded()).toBe(false);
      expect(watcher.getStatus().partial).toBe(true);
      expect(watcher.getStatus().pausedRepos).toContain("my-repo");

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(failCount).toBe(3);

      watcher.ingestEventForTests("my-repo", "hello.ts");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(failCount).toBe(3);

      await client.close();
    });

    it("deduplicates repeated file events in the pending map", async () => {
      const cwd = await makeTempWorkspace();
      const repoDir = path.join(cwd, "my-repo");
      await fs.mkdir(repoDir);
      await fs.writeFile(path.join(repoDir, "hello.ts"), "console.log('hello');");
      await writeConfig({ ...defaultConfig(), repos: [{ name: "my-repo", path: "./my-repo" }] }, cwd);

      const client = await createClient({ cwd });
      const watcher = new FileWatcher(client, { debounceMs: 1000 });
      expect(await watcher.start()).toBe(true);

      watcher.ingestEventForTests("my-repo", "hello.ts");
      watcher.ingestEventForTests("my-repo", "hello.ts");

      expect(watcher.getPendingFiles()).toHaveLength(1);
      watcher.stop();
      await client.close();
    });

    it("keeps installed Linux watchers when maxLinuxDirs is reached", async () => {
      const cwd = await makeTempWorkspace();
      const repoDir = path.join(cwd, "my-repo");
      await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
      await fs.writeFile(path.join(repoDir, "src", "hello.ts"), "console.log('hello');");
      await writeConfig({ ...defaultConfig(), repos: [{ name: "my-repo", path: "./my-repo" }] }, cwd);

      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      try {
        const client = await createClient({ cwd });
        const started = await client.watch({ maxLinuxDirs: 1 });
        expect(started).toBe(true);
        const status = client.getWatchStatus();
        expect(status.installedWatchers).toBe(1);
        expect(status.partial).toBe(true);
        expect(status.partialReasons.join("\n")).toContain("Linux directory watcher limit reached");
        await client.close();
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });

    it("plans 2000 repo roots as one common recursive root in auto mode", () => {
      const roots = Array.from({ length: 2000 }, (_value, index) => path.resolve("workspace", `repo-${index}`));
      const plan = planRecursiveWatchRoots(roots, "auto", 256);

      expect(plan.roots).toHaveLength(1);
      expect(plan.uncoveredRoots).toHaveLength(0);
      expect(plan.roots[0]?.replace(/\\/g, "/")).toContain("workspace");
    });

    it("routes absolute file paths to the most specific repo root", async () => {
      const tempDir = await makeTempWorkspace();
      const parent = path.join(tempDir, "repo");
      const child = path.join(parent, "packages", "child");
      const matcher = new FileMatcher(parent, ["**/*.ts"], []);
      const childMatcher = new FileMatcher(child, ["**/*.ts"], []);
      await matcher.init();
      await childMatcher.init();
      const index = new WatchRepoIndex([
        { name: "parent", root: parent, matcher },
        { name: "child", root: child, matcher: childMatcher }
      ]);

      const match = index.matchAbsolute(path.join(child, "src", "index.ts"));
      expect(match?.repo.name).toBe("child");
      expect(match?.relativePath.replace(/\\/g, "/")).toBe("src/index.ts");
    });
  });

  describe("MCP freshness warnings", () => {
    it("formats catch-up and pending-file warnings with ASCII text", () => {
      const warning = buildFreshnessWarning({
        content: [{ type: "text", text: "Trace result references src/OrderService.ts" }],
        pending: [{
          repoName: "service-a",
          path: "src/OrderService.ts",
          firstSeenMs: 1,
          lastSeenMs: 2,
          indexing: false
        }],
        catchUpError: new Error("catch-up failed")
      });

      expect(warning).toContain("[WARNING] LogicLens startup catch-up indexing failed: catch-up failed");
      expect(warning).toContain("service-a/src/OrderService.ts");
      expect(warning).not.toContain("\u26a0");
    });

    it("warns only while background catch-up is running", () => {
      const running = buildFreshnessWarning({
        content: [{ type: "text", text: "{}" }],
        pending: [],
        catchUp: {
          mode: "background",
          running: true,
          completed: false,
          failed: false,
          pendingRepos: ["repo-a"],
          completedRepos: []
        }
      });
      const completed = buildFreshnessWarning({
        content: [{ type: "text", text: "{}" }],
        pending: [],
        catchUp: {
          mode: "background",
          running: false,
          completed: true,
          failed: false,
          pendingRepos: [],
          completedRepos: ["repo-a"]
        }
      });

      expect(running).toContain("catch-up indexing is still running");
      expect(completed).toBe("");
    });

    it("builds structured freshness metadata for MCP responses", () => {
      const metadata = buildFreshnessMetadata({
        pending: [{
          repoName: "service-a",
          path: "src/OrderService.ts",
          firstSeenMs: 1,
          lastSeenMs: 2,
          indexing: true
        }],
        watcherActive: true,
        degradedReason: undefined,
        catchUp: {
          mode: "background",
          running: true,
          completed: false,
          failed: false,
          pendingRepos: ["service-a"],
          completedRepos: [],
          currentRepos: ["service-a"]
        },
        indexQueue: {
          running: true,
          runningJob: {
            id: "index:1",
            source: "watch",
            label: "watch:service-a",
            status: "running",
            queuedAt: "2026-01-01T00:00:00.000Z"
          },
          pendingJobs: [],
          completedJobs: 0,
          failedJobs: 0
        }
      });

      expect(metadata.stale).toBe(true);
      expect(metadata.reasons).toEqual(expect.arrayContaining(["catch-up-running", "pending-file-changes", "index-queue-running"]));
      expect(metadata.indexQueue.runningJob?.source).toBe("watch");
    });
  });
});
