import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import kuzu, { type KuzuValue, type QueryResult } from "kuzu";
import type {
  CallEdge,
  CodeSymbol,
  ContractKind,
  ContractNode,
  DocSection,
  EntityNode,
  EvidenceNode,
  FileNode,
  ImportEdge,
  OperationNode,
  OperationRepoEdge,
  PackageUsageEdge,
  ContractEntityEdge,
  RepoContractEdge,
  RepoDependencyEdge,
  RepoNode,
  ContractSpecNode,
  ContractSpecEdge,
  SemanticRelationEdge,
  WorkflowNode,
  WorkflowOperationEdge
} from "../../../core/parsing/types.js";
import { schemaStatements, systemId } from "../../../core/graph-model/schema.js";
import { createCypherCrud, type CypherCrud } from "../../../core/graph-model/cypherCrud.js";
import { getBrandedEnv } from "../../../shared/branding.js";
import {
  type GraphDB,
  type GraphValue,
  type GraphWriteAtomicityMode,
  type GraphWriteBatchStatus,
  type GraphWriteBatchJournal,
  type ActiveAliasOverride,
  type ContractSummaryRow,
  type Stats,
  withTransaction,
  ALL_EVIDENCE_REL_TYPES,
  REJECT_EVIDENCE_REL_TYPES
} from "../../../core/graph-model/db.js";

async function allRows(result: QueryResult | QueryResult[]): Promise<Record<string, KuzuValue>[]> {
  const results = Array.isArray(result) ? result : [result];
  const rows: Record<string, KuzuValue>[] = [];
  for (const item of results) {
    const all = await item.getAll();
    for (let i = 0; i < all.length; i++) {
      rows.push(all[i]!);
    }
  }
  return rows;
}

type TableInfoRow = {
  name: string;
};

function encodeList(values: string[]): string {
  return JSON.stringify(values);
}

function decodeList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return value.split("|").filter(Boolean);
  }
}

function decodeJournalRow(row: {
  batchId: string;
  repoIds: string;
  repoNames: string;
  writerMode: string;
  atomicityMode: GraphWriteAtomicityMode;
  status: GraphWriteBatchStatus;
  startedAt: string;
  updatedAt: string;
  completedStage: string;
  error: string;
}): GraphWriteBatchJournal {
  return {
    batchId: row.batchId,
    repoIds: decodeList(row.repoIds),
    repoNames: decodeList(row.repoNames),
    writerMode: row.writerMode,
    atomicityMode: row.atomicityMode,
    status: row.status,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedStage: row.completedStage || undefined,
    error: row.error || undefined
  };
}

const managedKuzuHandles = new Map<string, { db: kuzu.Database }>();

type KuzuTransactionContext = {
  conn: kuzu.Connection;
  depth: number;
};

// Kuzu reserves `maxDBSize` bytes of virtual address space via mmap up front.
// Passing 0 selects Kuzu's default of 8 TiB (2^43), which some constrained
// environments (notably GitHub Actions runners) refuse to mmap, surfacing as
// "Buffer manager exception: Mmap for size 8796093022208 failed". We instead
// reserve a generous-but-mappable 128 GiB by default — far beyond any realistic
// code-graph size — and allow an override for unusual deployments. Kuzu requires
// the value to be a power of two.
const DEFAULT_MAX_DB_SIZE = 137438953472; // 128 GiB (2^37)

function resolveMaxDBSize(): number {
  const raw = getBrandedEnv("KUZU_MAX_DB_SIZE");
  if (!raw) return DEFAULT_MAX_DB_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_DB_SIZE;
  return Math.floor(parsed);
}

export class KuzuGraphDB implements GraphDB {
  private db?: kuzu.Database;
  private closed = false;
  private managedKey?: string;
  private manualTx?: KuzuTransactionContext;
  private readonly txStorage = new AsyncLocalStorage<KuzuTransactionContext>();
  private readonly crud: CypherCrud;

  private constructor(db: kuzu.Database, managedKey?: string) {
    this.db = db;
    this.managedKey = managedKey;
    this.crud = createCypherCrud(this);
  }

