import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import type { GraphDB, GraphValue } from "../src/core/graph-model/db.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { pinPublicGraphReadSnapshot } from "../src/core/graph-model/readSnapshot.js";
import { runIndexing } from "../src/core/indexing/run.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import type { AppConfig } from "../src/config/schema.js";
import { fileId } from "../src/shared/path.js";
import { repoId } from "../src/shared/path.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function normalizeValue(value: GraphValue): GraphValue {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item as GraphValue)]));
  }
  return value;
}

function normalizedRows(rows: Array<Record<string, GraphValue>>): Array<Record<string, GraphValue>> {
  return rows
    .map((row) => normalizeValue(row) as Record<string, GraphValue>)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function publicGraphSnapshot(db: GraphDB, workspaceId: string) {
  const scope = await pinPublicGraphReadSnapshot(db, workspaceId);
  const query = (cypher: string) => db.query<Record<string, GraphValue>>(cypher, scope).then(normalizedRows);
  const [files, code, sections, entities, operations, workflows, contracts, evidence, specs,
    containsCode, containsSection, imports, calls, mentionsCode, mentionsSection, describes,
    documents, references, hasEvidence, contractMentions, participates, workflowSteps, hasSpec,
    semanticRelations] = await Promise.all([
    query("MATCH (n:File) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND (n.active IS NULL OR n.active=true) RETURN n.id AS id, n.repoId AS repoId, n.path AS path, n.directory AS directory, n.language AS language, n.hash AS hash, n.loc AS loc;"),
    query("MATCH (n:Code) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND (n.active IS NULL OR n.active=true) RETURN n.id AS id, n.repoId AS repoId, n.fileId AS fileId, n.kind AS kind, n.name AS name, n.qualifiedName AS qualifiedName, n.signature AS signature, n.hash AS hash;"),
    query("MATCH (n:Section) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND (n.active IS NULL OR n.active=true) RETURN n.id AS id, n.repoId AS repoId, n.fileId AS fileId, n.heading AS heading, n.level AS level, n.text AS text, n.hash AS hash;"),
    query("MATCH (n:Entity) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN n.id AS id, n.name AS name, n.kind AS kind, n.description AS description;"),
    query("MATCH (n:Operation) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN n.id AS id, n.verb AS verb, n.entityName AS entityName, n.description AS description;"),
    query("MATCH (n:Workflow) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN n.id AS id, n.name AS name, n.description AS description;"),
    query("MATCH (n:Contract) WHERE n.workspaceId=$workspaceId AND n.generation=$generation RETURN n.id AS id, n.kind AS kind, n.key AS key, n.name AS name, n.description AS description;"),
    query("MATCH (n:Evidence) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND (n.active IS NULL OR n.active=true) RETURN n.id AS id, n.repoId AS repoId, n.fileId AS fileId, n.filePath AS filePath, n.raw AS raw, n.rule AS rule, n.confidence AS confidence;"),
    query("MATCH (n:ContractSpec) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND (n.active IS NULL OR n.active=true) RETURN n.id AS id, n.contractId AS contractId, n.specKind AS specKind, n.repoId AS repoId, n.fileId AS fileId, n.evidenceId AS evidenceId, n.canonicalKey AS canonicalKey, n.specJson AS specJson;"),
    query("MATCH (a:File)-[r:CONTAINS]->(b:Code) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (a.active IS NULL OR a.active=true) AND (b.active IS NULL OR b.active=true) RETURN a.id AS fromId, b.id AS toId;"),
    query("MATCH (a:File)-[r:CONTAINS]->(b:Section) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (a.active IS NULL OR a.active=true) AND (b.active IS NULL OR b.active=true) RETURN a.id AS fromId, b.id AS toId;"),
    query("MATCH (a:File)-[r:IMPORTS]->(b:File) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (r.active IS NULL OR r.active=true) AND (a.active IS NULL OR a.active=true) AND (b.active IS NULL OR b.active=true) RETURN a.id AS fromId, b.id AS toId, r.module AS module, r.raw AS raw;"),
    query("MATCH (a:Code)-[r:CALLS]->(b:Code) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (r.active IS NULL OR r.active=true) AND (a.active IS NULL OR a.active=true) AND (b.active IS NULL OR b.active=true) RETURN a.id AS fromId, b.id AS toId, r.raw AS raw, r.resolution AS resolution;"),
    query("MATCH (a:Code)-[r:MENTIONS]->(b:Entity) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (a.active IS NULL OR a.active=true) RETURN a.id AS fromId, b.id AS toId, r.confidence AS confidence;"),
    query("MATCH (a:Section)-[r:MENTIONS]->(b:Entity) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (a.active IS NULL OR a.active=true) RETURN a.id AS fromId, b.id AS toId, r.confidence AS confidence;"),
    query("MATCH (a:Section)-[r:DESCRIBES]->(b:Repo) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (a.active IS NULL OR a.active=true) RETURN a.id AS fromId, b.id AS toId;"),
    query("MATCH (a:Section)-[r:DOCUMENTS]->(b:Code) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (a.active IS NULL OR a.active=true) AND (b.active IS NULL OR b.active=true) RETURN a.id AS fromId, b.id AS toId, r.confidence AS confidence;"),
    query("MATCH (a:Section)-[r:REFERENCES]->(b:File) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (a.active IS NULL OR a.active=true) AND (b.active IS NULL OR b.active=true) RETURN a.id AS fromId, b.id AS toId, r.raw AS raw;"),
    query("MATCH (a)-[r:HAS_EVIDENCE]->(b:Evidence) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (b.active IS NULL OR b.active=true) RETURN a.id AS fromId, b.id AS toId;"),
    query("MATCH (a:Contract)-[r:CONTRACT_MENTIONS]->(b:Entity) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (r.active IS NULL OR r.active=true) RETURN a.id AS fromId, b.id AS toId, r.evidenceId AS evidenceId;"),
    query("MATCH (a:Repo)-[r:PARTICIPATES_IN]->(b:Operation) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (r.active IS NULL OR r.active=true) RETURN a.id AS fromId, b.id AS toId, r.evidenceId AS evidenceId;"),
    query("MATCH (a:Workflow)-[r:WORKFLOW_STEP]->(b:Operation) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (r.active IS NULL OR r.active=true) RETURN a.id AS fromId, b.id AS toId, r.evidenceId AS evidenceId;"),
    query("MATCH (a:Contract)-[r:HAS_SPEC]->(b:ContractSpec) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (r.active IS NULL OR r.active=true) AND (b.active IS NULL OR b.active=true) RETURN a.id AS fromId, b.id AS toId, r.evidenceId AS evidenceId;"),
    query("MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec) WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND (r.active IS NULL OR r.active=true) AND (a.active IS NULL OR a.active=true) AND (b.active IS NULL OR b.active=true) RETURN a.id AS fromId, b.id AS toId, r.kind AS kind, r.evidenceId AS evidenceId;"),
  ]);
  return {
    files,
    code,
    sections,
    entities,
    operations,
    workflows,
    contracts,
    evidence,
    specs,
    containsCode,
    containsSection,
    imports,
    calls,
    mentionsCode,
    mentionsSection,
    describes,
    documents,
    references,
    hasEvidence,
    contractMentions,
    participates,
    workflowSteps,
    hasSpec,
    semanticRelations
  };
}

async function cleanFullSnapshot(directory: string, config: AppConfig, sequence: number) {
  const clean = await KuzuGraphDB.open(path.join(directory, `clean-${sequence}`));
  try {
    await clean.initSchema(config.systemName);
    await runIndexing(clean, config, { cwd: directory, writeMode: "auto" });
    return await publicGraphSnapshot(clean, deriveWorkspaceId(config.systemName));
  } finally {
    await clean.close();
  }
}

async function expectStoredStatsMatchActiveGraph(db: GraphDB, workspaceId: string): Promise<void> {
  const scope = await pinPublicGraphReadSnapshot(db, workspaceId);
  const stored = await db.readPublicGraphStats(scope);
  const computed = await db.computePublicGraphStats(scope);
  expect(stored).toBeDefined();
  expect(stored).toMatchObject(computed);
}

describe("changed-only public graph source replacement", () => {
  it("preserves exact cross-file references and converges after a touched source becomes empty", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-public-source-replacement-"));
    directories.push(directory);
    const repoPath = path.join(directory, "repo");
    const sourceDirectory = path.join(repoPath, "src");
    const modelsPath = path.join(sourceDirectory, "models.ts");
    const publisherPath = path.join(sourceDirectory, "publisher.ts");
    const readmePath = path.join(repoPath, "README.md");
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "public-source-replacement", version: "1.0.0" }), "utf8");
    await fs.writeFile(modelsPath, [
      "export interface Payload { id: string; }",
      "export function target(): string { return 'target'; }"
    ].join("\n"), "utf8");
    const publisherSource = (prefix: string) => [
      prefix,
      "import { Payload, target } from './models';",
      "export function publish(): string {",
      "  eventBus.publish<Payload>('topic.created', payload);",
      "  return target();",
      "}"
    ].join("\n");
    await fs.writeFile(publisherPath, publisherSource(""), "utf8");
    await fs.writeFile(readmePath, "# Guide\nPublisher calls target.\n\n## Details\n[models](src/models.ts)\n", "utf8");
    const config = {
      ...defaultConfig(),
      systemName: `public-source-${path.basename(directory)}`,
      repos: [{ name: "public-source-replacement", path: repoPath }]
    };
    const workspaceId = deriveWorkspaceId(config.systemName);
    const modelsFileId = fileId(repoId("public-source-replacement"), "src/models.ts");
    const publisherFileId = fileId(repoId("public-source-replacement"), "src/publisher.ts");
    const db = await KuzuGraphDB.open(path.join(directory, "graph"));
    try {
      await db.initSchema(config.systemName);
      await runIndexing(db, config, { cwd: directory, writeMode: "auto" });

      await fs.writeFile(publisherPath, publisherSource("// changed without changing references"), "utf8");
      await runIndexing(db, config, { cwd: directory, changedOnly: true, writeMode: "auto" });
      const referencesPreserved = await publicGraphSnapshot(db, workspaceId);
      expect(referencesPreserved.imports.some((edge) => edge.fromId === publisherFileId)).toBe(true);
      expect(referencesPreserved.calls.some((edge) => String(edge.fromId).includes("publish"))).toBe(true);
      expect(referencesPreserved).toEqual(await cleanFullSnapshot(directory, config, 1));

      await fs.writeFile(publisherPath, "// intentionally produces no symbols, calls, imports, or contracts\n", "utf8");
      await fs.writeFile(readmePath, "# Guide\nNo source references remain.\n", "utf8");
      await runIndexing(db, config, { cwd: directory, changedOnly: true, writeMode: "auto" });
      const replaced = await publicGraphSnapshot(db, workspaceId);
      expect(replaced.code.filter((node) => node.fileId === publisherFileId)).toEqual([]);
      expect(replaced.evidence.filter((node) => node.fileId === publisherFileId)).toEqual([]);
      expect(replaced.specs.filter((node) => node.fileId === publisherFileId)).toEqual([]);
      expect(replaced.imports.filter((edge) => edge.fromId === publisherFileId)).toEqual([]);
      expect(replaced.contracts.some((contract) => contract.key === "topic.created")).toBe(false);
      expect(replaced).toEqual(await cleanFullSnapshot(directory, config, 2));
      await expectStoredStatsMatchActiveGraph(db, workspaceId);

      const movedModelsPath = path.join(sourceDirectory, "domain", "models.ts");
      await fs.mkdir(path.dirname(movedModelsPath), { recursive: true });
      await fs.rename(modelsPath, movedModelsPath);
      await runIndexing(db, config, { cwd: directory, changedOnly: true, writeMode: "auto" });
      const movedSnapshot = await publicGraphSnapshot(db, workspaceId);
      const activeScopeAfterMove = await pinPublicGraphReadSnapshot(db, workspaceId);
      expect(await db.query(
        "MATCH (n:File) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND n.id=$id RETURN n.id AS id;",
        { ...activeScopeAfterMove, id: modelsFileId }
      )).toEqual([]);
      expect(movedSnapshot).toEqual(await cleanFullSnapshot(directory, config, 3));
      await expectStoredStatsMatchActiveGraph(db, workspaceId);

      const movedModelsFileId = fileId(repoId("public-source-replacement"), "src/domain/models.ts");
      await fs.rm(movedModelsPath);
      await runIndexing(db, config, { cwd: directory, changedOnly: true, writeMode: "auto" });
      const deletedSnapshot = await publicGraphSnapshot(db, workspaceId);
      const activeScopeAfterDelete = await pinPublicGraphReadSnapshot(db, workspaceId);
      expect(await db.query(
        "MATCH (n:File) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND n.id=$id RETURN n.id AS id;",
        { ...activeScopeAfterDelete, id: movedModelsFileId }
      )).toEqual([]);
      expect(deletedSnapshot).toEqual(await cleanFullSnapshot(directory, config, 4));
      await expectStoredStatsMatchActiveGraph(db, workspaceId);
    } finally {
      await db.close();
    }
  }, 90_000);
});
