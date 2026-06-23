import { createLogicLens } from "../sdk/client.js";

export async function initCommand(cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    await client.init();
    console.log("Initialized .logiclens/config.yaml");
  } finally {
    await client.close();
  }
}