  static async open(graphPath: string): Promise<KuzuGraphDB> {
    const resolved = path.resolve(graphPath);
    const dbPath = path.extname(resolved) ? resolved : path.join(resolved, "kuzu.db");
    if (shouldUseManagedKuzuClose()) {
      const managed = managedKuzuHandles.get(dbPath);
      if (managed) return new KuzuGraphDB(managed.db, dbPath);
    }
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    // Lower checkpoint threshold (default 16 MB) so dirty WAL pages are
    // flushed more frequently during bulk writes.  Without this, LOAD FROM
    // + MATCH + MERGE across many pair tables (CONTAINS, MENTIONS,
    // HAS_EVIDENCE) can exhaust the buffer pool before a checkpoint fires.
    const db = new kuzu.Database(
      dbPath,
      0,               // bufferManagerSize (0 = default: 80 % of RAM)
      true,            // enableCompression
      false,           // readOnly
      resolveMaxDBSize(), // maxDBSize — see resolveMaxDBSize (0 default = 8 TiB mmap)
      true,            // autoCheckpoint
      1048576          // checkpointThreshold — 1 MB instead of 16 MB
    );
    await db.init();
    if (shouldUseManagedKuzuClose()) {
      managedKuzuHandles.set(dbPath, { db });
      return new KuzuGraphDB(db, dbPath);
    }
    return new KuzuGraphDB(db);
  }

  async initSchema(systemName = "default-system"): Promise<void> {
    await this.withConnection(async (conn) => {
      for (const statement of schemaStatements) await conn.query(statement);
    });
    await this.ensureColumn("System", "summary", "STRING");
    await this.ensureColumn("Repo", "summary", "STRING");
    await this.ensureColumn("IndexState", "graphWriteAtomicity", "STRING");
    await this.ensureColumn("IndexState", "graphWriteStatus", "STRING");
    for (const tableName of ["File", "Code", "Section", "Evidence"]) {
      await this.ensureColumn(tableName, "batchId", "STRING");
      await this.ensureColumn(tableName, "indexedAt", "STRING");
      await this.ensureColumn(tableName, "active", "BOOL");
    }
    for (const tableName of ["IMPORTS", "CALLS", "OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON"]) {
      await this.ensureColumn(tableName, "batchId", "STRING");
      await this.ensureColumn(tableName, "active", "BOOL");
    }
    await this.ensureColumn("CALLS", "resolution", "STRING");
    await this.query("MERGE (s:System {id: $id}) ON CREATE SET s.name = $name, s.summary = '' ON MATCH SET s.name = $name;", { id: systemId, name: systemName });
  }

  private async ensureColumn(tableName: string, columnName: string, columnType: string): Promise<void> {
    const columns = await this.query<TableInfoRow>(`CALL table_info('${tableName}') RETURN name;`);
    if (columns.some((column) => column.name === columnName)) return;
    await this.query(`ALTER TABLE ${tableName} ADD ${columnName} ${columnType};`);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = this.activeTransaction();
    if (existing) {
      existing.depth++;
      try {
        return await fn();
      } finally {
        existing.depth--;
      }
    }

    const conn = await this.createConnection();
    const context: KuzuTransactionContext = { conn, depth: 1 };
    try {
      await conn.query("BEGIN TRANSACTION;");
      const result = await this.txStorage.run(context, fn);
      await conn.query("COMMIT;");
      return result;
    } catch (error) {
      try {
        await conn.query("ROLLBACK;");
      } catch {}
      throw error;
    } finally {
      await conn.close();
    }
  }

  async beginTransaction(): Promise<void> {
    const activeStore = this.txStorage.getStore();
    if (activeStore) {
      activeStore.depth++;
      return;
    }
    if (this.manualTx) {
      this.manualTx.depth++;
      return;
    }
    const conn = await this.createConnection();
    await conn.query("BEGIN TRANSACTION;");
    this.manualTx = { conn, depth: 1 };
  }

  async commitTransaction(): Promise<void> {
    const activeStore = this.txStorage.getStore();
    if (activeStore) {
      activeStore.depth--;
      return;
    }
    if (!this.manualTx) {
      throw new Error("No transaction in progress");
    }
    this.manualTx.depth--;
    if (this.manualTx.depth > 0) return;
    const tx = this.manualTx;
    this.manualTx = undefined;
    try {
      await tx.conn.query("COMMIT;");
    } finally {
      await tx.conn.close();
    }
  }

  async rollbackTransaction(): Promise<void> {
    const activeStore = this.txStorage.getStore();
    if (activeStore) {
      activeStore.depth = 0;
      try {
        await activeStore.conn.query("ROLLBACK;");
      } catch {}
      return;
    }
    if (!this.manualTx) return;
    const tx = this.manualTx;
    this.manualTx = undefined;
    try {
      await tx.conn.query("ROLLBACK;");
    } finally {
      await tx.conn.close();
    }
  }

