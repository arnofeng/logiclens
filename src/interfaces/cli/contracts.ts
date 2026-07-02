import { createClient } from "../sdk/client.js";

export type ContractsCommandOptions = {
  kind?: string;
  limit?: number;
};

export async function contractsCommand(options: ContractsCommandOptions = {}, cwd = process.cwd()): Promise<void> {
  const client = await createClient({ cwd });
  try {
    const rows = await client.contracts(options);
    console.log("Contracts:");
    for (const row of rows) {
      console.log(`- ${row.kind}:${row.key} producers=${row.producers} consumers=${row.consumers} shared=${row.shared}`);
    }
  } finally {
    await client.close();
  }
}
