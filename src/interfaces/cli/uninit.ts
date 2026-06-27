import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, defaultConfig, configPath } from "../../config/loadConfig.js";

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

/**
 * Removes the `.logiclens` workspace: stops a running MCP server (via its pid
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
  const mcpPidPath = path.join(cwd, ".logiclens", "mcp.pid");
  try {
    const info = JSON.parse(await fs.readFile(mcpPidPath, "utf8"));
    const pid = info.pid;
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

  // Resolve and remove all workspace artifacts.
  const graphPath = path.resolve(cwd, config.graph.path);
  const semanticPath = path.resolve(cwd, config.semantic.jsonPath);

  await fs.rm(graphPath, { recursive: true, force: true });
  await fs.rm(semanticPath, { force: true });
  await fs.rm(configPath(cwd), { force: true });
  await fs.rm(mcpPidPath, { force: true });
  await fs.rm(path.join(cwd, ".logiclens"), { recursive: true, force: true });

  console.log("Uninitialized LogicLens workspace successfully (removed config, graph DB, and stopped running MCP service).");
}
