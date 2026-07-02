import { createClient } from "../sdk/client.js";

export async function askCommand(question: string, cwd = process.cwd()): Promise<void> {
  const client = await createClient({ cwd });
  try {
    console.log(await client.ask(question));
  } finally {
    await client.close();
  }
}
