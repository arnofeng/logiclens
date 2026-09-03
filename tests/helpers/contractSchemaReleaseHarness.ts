import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../../src/config/schema.js";
import { defaultConfig } from "../../src/config/loadConfig.js";
import type { GraphDB, GraphValue } from "../../src/core/graph-model/db.js";
import { runIndexing } from "../../src/core/indexing/run.js";
import { deriveWorkspaceId } from "../../src/core/workspace/identity.js";
import { captureSchemaBaselineSnapshot, type SchemaBaselineSnapshot } from "./schemaBaselineSnapshot.js";

type GroundTruth = {
  roots: string[];
  schemaCanonicalNames: string[];
  relations: string[];
  forbiddenSchemas: string[];
  forbiddenRelations: string[];
  diagnostics: string[];
};

type Manifest = {
  repositories: Array<{ name: string; path: string }>;
  mutations: { renameFrom: string; renameTo: string; deleteSharedRoot: string; deleteLastRoot: string };
};

export type ContractSchemaReleaseResult = {
  initial: SchemaBaselineSnapshot;
  logical: ReturnType<typeof logicalSnapshot>;
  final: SchemaBaselineSnapshot;
};

const fixtureDirectory = path.resolve("tests/fixtures/contract-schema-release");

export async function prepareContractSchemaReleaseCorpus(): Promise<{
  directory: string;
  config: AppConfig;
  groundTruth: GroundTruth;
  manifest: Manifest;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-contract-schema-release-"));
  await fs.cp(fixtureDirectory, directory, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as Manifest;
  const groundTruth = JSON.parse(await fs.readFile(path.join(directory, "ground-truth.json"), "utf8")) as GroundTruth;
  const base = defaultConfig();
  const config: AppConfig = {
    ...base,
    systemName: "contract-schema-release",
    repos: manifest.repositories.map((repo) => ({ name: repo.name, path: path.join(directory, repo.path) })),
    indexing: { ...base.indexing, batchSize: 0, llmSummaryLevel: "off" }
  };
  return { directory, config, groundTruth, manifest };
}

export async function runContractSchemaReleaseConformance(input: {
  db: GraphDB;
  corpusDirectory: string;
  config: AppConfig;
  groundTruth: GroundTruth;
  manifest: Manifest;
}): Promise<ContractSchemaReleaseResult> {
  const workspaceId = deriveWorkspaceId(input.config.systemName);
  await runIndexing(input.db, input.config, { cwd: input.corpusDirectory, writeMode: "auto" });
  let generation = await currentGeneration(input.db, workspaceId);
  const initial = await captureSchemaBaselineSnapshot(input.db, workspaceId);
  const logical = logicalSnapshot(initial);
  assertGroundTruth(logical, input.groundTruth);
  await assertNoOrphans(input.db, workspaceId, generation);

  const sharedRoot = path.join(input.corpusDirectory, input.manifest.mutations.deleteSharedRoot);
  const lastRoot = path.join(input.corpusDirectory, input.manifest.mutations.deleteLastRoot);
  const sharedSource = await fs.readFile(sharedRoot, "utf8");
  const lastSource = await fs.readFile(lastRoot, "utf8");
  await fs.rm(sharedRoot);
  await runIndexing(input.db, input.config, { cwd: input.corpusDirectory, writeMode: "auto", changedOnly: true });
  generation = await currentGeneration(input.db, workspaceId);
  let snapshot = await captureSchemaBaselineSnapshot(input.db, workspaceId);
  assert(schemaNames(snapshot).includes("AuditRecord"), "shared SchemaSpec was collected while one root still contributed");
  await assertNoOrphans(input.db, workspaceId, generation);

  await fs.rm(lastRoot);
  await runIndexing(input.db, input.config, { cwd: input.corpusDirectory, writeMode: "auto", changedOnly: true });
  generation = await currentGeneration(input.db, workspaceId);
  snapshot = await captureSchemaBaselineSnapshot(input.db, workspaceId);
  assert(!schemaNames(snapshot).includes("AuditRecord"), "last contribution did not garbage-collect its SchemaSpec");
  await assertNoOrphans(input.db, workspaceId, generation);

  await fs.writeFile(sharedRoot, sharedSource, "utf8");
  await fs.writeFile(lastRoot, lastSource, "utf8");
  await applyReleaseFinalMutation(input.corpusDirectory, input.manifest);
  await runIndexing(input.db, input.config, { cwd: input.corpusDirectory, writeMode: "auto", changedOnly: true });
  generation = await currentGeneration(input.db, workspaceId);
  const final = await captureSchemaBaselineSnapshot(input.db, workspaceId);
  await assertNoOrphans(input.db, workspaceId, generation);
  await assertGenerationAlignment(input.db, workspaceId, generation);
  return { initial, logical, final };
}

export async function applyReleaseFinalMutation(directory: string, manifest: Manifest): Promise<void> {
  const lastRoot = path.join(directory, manifest.mutations.deleteLastRoot);
  const sharedRoot = path.join(directory, manifest.mutations.deleteSharedRoot);
  const [lastSource, sharedSource] = await Promise.all([fs.readFile(lastRoot, "utf8"), fs.readFile(sharedRoot, "utf8")]);
  const renameFrom = path.join(directory, manifest.mutations.renameFrom);
  const renameTo = path.join(directory, manifest.mutations.renameTo);
  await fs.mkdir(path.dirname(renameTo), { recursive: true });
  await fs.rename(renameFrom, renameTo);
  await fs.writeFile(lastRoot, lastSource.replace("./contracts.js", "./domain/contracts.js").replace("release.audit\", audit", "release.audit.v2\", audit"), "utf8");
  await fs.writeFile(sharedRoot, sharedSource.replace("./contracts.js", "./domain/contracts.js"), "utf8");
}

export function logicalSnapshot(snapshot: SchemaBaselineSnapshot) {
  const specs = new Map<string, { label: string; kind: string; schemaName?: string }>();
  for (const row of snapshot.publicGraph.contractSpecs) {
    if (typeof row.id !== "string" || typeof row.specKind !== "string" || typeof row.specJson !== "string") continue;
    const json = JSON.parse(row.specJson) as Record<string, unknown>;
    const schemaName = row.specKind === "schema"
      ? ((json.declaration as { canonicalName?: string } | undefined)?.canonicalName ?? String(json.displayName ?? ""))
      : undefined;
    const key = String(row.canonicalKey ?? json.fullName ?? json.topic ?? "");
    specs.set(row.id, { label: row.specKind === "schema" ? `schema:${schemaName}` : `${row.specKind}:${key}`, kind: row.specKind, schemaName });
  }
  const roots = snapshot.internalIndex.roots.items.flatMap((row) => parsePayload(row.payload)).map((root) => {
    const owner = specs.get(String(root.ownerSpecId));
    const slot = root.slot as { index?: number; name?: string } | undefined;
    return `${owner?.label ?? String(root.ownerSpecId)}|${String(root.relationKind)}|${String(root.rawTypeExpression)}|${slot?.index ?? ""}:${slot?.name ?? ""}`;
  }).sort();
  const relations = snapshot.publicGraph.semanticRelations.map((row) => {
    const from = specs.get(String(row.fromSpecId))?.label ?? String(row.fromSpecId);
    const to = specs.get(String(row.toSpecId))?.label ?? String(row.toSpecId);
    return `${from}|${String(row.kind)}|${to}`;
  }).sort();
  const diagnostics = snapshot.internalIndex.diagnostics.items.flatMap((row) => parsePayload(row.payload)).map((item) => {
    const owner = specs.get(String(item.ownerSpecId));
    const fieldPath = Array.isArray(item.fieldPath) ? item.fieldPath.map(String).join(".") : "";
    const limit = item.limit as { kind?: unknown; value?: unknown } | undefined;
    const limitIdentity = limit ? `${String(limit.kind ?? "")}:${String(limit.value ?? "")}` : "";
    return `${owner?.label ?? String(item.ownerSpecId)}|${String(item.code)}|${String(item.symbol ?? "")}|${fieldPath}|${limitIdentity}`;
  }).sort();
  return {
    roots,
    schemaCanonicalNames: [...specs.values()].flatMap((spec) => spec.schemaName ? [spec.schemaName] : []).sort(),
    relations,
    diagnostics,
    specLabelsById: specs
  };
}

function assertGroundTruth(logical: ReturnType<typeof logicalSnapshot>, groundTruth: GroundTruth): void {
  assert.deepEqual(logical.roots, sorted(groundTruth.roots), "release roots differ from the complete ground truth");
  assert.deepEqual(logical.schemaCanonicalNames, sorted(groundTruth.schemaCanonicalNames), "release SchemaSpecs differ from the complete ground truth");
  assert.deepEqual(logical.relations, sorted(groundTruth.relations), "release semantic relations differ from the complete ground truth");
  assert.deepEqual(logical.diagnostics, sorted(groundTruth.diagnostics), "release diagnostics differ from the complete ground truth");
  for (const forbidden of groundTruth.forbiddenSchemas) assert(!logical.schemaCanonicalNames.includes(forbidden), `forbidden SchemaSpec exists: ${forbidden}`);
  for (const forbidden of groundTruth.forbiddenRelations) assert(!logical.relations.some((item) => item.includes(forbidden)), `forbidden semantic relation exists: ${forbidden}`);
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

async function assertNoOrphans(db: GraphDB, workspaceId: string, generation: string): Promise<void> {
  const checks = [
    "MATCH (c:SchemaContribution) WHERE c.generation=$generation AND NOT EXISTS { MATCH (r:SchemaRootFact) WHERE r.generation=$generation AND (r.rootReferenceId=c.rootReferenceId OR c.rootReferenceId STARTS WITH 'declaration:') } RETURN count(c) AS count"
  ];
  for (const cypher of checks) {
    const rows = await db.query<{ count?: GraphValue }>(cypher, cypher.includes("$workspaceId") ? { workspaceId, generation } : { generation });
    assert.equal(Number(rows[0]?.count ?? 0), 0, `orphan scan failed: ${cypher}`);
  }
}

function parsePayload(value: GraphValue | undefined): Array<Record<string, unknown>> {
  if (typeof value !== "string") return [];
  return [JSON.parse(value) as Record<string, unknown>];
}

function schemaNames(snapshot: SchemaBaselineSnapshot): string[] {
  return logicalSnapshot(snapshot).schemaCanonicalNames;
}

async function currentGeneration(db: GraphDB, workspaceId: string): Promise<string> {
  const rows = await db.query<{ activeGeneration?: GraphValue }>(
    "MATCH (n:SchemaGenerationState {id:$id}) RETURN n.activeGeneration AS activeGeneration;",
    { id: `schema-generation-state:${workspaceId}` }
  );
  const value = rows[0]?.activeGeneration;
  assert(typeof value === "string" && value.length > 0, "active generation is missing");
  return value;
}

async function assertGenerationAlignment(db: GraphDB, workspaceId: string, generation: string): Promise<void> {
  for (const label of ["Contract", "ContractSpec"]) {
    const rows = await db.query<{ generations?: GraphValue }>(
      `MATCH (n:${label}) WHERE n.workspaceId=$workspaceId RETURN collect(DISTINCT n.generation) AS generations;`,
      { workspaceId }
    );
    assert.deepEqual(rows[0]?.generations, [generation], `${label} diverged from the active generation`);
  }
}
