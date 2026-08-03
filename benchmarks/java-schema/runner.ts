import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { x as extractTarball } from "tar";
import { KuzuGraphDB } from "../../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { defaultConfig } from "../../src/config/loadConfig.js";
import { runIndexing } from "../../src/core/indexing/run.js";
import { deriveWorkspaceId } from "../../src/core/workspace/identity.js";
import type { GraphValue } from "../../src/core/graph-model/db.js";

type Manifest = {
  fixtureVersion: string;
  manifestVersion: string;
  repositoryUrl: string;
  archiveUrl: string;
  commitSha: string;
  archiveSha256: string;
  approvedBaselineVersion: string;
  runnerProfile: string;
  maxDepth: number;
  maxTypesPerRoot: number;
  scenarios: string[];
};

type Sample = {
  durationMs: number;
  peakRssBytes: number;
  persistentIndexBytes: number;
  counts: { publicGraph: number; internalFacts: number; lexicalDocuments: number; roots: number; semanticRelations: number; diagnostics: number };
};

type SampleRequest = {
  fixture: string;
  manifest: Manifest;
  scratch: string;
  name: string;
};

const root = process.cwd();
const manifestPath = path.resolve("benchmarks/java-schema/manifest.json");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--sample-worker") {
    const requestPath = args[1];
    const resultPath = args[2];
    if (!requestPath || !resultPath) throw new Error("Benchmark sample worker requires request and result paths.");
    await runSampleWorker(requestPath, resultPath);
    return;
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Manifest;
  validateManifest(manifest);
  const smoke = args.includes("--smoke");
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-java-schema-benchmark-"));
  try {
    const fixture = await resolveFixture(args, manifest, scratch);
    if (!smoke) await runSample(fixture, manifest, scratch, "warmup");
    const measured: Sample[] = [];
    for (let index = 0; index < (smoke ? 1 : 5); index += 1) measured.push(await runSample(fixture, manifest, scratch, `sample-${index + 1}`));
    const report = {
      reportVersion: "1",
      createdAt: new Date().toISOString(),
      smoke,
      runnerProfile: manifest.runnerProfile,
      fixtureVersion: manifest.fixtureVersion,
      manifestVersion: manifest.manifestVersion,
      commitSha: manifest.commitSha,
      approvedBaselineVersion: manifest.approvedBaselineVersion,
      maxDepth: manifest.maxDepth,
      maxTypesPerRoot: manifest.maxTypesPerRoot,
      warmupRuns: smoke ? 0 : 1,
      measuredRuns: measured.length,
      median: {
        durationMs: median(measured.map((sample) => sample.durationMs)),
        peakRssBytes: median(measured.map((sample) => sample.peakRssBytes)),
        persistentIndexBytes: median(measured.map((sample) => sample.persistentIndexBytes)),
        counts: measured[0]!.counts
      },
      samples: measured
    };
    const output = option(args, "--output") ?? path.resolve("benchmark-results/java-schema");
    await fs.mkdir(output, { recursive: true });
    const suffix = smoke ? "smoke" : manifest.commitSha.slice(0, 12);
    const jsonPath = path.join(output, `report-${suffix}.json`);
    const textPath = path.join(output, `report-${suffix}.txt`);
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const summary = [
      `Java schema benchmark (${report.runnerProfile}, commit ${report.commitSha})`,
      `fixture=${report.fixtureVersion} samples=${report.measuredRuns} smoke=${report.smoke}`,
      `median duration=${report.median.durationMs.toFixed(1)}ms peakRSS=${formatBytes(report.median.peakRssBytes)} index=${formatBytes(report.median.persistentIndexBytes)}`,
      `counts public=${report.median.counts.publicGraph} internal=${report.median.counts.internalFacts} lexical=${report.median.counts.lexicalDocuments} roots=${report.median.counts.roots} relations=${report.median.counts.semanticRelations} diagnostics=${report.median.counts.diagnostics}`,
      `json=${path.relative(root, jsonPath).replaceAll("\\", "/")}`
    ].join("\n");
    await fs.writeFile(textPath, `${summary}\n`, "utf8");
    console.log(summary);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function resolveFixture(args: string[], manifest: Manifest, scratch: string): Promise<string> {
  const fixture = option(args, "--fixture");
  if (fixture) return path.resolve(fixture);
  const archive = option(args, "--archive");
  if (!archive) throw new Error("Provide --fixture <extracted-path> or --archive <pinned-archive>.");
  const archivePath = path.resolve(archive);
  if (args.includes("--download")) {
    const response = await fetch(manifest.archiveUrl);
    if (!response.ok) throw new Error(`Pinned archive download failed: ${response.status} ${response.statusText}`);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256").update(await fs.readFile(archivePath)).digest("hex");
  if (digest !== manifest.archiveSha256) throw new Error(`Archive SHA-256 mismatch: expected ${manifest.archiveSha256}, got ${digest}.`);
  const extraction = path.join(scratch, "fixture");
  await fs.mkdir(extraction);
  await extractTarball({ file: archivePath, cwd: extraction });
  const entries = await fs.readdir(extraction, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  return directories.length === 1 ? path.join(extraction, directories[0]!.name) : extraction;
}

async function runSample(fixture: string, manifest: Manifest, scratch: string, name: string): Promise<Sample> {
  const requestPath = path.join(scratch, `${name}-request.json`);
  const resultPath = path.join(scratch, `${name}-result.json`);
  await fs.writeFile(requestPath, JSON.stringify({ fixture, manifest, scratch, name } satisfies SampleRequest), "utf8");
  const child = spawn(process.execPath, [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    "--sample-worker",
    requestPath,
    resultPath
  ], { stdio: ["ignore", "inherit", "inherit"] });
  if (!child.pid) throw new Error(`Unable to start isolated benchmark process for ${name}.`);
  const peakRss = monitorChildPeakRss(child);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const peakRssBytes = await peakRss;
  if (exitCode !== 0) throw new Error(`Isolated benchmark process ${name} exited with code ${String(exitCode)}.`);
  if (peakRssBytes <= 0) throw new Error(`Unable to observe RSS for isolated benchmark process ${name}.`);
  const sample = JSON.parse(await fs.readFile(resultPath, "utf8")) as Sample;
  return { ...sample, peakRssBytes };
}

async function runSampleWorker(requestPath: string, resultPath: string): Promise<void> {
  const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as SampleRequest;
  const sample = await executeSample(request.fixture, request.manifest, request.scratch, request.name);
  await fs.writeFile(resultPath, JSON.stringify(sample), "utf8");
}

async function executeSample(fixture: string, manifest: Manifest, scratch: string, name: string): Promise<Sample> {
  const graphPath = path.join(scratch, name, "graph");
  await fs.mkdir(path.dirname(graphPath), { recursive: true });
  const db = await KuzuGraphDB.open(graphPath);
  const base = defaultConfig();
  const systemName = `java-schema-benchmark-${name}`;
  const config = {
    ...base,
    systemName,
    repos: [{ name: "spring-petclinic", path: fixture }],
    embedding: { ...base.embedding, level: "off" as const },
    indexing: { ...base.indexing, llmSummaryLevel: "off" as const }
  };
  const started = performance.now();
  try {
    await db.initSchema(systemName);
    await runIndexing(db, config, { cwd: fixture, writeMode: "auto" });
    const workspaceId = deriveWorkspaceId(systemName);
    const state = await db.query<{ generation?: GraphValue }>("MATCH (n:SchemaGenerationState {id:$id}) RETURN n.activeGeneration AS generation;", { id: `schema-generation-state:${workspaceId}` });
    const generation = String(state[0]?.generation ?? "");
    const count = async (cypher: string, params: Record<string, GraphValue>): Promise<number> => Number((await db.query<{ count?: GraphValue }>(cypher, params))[0]?.count ?? 0);
    const publicLabels = ["Contract", "ContractSpec"];
    const internalLabels = ["TypeDeclarationFact", "ResolutionContextFact", "ResolutionScopeDependencyFact", "SchemaRootFact", "SchemaDependencyFact", "SchemaContribution", "SchemaProvenanceFact", "SchemaDiagnosticFact", "SchemaBehaviorFingerprintFact"];
    const publicCounts = await Promise.all(publicLabels.map((label) => count(`MATCH (n:${label}) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN count(n) AS count;`, { workspaceId, generation })));
    const internalCounts = await Promise.all(internalLabels.map((label) => count(`MATCH (n:${label}) WHERE n.generation=$generation RETURN count(n) AS count;`, { generation })));
    const roots = await count("MATCH (n:SchemaRootFact) WHERE n.generation=$generation RETURN count(n) AS count;", { generation });
    const diagnostics = await count("MATCH (n:SchemaDiagnosticFact) WHERE n.generation=$generation RETURN count(n) AS count;", { generation });
    const lexicalDocuments = await count("MATCH (n:LexicalDocument) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN count(n) AS count;", { workspaceId, generation });
    const semanticRelations = await count("MATCH (:ContractSpec)-[r:SEMANTIC_REL]->(:ContractSpec) WHERE r.workspaceId=$workspaceId AND r.generation=$generation RETURN count(r) AS count;", { workspaceId, generation });
    await db.close();
    return {
      durationMs: performance.now() - started,
      peakRssBytes: 0,
      persistentIndexBytes: await directorySize(path.dirname(graphPath)),
      counts: { publicGraph: publicCounts.reduce(sum, 0) + semanticRelations, internalFacts: internalCounts.reduce(sum, 0), lexicalDocuments, roots, semanticRelations, diagnostics }
    };
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}

function monitorChildPeakRss(child: ChildProcess): Promise<number> {
  const childPid = child.pid;
  if (!childPid) return Promise.resolve(0);
  if (process.platform === "win32") return monitorWindowsRss(child, childPid);

  let peak = 0;
  let sampling = false;
  const sample = async (): Promise<void> => {
    if (sampling) return;
    sampling = true;
    try {
      if (process.platform === "linux") {
        const status = await fs.readFile(`/proc/${childPid}/status`, "utf8");
        const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
        if (match) peak = Math.max(peak, Number(match[1]) * 1024);
      } else {
        const rss = await execFileText("ps", ["-o", "rss=", "-p", String(childPid)]);
        peak = Math.max(peak, Number(rss.trim()) * 1024 || 0);
      }
    } catch {
      // The process may exit between two samples.
    } finally {
      sampling = false;
    }
  };
  void sample();
  const timer = setInterval(() => void sample(), 20);
  return new Promise((resolve) => child.once("close", () => {
    clearInterval(timer);
    void sample().finally(() => resolve(peak));
  }));
}

function monitorWindowsRss(child: ChildProcess, childPid: number): Promise<number> {
  const command = [
    `$targetProcessId = ${childPid}`,
    "while ($true) {",
    "  $targetProcess = Get-Process -Id $targetProcessId -ErrorAction SilentlyContinue",
    "  if ($null -eq $targetProcess) { break }",
    "  [Console]::Out.WriteLine($targetProcess.WorkingSet64)",
    "  Start-Sleep -Milliseconds 20",
    "}"
  ].join("\n");
  const monitor = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  let peak = 0;
  let pending = "";
  monitor.stdout?.setEncoding("utf8");
  monitor.stdout?.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) peak = Math.max(peak, Number(line.trim()) || 0);
  });
  return new Promise((resolve) => child.once("close", () => {
    if (pending.trim()) peak = Math.max(peak, Number(pending.trim()) || 0);
    const finish = (): void => resolve(peak);
    if (monitor.exitCode !== null) finish();
    else {
      monitor.once("close", finish);
      setTimeout(() => {
        if (monitor.exitCode === null) monitor.kill();
      }, 100);
    }
  }));
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { encoding: "utf8" }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  }));
}

function validateManifest(manifest: Manifest): void {
  if (!/^[0-9a-f]{40}$/u.test(manifest.commitSha)) throw new Error("Benchmark commitSha must be a full fixed SHA.");
  if (!/^[0-9a-f]{64}$/u.test(manifest.archiveSha256)) throw new Error("Benchmark archiveSha256 must be a fixed SHA-256.");
  if (!manifest.archiveUrl.includes(manifest.commitSha)) throw new Error("Benchmark archive URL must embed the fixed commit SHA.");
  if (manifest.maxDepth <= 0 || manifest.maxTypesPerRoot <= 0) throw new Error("Benchmark adapter limits must be positive.");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function sum(left: number, right: number): number { return left + right; }
function formatBytes(value: number): string { return `${(value / 1024 / 1024).toFixed(1)} MiB`; }

async function directorySize(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => entry.isDirectory()
    ? directorySize(path.join(directory, entry.name))
    : (await fs.stat(path.join(directory, entry.name))).size));
  return sizes.reduce(sum, 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
