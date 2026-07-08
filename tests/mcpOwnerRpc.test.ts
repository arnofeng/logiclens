import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND_PATHS } from "../src/shared/branding.js";
import { findMcpOwner, ownerRpcRequest, startMcpOwnerRpcServer, type McpOwnerRpcServer } from "../src/interfaces/mcp/ownerRpc.js";
import type { WatchStatus } from "../src/features/watch/watcher.js";

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

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "logiclens-owner-rpc-"));
}

describe("MCP owner RPC", () => {
  let rpc: McpOwnerRpcServer | undefined;

  afterEach(async () => {
    if (rpc) await rpc.close();
    rpc = undefined;
    vi.restoreAllMocks();
  });

  it("serves authorized health and watcher status requests", async () => {
    const cwd = await makeWorkspace();
    const client = {
      isWatching: () => true,
      watch: vi.fn(),
      getWatchStatus: () => status()
    } as any;

    rpc = await startMcpOwnerRpcServer({ client, cwd, getCatchUp: () => status().catchUp });
    const pidPath = path.join(cwd, BRAND_PATHS.mcpPid);
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, JSON.stringify({ pid: process.pid, cwd, version: "test", startedAt: Date.now(), rpc: rpc.info }), "utf8");

    const owner = await findMcpOwner(cwd);
    expect(owner?.rpc.port).toBe(rpc.info.port);

    const health = await ownerRpcRequest<{ ok: boolean; cwd: string }>(owner!, "GET", "/health");
    expect(health.ok).toBe(true);
    expect(path.resolve(health.cwd)).toBe(path.resolve(cwd));

    const watchStatus = await ownerRpcRequest<WatchStatus>(owner!, "GET", "/watch/status");
    expect(watchStatus.active).toBe(true);
    expect(watchStatus.coveredRepos).toEqual(["repo-a"]);
  });

  it("rejects requests without the owner token", async () => {
    const cwd = await makeWorkspace();
    const client = {
      isWatching: () => true,
      watch: vi.fn(),
      getWatchStatus: () => status()
    } as any;

    rpc = await startMcpOwnerRpcServer({ client, cwd, getCatchUp: () => undefined });

    const response = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: rpc!.info.host, port: rpc!.info.port, path: "/health", method: "GET" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      });
      req.on("error", reject);
      req.end();
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("unauthorized");
  });
});
