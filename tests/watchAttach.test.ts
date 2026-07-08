import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND_PATHS } from "../src/shared/branding.js";
import { startMcpOwnerRpcServer, type McpOwnerRpcServer } from "../src/interfaces/mcp/ownerRpc.js";
import type { WatchStatus } from "../src/features/watch/watcher.js";

vi.mock("../src/interfaces/sdk/client.js", () => ({
  createClient: vi.fn(async () => {
    throw new Error("standalone client should not be created while attached to MCP owner");
  })
}));

function status(): WatchStatus {
  return {
    active: true,
    degraded: false,
    degradedReason: null,
    partial: false,
    partialReasons: [],
    mode: "auto",
    installedWatchers: 1,
    coveredRepos: ["repo-a"],
    uncoveredRepos: [],
    uncoveredPaths: [],
    pendingFiles: [],
    pausedRepos: [],
    indexQueue: {
      running: false,
      pendingJobs: [],
      completedJobs: 0,
      failedJobs: 0
    },
    catchUp: {
      mode: "background",
      running: false,
      completed: true,
      failed: false,
      pendingRepos: [],
      completedRepos: ["repo-a"]
    }
  };
}

describe("watch command MCP owner attach", () => {
  let rpc: McpOwnerRpcServer | undefined;

  afterEach(async () => {
    if (rpc) await rpc.close();
    rpc = undefined;
    vi.restoreAllMocks();
  });

  it("attaches to a live MCP owner instead of opening a standalone graph client", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-watch-attach-"));
    const client = {
      isWatching: () => true,
      watch: vi.fn(),
      getWatchStatus: () => status()
    } as any;
    rpc = await startMcpOwnerRpcServer({ client, cwd, getCatchUp: () => status().catchUp });
    const pidPath = path.join(cwd, BRAND_PATHS.mcpPid);
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, JSON.stringify({ pid: process.pid, cwd, version: "test", startedAt: Date.now(), rpc: rpc.info }), "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalOnce = process.once.bind(process);
    const onceSpy = vi.spyOn(process, "once").mockImplementation((eventName: string | symbol, listener: (...args: any[]) => void) => {
      const result = originalOnce(eventName, listener);
      if (eventName === "SIGINT") {
        setTimeout(() => listener("SIGINT"), 0);
      }
      return result;
    });
    const { watchCommand } = await import("../src/interfaces/cli/watch.js");

    await watchCommand({}, cwd);

    expect(client.watch).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("attached to MCP owner"))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(onceSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
  });
});
