import { createLogicLens } from "../sdk/client.js";

export async function impactCommand(symbolOrEntity: string, cwd = process.cwd()): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    const result = await client.impact(symbolOrEntity);
    console.log(`Potential impact for ${symbolOrEntity}:`);
    if (result.contractTrace.length > 0) {
      console.log("");
      console.log("Contract producers/consumers:");
      for (const row of result.contractTrace) console.log(`- ${row.role} ${row.repoName}/${row.filePath}:${row.line} ${row.rule} ${row.raw}`);
    }
    if (result.entityTrace.length > 0) {
      console.log("");
      console.log("Entity graph context:");
      for (const row of result.entityTrace) console.log(`- ${row.sourceKind} ${row.repoName} ${row.name} ${row.filePath}:${row.line} ${row.role}`);
    }
    console.log("");
    console.log("Matched code:");
    for (const seed of result.seeds) console.log(`- ${seed.repoName}/${seed.filePath}:${seed.qualifiedName}`);
    console.log("");
    console.log("Related call edges:");
    for (const edge of result.edges) console.log(`- ${edge.fromFile}:${edge.fromName} -> ${edge.toFile}:${edge.toName} (${edge.resolution}, confidence=${edge.confidence})`);
    console.log("");
    console.log("Related docs:");
    for (const section of result.sections) console.log(`- ${section.repoName}/${section.filePath}:${section.heading} (lines ${section.startLine}-${section.endLine})`);
    console.log("");
    console.log("Recommended files to inspect:");
    for (const file of result.recommendedFiles) console.log(`- ${file}`);
  } finally {
    await client.close();
  }
}
