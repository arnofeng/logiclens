import { createClient } from "../sdk/client.js";
import { BRAND } from "../../shared/branding.js";
import { findMcpOwner, ownerRpcRequest, type McpOwnerRpcAttach } from "../mcp/ownerRpc.js";
import type { WatchStatus } from "../../features/watch/watcher.js";

export type WatchCommandOptions = {
  debounceMs?: number;
  repo?: string;
};

export async function watchCommand(options: WatchCommandOptions, cwd = process.cwd()): Promise<void> {
  const attached = await tryAttachToMcpOwner(options, cwd);
  if (attached) return;

  const client = await createClient({
    cwd,
    logger: {
      log: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
      error: (...args) => console.error(...args),
      writeStderr: (msg) => process.stderr.write(msg)
    }
  });

  const cleanup = async () => {
    console.log("\nStopping file watcher...");
    client.unwatch();
    await client.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    cleanup().catch(() => process.exit(1));
  });
  process.on("SIGTERM", () => {
    cleanup().catch(() => process.exit(1));
  });

  try {
    console.log("Running initial catch-up indexing...");
    await client.index({
      repo: options.repo,
      changedOnly: true,
      writeMode: "merge"
    });
    console.log("Catch-up indexing complete.");

    const started = await client.watch({
      debounceMs: options.debounceMs,
      repo: options.repo
    });

    if (!started) {
      console.error("Failed to start file watcher (disabled by policy or already running).");
      await client.close();
      process.exit(1);
    }

    console.log(`${BRAND.displayName} file watcher started.`);
    console.log("Press Ctrl+C to terminate.");
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    await client.close();
    process.exit(1);
  }
}

async function tryAttachToMcpOwner(options: WatchCommandOptions, cwd: string): Promise<boolean> {
  const owner = await findMcpOwner(cwd);
  if (!owner) return false;

  try {
    const health = await ownerRpcRequest<{ ok: boolean; cwd: string }>(owner, "GET", "/health");
    if (!health.ok) return false;
    await ownerRpcRequest<WatchStatus>(owner, "POST", "/watch/ensure");
  } catch {
    return false;
  }

  console.log(`${BRAND.displayName} file watcher attached to MCP owner (PID ${owner.pid}).`);
  if (options.repo || options.debounceMs !== undefined) {
    console.warn("Note: MCP owner watcher is already configured by the running MCP server; watch command options are ignored while attached.");
  }
  console.log("Press Ctrl+C to detach. The MCP watcher will keep running.");
  await pollAttachedWatchStatus(owner);
  return true;
}

async function pollAttachedWatchStatus(owner: McpOwnerRpcAttach): Promise<void> {
  let lastLine = "";
  let stopped = false;
  let interval: NodeJS.Timeout | undefined;

  const render = async () => {
    try {
      const status = await ownerRpcRequest<WatchStatus>(owner, "GET", "/watch/status");
      const pending = status.pendingFiles.length;
      const queued = status.indexQueue.pendingJobs.length;
      const running = status.indexQueue.running ? status.indexQueue.runningJob?.label ?? "yes" : "no";
      const degraded = status.degraded ? ` degraded=${status.degradedReason ?? "unknown"}` : "";
      const line = `Watcher status: pending=${pending} queued=${queued} running=${running}${degraded}`;
      if (line !== lastLine) {
        console.log(line);
        lastLine = line;
      }
    } catch (error) {
      console.warn(`Lost MCP owner connection: ${error instanceof Error ? error.message : String(error)}`);
      stop();
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (interval) clearInterval(interval);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await render();
  interval = setInterval(() => {
    render().catch(() => {});
  }, 5000);

  while (!stopped) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
