import { createLogicLens } from "../sdk/client.js";
import { writeConfig } from "../config/loadConfig.js";

export async function addRepoCommand(repoPath: string, options: { name?: string }, cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    const result = await client.addRepo(repoPath, options);
    await writeConfig(client.getConfig(), cwd);
    console.log(`Added repo ${result.name}: ${result.storedPath}`);
  } finally {
    await client.close();
  }
}
