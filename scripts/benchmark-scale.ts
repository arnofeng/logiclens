import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KuzuGraphDB } from "../src/graph/db.js";
import { writeGraphFactsWithKuzuAppendCopy, writeGraphFactsWithKuzuBulk, writeGraphFactsWithKuzuBulkUpsert } from "../src/graph/bulkWriter.js";
import { buildGraphFactsBatch, type GraphFactsBatch } from "../src/graph/facts.js";
import { rebuildRepoDependencies } from "../src/graph/rebuildRelations.js";
import { writeGraphFactsBatch, createBatchId } from "../src/graph/batchWriter.js";
import { listContracts, listDependencies, traceContract, traceEntity, findImpactSections } from "../src/graph/queries.js";
import { retrieveForQuestion } from "../src/rag/retrieve.js";
import { configSchema } from "../src/config/schema.js";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import { repoId } from "../src/utils/path.js";
import type { ParsedGraphFile, RepoNode } from "../src/parsers/types.js";

type WriteMode = "merge" | "bulk" | "bulk-upsert" | "batched";
type ScenarioName = "smoke" | "100-repos" | "1000-repos" | "million-evidence";

type Scenario = {
  name: ScenarioName | "custom";
  repoCount: number;
  filesPerRepo: number;
  evidencePerFile: number;
  semantic: boolean;
};

type BenchmarkOptions = Scenario & {
  writeMode: WriteMode;
  batchSize: number;
  outputJson?: string;
  outputMarkdown?: string;
  baselineJson?: string;
  regressionThreshold: number;
  keepWorkspace: boolean;
};

type TimingResult<T> = {
  label: string;
  ms: number;
  value: T;
};

type QueryBenchmark = {
  name: string;
  ms: number;
  rows: number;
  suspectedUnboundedScan: boolean;
  notes: string[];
};

const scenarioDefaults: Record<ScenarioName, Scenario> = {
  smoke: { name: "smoke", repoCount: 12, filesPerRepo: 3, evidencePerFile: 3, semantic: false },
  "100-repos": { name: "100-repos", repoCount: 100, filesPerRepo: 5, evidencePerFile: 5, semantic: false },
  "1000-repos": { name: "1000-repos", repoCount: 1000, filesPerRepo: 3, evidencePerFile: 3, semantic: false },
  "million-evidence": { name: "million-evidence", repoCount: 1000, filesPerRepo: 100, evidencePerFile: 10, semantic: false }
};

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const withEquals = process.argv.find((arg) => arg.startsWith(prefix));
  if (withEquals) return withEquals.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readInt(name: string, fallback: number): number {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid --${name}=${raw}. Expected a positive integer.`);
  return value;
}

function readFloat(name: string, fallback: number): number {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${name}=${raw}. Expected a non-negative number.`);
  return value;
}

