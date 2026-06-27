import path from "node:path";
import fs from "node:fs/promises";
import type { GraphDB } from "./db.js";
import type { CsvTableName } from "./csvStaging.js";
import { stageGraphFactsAsCsv, type CsvStagingResult } from "./csvStaging.js";
import type { GraphFactsBatch } from "./facts.js";
import { systemId } from "./schema.js";
import type { ProgressReporter } from "../utils/progress.js";

export type KuzuBulkWriteResult = {
  staging: CsvStagingResult;
  copiedTables: CsvTableName[];
};

export type KuzuBulkUpsertResult = {
  staging: CsvStagingResult;
  upsertedTables: CsvTableName[];
};

export type KuzuBulkAppendResult = {
  staging: CsvStagingResult;
  upsertedNodeTables: CsvTableName[];
  copiedRelationTables: CsvTableName[];
};

export type KuzuBulkWriteOptions = {
  stagingRoot: string;
  requireEmpty?: boolean;
  progress?: ProgressReporter;
};

export type KuzuBulkUpsertOptions = {
  stagingRoot: string;
  progress?: ProgressReporter;
};

const COPY_ORDER: CsvTableName[] = [
  "Repo",
  "File",
  "Code",
  "Section",
  "Entity",
  "Operation",
  "Workflow",
  "Contract",
  "ContractSpec",
  "Evidence",
  "IMPORTS",
  "CALLS",
  "DESCRIBES",
  "DOCUMENTS",
  "REFERENCES",
  "OWNS_PACKAGE",
  "PRODUCES",
  "CONSUMES",
  "SHARES_CONTRACT",
  "CONTRACT_MENTIONS",
  "PARTICIPATES_IN",
  "WORKFLOW_STEP",
  "USES_PACKAGE",
  "DEPENDS_ON",
  "HAS_SPEC",
  "SEMANTIC_REL"
];

type PairCopyTable = "CONTAINS" | "MENTIONS" | "HAS_EVIDENCE";
type PairCopySpec = {
  table: PairCopyTable;
  from: string;
  to: string;
  rows: Array<Array<string | number | boolean>>;
};

function toKuzuPath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/").replace(/"/g, '\\"');
}

function csvValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function writePairCsv(stagingDir: string, spec: PairCopySpec): Promise<string | undefined> {
  if (spec.rows.length === 0) return undefined;
  const filePath = path.join(stagingDir, `${spec.table}_${spec.from}_${spec.to}.csv`);
  await fs.writeFile(filePath, spec.rows.map((row) => row.map(csvValue).join(",")).join("\n"), "utf8");
  return filePath;
}

function pairCopySpecs(facts: GraphFactsBatch): PairCopySpec[] {
  return [
    { table: "CONTAINS", from: "System", to: "Repo", rows: facts.repos.map((repo) => [systemId, repo.id]) },
    { table: "CONTAINS", from: "Repo", to: "File", rows: facts.contains.filter((edge) => edge.fromId.startsWith("repo:") && edge.toId.startsWith("file:")).map((edge) => [edge.fromId, edge.toId]) },
    { table: "CONTAINS", from: "File", to: "Code", rows: facts.contains.filter((edge) => edge.fromId.startsWith("file:") && edge.toId.startsWith("code:")).map((edge) => [edge.fromId, edge.toId]) },
    { table: "CONTAINS", from: "File", to: "Section", rows: facts.contains.filter((edge) => edge.fromId.startsWith("file:") && edge.toId.startsWith("section:")).map((edge) => [edge.fromId, edge.toId]) },
    { table: "MENTIONS", from: "Code", to: "Entity", rows: facts.mentions.filter((edge) => edge.sourceKind === "code").map((edge) => [edge.fromId, edge.entityId, edge.confidence]) },
    { table: "MENTIONS", from: "Section", to: "Entity", rows: facts.mentions.filter((edge) => edge.sourceKind === "section").map((edge) => [edge.fromId, edge.entityId, edge.confidence]) },
    { table: "HAS_EVIDENCE", from: "Contract", to: "Evidence", rows: facts.repoContracts.map((edge) => [edge.contractId, edge.evidenceId]) },
    { table: "HAS_EVIDENCE", from: "Repo", to: "Evidence", rows: facts.evidence.map((evidence) => [evidence.repoId, evidence.id]) }
  ];
}

