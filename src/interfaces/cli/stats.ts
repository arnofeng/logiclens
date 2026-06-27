import { createLogicLens } from "../sdk/client.js";

export async function statsCommand(cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    const stats = await client.stats();
    console.log(`Repos: ${stats.repos}`);
    console.log(`Files: ${stats.files}`);
    console.log(`Code nodes: ${stats.codeNodes}`);
    console.log(`Call edges: ${stats.callEdges}`);
    console.log(`Import edges: ${stats.importEdges}`);
    console.log(`Entities: ${stats.entities}`);
  } finally {
    await client.close();
  }
}