function parseOptions(): BenchmarkOptions {
  const positional = process.argv.slice(2).filter((arg, index, args) => {
    if (arg.startsWith("--")) return false;
    const previous = args[index - 1];
    return previous === undefined || !previous.startsWith("--");
  });
  const legacyRepoCount = positional[0] !== undefined ? Number(positional[0]) : undefined;
  const legacyFilesPerRepo = positional[1] !== undefined ? Number(positional[1]) : undefined;
  const legacyWriteMode = positional[2];
  const legacyBatchSize = positional[3] !== undefined ? Number(positional[3]) : undefined;

  const scenarioName = (readArg("scenario") ?? "smoke") as ScenarioName;
  const base = scenarioDefaults[scenarioName];
  if (!base) throw new Error(`Unknown --scenario=${scenarioName}. Expected one of ${Object.keys(scenarioDefaults).join(", ")}.`);
  const repoCount = legacyRepoCount ?? readInt("repos", base.repoCount);
  const filesPerRepo = legacyFilesPerRepo ?? readInt("files-per-repo", base.filesPerRepo);
  const evidencePerFile = readInt("evidence-per-file", base.evidencePerFile);
  const writeMode = (legacyWriteMode ?? readArg("write-mode") ?? "merge") as WriteMode;
  if (!["merge", "bulk", "bulk-upsert", "batched"].includes(writeMode)) throw new Error(`Invalid write mode: ${writeMode}`);

  return {
    name: repoCount === base.repoCount && filesPerRepo === base.filesPerRepo && evidencePerFile === base.evidencePerFile ? base.name : "custom",
    repoCount,
    filesPerRepo,
    evidencePerFile,
    semantic: hasFlag("semantic") || base.semantic,
    writeMode,
    batchSize: legacyBatchSize ?? readInt("batch-size", 50),
    outputJson: readArg("json"),
    outputMarkdown: readArg("markdown"),
    baselineJson: readArg("baseline"),
    regressionThreshold: readFloat("threshold", 0.2),
    keepWorkspace: hasFlag("keep")
  };
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<TimingResult<T>> {
  const started = performance.now();
  const value = await fn();
  return { label, ms: performance.now() - started, value };
}

function sourceForFile(repoIndex: number, fileIndex: number, evidencePerFile: number): string {
  const methods = Array.from({ length: evidencePerFile }, (_, evidenceIndex) => {
    const producer = `export const route${evidenceIndex} = "/api/bench/${repoIndex}/${fileIndex}/${evidenceIndex}";`;
    const previousRepo = repoIndex > 0 ? repoIndex - 1 : repoIndex;
    const consumer = `fetch("/api/bench/${previousRepo}/${fileIndex}/${evidenceIndex}");`;
    return `${producer}\nexport function call${repoIndex}_${fileIndex}_${evidenceIndex}() { return ${consumer} }\n`;
  }).join("\n");
  return `export class Service${repoIndex}_${fileIndex} {\n  run() { return "${repoIndex}:${fileIndex}"; }\n}\n${methods}`;
}

async function createSyntheticRepos(root: string, options: Scenario): Promise<RepoNode[]> {
  const repos: RepoNode[] = [];
  const indexedAt = new Date().toISOString();
  for (let index = 0; index < options.repoCount; index += 1) {
    const name = `bench-service-${index}`;
    const repoPath = path.join(root, name);
    await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
    const dependency = index > 0 ? `"@bench/service-${index - 1}": "1.0.0"` : "";
    await fs.writeFile(path.join(repoPath, "package.json"), `{"name":"@bench/service-${index}","dependencies":{${dependency}}}`, "utf8");
    for (let fileIndex = 0; fileIndex < options.filesPerRepo; fileIndex += 1) {
      await fs.writeFile(path.join(repoPath, "src", `File${fileIndex}.ts`), sourceForFile(index, fileIndex, options.evidencePerFile), "utf8");
    }
    repos.push({ id: repoId(name), name, path: repoPath, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt });
  }
  return repos;
}

function scanSyntheticFiles(repos: RepoNode[], filesPerRepo: number): { repo: RepoNode; absolutePath: string; relativePath: string }[] {
  return repos.flatMap((repo) => Array.from({ length: filesPerRepo }, (_, fileIndex) => ({
    repo,
    absolutePath: path.join(repo.path, "src", `File${fileIndex}.ts`),
    relativePath: `src/File${fileIndex}.ts`
  })));
}

async function parseSyntheticFiles(files: ReturnType<typeof scanSyntheticFiles>): Promise<ParsedGraphFile[]> {
  const parsed: ParsedGraphFile[] = [];
  for (const file of files) {
    parsed.push(await parseSourceFile({ repoId: file.repo.id, absolutePath: file.absolutePath, relativePath: file.relativePath, language: "typescript" }));
  }
  return parsed;
}

async function writeBatched(input: {
  db: KuzuGraphDB;
  root: string;
  repos: RepoNode[];
  files: ReturnType<typeof scanSyntheticFiles>;
  options: BenchmarkOptions;
}): Promise<{ parseMs: number; factsMs: number; graphWriteMs: number; graphFacts: GraphFactsBatch }> {
  let firstBatch = true;
  let parseMs = 0;
  let factsMs = 0;
  let graphWriteMs = 0;
  let combinedFacts: GraphFactsBatch | undefined;

  for (let index = 0; index < input.repos.length; index += input.options.batchSize) {
    const batchRepos = input.repos.slice(index, index + input.options.batchSize);
    const batchFiles = input.files.filter((file) => batchRepos.some((repo) => repo.id === file.repo.id));
    const parsedTiming = await timed("parse", () => parseSyntheticFiles(batchFiles));
    parseMs += parsedTiming.ms;
    const factsTiming = await timed("fact", () => buildGraphFactsBatch({
      batchId: createBatchId(`bench:batch:${index / input.options.batchSize + 1}`),
      repos: batchRepos,
      parsedFiles: parsedTiming.value,
      semantic: input.options.semantic
    }));
    factsMs += factsTiming.ms;
    if (!combinedFacts) combinedFacts = factsTiming.value;
    else {
      combinedFacts.repos.push(...factsTiming.value.repos);
      combinedFacts.parsedFiles.push(...factsTiming.value.parsedFiles);
      combinedFacts.files.push(...factsTiming.value.files);
      combinedFacts.code.push(...factsTiming.value.code);
      combinedFacts.sections.push(...factsTiming.value.sections);
      combinedFacts.evidence.push(...factsTiming.value.evidence);
      combinedFacts.contains.push(...factsTiming.value.contains);
      combinedFacts.imports.push(...factsTiming.value.imports);
      combinedFacts.calls.push(...factsTiming.value.calls);
      combinedFacts.entities.push(...factsTiming.value.entities);
      combinedFacts.mentions.push(...factsTiming.value.mentions);
      combinedFacts.sectionDescribesRepos.push(...factsTiming.value.sectionDescribesRepos);
      combinedFacts.sectionDocumentsCode.push(...factsTiming.value.sectionDocumentsCode);
      combinedFacts.sectionReferencesFile.push(...factsTiming.value.sectionReferencesFile);
      combinedFacts.contracts.push(...factsTiming.value.contracts);
      combinedFacts.repoContracts.push(...factsTiming.value.repoContracts);
      combinedFacts.contractEntities.push(...factsTiming.value.contractEntities);
      combinedFacts.operations.push(...factsTiming.value.operations);
      combinedFacts.operationRepos.push(...factsTiming.value.operationRepos);
      combinedFacts.workflows.push(...factsTiming.value.workflows);
      combinedFacts.workflowOperations.push(...factsTiming.value.workflowOperations);
      combinedFacts.packageUsages.push(...factsTiming.value.packageUsages);
      combinedFacts.repoDependencies.push(...factsTiming.value.repoDependencies);
    }
    const writeTiming = await timed("graph-write", async () => {
      if (firstBatch) {
        await writeGraphFactsWithKuzuBulk(input.db, factsTiming.value, { stagingRoot: path.join(input.root, "staging") });
        firstBatch = false;
      } else {
        await writeGraphFactsWithKuzuAppendCopy(input.db, factsTiming.value, { stagingRoot: path.join(input.root, "staging") });
      }
    });
    graphWriteMs += writeTiming.ms;
  }
  if (!combinedFacts) throw new Error("Batched benchmark produced no graph facts.");
  return { parseMs, factsMs, graphWriteMs, graphFacts: combinedFacts };
}

function queryNotes(name: string, rows: number, ms: number): { suspectedUnboundedScan: boolean; notes: string[] } {
  const notes: string[] = [];
  let suspectedUnboundedScan = false;
  if (["stats", "listContracts", "listDependencies"].includes(name)) {
    suspectedUnboundedScan = true;
    notes.push("whole-graph aggregate/list query");
  }
  if (["traceEntity", "impactSections", "retrieveImpact"].includes(name)) {
    suspectedUnboundedScan = true;
    notes.push("contains text predicate before final limit");
  }
  if (rows === 0) notes.push("returned no rows for fixed benchmark target");
  if (ms > 1000) notes.push("slower than 1s on this run");
  return { suspectedUnboundedScan, notes };
}

async function benchmarkQuery(name: string, fn: () => Promise<unknown[] | Record<string, unknown>>): Promise<QueryBenchmark> {
  const result = await timed(name, fn);
  const rows = Array.isArray(result.value) ? result.value.length : 1;
  return { name, ms: Math.round(result.ms), rows, ...queryNotes(name, rows, result.ms) };
}

async function benchmarkQueries(db: KuzuGraphDB): Promise<QueryBenchmark[]> {
  const config = configSchema.parse({ embedding: { level: "off" } });
  return [
    await benchmarkQuery("stats", () => db.stats()),
    await benchmarkQuery("listDependencies", () => listDependencies(db, { limit: 100 })),
    await benchmarkQuery("listContracts", () => listContracts(db, { limit: 100 })),
    await benchmarkQuery("traceContract", () => traceContract(db, "api", "/api/bench/0/0/0")),
    await benchmarkQuery("traceEntity", () => traceEntity(db, "Service0", 100)),
    await benchmarkQuery("impactSections", () => findImpactSections(db, "Service0", 50)),
    await benchmarkQuery("retrieveImpact", async () => {
      const result = await retrieveForQuestion(db, "impact /api/bench/0/0/0", { config });
      return [...result.contracts, ...result.entities, ...result.dependencies, ...result.sections, ...result.code];
    })
  ];
}

async function readBaseline(filePath: string | undefined): Promise<Record<string, number>> {
  if (!filePath) return {};
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { queryBenchmarks?: QueryBenchmark[]; timings?: Record<string, number> };
  const baseline: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed.timings ?? {})) baseline[`timing:${key}`] = Number(value);
  for (const query of parsed.queryBenchmarks ?? []) baseline[`query:${query.name}`] = query.ms;
  return baseline;
}

