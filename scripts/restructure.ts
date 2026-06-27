/**
 * Throwaway codemod for the src/ architectural restructure.
 *
 * Uses ts-morph to move files/directories while auto-rewriting every relative
 * `.js` import specifier across src/ and tests/. Run one phase at a time:
 *
 *   npx tsx scripts/restructure.ts <phase>
 *
 * Phases are defined in PHASES below. Delete this script after the restructure.
 */
import path from "node:path";
import { Project, SourceFile, SyntaxKind } from "ts-morph";

const root = process.cwd();
// ts-morph reports file paths with forward slashes; normalize so comparisons
// work on Windows where path.resolve yields backslashes.
const abs = (p: string): string => path.resolve(root, p).replace(/\\/g, "/");

type Op =
  | { kind: "moveDir"; from: string; to: string }
  | { kind: "moveFile"; from: string; to: string }
  | { kind: "moveFilesFlat"; fromDir: string; toDir: string; except?: string[] };

const PHASES: Record<string, Op[]> = {
  shared: [
    { kind: "moveFilesFlat", fromDir: "src/utils", toDir: "src/shared" },
    { kind: "moveFile", from: "src/confidence.ts", to: "src/shared/confidence.ts" },
    { kind: "moveFile", from: "src/version.ts", to: "src/shared/version.ts" },
    { kind: "moveFile", from: "src/resilience/providerPolicy.ts", to: "src/shared/providerPolicy.ts" }
  ],
  adapters: [
    { kind: "moveDir", from: "src/graph/kuzu", to: "src/adapters/graph-db/kuzu" },
    { kind: "moveDir", from: "src/graph/neo4j", to: "src/adapters/graph-db/neo4j" },
    { kind: "moveFile", from: "src/semantic/openaiEmbeddingProvider.ts", to: "src/adapters/embeddings/openaiEmbeddingProvider.ts" },
    { kind: "moveFile", from: "src/semantic/builtinProviders.ts", to: "src/adapters/embeddings/builtinProviders.ts" }
  ],
  core: [
    { kind: "moveDir", from: "src/repos", to: "src/core/workspace" },
    { kind: "moveDir", from: "src/parsers", to: "src/core/parsing" },
    { kind: "moveFile", from: "src/languages/markdown/adapter.ts", to: "src/core/parsing/markdown/adapter.ts" },
    // code-fact extractors
    { kind: "moveFilesFlat", fromDir: "src/extractors", toDir: "src/core/extraction", except: ["crossRepoContracts.ts"] },
    // contract domain (move whole dir first so core/contracts exists)
    { kind: "moveDir", from: "src/contracts", to: "src/core/contracts" },
    // contract extraction (high-level)
    { kind: "moveFile", from: "src/extractors/crossRepoContracts.ts", to: "src/core/contracts/extraction/crossRepoContracts.ts" },
    { kind: "moveDir", from: "src/extractors/builtin", to: "src/core/contracts/extraction/builtin" },
    // golden eval joins contracts/evaluation
    { kind: "moveFile", from: "src/golden/evaluate.ts", to: "src/core/contracts/evaluation/evaluate.ts" },
    // frameworks must stay core (crossRepoContracts imports it)
    { kind: "moveDir", from: "src/frameworks", to: "src/core/frameworks" },
    // graph domain model (kuzu/neo4j already moved to adapters; quality goes to features later)
    { kind: "moveFilesFlat", fromDir: "src/graph", toDir: "src/core/graph-model", except: ["quality.ts"] },
    // indexing (types.ts + run.ts created by the manual extraction step ride along)
    { kind: "moveDir", from: "src/indexing", to: "src/core/indexing" },
    // semantic domain (providers already moved to adapters)
    { kind: "moveFilesFlat", fromDir: "src/semantic", toDir: "src/core/semantic" }
  ],
  features: [
    { kind: "moveDir", from: "src/rag", to: "src/features/ask" },
    { kind: "moveDir", from: "src/watch", to: "src/features/watch" },
    { kind: "moveFile", from: "src/graph/quality.ts", to: "src/features/quality/quality.ts" },
    { kind: "moveFile", from: "src/core/contracts/qualityRules.ts", to: "src/features/quality/qualityRules.ts" }
  ],
  interfaces: [
    { kind: "moveDir", from: "src/commands", to: "src/interfaces/cli" },
    { kind: "moveDir", from: "src/sdk", to: "src/interfaces/sdk" },
    { kind: "moveDir", from: "src/mcp", to: "src/interfaces/mcp" },
    { kind: "moveDir", from: "src/plugins", to: "src/interfaces/plugins" },
    { kind: "moveDir", from: "src/installer", to: "src/interfaces/installer" }
  ]
};

