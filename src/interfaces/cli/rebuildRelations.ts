import { createClient } from "../sdk/client.js";
import { ProgressBar } from "../../shared/progress.js";

export type RebuildRelationsOptions = {
  repo?: string;
  full?: boolean;
};

export async function rebuildRelationsCommand(options: RebuildRelationsOptions, cwd = process.cwd()): Promise<void> {
  const client = await createClient({
    cwd,
    logger: {
      log: console.log,
      warn: console.warn,
      error: console.error,
      writeStderr: (msg) => process.stderr.write(msg),
      createProgressBar: (label, total) => new ProgressBar(label, total)
    }
  });
  try {
    const result = await client.rebuildRelations(options);
    console.log(`Rebuilt ${result.rebuiltCount} repo dependency edges${options.repo && !options.full ? ` for ${options.repo}` : ""}`);
  } finally {
    await client.close();
  }
}
