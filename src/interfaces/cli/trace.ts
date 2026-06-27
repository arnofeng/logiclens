import { createLogicLens } from "../sdk/client.js";

export async function traceCommand(target: string, cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    const result = await client.trace(target);
    if (result.type === "contract") {
      console.log(`Contract trace for ${target}:`);
      for (const row of result.rows) {
        console.log(`- ${row.role} ${row.repoName} ${row.filePath}:${row.line} [${row.resolution}] ${row.rule} ${row.raw}`);
      }
    } else {
      console.log(`Entity trace for ${target}:`);
      for (const row of result.rows) {
        console.log(`- ${row.sourceKind} ${row.repoName} ${row.name} ${row.filePath}:${row.line} ${row.role} ${row.evidence.slice(0, 120)}`);
      }
    }
  } finally {
    await client.close();
  }
}