async function writeTextFile(filePath: string | undefined, content: string): Promise<void> {
  if (!filePath) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function regressions(input: { timings: Record<string, number>; queries: QueryBenchmark[]; baseline: Record<string, number>; threshold: number }): string[] {
  const rows: string[] = [];
  for (const [key, value] of Object.entries(input.timings)) {
    const baseline = input.baseline[`timing:${key}`];
    if (baseline && value > baseline * (1 + input.threshold)) rows.push(`${key}: ${value}ms > baseline ${baseline}ms`);
  }
  for (const query of input.queries) {
    const baseline = input.baseline[`query:${query.name}`];
    if (baseline && query.ms > baseline * (1 + input.threshold)) rows.push(`${query.name}: ${query.ms}ms > baseline ${baseline}ms`);
  }
  return rows;
}

function markdownReport(report: any): string {
  const timingRows = Object.entries(report.timings).map(([name, value]) => `| ${name} | ${value} |`).join("\n");
  const queryRows = report.queryBenchmarks.map((query: QueryBenchmark) =>
    `| ${query.name} | ${query.ms} | ${query.rows} | ${query.suspectedUnboundedScan ? "yes" : "no"} | ${query.notes.join("; ")} |`
  ).join("\n");
  const regressionRows = report.regressions.length > 0 ? report.regressions.map((row: string) => `- ${row}`).join("\n") : "- none";
  return `# LogicLens Scale Benchmark

- Scenario: ${report.scenario.name}
- Repos: ${report.scenario.repoCount}
- Files per repo: ${report.scenario.filesPerRepo}
- Evidence per file target: ${report.scenario.evidencePerFile}
- Write mode: ${report.writeMode}
- Batch size: ${report.batchSize ?? "n/a"}

## Index Timings

| Metric | ms |
| --- | ---: |
${timingRows}

## Query Hotspots

| Query | ms | Rows | Suspected unbounded scan | Notes |
| --- | ---: | ---: | --- | --- |
${queryRows}

## Regressions

${regressionRows}
`;
}

async function main(): Promise<void> {
  const options = parseOptions();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-bench-"));
  const graphPath = path.join(root, "graph");
  const db = await KuzuGraphDB.open(graphPath);
  try {
    await db.initSchema("benchmark");
    const fixtureTiming = await timed("fixture", () => createSyntheticRepos(root, options));
    const repos = fixtureTiming.value;
    const scanTiming = await timed("scan", async () => scanSyntheticFiles(repos, options.filesPerRepo));
    let parseMs = 0;
    let factsMs = 0;
    let graphWriteMs = 0;
    let facts: GraphFactsBatch;

    if (options.writeMode === "batched") {
      const batched = await writeBatched({ db, root, repos, files: scanTiming.value, options });
      parseMs = batched.parseMs;
      factsMs = batched.factsMs;
      graphWriteMs = batched.graphWriteMs;
      facts = batched.graphFacts;
    } else {
      const parseTiming = await timed("parse", () => parseSyntheticFiles(scanTiming.value));
      parseMs = parseTiming.ms;
      const factsTiming = await timed("fact", () => buildGraphFactsBatch({
        batchId: createBatchId("bench"),
        repos,
        parsedFiles: parseTiming.value,
        semantic: options.semantic
      }));
      factsMs = factsTiming.ms;
      facts = factsTiming.value;
      const writeTiming = await timed("graph-write", async () => {
        if (options.writeMode === "bulk") {
          await writeGraphFactsWithKuzuBulk(db, facts, { stagingRoot: path.join(root, "staging") });
        } else if (options.writeMode === "bulk-upsert") {
          await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot: path.join(root, "staging") });
        } else {
          for (const repo of repos) await db.upsertRepo(repo);
          await writeGraphFactsBatch(db, { batchId: facts.batchId, repos, parsedFiles: facts.parsedFiles }, { semantic: options.semantic });
        }
      });
      graphWriteMs = writeTiming.ms;
    }

    const rebuildTiming = await timed("rebuild", () => rebuildRepoDependencies(db, { batchId: createBatchId("bench:deps") }));
    const queryBenchmarks = await benchmarkQueries(db);
    const stats = await db.stats();
    const memory = process.memoryUsage();
    const timings = {
      fixtureMs: Math.round(fixtureTiming.ms),
      scanMs: Math.round(scanTiming.ms),
      parseMs: Math.round(parseMs),
      factsMs: Math.round(factsMs),
      graphWriteMs: Math.round(graphWriteMs),
      rebuildMs: Math.round(rebuildTiming.ms),
      queryTotalMs: queryBenchmarks.reduce((sum, query) => sum + query.ms, 0)
    };
    const baseline = await readBaseline(options.baselineJson);
    const report = {
      generatedAt: new Date().toISOString(),
      scenario: {
        name: options.name,
        repoCount: options.repoCount,
        filesPerRepo: options.filesPerRepo,
        evidencePerFile: options.evidencePerFile,
        semantic: options.semantic,
        targetEvidence: options.repoCount * options.filesPerRepo * options.evidencePerFile
      },
      writeMode: options.writeMode,
      batchSize: options.writeMode === "batched" ? options.batchSize : undefined,
      timings,
      counts: {
        filesScanned: scanTiming.value.length,
        filesChanged: scanTiming.value.length,
        graphFiles: facts.files.length,
        codeNodes: facts.code.length,
        sectionNodes: facts.sections.length,
        evidence: facts.evidence.length,
        contracts: facts.contracts.length,
        semanticRecords: options.semantic ? facts.code.length + facts.sections.length : 0,
        dependencyEdges: rebuildTiming.value.length,
        stats
      },
      queryBenchmarks,
      resources: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024)
      },
      regressions: regressions({ timings, queries: queryBenchmarks, baseline, threshold: options.regressionThreshold }),
      workspace: options.keepWorkspace ? root : undefined
    };
    const json = JSON.stringify(report, null, 2);
    await writeTextFile(options.outputJson, json);
    await writeTextFile(options.outputMarkdown, markdownReport(report));
    console.log(json);
  } finally {
    await db.close();
    if (!options.keepWorkspace) await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
