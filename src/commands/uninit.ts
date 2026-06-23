import { createLogicLens } from "../sdk/client.js";

export async function uninitCommand(cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({
    cwd,
    logger: {
      log: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
      error: (...args) => console.error(...args),
      writeStderr: (msg) => process.stderr.write(msg)
    }
  });
  try {
    await client.uninit();
    console.log("Uninitialized LogicLens workspace successfully (removed config, graph DB, cache, and stopped running MCP service).");
  } finally {
    await client.close();
  }
}
