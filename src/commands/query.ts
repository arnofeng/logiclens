import { createLogicLens } from "../sdk/client.js";

export async function queryCommand(cypher: string, cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    console.log(JSON.stringify(await client.query(cypher), null, 2));
  } finally {
    await client.close();
  }
}
