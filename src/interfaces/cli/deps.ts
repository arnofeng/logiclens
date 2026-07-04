import type { DependencyQueryOptions } from "../../core/graph-model/queries.js";
import { createClient } from "../sdk/client.js";

export type DepsCommandOptions = DependencyQueryOptions;

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
  // Validate parameter constraints (SDK also enforces, but fail-fast at CLI level)
  if (options.direction && !options.repo) {
    throw new Error("--direction requires --repo");
  }
  if (options.target && !options.repo) {
    throw new Error("--target requires --repo");
  }

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