  async upsertRepo(repo: RepoNode): Promise<void> {
    await this.crud.upsertRepo(repo);
  }

  async updateRepoSummary(repoIdValue: string, summary: string): Promise<void> {
    await this.crud.updateRepoSummary(repoIdValue, summary);
  }

  async updateSystemSummary(summary: string): Promise<void> {
    await this.crud.updateSystemSummary(summary);
  }

  async upsertFile(file: FileNode): Promise<void> {
    await this.crud.upsertFile(file);
  }

  async upsertFilesBatch(files: FileNode[]): Promise<void> {
    await this.crud.upsertFilesBatch(files);
  }

  async upsertCode(code: CodeSymbol): Promise<void> {
    await this.crud.upsertCode(code);
  }

  async upsertCodeBatch(codes: CodeSymbol[]): Promise<void> {
    await this.crud.upsertCodeBatch(codes);
  }

  async upsertSection(section: DocSection): Promise<void> {
    await this.crud.upsertSection(section);
  }

  async upsertEntity(entity: EntityNode): Promise<void> {
    await this.crud.upsertEntity(entity);
  }

  async upsertOperation(operation: OperationNode): Promise<void> {
    await this.crud.upsertOperation(operation);
  }

  async upsertWorkflow(workflow: WorkflowNode): Promise<void> {
    await this.crud.upsertWorkflow(workflow);
  }

  async upsertContract(contract: ContractNode): Promise<void> {
    await this.crud.upsertContract(contract);
  }

  async upsertEvidence(evidence: EvidenceNode): Promise<void> {
    await this.crud.upsertEvidence(evidence);
  }

  async addRepoContract(edge: RepoContractEdge): Promise<void> {
    await this.crud.addRepoContract(edge);
  }

  async addRepoDependency(edge: RepoDependencyEdge): Promise<void> {
    await this.crud.addRepoDependency(edge);
  }

  async addRepoDependenciesBatch(edges: RepoDependencyEdge[]): Promise<void> {
    await this.crud.addRepoDependenciesBatch(edges);
  }

