import { createLogicLens } from "../sdk/client.js";

export type ExplainDepsOptions = {
  kind?: string;
};

export async function explainDepsCommand(
  sourceRepo: string,
  targetRepo: string,
  options: ExplainDepsOptions = {},
  cwd = process.cwd()
): Promise<void> {
  const client = await createLogicLens({ cwd });
  try {
    const result = await client.explainDeps(sourceRepo, targetRepo);

    if (result.relations.length === 0) {
      console.log(`No semantic relations found between "${sourceRepo}" and "${targetRepo}".`);
      return;
    }

    let filtered = result.relations;
    if (options.kind) {
      filtered = filtered.filter((r) => r.kind === options.kind);
    }

    console.log(`Semantic relations from "${sourceRepo}" to "${targetRepo}":`);
    console.log(`Found ${filtered.length} relation(s):\n`);

    for (const rel of filtered) {
      console.log(`  [${rel.kind}] ${rel.fromContractKey} → ${rel.toContractKey}`);
      console.log(`    Reason: ${rel.reason}`);
      console.log(`    Confidence: ${rel.confidence}`);
      console.log(`    From spec: ${rel.fromSpecKind} (${rel.fromSpecId})`);
      console.log(`    To spec:   ${rel.toSpecKind} (${rel.toSpecId})`);
      console.log();
    }
  } finally {
    await client.close();
  }
}