type NodeUpsertSpec = {
  table: CsvTableName;
  aliases: string[];
  idAlias: string;
  properties: string[];
};

type RelationUpsertSpec = {
  table: CsvTableName;
  from: string;
  to: string;
  aliases: string[];
  fromAlias: string;
  toAlias: string;
  mergeProperties?: string[];
  setProperties?: string[];
};

const NODE_UPSERT_SPECS: NodeUpsertSpec[] = [
  { table: "Repo", aliases: ["id", "name", "path", "remoteUrl", "branch", "commitSha", "language", "indexedAt", "summary"], idAlias: "id", properties: ["name", "path", "remoteUrl", "branch", "commitSha", "language", "indexedAt", "summary"] },
  { table: "File", aliases: ["id", "repoId", "path", "language", "hash", "loc", "batchId", "indexedAt", "active"], idAlias: "id", properties: ["repoId", "path", "language", "hash", "loc", "batchId", "indexedAt", "active"] },
  { table: "Code", aliases: ["id", "repoId", "fileId", "kind", "name", "qualifiedName", "startLine", "endLine", "signature", "summary", "hash", "batchId", "indexedAt", "active"], idAlias: "id", properties: ["repoId", "fileId", "kind", "name", "qualifiedName", "startLine", "endLine", "signature", "summary", "hash", "batchId", "indexedAt", "active"] },
  { table: "Section", aliases: ["id", "repoId", "fileId", "heading", "level", "startLine", "endLine", "text", "summary", "hash", "batchId", "indexedAt", "active"], idAlias: "id", properties: ["repoId", "fileId", "heading", "level", "startLine", "endLine", "text", "summary", "hash", "batchId", "indexedAt", "active"] },
  { table: "Entity", aliases: ["id", "name", "kind", "description"], idAlias: "id", properties: ["name", "kind", "description"] },
  { table: "Operation", aliases: ["id", "verb", "entityName", "description"], idAlias: "id", properties: ["verb", "entityName", "description"] },
  { table: "Workflow", aliases: ["id", "name", "description"], idAlias: "id", properties: ["name", "description"] },
  { table: "Contract", aliases: ["id", "kind", "key", "name", "description"], idAlias: "id", properties: ["kind", "key", "name", "description"] },
  { table: "Evidence", aliases: ["id", "repoId", "fileId", "filePath", "line", "raw", "rule", "confidence", "batchId", "indexedAt", "active"], idAlias: "id", properties: ["repoId", "fileId", "filePath", "line", "raw", "rule", "confidence", "batchId", "indexedAt", "active"] }
];