  async addPackageUsage(edge: PackageUsageEdge): Promise<void> {
    await this.query(
      "MATCH (r:Repo {id: $repoId}), (c:Contract {id: $packageContractId}) MERGE (r)-[u:USES_PACKAGE {packageName: $packageName, evidenceId: $evidenceId, raw: $raw}]->(c) SET u.confidence = $confidence, u.batchId = $batchId, u.active = $active;",
      { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>
    );
  }

  async addContractEntity(edge: ContractEntityEdge): Promise<void> {
    await this.crud.addContractEntity(edge);
  }

  async addOperationRepo(edge: OperationRepoEdge): Promise<void> {
    await this.crud.addOperationRepo(edge);
  }

  async addWorkflowOperation(edge: WorkflowOperationEdge): Promise<void> {
    await this.crud.addWorkflowOperation(edge);
  }

  async upsertContractSpec(spec: ContractSpecNode): Promise<void> {
    await this.crud.upsertContractSpec(spec);
  }

  async addHasSpec(edge: ContractSpecEdge): Promise<void> {
    await this.crud.addHasSpec(edge);
  }

  async addSemanticRelation(edge: SemanticRelationEdge): Promise<void> {
    await this.crud.addSemanticRelation(edge);
  }

  async addSemanticRelationsBatch(edges: SemanticRelationEdge[]): Promise<void> {
    await this.crud.addSemanticRelationsBatch(edges);
  }

  async addContractEvidence(contractIdValue: string, evidenceIdValue: string): Promise<void> {
    await this.crud.addContractEvidence(contractIdValue, evidenceIdValue);
  }

  async addRepoEvidence(repoIdValue: string, evidenceIdValue: string): Promise<void> {
    await this.crud.addRepoEvidence(repoIdValue, evidenceIdValue);
  }

  async addContains(fromId: string, toId: string): Promise<void> {
    await this.crud.addContains(fromId, toId);
  }

  async addImport(edge: ImportEdge): Promise<void> {
    await this.crud.addImport(edge);
  }

  async addImportsBatch(edges: ImportEdge[]): Promise<void> {
    await this.crud.addImportsBatch(edges);
  }

  async addCall(edge: CallEdge): Promise<void> {
    await this.crud.addCall(edge);
  }

  async addCallsBatch(edges: CallEdge[]): Promise<void> {
    await this.crud.addCallsBatch(edges);
  }

  async addMention(codeIdValue: string, entityIdValue: string, confidence: number): Promise<void> {
    await this.crud.addMention(codeIdValue, entityIdValue, confidence);
  }

  async addSectionMention(sectionIdValue: string, entityIdValue: string, confidence: number): Promise<void> {
    await this.crud.addSectionMention(sectionIdValue, entityIdValue, confidence);
  }

  async addSectionDescribesRepo(sectionIdValue: string, repoIdValue: string): Promise<void> {
    await this.crud.addSectionDescribesRepo(sectionIdValue, repoIdValue);
  }

  async addSectionDocumentsCode(sectionIdValue: string, codeIdValue: string, confidence: number): Promise<void> {
    await this.crud.addSectionDocumentsCode(sectionIdValue, codeIdValue, confidence);
  }

  async addSectionReferencesFile(sectionIdValue: string, fileIdValue: string, raw: string): Promise<void> {
    await this.crud.addSectionReferencesFile(sectionIdValue, fileIdValue, raw);
  }

  async clearRepoDependencies(repoIds?: string[]): Promise<void> {
    await this.crud.clearRepoDependencies(repoIds);
  }

  async clearRepoIndexedArtifacts(repoId: string): Promise<void> {
    const params = { repoId };
    const statements = [
      "MATCH (:Repo {id: $repoId})-[r:OWNS_PACKAGE]->(:Contract) DELETE r;",
      "MATCH (:Repo {id: $repoId})-[r:PRODUCES]->(:Contract) DELETE r;",
      "MATCH (:Repo {id: $repoId})-[r:CONSUMES]->(:Contract) DELETE r;",
      "MATCH (:Repo {id: $repoId})-[r:SHARES_CONTRACT]->(:Contract) DELETE r;",
      "MATCH (:Repo {id: $repoId})-[r:PARTICIPATES_IN]->(:Operation) DELETE r;",
      "MATCH (:Repo {id: $repoId})-[r:USES_PACKAGE]->(:Contract) DELETE r;",
      "MATCH (:Repo {id: $repoId})-[r:DEPENDS_ON]->(:Repo) DELETE r;",
      "MATCH (:Repo)-[r:DEPENDS_ON]->(:Repo {id: $repoId}) DELETE r;",
      "MATCH (:Repo {id: $repoId})-[r:HAS_EVIDENCE]->(:Evidence) DELETE r;",
      "MATCH (:Contract)-[r:HAS_EVIDENCE]->(e:Evidence) WHERE e.repoId = $repoId DELETE r;",
      "MATCH (:Contract)-[r:CONTRACT_MENTIONS]->(:Entity), (e:Evidence) WHERE r.evidenceId = e.id AND e.repoId = $repoId DELETE r;",
      "MATCH (:Workflow)-[r:WORKFLOW_STEP]->(:Operation), (e:Evidence) WHERE r.evidenceId = e.id AND e.repoId = $repoId DELETE r;",
      "MATCH (f:File)-[r:IMPORTS]->(:File) WHERE f.repoId = $repoId DELETE r;",
      "MATCH (:File)-[r:IMPORTS]->(f:File) WHERE f.repoId = $repoId DELETE r;",
      "MATCH (c:Code)-[r:CALLS]->(:Code) WHERE c.repoId = $repoId DELETE r;",
      "MATCH (:Code)-[r:CALLS]->(c:Code) WHERE c.repoId = $repoId DELETE r;",
      "MATCH (c:Code)-[r:MENTIONS]->(:Entity) WHERE c.repoId = $repoId DELETE r;",
      "MATCH (s:Section)-[r:MENTIONS]->(:Entity) WHERE s.repoId = $repoId DELETE r;",
      "MATCH (s:Section)-[r:DESCRIBES]->(:Repo) WHERE s.repoId = $repoId DELETE r;",
      "MATCH (s:Section)-[r:DOCUMENTS]->(:Code) WHERE s.repoId = $repoId DELETE r;",
      "MATCH (:Section)-[r:DOCUMENTS]->(c:Code) WHERE c.repoId = $repoId DELETE r;",
      "MATCH (s:Section)-[r:REFERENCES]->(:File) WHERE s.repoId = $repoId DELETE r;",
      "MATCH (:Section)-[r:REFERENCES]->(f:File) WHERE f.repoId = $repoId DELETE r;",
      "MATCH (:System)-[r:CONTAINS]->(:Repo {id: $repoId}) DELETE r;",
      "MATCH (:Repo {id: $repoId})-[r:CONTAINS]->(:File) DELETE r;",
      "MATCH (:File)-[r:CONTAINS]->(c:Code) WHERE c.repoId = $repoId DELETE r;",
      "MATCH (:File)-[r:CONTAINS]->(s:Section) WHERE s.repoId = $repoId DELETE r;",
      "MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec) WHERE a.repoId = $repoId OR b.repoId = $repoId DELETE r;",
      "MATCH (:Contract)-[r:HAS_SPEC]->(s:ContractSpec) WHERE s.repoId = $repoId DELETE r;",
      "MATCH (e:Evidence) WHERE e.repoId = $repoId DELETE e;",
      "MATCH (c:Code) WHERE c.repoId = $repoId DELETE c;",
      "MATCH (s:Section) WHERE s.repoId = $repoId DELETE s;",
      "MATCH (f:File) WHERE f.repoId = $repoId DELETE f;",
      "MATCH (s:ContractSpec) WHERE s.repoId = $repoId DELETE s;"
    ];
    await withTransaction(this, async () => {
      for (const statement of statements) await this.query(statement, params);
    });
  }

  async beginGraphWriteBatch(journal: Omit<GraphWriteBatchJournal, "status" | "updatedAt"> & { updatedAt?: string }): Promise<void> {
    const updatedAt = journal.updatedAt ?? journal.startedAt;
    await this.query(
      "MERGE (b:GraphWriteBatch {id: $id}) ON CREATE SET b.batchId=$batchId, b.repoIds=$repoIds, b.repoNames=$repoNames, b.writerMode=$writerMode, b.atomicityMode=$atomicityMode, b.status=$status, b.startedAt=$startedAt, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error ON MATCH SET b.batchId=$batchId, b.repoIds=$repoIds, b.repoNames=$repoNames, b.writerMode=$writerMode, b.atomicityMode=$atomicityMode, b.status=$status, b.startedAt=$startedAt, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error;",
      {
        id: `graph-write:${journal.batchId}`,
        batchId: journal.batchId,
        repoIds: encodeList(journal.repoIds),
        repoNames: encodeList(journal.repoNames),
        writerMode: journal.writerMode,
        atomicityMode: journal.atomicityMode,
        status: "started",
        startedAt: journal.startedAt,
        updatedAt,
        completedStage: journal.completedStage ?? "begin",
        error: journal.error ?? ""
      }
    );
  }

  async commitGraphWriteBatch(input: { batchId: string; updatedAt: string; completedStage?: string }): Promise<void> {
    await this.query(
      "MATCH (b:GraphWriteBatch {id: $id}) SET b.status=$status, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error;",
      { id: `graph-write:${input.batchId}`, status: "committed", updatedAt: input.updatedAt, completedStage: input.completedStage ?? "commit", error: "" }
    );
  }

  async failGraphWriteBatch(input: { batchId: string; updatedAt: string; error: string; completedStage?: string; awaitingCleanup?: boolean }): Promise<void> {
    await this.query(
      "MATCH (b:GraphWriteBatch {id: $id}) SET b.status=$status, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error;",
      {
        id: `graph-write:${input.batchId}`,
        status: input.awaitingCleanup ? "awaiting-cleanup" : "failed",
        updatedAt: input.updatedAt,
        completedStage: input.completedStage ?? "failed",
        error: input.error
      }
    );
  }

  async recoverIncompleteGraphWriteBatches(input: { repoIds?: string[]; updatedAt: string }): Promise<GraphWriteBatchJournal[]> {
    const rows = await this.query<{
      batchId: string;
      repoIds: string;
      repoNames: string;
      writerMode: string;
      atomicityMode: GraphWriteAtomicityMode;
      status: GraphWriteBatchStatus;
      startedAt: string;
      updatedAt: string;
      completedStage: string;
      error: string;
    }>(
      "MATCH (b:GraphWriteBatch) WHERE b.status = 'started' OR b.status = 'awaiting-cleanup' RETURN b.batchId AS batchId, b.repoIds AS repoIds, b.repoNames AS repoNames, b.writerMode AS writerMode, b.atomicityMode AS atomicityMode, b.status AS status, b.startedAt AS startedAt, b.updatedAt AS updatedAt, b.completedStage AS completedStage, b.error AS error;"
    );
    const repoFilter = input.repoIds && input.repoIds.length > 0 ? new Set(input.repoIds) : undefined;
    const journals = rows
      .map((row) => decodeJournalRow(row))
      .filter((journal) => !repoFilter || journal.repoIds.some((repoId) => repoFilter.has(repoId)));
    for (const journal of journals) {
      await this.cleanupGraphWriteBatch(journal.batchId);
      await this.query(
        "MATCH (b:GraphWriteBatch {id: $id}) SET b.status=$status, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error;",
        {
          id: `graph-write:${journal.batchId}`,
          status: "recovered",
          updatedAt: input.updatedAt,
          completedStage: "recovered-cleanup",
          error: journal.error ?? ""
        }
      );
    }
    return journals;
  }

  async cleanupGraphWriteBatch(batchId: string): Promise<void> {
    const params = { batchId, active: false };
    for (const table of ["File", "Code", "Section", "Evidence", "ContractSpec"]) {
      await this.query(`MATCH (n:${table}) WHERE n.batchId = $batchId SET n.active = $active;`, params);
    }
    for (const rel of ["IMPORTS", "CALLS", "OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON", "HAS_SPEC", "SEMANTIC_REL"]) {
      await this.query(`MATCH ()-[r:${rel}]->() WHERE r.batchId = $batchId SET r.active = $active;`, params);
    }
  }

  async markRepoArtifactsStale(input: { repoId: string; activeFileIds: string[]; batchId: string; indexedAt: string }): Promise<number> {
    const staleRows = input.activeFileIds.length === 0
      ? await this.query<{ id: string }>(
        "MATCH (f:File) WHERE f.repoId = $repoId AND (f.active IS NULL OR f.active = true) RETURN f.id AS id;",
        { repoId: input.repoId }
      )
      : await this.query<{ id: string }>(
        "MATCH (f:File) WHERE f.repoId = $repoId AND NOT (f.id IN $activeFileIds) AND (f.active IS NULL OR f.active = true) RETURN f.id AS id;",
        { repoId: input.repoId, activeFileIds: input.activeFileIds }
      );
    const staleFileIds = staleRows.map((row) => row.id);

    const evidenceRows = input.activeFileIds.length === 0
      ? await this.query<{ id: string }>(
        "MATCH (e:Evidence) WHERE e.repoId = $repoId AND (e.active IS NULL OR e.active = true) RETURN e.id AS id;",
        { repoId: input.repoId }
      )
      : await this.query<{ id: string }>(
        "MATCH (e:Evidence) WHERE e.repoId = $repoId AND NOT (e.fileId IN $activeFileIds) AND (e.active IS NULL OR e.active = true) RETURN e.id AS id;",
        { repoId: input.repoId, activeFileIds: input.activeFileIds }
      );
    const staleEvidenceIds = evidenceRows.map((row) => row.id);

    if (staleFileIds.length === 0 && staleEvidenceIds.length === 0) return 0;

    await withTransaction(this, async () => {
      if (staleFileIds.length > 0) {
        const nodeParams = { staleFileIds, batchId: input.batchId, staleIndexedAt: input.indexedAt, active: false };
        const relParams = { staleFileIds, batchId: input.batchId, active: false };
        await this.query("MATCH (f:File) WHERE f.id IN $staleFileIds SET f.active = $active, f.batchId = $batchId, f.indexedAt = $staleIndexedAt;", nodeParams);
        await this.query("MATCH (c:Code) WHERE c.fileId IN $staleFileIds SET c.active = $active, c.batchId = $batchId, c.indexedAt = $staleIndexedAt;", nodeParams);
        await this.query("MATCH (s:Section) WHERE s.fileId IN $staleFileIds SET s.active = $active, s.batchId = $batchId, s.indexedAt = $staleIndexedAt;", nodeParams);
        await this.query("MATCH (e:Evidence) WHERE e.fileId IN $staleFileIds SET e.active = $active, e.batchId = $batchId, e.indexedAt = $staleIndexedAt;", nodeParams);
        await this.query("MATCH (a:File)-[r:IMPORTS]->(b:File) WHERE a.id IN $staleFileIds OR b.id IN $staleFileIds SET r.active = $active, r.batchId = $batchId;", relParams);
        await this.query("MATCH (a:Code)-[r:CALLS]->(b:Code) WHERE a.fileId IN $staleFileIds OR b.fileId IN $staleFileIds SET r.active = $active, r.batchId = $batchId;", relParams);
        const relTypes = ALL_EVIDENCE_REL_TYPES.join("|");
        await this.query(`MATCH ()-[r:${relTypes}]->(), (e:Evidence) WHERE r.evidenceId = e.id AND e.fileId IN $staleFileIds SET r.active = $active, r.batchId = $batchId;`, relParams);
        await this.query("MATCH (cs:ContractSpec) WHERE cs.fileId IN $staleFileIds SET cs.active = $active, cs.batchId = $batchId;", relParams);
        await this.query("MATCH (cs:ContractSpec)-[r:SEMANTIC_REL]->(cs2:ContractSpec) WHERE cs.fileId IN $staleFileIds SET r.active = $active, r.batchId = $batchId;", relParams);
        await this.query("MATCH (cs2:ContractSpec)-[r:SEMANTIC_REL]->(cs:ContractSpec) WHERE cs.fileId IN $staleFileIds SET r.active = $active, r.batchId = $batchId;", relParams);
      }

      if (staleEvidenceIds.length > 0) {
        const relParams = { staleEvidenceIds, batchId: input.batchId, active: false };
        await this.query("MATCH (e:Evidence) WHERE e.id IN $staleEvidenceIds SET e.active = $active, e.batchId = $batchId;", relParams);
        const relTypes = ALL_EVIDENCE_REL_TYPES.join("|");
        await this.query(`MATCH ()-[r:${relTypes}]->() WHERE r.evidenceId IN $staleEvidenceIds SET r.active = $active, r.batchId = $batchId;`, relParams);
      }

      if (input.activeFileIds.length === 0) {
        await this.query(
          "MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo) WHERE a.id = $repoId OR b.id = $repoId SET r.active = $active, r.batchId = $batchId;",
          { repoId: input.repoId, batchId: input.batchId, active: false }
        );
      }
    });
    // Return only the file count — the IndexState field is named "filesStale".
    return staleFileIds.length;
  }

  async upsertIndexState(state: { repoId: string; repoName: string; lastBatchId: string; lastIndexedAt: string; lastCommitSha: string; filesScanned: number; filesChanged: number; filesStale: number; status: string; error?: string; graphWriteAtomicity?: GraphWriteAtomicityMode; graphWriteStatus?: GraphWriteBatchStatus }): Promise<void> {
    await this.crud.upsertIndexState(state);
  }

  async knownFileHashes(repoIdValue: string): Promise<Map<string, string>> {
    return this.crud.knownFileHashes(repoIdValue);
  }

  async repoCount(): Promise<number> {
    return this.crud.repoCount();
  }

  async listRepos(): Promise<RepoNode[]> {
    return this.crud.listRepos();
  }

  async listActiveAliasOverrides(): Promise<ActiveAliasOverride[]> {
    return this.crud.listActiveAliasOverrides();
  }

  async rejectEvidence(input: { evidenceId: string; reason: string }): Promise<void> {
    const createdAt = new Date().toISOString();
    await withTransaction(this, async () => {
      await this.query(
        "MERGE (f:RelationFeedback {id: $id}) ON CREATE SET f.evidenceId=$evidenceId, f.action=$action, f.reason=$reason, f.createdAt=$createdAt ON MATCH SET f.action=$action, f.reason=$reason, f.createdAt=$createdAt;",
        { id: `feedback:${input.evidenceId}:reject`, evidenceId: input.evidenceId, action: "reject", reason: input.reason, createdAt }
      );
      await this.query("MATCH (e:Evidence) WHERE e.id = $evidenceId SET e.active = false;", { evidenceId: input.evidenceId });
      for (const rel of REJECT_EVIDENCE_REL_TYPES) {
        await this.query(`MATCH ()-[r:${rel}]->() WHERE r.evidenceId = $evidenceId SET r.active = false;`, { evidenceId: input.evidenceId });
      }
    });
  }

  async upsertAliasOverride(input: { alias: string; targetRepoId: string; reason: string }): Promise<void> {
    const createdAt = new Date().toISOString();
    await this.query(
      "MERGE (a:AliasOverride {id: $id}) ON CREATE SET a.alias=$alias, a.targetRepoId=$targetRepoId, a.reason=$reason, a.createdAt=$createdAt, a.active=true ON MATCH SET a.targetRepoId=$targetRepoId, a.reason=$reason, a.createdAt=$createdAt, a.active=true;",
      { id: `alias:${input.alias.toLowerCase()}`, alias: input.alias, targetRepoId: input.targetRepoId, reason: input.reason, createdAt }
    );
  }

  async listContracts(options: { limit?: number; kind?: ContractKind; repo?: string; direction?: "outgoing" | "incoming" } = {}): Promise<ContractSummaryRow[]> {
    const limit = options.limit ?? 100;
    const conditions: string[] = [];
    const params: Record<string, GraphValue> = {};

    if (options.kind) {
      conditions.push("c.kind = $kind");
      params.kind = options.kind;
    }

    if (options.repo) {
      params.repoId = options.repo;
      if (options.direction === "outgoing") {
        conditions.push(
          "(EXISTS { MATCH (r:Repo)-[p:PRODUCES]->(c) WHERE r.id = $repoId AND (p.active IS NULL OR p.active = true) }" +
          " OR EXISTS { MATCH (r:Repo)-[o:OWNS_PACKAGE]->(c) WHERE r.id = $repoId AND (o.active IS NULL OR o.active = true) })"
        );
      } else if (options.direction === "incoming") {
        conditions.push(
          "EXISTS { MATCH (r:Repo)-[u:CONSUMES]->(c) WHERE r.id = $repoId AND (u.active IS NULL OR u.active = true) }"
        );
      } else {
        conditions.push(
          "(EXISTS { MATCH (r:Repo)-[p:PRODUCES]->(c) WHERE r.id = $repoId AND (p.active IS NULL OR p.active = true) }" +
          " OR EXISTS { MATCH (r:Repo)-[o:OWNS_PACKAGE]->(c) WHERE r.id = $repoId AND (o.active IS NULL OR o.active = true) }" +
          " OR EXISTS { MATCH (r:Repo)-[u:CONSUMES]->(c) WHERE r.id = $repoId AND (u.active IS NULL OR u.active = true) }" +
          " OR EXISTS { MATCH (r:Repo)-[s:SHARES_CONTRACT]->(c) WHERE r.id = $repoId AND (s.active IS NULL OR s.active = true) })"
        );
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    return this.query<ContractSummaryRow>(
      `MATCH (c:Contract)
       ${whereClause}
       RETURN c.kind AS kind, c.key AS key, c.name AS name,
         COUNT { MATCH (:Repo)-[p:PRODUCES]->(c) WHERE p.active IS NULL OR p.active = true }
         + COUNT { MATCH (:Repo)-[o:OWNS_PACKAGE]->(c) WHERE o.active IS NULL OR o.active = true } AS producers,
         COUNT { MATCH (:Repo)-[u:CONSUMES]->(c) WHERE u.active IS NULL OR u.active = true } AS consumers,
         COUNT { MATCH (:Repo)-[s:SHARES_CONTRACT]->(c) WHERE s.active IS NULL OR s.active = true } AS shared
       ORDER BY c.kind, c.key
       LIMIT ${limit};`,
      Object.keys(params).length > 0 ? params : undefined
    );
  }

  async query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
    const active = this.activeTransaction();
    if (active) {
      return this.queryWithConnection<T>(active.conn, cypher, params);
    }
    const conn = await this.createConnection();
    try {
      return await this.queryWithConnection<T>(conn, cypher, params);
    } finally {
      await conn.close();
    }
  }

  private async queryWithConnection<T>(conn: kuzu.Connection, cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
    if (params && Object.keys(params).length > 0) {
      const statement = await conn.prepare(cypher);
      if (!statement.isSuccess()) throw new Error(statement.getErrorMessage());
      return allRows(await conn.execute(statement, params)) as Promise<T[]>;
    }
    return allRows(await conn.query(cypher)) as Promise<T[]>;
  }

  async stats(): Promise<Stats> {
    return this.crud.stats();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.manualTx) {
      const tx = this.manualTx;
      this.manualTx = undefined;
      try {
        await tx.conn.query("ROLLBACK;");
      } catch {}
      await tx.conn.close();
    }

    if (shouldUseManagedKuzuClose()) {
      if (this.managedKey && this.db) {
        managedKuzuHandles.set(this.managedKey, { db: this.db });
      }
      this.db = undefined;
      return;
    }

    const db = this.db;
    this.db = undefined;
    if (db) await db.close();
  }

  private database(): kuzu.Database {
    if (this.closed || !this.db) throw new Error("Graph database is closed");
    return this.db;
  }

  private activeTransaction(): KuzuTransactionContext | undefined {
    return this.txStorage.getStore() ?? this.manualTx;
  }

  private async createConnection(): Promise<kuzu.Connection> {
    const conn = new kuzu.Connection(this.database());
    await conn.init();
    return conn;
  }

  private async withConnection<T>(fn: (conn: kuzu.Connection) => Promise<T>): Promise<T> {
    const conn = await this.createConnection();
    try {
      return await fn(conn);
    } finally {
      await conn.close();
    }
  }
}

function shouldUseManagedKuzuClose(): boolean {
  const mode = getBrandedEnv("KUZU_CLOSE_MODE")?.toLowerCase();
  if (mode === "explicit") return false;
  return true;
}
