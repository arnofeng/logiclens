import { createLogicLens } from "../sdk/client.js";
import { BRAND } from "../../shared/branding.js";

export type WatchCommandOptions = {
  debounceMs?: number;
  repo?: string;
};

export async function watchCommand(options: WatchCommandOptions, cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({
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