// Move a directory by relocating each source file individually. SourceFile.move
// creates destination directories on save (mkdir -p), avoiding the ENOENT that
// ts-morph's Directory.move rename hits when the destination parent is missing.
function moveDir(project: Project, from: string, to: string): void {
  const fromAbs = abs(from);
  const toAbs = abs(to);
  const files = project.getSourceFiles().filter((f: SourceFile) => {
    const p = f.getFilePath().replace(/\\/g, "/");
    return p === fromAbs || p.startsWith(`${fromAbs}/`);
  });
  if (files.length === 0) throw new Error(`No source files under directory: ${from}`);
  for (const file of files) {
    const rel = file.getFilePath().replace(/\\/g, "/").slice(fromAbs.length); // leading "/" + nested subpath
    file.move(`${toAbs}${rel}`);
  }
  console.log(`  moveDir   ${from} -> ${to} (${files.length} files)`);
}

function moveFile(project: Project, from: string, to: string): void {
  const file = project.getSourceFile(abs(from));
  if (!file) throw new Error(`File not found: ${from}`);
  file.move(abs(to));
  console.log(`  moveFile  ${from} -> ${to}`);
}

function moveFilesFlat(project: Project, fromDir: string, toDir: string, except: string[]): void {
  const fromAbs = abs(fromDir);
  const dirOf = (p: string): string => p.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
  const files = project.getSourceFiles().filter((f: SourceFile) => dirOf(f.getFilePath()) === fromAbs);
  for (const file of files) {
    const name = path.basename(file.getFilePath());
    if (except.includes(name)) continue;
    file.move(abs(path.join(toDir, name)));
    console.log(`  moveFile  ${fromDir}/${name} -> ${toDir}/${name}`);
  }
}

const KNOWN_EXT = /\.(js|json|cjs|mjs|node)$/;

function needsJs(spec: string): boolean {
  return (spec.startsWith("./") || spec.startsWith("../")) && !KNOWN_EXT.test(spec);
}

/**
 * ts-morph drops the explicit `.js` extension when it recomputes relative module
 * specifiers, which breaks NodeNext resolution. Re-append it on every relative
 * specifier that lacks a known extension (idempotent — already-correct ones are
 * skipped). Covers static import/export declarations and dynamic import() calls.
 */
function fixExtensions(project: Project): number {
  let fixed = 0;
  for (const file of project.getSourceFiles()) {
    for (const decl of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      const spec = decl.getModuleSpecifierValue();
      if (spec && needsJs(spec)) {
        decl.setModuleSpecifier(`${spec}.js`);
        fixed += 1;
      }
    }
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
      const arg = call.getArguments()[0];
      if (arg && arg.getKind() === SyntaxKind.StringLiteral) {
        const lit = arg.asKindOrThrow(SyntaxKind.StringLiteral);
        const spec = lit.getLiteralValue();
        if (needsJs(spec)) {
          lit.setLiteralValue(`${spec}.js`);
          fixed += 1;
        }
      }
    }
    // type-position imports: `import("../x").Type`
    for (const importType of file.getDescendantsOfKind(SyntaxKind.ImportType)) {
      const lit = importType.getFirstDescendantByKind(SyntaxKind.StringLiteral);
      if (lit) {
        const spec = lit.getLiteralValue();
        if (needsJs(spec)) {
          lit.setLiteralValue(`${spec}.js`);
          fixed += 1;
        }
      }
    }
  }
  return fixed;
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  const ops = phase ? PHASES[phase] : undefined;
  if (!ops) {
    console.error(`Unknown phase "${phase}". Known: ${Object.keys(PHASES).join(", ")}`);
    process.exit(1);
  }
  const project = new Project({ tsConfigFilePath: abs("tsconfig.json") });
  console.log(`Phase: ${phase}`);
  for (const op of ops) {
    if (op.kind === "moveDir") moveDir(project, op.from, op.to);
    else if (op.kind === "moveFile") moveFile(project, op.from, op.to);
    else moveFilesFlat(project, op.fromDir, op.toDir, op.except ?? []);
  }
  const fixed = fixExtensions(project);
  console.log(`  fixed ${fixed} module specifier extension(s)`);
  await project.save();
  console.log("Saved.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
