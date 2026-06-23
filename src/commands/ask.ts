import { createLogicLens } from "../sdk/client.js";

export async function askCommand(question: string, cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    console.log(await client.ask(question));
  } finally {
    await client.close();
  }
}
