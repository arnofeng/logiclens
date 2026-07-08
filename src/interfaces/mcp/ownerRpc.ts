import crypto from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { BRAND_PATHS } from "../../shared/branding.js";
import type { AppClient } from "../sdk/client.js";
import type { WatchOptions, WatchStatus } from "../../features/watch/watcher.js";

const PID_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RPC_REQUEST_TIMEOUT_MS = 2000;

export type McpOwnerRpcInfo = {
  host: string;
  port: number;
  token: string;
};

export type McpPidFile = {
  pid?: unknown;
  cwd?: unknown;
  version?: unknown;
  startedAt?: unknown;
  rpc?: Partial<McpOwnerRpcInfo>;
};

export type McpOwnerRpcServer = {
  info: McpOwnerRpcInfo;
  close(): Promise<void>;
};

export type McpOwnerRpcAttach = {
  pidPath: string;
  pid: number;
  cwd: string;
  version?: string;
  startedAt: number;
  rpc: McpOwnerRpcInfo;
};

export function mcpPidPath(cwd: string): string {
  return path.resolve(cwd, BRAND_PATHS.mcpPid);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

export async function startMcpOwnerRpcServer(input: {
  client: AppClient;
  cwd: string;
  getCatchUp: () => WatchStatus["catchUp"] | undefined;
  defaultWatchOptions?: WatchOptions;
}): Promise<McpOwnerRpcServer> {
  const token = crypto.randomBytes(32).toString("hex");
  const host = "127.0.0.1";

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          cwd: path.resolve(input.cwd)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/watch/status") {
        sendJson(res, 200, input.client.getWatchStatus(input.getCatchUp()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/watch/ensure") {
        if (!input.client.isWatching()) {
          await input.client.watch(input.defaultWatchOptions ?? { catchUp: "background" });
        }
        sendJson(res, 200, input.client.getWatchStatus(input.getCatchUp()));
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const info: McpOwnerRpcInfo = { host, port: address.port, token };
  return {
    info,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

export async function findMcpOwner(cwd: string): Promise<McpOwnerRpcAttach | null> {
  const pidPath = mcpPidPath(cwd);
  let info: McpPidFile;
  try {
    info = JSON.parse(await fs.readFile(pidPath, "utf8")) as McpPidFile;
  } catch {
    return null;
  }

  const pid = Number(info.pid);
  const startedAt = Number(info.startedAt);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isFinite(startedAt) || Date.now() - startedAt > PID_FILE_MAX_AGE_MS) return null;
  if (typeof info.cwd !== "string" || path.resolve(info.cwd) !== path.resolve(cwd)) return null;
  if (!isProcessAlive(pid)) return null;
  if (!isValidRpcInfo(info.rpc)) return null;

  return {
    pidPath,
    pid,
    cwd: path.resolve(info.cwd),
    version: typeof info.version === "string" ? info.version : undefined,
    startedAt,
    rpc: info.rpc
  };
}

export async function ownerRpcRequest<T>(owner: McpOwnerRpcAttach, method: "GET" | "POST", pathname: string): Promise<T> {
  const body = await new Promise<string>((resolve, reject) => {
    const req = http.request({
      host: owner.rpc.host,
      port: owner.rpc.port,
      path: pathname,
      method,
      timeout: RPC_REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${owner.rpc.token}`,
        Accept: "application/json"
      }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`Owner RPC ${method} ${pathname} failed with status ${res.statusCode}: ${data}`));
          return;
        }
        resolve(data);
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`Owner RPC ${method} ${pathname} timed out`));
    });
    req.on("error", reject);
    req.end();
  });
  return JSON.parse(body) as T;
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  return header === `Bearer ${token}`;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized)
  });
  res.end(serialized);
}

function isValidRpcInfo(value: McpPidFile["rpc"]): value is McpOwnerRpcInfo {
  return Boolean(
    value &&
    value.host === "127.0.0.1" &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65535 &&
    typeof value.token === "string" &&
    value.token.length > 0
  );
}
