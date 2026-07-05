import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, defaultConfig, configPath } from "../../config/loadConfig.js";
import { BRAND, BRAND_PATHS, brandedConfigDirPaths, configFileCandidates } from "../../shared/branding.js";

const PID_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type McpPidFile = {
  pid?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
  version?: unknown;
};

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeResolveManagedPath(cwd: string, candidate: string, label: string): string {
  if (!candidate || candidate.trim() === "") throw new Error(`Refusing to remove empty ${label} path.`);
  if (candidate.includes("\0")) throw new Error(`Refusing to remove invalid ${label} path.`);

  const workspace = path.resolve(cwd);
  const resolved = path.resolve(workspace, candidate);
  const root = path.parse(resolved).root;
  if (resolved === root) throw new Error(`Refusing to remove filesystem root for ${label}: ${resolved}`);
  if (!isPathInside(workspace, resolved)) throw new Error(`Refusing to remove ${label} outside workspace: ${resolved}`);

  const relative = path.relative(workspace, resolved).replace(/\\/g, "/");
  const allowedPrefixes = [
    BRAND.configDirName,
    BRAND_PATHS.graph,
    BRAND_PATHS.semanticIndex,
    ".codegraph"
  ].map((value) => value.replace(/\\/g, "/").replace(/\/$/, ""));

  const allowed = allowedPrefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
  if (!allowed) throw new Error(`Refusing to remove unmanaged ${label} path: ${resolved}`);
  return resolved;
}

function validPidInfo(info: McpPidFile, cwd: string): { pid: number } | undefined {
  const pid = Number(info.pid);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof info.cwd !== "string" || path.resolve(info.cwd) !== path.resolve(cwd)) return undefined;
  if (typeof info.startedAt !== "number" || Date.now() - info.startedAt > PID_FILE_MAX_AGE_MS) return undefined;
  return { pid };
}

/**
 * Removes the branded workspace: stops a running MCP server (via its pid
 * lock file) and deletes the config, graph database, and semantic index.
 *
 * Workspace teardown lives in the CLI layer (not the SDK) so that embedding the
 * SDK can never delete a user's workspace as a side effect.
 */
export async function uninitCommand(cwd = process.cwd()): Promise<void> {
  let config;
  try {
    config = await loadConfig(cwd);
  } catch {
    config = defaultConfig();
  }

  // Stop a running MCP service safely if a lock file exists.
  const mcpPidPaths = [...new Set(brandedConfigDirPaths(cwd).map((dir) => path.join(dir, "mcp.pid")))];
  for (const mcpPidPath of mcpPidPaths) {
    try {
      const info = JSON.parse(await fs.readFile(mcpPidPath, "utf8")) as McpPidFile;
      const valid = validPidInfo(info, cwd);
      if (!valid) {
        console.warn(`Ignoring stale or untrusted MCP pid file: ${mcpPidPath}`);
        continue;
      }
      const { pid } = valid;
      if (isProcessAlive(pid)) {
        console.log(`Stopping running MCP service (PID ${pid})...`);
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
        if (!(await waitForDeath(pid, 3000))) {
          console.warn(`MCP service (PID ${pid}) did not exit. Forcing shutdown...`);
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
          await waitForDeath(pid, 2000);
        }
      }
    } catch {
      // Lock file missing or invalid: nothing to stop.
    }
  }

  // Resolve and remove all workspace artifacts.
  const graphPath = safeResolveManagedPath(cwd, config.graph.path, "graph");
  const semanticPath = safeResolveManagedPath(cwd, config.semantic.jsonPath, "semantic index");

  await fs.rm(graphPath, { recursive: true, force: true });
  await fs.rm(semanticPath, { force: true });
  await Promise.all(configFileCandidates(cwd).map((file) => fs.rm(file, { force: true })));
  await Promise.all(mcpPidPaths.map((file) => fs.rm(file, { force: true })));
  await fs.rm(configPath(cwd), { force: true });
  await Promise.all(brandedConfigDirPaths(cwd).map((dir) => fs.rm(dir, { recursive: true, force: true })));

  console.log(`Uninitialized ${BRAND.displayName} workspace successfully (removed config, graph DB, and stopped running MCP service).`);
}