const RELATION_UPSERT_SPECS: RelationUpsertSpec[] = [
  { table: "IMPORTS", from: "File", to: "File", aliases: ["fromId", "toId", "module", "raw", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["module", "raw"], setProperties: ["batchId", "active"] },
  { table: "CALLS", from: "Code", to: "Code", aliases: ["fromId", "toId", "confidence", "resolution", "raw", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["raw"], setProperties: ["confidence", "resolution", "batchId", "active"] },
  { table: "DESCRIBES", from: "Section", to: "Repo", aliases: ["fromId", "toId"], fromAlias: "fromId", toAlias: "toId" },
  { table: "DOCUMENTS", from: "Section", to: "Code", aliases: ["fromId", "toId", "confidence"], fromAlias: "fromId", toAlias: "toId", setProperties: ["confidence"] },
  { table: "REFERENCES", from: "Section", to: "File", aliases: ["fromId", "toId", "raw"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["raw"] },
  { table: "OWNS_PACKAGE", from: "Repo", to: "Contract", aliases: ["fromId", "toId", "evidenceId", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["evidenceId"], setProperties: ["confidence", "batchId", "active"] },
  { table: "PRODUCES", from: "Repo", to: "Contract", aliases: ["fromId", "toId", "evidenceId", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["evidenceId"], setProperties: ["confidence", "batchId", "active"] },
  { table: "CONSUMES", from: "Repo", to: "Contract", aliases: ["fromId", "toId", "evidenceId", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["evidenceId"], setProperties: ["confidence", "batchId", "active"] },
  { table: "SHARES_CONTRACT", from: "Repo", to: "Contract", aliases: ["fromId", "toId", "evidenceId", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["evidenceId"], setProperties: ["confidence", "batchId", "active"] },
  { table: "CONTRACT_MENTIONS", from: "Contract", to: "Entity", aliases: ["fromId", "toId", "evidenceId", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["evidenceId"], setProperties: ["confidence", "batchId", "active"] },
  { table: "PARTICIPATES_IN", from: "Repo", to: "Operation", aliases: ["fromId", "toId", "role", "evidenceId", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["role", "evidenceId"], setProperties: ["confidence", "batchId", "active"] },
  { table: "WORKFLOW_STEP", from: "Workflow", to: "Operation", aliases: ["fromId", "toId", "step", "evidenceId", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["step", "evidenceId"], setProperties: ["confidence", "batchId", "active"] },
  { table: "USES_PACKAGE", from: "Repo", to: "Contract", aliases: ["fromId", "toId", "packageName", "evidenceId", "raw", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["packageName", "evidenceId", "raw"], setProperties: ["confidence", "batchId", "active"] },
  { table: "DEPENDS_ON", from: "Repo", to: "Repo", aliases: ["fromId", "toId", "dependencyType", "sourceContractId", "targetContractId", "evidenceId", "raw", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["dependencyType", "sourceContractId", "targetContractId", "evidenceId", "raw"], setProperties: ["confidence", "batchId", "active"] },
  { table: "HAS_SPEC", from: "Contract", to: "ContractSpec", aliases: ["fromId", "toId", "evidenceId", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["evidenceId"], setProperties: ["confidence", "batchId", "active"] },
  { table: "SEMANTIC_REL", from: "ContractSpec", to: "ContractSpec", aliases: ["fromId", "toId", "kind", "evidenceId", "reason", "confidence", "batchId", "active"], fromAlias: "fromId", toAlias: "toId", mergeProperties: ["kind", "evidenceId"], setProperties: ["reason", "confidence", "batchId", "active"] }
];

const COLUMN_TYPES: Record<string, "INT64" | "DOUBLE" | "BOOL"> = {
  loc: "INT64",
  startLine: "INT64",
  endLine: "INT64",
  level: "INT64",
  line: "INT64",
  confidence: "DOUBLE",
  step: "INT64",
  active: "BOOL"
};

function withColumns(aliases: string[]): string {
  return aliases.map((alias, index) => {
    const type = COLUMN_TYPES[alias];
    return type ? `CAST(COLUMN${index} AS ${type}) AS ${alias}` : `COLUMN${index} AS ${alias}`;
  }).join(", ");
}

function setClause(variable: string, properties: string[] | undefined): string {
  if (!properties || properties.length === 0) return "";
  return ` SET ${properties.map((property) => `${variable}.${property} = ${property}`).join(", ")}`;
}

function propertyMap(properties: string[] | undefined): string {
  if (!properties || properties.length === 0) return "";
  return ` {${properties.map((property) => `${property}: ${property}`).join(", ")}}`;
}

function uniqueProperties(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

async function upsertNodeTable(db: GraphDB, filePath: string, spec: NodeUpsertSpec): Promise<void> {
  await db.query(
    `LOAD FROM "${toKuzuPath(filePath)}" (PARALLEL=false) WITH ${withColumns(spec.aliases)} ` +
    `MERGE (n:${spec.table} {${spec.idAlias}: ${spec.idAlias}})` +
    `${setClause("n", spec.properties)};`
  );
}

async function upsertRelationTable(db: GraphDB, filePath: string, spec: RelationUpsertSpec): Promise<void> {
  const matchProperties = propertyMap(spec.mergeProperties);
  const createProperties = propertyMap(uniqueProperties(spec.mergeProperties, spec.setProperties));
  await db.query(
    `LOAD FROM "${toKuzuPath(filePath)}" (PARALLEL=false) WITH ${withColumns(spec.aliases)} ` +
    `MATCH (a:${spec.from} {id: ${spec.fromAlias}}), (b:${spec.to} {id: ${spec.toAlias}}) ` +
    `MATCH (a)-[r:${spec.table}${matchProperties}]->(b) DELETE r;`
  );
  await db.query(
    `LOAD FROM "${toKuzuPath(filePath)}" (PARALLEL=false) WITH ${withColumns(spec.aliases)} ` +
    `MATCH (a:${spec.from} {id: ${spec.fromAlias}}), (b:${spec.to} {id: ${spec.toAlias}}) ` +
    `CREATE (a)-[:${spec.table}${createProperties}]->(b);`
  );
}

async function copyRelationTable(db: GraphDB, filePath: string, table: CsvTableName): Promise<void> {
  await db.query(`COPY ${table} FROM "${toKuzuPath(filePath)}" (PARALLEL=false);`);
}

async function copyPairTable(db: GraphDB, filePath: string, table: CsvTableName, from: string, to: string): Promise<void> {
  await db.query(`COPY ${table} FROM "${toKuzuPath(filePath)}" (FROM='${from}', TO='${to}', PARALLEL=false);`);
}

/** Maximum rows per LOAD-FROM chunk for relation-table pair specs to avoid
 *  Kuzu buffer-pool exhaustion.  Only the bulk-upsert path still uses this;
 *  append-copy now uses COPY FROM instead of LOAD-FROM + MERGE. */
const PAIR_TABLE_CHUNK_SIZE = 500;

/**
 * Processes a relation table CSV in chunks to avoid Kuzu buffer-pool
 * exhaustion. Applies the same LOAD-FROM + MATCH + DELETE → CREATE pattern as
 * {@link upsertRelationTable}, but splits rows so that no single query
 * overwhelms the buffer manager.
 */
async function upsertRelationTableChunked(
  db: GraphDB,
  filePath: string,
  spec: RelationUpsertSpec,
  chunkSize: number
): Promise<void> {
  const raw = await fs.readFile(filePath, "utf-8");
  // Relation-table values are ids and numbers — they never contain embedded
  // newlines, so line-based splitting is safe.
  const allRows = raw.trim().split("\n").filter((line) => line.length > 0);
  if (allRows.length === 0) return;

  if (allRows.length <= chunkSize) {
    await upsertRelationTable(db, filePath, spec);
    return;
  }

  const stagingDir = path.dirname(filePath);
  for (let i = 0; i < allRows.length; i += chunkSize) {
    const chunk = allRows.slice(i, i + chunkSize);
    const chunkPath = path.join(stagingDir, `${spec.table}_${spec.from}_${spec.to}_chunk_${i}.csv`);
    await fs.writeFile(chunkPath, chunk.join("\n"), "utf-8");
    try {
      await upsertRelationTable(db, chunkPath, spec);
    } finally {
      await fs.rm(chunkPath, { force: true });
    }
  }
}

export async function writeGraphFactsWithKuzuBulk(db: GraphDB, facts: GraphFactsBatch, options: KuzuBulkWriteOptions): Promise<KuzuBulkWriteResult> {
  if (options.requireEmpty !== false) {
    const existing = await db.query<{ count: number }>("MATCH (r:Repo) RETURN count(r) AS count;");
    if (Number(existing[0]?.count ?? 0) > 0) {
      throw new Error("Kuzu bulk writer currently supports empty graph imports only. Use merge mode for existing graphs.");
    }
  }
  const staging = await stageGraphFactsAsCsv(facts, options.stagingRoot);
  const copiedTables: CsvTableName[] = [];
  const pairSpecs = pairCopySpecs(facts).filter((spec) => spec.rows.length > 0);
  const totalSteps = COPY_ORDER.filter((table) => staging.files[table]).length + pairSpecs.length;
  let completedSteps = 0;
  try {
    for (const table of COPY_ORDER) {
      const filePath = staging.files[table];
      if (!filePath) continue;
      try {
        options.progress?.({ current: completedSteps, total: totalSteps, label: `copy ${table}` });
        await db.query(`COPY ${table} FROM "${toKuzuPath(filePath)}" (PARALLEL=false);`);
        copiedTables.push(table);
        completedSteps += 1;
        options.progress?.({ current: completedSteps, total: totalSteps, label: `copy ${table}` });
      } catch (error) {
        throw new Error(`Failed to bulk copy ${table} from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const spec of pairSpecs) {
      const filePath = await writePairCsv(staging.dir, spec);
      if (!filePath) continue;
      try {
        options.progress?.({ current: completedSteps, total: totalSteps, label: `copy ${spec.table} ${spec.from}->${spec.to}` });
        await db.query(`COPY ${spec.table} FROM "${toKuzuPath(filePath)}" (FROM='${spec.from}', TO='${spec.to}', PARALLEL=false);`);
        copiedTables.push(spec.table);
        completedSteps += 1;
        options.progress?.({ current: completedSteps, total: totalSteps, label: `copy ${spec.table} ${spec.from}->${spec.to}` });
      } catch (error) {
        throw new Error(`Failed to bulk copy ${spec.table} (${spec.from}->${spec.to}) from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await fs.rm(staging.dir, { recursive: true, force: true });
    } catch {
      // Ignore staging directory deletion error to avoid blocking the index process
    }
  } catch (error) {
    throw error;
  }
  return { staging, copiedTables };
}

export async function writeGraphFactsWithKuzuAppendCopy(db: GraphDB, facts: GraphFactsBatch, options: KuzuBulkUpsertOptions): Promise<KuzuBulkAppendResult> {
  const staging = await stageGraphFactsAsCsv(facts, options.stagingRoot);
  const upsertedNodeTables: CsvTableName[] = [];
  const copiedRelationTables: CsvTableName[] = [];
  const nodeSpecs = NODE_UPSERT_SPECS.filter((spec) => staging.files[spec.table]);
  const relationSpecs = RELATION_UPSERT_SPECS.filter((spec) => staging.files[spec.table]);
  const pairSpecs = pairCopySpecs(facts).filter((spec) => spec.rows.length > 0);
  const hasContractSpec = staging.files["ContractSpec"] !== undefined;
  const totalSteps = nodeSpecs.length + relationSpecs.length + pairSpecs.length + (hasContractSpec ? 1 : 0);
  let completedSteps = 0;
  try {
    for (const spec of nodeSpecs) {
      const filePath = staging.files[spec.table];
      if (!filePath) continue;
      try {
        options.progress?.({ current: completedSteps, total: totalSteps, label: `upsert ${spec.table}` });
        await upsertNodeTable(db, filePath, spec);
        upsertedNodeTables.push(spec.table);
        completedSteps += 1;
        options.progress?.({ current: completedSteps, total: totalSteps, label: `upsert ${spec.table}` });
      } catch (error) {
        throw new Error(`Failed to append-copy upsert ${spec.table} from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // ContractSpec is handled via COPY FROM (not MERGE+SET) because
    // clearRepoIndexedArtifacts already deletes old ContractSpec rows for
    // the repos in this batch before we reach this writer.
    if (hasContractSpec) {
      const contractSpecPath = staging.files["ContractSpec"]!;
      try {
        options.progress?.({ current: completedSteps, total: totalSteps, label: "copy ContractSpec" });
        await db.query(`COPY ContractSpec FROM "${toKuzuPath(contractSpecPath)}" (PARALLEL=false);`);
        upsertedNodeTables.push("ContractSpec");
        completedSteps += 1;
        options.progress?.({ current: completedSteps, total: totalSteps, label: "copy ContractSpec" });
      } catch (error) {
        throw new Error(`Failed to append-copy ContractSpec from ${contractSpecPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Pair tables use COPY FROM (not LOAD FROM + MERGE) because
    // clearRepoIndexedArtifacts already deletes old CONTAINS, MENTIONS, and
    // HAS_EVIDENCE edges for this repo.  COPY FROM streams directly to disk
    // without pinning index pages for MATCH/MERGE, entirely sidestepping
    // the Kuzu buffer-pool exhaustion that occurred with MERGE.
    for (const spec of pairSpecs) {
      const filePath = await writePairCsv(staging.dir, spec);
      if (!filePath) continue;
      try {
        options.progress?.({ current: completedSteps, total: totalSteps, label: `copy ${spec.table} ${spec.from}->${spec.to}` });
        await copyPairTable(db, filePath, spec.table, spec.from, spec.to);
        copiedRelationTables.push(spec.table);
        completedSteps += 1;
        options.progress?.({ current: completedSteps, total: totalSteps, label: `copy ${spec.table} ${spec.from}->${spec.to}` });
      } catch (error) {
        throw new Error(`Failed to append-copy ${spec.table} (${spec.from}->${spec.to}) from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const spec of relationSpecs) {
      const filePath = staging.files[spec.table];
      if (!filePath) continue;
      try {
        options.progress?.({ current: completedSteps, total: totalSteps, label: `copy ${spec.table}` });
        await copyRelationTable(db, filePath, spec.table);
        copiedRelationTables.push(spec.table);
        completedSteps += 1;
        options.progress?.({ current: completedSteps, total: totalSteps, label: `copy ${spec.table}` });
      } catch (error) {
        throw new Error(`Failed to append-copy ${spec.table} from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await fs.rm(staging.dir, { recursive: true, force: true });
    } catch {
      // Ignore staging directory deletion error to avoid blocking the index process
    }
  } catch (error) {
    throw error;
  }
  return { staging, upsertedNodeTables, copiedRelationTables };
}

export async function writeGraphFactsWithKuzuBulkUpsert(db: GraphDB, facts: GraphFactsBatch, options: KuzuBulkUpsertOptions): Promise<KuzuBulkUpsertResult> {
  const staging = await stageGraphFactsAsCsv(facts, options.stagingRoot);
  const upsertedTables: CsvTableName[] = [];
  const nodeSpecs = NODE_UPSERT_SPECS.filter((spec) => staging.files[spec.table]);
  const relationSpecs = RELATION_UPSERT_SPECS.filter((spec) => staging.files[spec.table]);
  const pairSpecs = pairCopySpecs(facts).filter((spec) => spec.rows.length > 0);
  const hasContractSpec = staging.files["ContractSpec"] !== undefined;
  const totalSteps = nodeSpecs.length + relationSpecs.length + pairSpecs.length + (hasContractSpec ? 1 : 0);
  let completedSteps = 0;
  try {
    // Clean up existing ContractSpec data for repos in this batch so that
    // the following COPY FROM can safely insert without primary-key conflicts.
    if (hasContractSpec) {
      const batchRepoIds = [...new Set(facts.repos.map((r) => r.id))];
      for (const repoId of batchRepoIds) {
        await db.query("MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec) WHERE a.repoId = $repoId OR b.repoId = $repoId DELETE r;", { repoId });
        await db.query("MATCH (:Contract)-[r:HAS_SPEC]->(s:ContractSpec) WHERE s.repoId = $repoId DELETE r;", { repoId });
        await db.query("MATCH (s:ContractSpec) WHERE s.repoId = $repoId DELETE s;", { repoId });
      }
    }
    for (const spec of nodeSpecs) {
      const filePath = staging.files[spec.table];
      if (!filePath) continue;
      try {
        options.progress?.({ current: completedSteps, total: totalSteps, label: `upsert ${spec.table}` });
        await upsertNodeTable(db, filePath, spec);
        upsertedTables.push(spec.table);
        completedSteps += 1;
        options.progress?.({ current: completedSteps, total: totalSteps, label: `upsert ${spec.table}` });
      } catch (error) {
        throw new Error(`Failed to bulk upsert ${spec.table} from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // ContractSpec is handled via cleanup + COPY FROM (not MERGE+SET) to
    // avoid a KùzuDB parser limitation with the MERGE+SET query shape.
    if (hasContractSpec) {
      const contractSpecPath = staging.files["ContractSpec"]!;
      try {
        options.progress?.({ current: completedSteps, total: totalSteps, label: "copy ContractSpec" });
        await db.query(`COPY ContractSpec FROM "${toKuzuPath(contractSpecPath)}" (PARALLEL=false);`);
        upsertedTables.push("ContractSpec");
        completedSteps += 1;
        options.progress?.({ current: completedSteps, total: totalSteps, label: "copy ContractSpec" });
      } catch (error) {
        throw new Error(`Failed to bulk upsert ContractSpec from ${contractSpecPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Pair tables (CONTAINS, MENTIONS, HAS_EVIDENCE) use LOAD FROM + MATCH
    // + DELETE/CREATE which pins pages aggressively.  Run them BEFORE
    // relation tables so the buffer pool is still relatively clean.
    for (const spec of pairSpecs) {
      const filePath = await writePairCsv(staging.dir, spec);
      if (!filePath) continue;
      try {
        options.progress?.({ current: completedSteps, total: totalSteps, label: `upsert ${spec.table} ${spec.from}->${spec.to}` });
        const relationSpec: RelationUpsertSpec = {
          table: spec.table,
          from: spec.from,
          to: spec.to,
          aliases: spec.table === "MENTIONS" ? ["fromId", "toId", "confidence"] : ["fromId", "toId"],
          fromAlias: "fromId",
          toAlias: "toId",
          setProperties: spec.table === "MENTIONS" ? ["confidence"] : []
        };
        await upsertRelationTableChunked(db, filePath, relationSpec, PAIR_TABLE_CHUNK_SIZE);
        upsertedTables.push(spec.table);
        completedSteps += 1;
        options.progress?.({ current: completedSteps, total: totalSteps, label: `upsert ${spec.table} ${spec.from}->${spec.to}` });
      } catch (error) {
        throw new Error(`Failed to bulk upsert ${spec.table} (${spec.from}->${spec.to}) from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const spec of relationSpecs) {
      const filePath = staging.files[spec.table];
      if (!filePath) continue;
      try {
        options.progress?.({ current: completedSteps, total: totalSteps, label: `upsert ${spec.table}` });
        await upsertRelationTable(db, filePath, spec);
        upsertedTables.push(spec.table);
        completedSteps += 1;
        options.progress?.({ current: completedSteps, total: totalSteps, label: `upsert ${spec.table}` });
      } catch (error) {
        throw new Error(`Failed to bulk upsert ${spec.table} from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await fs.rm(staging.dir, { recursive: true, force: true });
    } catch {
      // Ignore staging directory deletion error to avoid blocking the index process
    }
  } catch (error) {
    throw error;
  }
  return { staging, upsertedTables };
}
