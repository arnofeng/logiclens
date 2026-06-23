import { createLogicLens } from "../sdk/client.js";

export async function addRepoCommand(repoPath: string, options: { name?: string }, cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    const result = await client.addRepo(repoPath, options);
    console.log(`Added repo ${result.name}: ${result.storedPath}`);
  } finally {
    await client.close();
  }
}
