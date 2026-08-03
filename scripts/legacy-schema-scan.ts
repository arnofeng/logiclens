import fs from "node:fs/promises";
import path from "node:path";

type Rule = { id: string; pattern: RegExp; description: string };

const rules: Rule[] = [
  { id: "schema-ref-protocol", pattern: /schema-ref:/u, description: "removed schema-ref protocol" },
  { id: "pending-schema-relation", pattern: /\b(?:PendingSchemaRelation|pendingSchemaRelation|pendingSchemaRelations)\b/u, description: "removed pending relation writer protocol" },
  { id: "extractor-compat-shim", pattern: /\bcompatExtractor\b/u, description: "removed extractor compatibility shim" },
  { id: "deprecated-extractor-types", pattern: /\b(?:ExtractorFactBundle|ExtractedRelation)\b/u, description: "removed deprecated extraction types" },
  { id: "legacy-lexical-backfill", pattern: /\b(?:LegacyFileIdentityRow|migrateFileIds|migratePayloadSizes|rebuildWorkspaceStats)\b|lexical-stats:legacy:/u, description: "removed lexical projection backfill protocol" },
  { id: "simple-name-resolver", pattern: /\b(?:WorkspaceSimpleNameResolver|GlobalSimpleNameResolver|resolveSchemaBySimpleName)\b/u, description: "removed workspace-global simple-name fallback" },
  { id: "old-schema-id-helper", pattern: /\b(?:legacySchemaSpecId|legacySchemaRootId|legacyTypeInstanceId|oldSchemaSpecId|oldSchemaRootId)\b/u, description: "removed schema identity helper" },
  { id: "suffix-only-discovery", pattern: /\b(?:suffixOnlySchema|schemaSuffixCandidate|materializeSchemaBySuffix|discoverSchemaBySuffix)\b/u, description: "removed suffix-only schema discovery" }
];

const sourceRoots = ["src", "packages/plugin-sdk/src", "packages/plugin-csharp/src"];
const artifactRoots = ["dist", "packages/plugin-sdk/dist", "packages/plugin-csharp/dist"];

async function main(): Promise<void> {
  const artifacts = process.argv.slice(2).includes("--artifacts");
  const roots = artifacts ? artifactRoots : sourceRoots;
  const missing = [];
  const files: string[] = [];
  for (const root of roots) {
    try {
      files.push(...await collect(path.resolve(root)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(root);
      else throw error;
    }
  }
  if (artifacts && missing.length > 0) throw new Error(`Production artifact scan requires a completed build; missing ${missing.join(", ")}.`);
  const violations: string[] = [];
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    for (const rule of rules) {
      if (rule.pattern.test(content)) violations.push(`${path.relative(process.cwd(), file).replaceAll("\\", "/")}: ${rule.id} (${rule.description})`);
    }
  }
  if (violations.length > 0) throw new Error(`Legacy schema scan failed:\n${violations.join("\n")}`);
  console.log(`Legacy schema ${artifacts ? "production artifact" : "source"} scan passed: ${files.length} files, ${rules.length} rules.`);
}

async function collect(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collect(absolute));
    else if (/\.(?:js|mjs|cjs|ts|d\.ts|json)$/u.test(entry.name)) result.push(absolute);
  }
  return result.sort();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
