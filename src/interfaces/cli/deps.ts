import { createClient } from "../sdk/client.js";

export type DepsCommandOptions = {
  strength?: "strong" | "weak";
  type?: string;
  limit?: number;
};

export function getDependencyStrength(type: string): "Strong" | "Weak" {
  switch (type) {
    case "package":
    case "import":
    case "api":
      return "Strong";
    case "event":
    case "shared-contract":
    default:
      return "Weak";
  }
}

export async function depsCommand(options: DepsCommandOptions = {}, cwd = process.cwd()): Promise<void> {
  const client = await createClient({ cwd });
  try {
    const rows = await client.dependencies(options);
    console.log("Repo dependencies:");
    for (const row of rows) {
      const strength = getDependencyStrength(row.dependencyType);
      console.log(`- ${row.fromRepo} -> ${row.toRepo} [${strength}] [${row.dependencyType}] ${row.contractKind}:${row.contractKey}`);
      console.log(`  evidence: ${row.filePath}:${row.line} [${row.resolution}] ${row.rule} ${row.raw}`);
    }
  } finally {
    await client.close();
  }
}
