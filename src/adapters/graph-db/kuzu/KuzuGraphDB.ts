import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
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
import { schemaStatements } from "../../../core/graph-model/schema.js";
import { createCypherCrud, type CypherCrud } from "../../../core/graph-model/cypherCrud.js";
import {
  deletePublicGraphGeneration,
  publicGraphStatsId,
  publicNodeStorageId,
  publicRelationshipScopeParams,
  type PublicGraphGenerationScope
} from "../../../core/graph-model/publicGraphGeneration.js";
import { assertNoLivePublicGraphReadLeases } from "../../../core/graph-model/readSnapshot.js";
import { getBrandedEnv } from "../../../shared/branding.js";
import { SCHEMA_INDEX_VERSION } from "../../../core/schema/model.js";
import {
  GraphDatabaseOperationalError,
  GraphDatabaseClosedError,
  type GraphDatabaseErrorClassifier,
  type GraphDB,
  type GraphValue,
  type GraphWriteAtomicityMode,
  type GraphWriteBatchStatus,
  type GraphWriteBatchJournal,
  type IncrementalIndexCommitRequest,
  type PublicGraphStatsUpdate,
  type PublicGraphStatsSnapshot,
  type ActiveAliasOverride,
  type ContractSummaryRow,
  type Stats,
  withTransaction,
  ALL_EVIDENCE_REL_TYPES,
  REJECT_EVIDENCE_REL_TYPES,
  validateIncrementalIndexCommitRequest
} from "../../../core/graph-model/db.js";

/**
 * Kuzu does not currently expose structured query error codes in its Node API.
 * Keep this allow-list deliberately narrow: parser, binder, schema, parameter,
 * conversion, and unknown errors are programming/contract failures.
 */
export const classifyKuzuQueryError: GraphDatabaseErrorClassifier = (error) => {
  if (!(error instanceof Error)) return undefined;
  const message = error.message.toLowerCase();
  if (/\b(?:timed?\s*out|timeout)\b/.test(message)) return "timeout";
  if (/\b(?:connection (?:exception|failed|failure|lost|reset|refused|aborted|closed)|broken pipe|network (?:is )?unreachable)\b/.test(message)) {
    return "connection";
  }
  if (/\b(?:service|database) (?:is )?(?:temporarily )?unavailable\b/.test(message)) return "service-unavailable";
  return undefined;
};

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

type IncrementalCommitStateRow = {
  activeGeneration?: GraphValue;
  activeRevision?: GraphValue;
  pendingGeneration?: GraphValue;
  pendingRevision?: GraphValue;
  pendingParentGeneration?: GraphValue;
  pendingParentRevision?: GraphValue;
  pendingLeaseUntil?: GraphValue;
};

function optionalString(value: GraphValue | undefined): string {
  return typeof value === "string" ? value : "";
}

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
  generation: string;
  parentGeneration?: string | null;
  repoIds: string;
  repoNames: string;
  writerMode: string;
  atomicityMode: GraphWriteAtomicityMode;
  workspaceId?: string | null;
  status: GraphWriteBatchStatus;
  startedAt: string;
  updatedAt: string;
  completedStage: string;
  error: string;
}): GraphWriteBatchJournal {
  return {
    batchId: row.batchId,
    generation: row.generation,
    parentGeneration: row.parentGeneration || undefined,
    repoIds: decodeList(row.repoIds),
    repoNames: decodeList(row.repoNames),
    writerMode: row.writerMode,
    atomicityMode: row.atomicityMode,
    workspaceId: row.workspaceId ?? "",
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
const TEST_BUFFER_MANAGER_SIZE = 268435456; // 256 MiB
const TEST_MAX_DB_SIZE = 536870912; // 512 MiB (2^29)

function isVitestProcess(): boolean {
  return process.env.VITEST === "true";
}

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
  private retainHandleOnClose: boolean;
  private manualTx?: KuzuTransactionContext;
  private readonly txStorage = new AsyncLocalStorage<KuzuTransactionContext>();
  private writeTransactionTail: Promise<void> = Promise.resolve();
  private readonly crud: CypherCrud;

  private constructor(db: kuzu.Database, managedKey: string, retainHandleOnClose: boolean) {
    this.db = db;
    this.managedKey = managedKey;
    this.retainHandleOnClose = retainHandleOnClose;
    this.crud = createCypherCrud(this);
  }

  static async open(graphPath: string): Promise<KuzuGraphDB> {
    const resolved = path.resolve(graphPath);
    const dbPath = path.extname(resolved) ? resolved : path.join(resolved, "kuzu.db");
    const managed = managedKuzuHandles.get(dbPath);
    if (managed) return new KuzuGraphDB(managed.db, dbPath, true);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    // Lower checkpoint threshold (default 16 MB) so dirty WAL pages are
    // flushed more frequently during bulk writes.  Without this, LOAD FROM
    // + MATCH + MERGE across many pair tables (CONTAINS, MENTIONS,
    // HAS_EVIDENCE) can exhaust the buffer pool before a checkpoint fires.
    const db = new kuzu.Database(
      dbPath,
      isVitestProcess() ? TEST_BUFFER_MANAGER_SIZE : 0,
      true,            // enableCompression
      false,           // readOnly
      isVitestProcess() ? TEST_MAX_DB_SIZE : resolveMaxDBSize(),
      true,            // autoCheckpoint
      1048576          // checkpointThreshold — 1 MB instead of 16 MB
    );
    await db.init();
    const retainHandleOnClose = shouldUseManagedKuzuClose();
    if (retainHandleOnClose) {
      managedKuzuHandles.set(dbPath, { db });
    }
    return new KuzuGraphDB(db, dbPath, retainHandleOnClose);
  }

  /** Kuzu's FTS extension cannot be safely unloaded by native close in-process. */
  retainNativeHandleOnClose(): void {
    this.retainHandleOnClose = true;
  }

  async initSchema(_systemName = "default-system"): Promise<void> {
    await this.withConnection(async (conn) => {
      for (const statement of schemaStatements) await conn.query(statement);
    });
    const publicGraphColumns = await this.query<TableInfoRow>("CALL table_info('System') RETURN name;");
    if (!publicGraphColumns.some((column) => column.name === "storageId")) {
      throw new Error(
        "Kuzu public graph tables use the legacy logical-ID primary key; " +
        `remove the generated Kuzu database and run a clean full reindex before using schema index version ${SCHEMA_INDEX_VERSION}.`
      );
    }
    await this.ensureColumn("System", "summary", "STRING");
    await this.ensureColumn("Repo", "summary", "STRING");
    await this.ensureColumn("IndexState", "graphWriteAtomicity", "STRING");
    await this.ensureColumn("IndexState", "graphWriteStatus", "STRING");
    await this.ensureColumn("IndexState", "lexicalDocumentCount", "INT64");
    await this.ensureColumn("IndexState", "lexicalIndexSizeBytes", "INT64");
    await this.ensureColumn("IndexState", "lexicalProjectionSchemaVersion", "STRING");
    await this.ensureColumn("IndexState", "lexicalTokenizerVersion", "STRING");
    await this.ensureColumn("IndexState", "lexicalIndexStatus", "STRING");
    await this.ensureColumn("IndexState", "lexicalProjectionDurationMs", "INT64");
    await this.ensureColumn("IndexState", "lexicalWriteDurationMs", "INT64");
    await this.ensureColumn("GraphWriteBatch", "workspaceId", "STRING");
    await this.ensureColumn("GraphWriteBatch", "generation", "STRING");
    await this.ensureColumn("GraphWriteBatch", "parentGeneration", "STRING");
    await this.ensureColumn("SchemaGenerationState", "pendingGeneration", "STRING");
    await this.ensureColumn("SchemaGenerationState", "activeRevision", "STRING");
    await this.ensureColumn("SchemaGenerationState", "pendingRevision", "STRING");
    await this.ensureColumn("SchemaGenerationState", "pendingParentGeneration", "STRING");
    await this.ensureColumn("SchemaGenerationState", "pendingParentRevision", "STRING");
    await this.ensureColumn("SchemaGenerationState", "pendingLeaseUntil", "STRING");
    await this.ensureColumn("SchemaGenerationState", "protocolNonce", "STRING");
    await this.ensureColumn("SchemaGeneration", "activeRevision", "STRING");
    await this.ensureColumn("SchemaGeneration", "lexicalProjectionVersion", "STRING");
    await this.ensureColumn("SchemaGeneration", "updatedAt", "STRING");
    await this.ensureColumn("SchemaSourceReplacement", "revision", "STRING");
    await this.ensureColumn("SchemaBehaviorReplacement", "revision", "STRING");
    await this.ensureColumn("SchemaContributionReplacement", "revision", "STRING");
    const schemaFactColumns: Readonly<Record<string, readonly string[]>> = {
      TypeDeclarationFact: ["factId", "languageId", "resolutionScopeId", "canonicalName"],
      ResolutionContextFact: ["factId", "languageId", "resolutionScopeId"],
      ResolutionScopeDependencyFact: [
        "factId",
        "sourceContextId",
        "fromLanguageId",
        "fromRepoId",
        "fromResolutionScopeId",
        "toLanguageId",
        "toRepoId",
        "toResolutionScopeId"
      ],
      SchemaRootFact: [
        "factId",
        "rootReferenceId",
        "ownerFileId",
        "ownerSpecId",
        "resolutionContextId",
        "languageId"
      ],
      SchemaDependencyFact: ["factId", "rootReferenceId", "declarationId"],
      SchemaProvenanceFact: ["factId", "rootReferenceId", "relationId"],
      SchemaDiagnosticFact: ["factId", "rootReferenceId", "ownerSpecId", "languageId", "resolutionScopeId"],
      SchemaBehaviorFingerprintFact: ["factId", "languageId", "resolutionScopeId"]
    };
    for (const [tableName, columnNames] of Object.entries(schemaFactColumns)) {
      for (const columnName of columnNames) {
        await this.ensureColumn(tableName, columnName, "STRING");
      }
    }
    for (const tableName of ["File", "Code", "Section", "Evidence"]) {
      await this.ensureColumn(tableName, "batchId", "STRING");
      await this.ensureColumn(tableName, "indexedAt", "STRING");
      await this.ensureColumn(tableName, "active", "BOOL");
    }
    await this.ensureColumn("File", "directory", "STRING");
    for (const tableName of ["IMPORTS", "CALLS", "OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON"]) {
      await this.ensureColumn(tableName, "batchId", "STRING");
      await this.ensureColumn(tableName, "active", "BOOL");
    }
    await this.ensureColumn("CALLS", "resolution", "STRING");
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

    return this.serializeWriteTransaction(async () => {
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
    });
  }

  async readTransaction<T>(fn: () => Promise<T>): Promise<T> {
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
      // Kuzu supports concurrent manual read transactions, while a plain
      // BEGIN TRANSACTION consumes its process-wide single writer slot.
      await conn.query("BEGIN TRANSACTION READ ONLY;");
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

  async applyIncrementalIndexMutation<T>(
    request: Readonly<IncrementalIndexCommitRequest>,
    apply: () => Promise<T>
  ): Promise<T> {
    validateIncrementalIndexCommitRequest(request);
    const stateId = `schema-generation-state:${request.workspaceId}`;

    return this.transaction(async () => {
      const lockNonce = `incremental-commit:${request.nextRevision}:${randomUUID()}`;
      const stateRows = await this.query<IncrementalCommitStateRow>(
        "MATCH (s:SchemaGenerationState {id: $stateId}) " +
        "SET s.protocolNonce=$lockNonce " +
        "RETURN s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision, " +
        "s.pendingGeneration AS pendingGeneration, s.pendingRevision AS pendingRevision, " +
        "s.pendingParentGeneration AS pendingParentGeneration, " +
        "s.pendingParentRevision AS pendingParentRevision, s.pendingLeaseUntil AS pendingLeaseUntil;",
        { stateId, lockNonce }
      );
      const state = stateRows[0];
      if (!state) {
        throw new Error(`Incremental index commit has no generation state for workspace ${request.workspaceId}.`);
      }
      const leaseUntil = optionalString(state.pendingLeaseUntil);
      const leaseTimestamp = Date.parse(leaseUntil);
      const reservationMatches =
        optionalString(state.activeGeneration) === request.expectedActiveGeneration &&
        optionalString(state.activeRevision) === request.expectedActiveRevision &&
        optionalString(state.pendingGeneration) === "" &&
        optionalString(state.pendingRevision) === request.nextRevision &&
        optionalString(state.pendingParentGeneration) === request.expectedActiveGeneration &&
        optionalString(state.pendingParentRevision) === request.expectedActiveRevision;
      if (!reservationMatches) {
        throw new Error(
          `Incremental index revision ${request.nextRevision} lost its workspace reservation or active parent.`
        );
      }
      if (!Number.isFinite(leaseTimestamp) || leaseTimestamp <= Date.now()) {
        throw new Error(`Incremental index revision ${request.nextRevision} has an expired workspace reservation.`);
      }

      // The callback contains only the already-prepared graph, schema, and
      // lexical delta. AsyncLocalStorage keeps all nested provider calls on
      // this same transaction, so any callback failure rolls the delta back.
      const result = await apply();
      const statsRows = await this.query<{ revision?: GraphValue }>(
        "MATCH (s:PublicGraphStats {id: $statsId}) " +
        "WHERE s.workspaceId=$workspaceId AND s.generation=$generation AND s.revision=$nextRevision " +
        "RETURN s.revision AS revision;",
        {
          statsId: publicGraphStatsId({
            workspaceId: request.workspaceId,
            generation: request.expectedActiveGeneration
          }),
          workspaceId: request.workspaceId,
          generation: request.expectedActiveGeneration,
          nextRevision: request.nextRevision
        }
      );
      if (statsRows.length !== 1 || optionalString(statsRows[0]?.revision) !== request.nextRevision) {
        throw new Error(
          `Incremental index revision ${request.nextRevision} did not publish matching public graph stats metadata.`
        );
      }
      const updatedAt = new Date().toISOString();
      const generationRows = await this.query<{ id?: GraphValue }>(
        "MATCH (g:SchemaGeneration {id: $generation}) " +
        "WHERE g.workspaceId=$workspaceId AND g.status='active' " +
        "SET g.activeRevision=$nextRevision, g.schemaIndexVersion=$schemaIndexVersion, " +
        "g.lexicalProjectionVersion=$lexicalProjectionVersion, g.updatedAt=$updatedAt " +
        "RETURN g.id AS id;",
        {
          generation: request.expectedActiveGeneration,
          workspaceId: request.workspaceId,
          nextRevision: request.nextRevision,
          schemaIndexVersion: request.schemaIndexVersion,
          lexicalProjectionVersion: request.lexicalProjectionVersion,
          updatedAt
        }
      );
      if (generationRows.length !== 1) {
        throw new Error(
          `Incremental index commit cannot update active generation ${request.expectedActiveGeneration}.`
        );
      }

      const committedRows = await this.query<{ activeRevision?: GraphValue }>(
        "MATCH (s:SchemaGenerationState {id: $stateId}) " +
        "WHERE s.activeGeneration=$expectedActiveGeneration " +
        "AND s.activeRevision=$expectedActiveRevision AND s.pendingGeneration='' " +
        "AND s.pendingRevision=$nextRevision " +
        "AND s.pendingParentGeneration=$expectedActiveGeneration " +
        "AND s.pendingParentRevision=$expectedActiveRevision " +
        "AND s.pendingLeaseUntil=$pendingLeaseUntil " +
        "SET s.activeRevision=$nextRevision, s.pendingRevision='', " +
        "s.pendingParentGeneration='', s.pendingParentRevision='', s.pendingLeaseUntil='', " +
        "s.schemaIndexVersion=$schemaIndexVersion, " +
        "s.lexicalProjectionVersion=$lexicalProjectionVersion, s.protocolNonce=$lockNonce " +
        "RETURN s.activeRevision AS activeRevision;",
        {
          stateId,
          expectedActiveGeneration: request.expectedActiveGeneration,
          expectedActiveRevision: request.expectedActiveRevision,
          nextRevision: request.nextRevision,
          pendingLeaseUntil: leaseUntil,
          schemaIndexVersion: request.schemaIndexVersion,
          lexicalProjectionVersion: request.lexicalProjectionVersion,
          lockNonce
        }
      );
      if (committedRows.length !== 1 || optionalString(committedRows[0]?.activeRevision) !== request.nextRevision) {
        throw new Error(`Incremental index revision ${request.nextRevision} failed its final compare-and-swap.`);
      }
      return result;
    });
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

  async upsertSystem(systemName: string, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertSystem(systemName, scope);
  }

  async upsertRepo(repo: RepoNode, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertRepo(repo, scope);
  }

  async updateRepoSummary(repoIdValue: string, summary: string, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.updateRepoSummary(repoIdValue, summary, scope);
  }

  async updateSystemSummary(summary: string, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.updateSystemSummary(summary, scope);
  }

  async upsertFile(file: FileNode, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertFile(file, scope);
  }

  async upsertFilesBatch(files: FileNode[], scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertFilesBatch(files, scope);
  }

  async upsertCode(code: CodeSymbol, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertCode(code, scope);
  }

  async upsertCodeBatch(codes: CodeSymbol[], scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertCodeBatch(codes, scope);
  }

  async upsertSection(section: DocSection, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertSection(section, scope);
  }

  async upsertEntity(entity: EntityNode, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertEntity(entity, scope);
  }

  async upsertOperation(operation: OperationNode, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertOperation(operation, scope);
  }

  async upsertWorkflow(workflow: WorkflowNode, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertWorkflow(workflow, scope);
  }

  async upsertContract(contract: ContractNode, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertContract(contract, scope);
  }

  async upsertEvidence(evidence: EvidenceNode, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertEvidence(evidence, scope);
  }

  async addRepoContract(edge: RepoContractEdge, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addRepoContract(edge, scope);
  }

  async addRepoDependency(edge: RepoDependencyEdge, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addRepoDependency(edge, scope);
  }

  async addRepoDependenciesBatch(edges: RepoDependencyEdge[], scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addRepoDependenciesBatch(edges, scope);
  }

  async addPackageUsage(edge: PackageUsageEdge, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addPackageUsage(edge, scope);
  }

  async addContractEntity(edge: ContractEntityEdge, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addContractEntity(edge, scope);
  }

  async addOperationRepo(edge: OperationRepoEdge, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addOperationRepo(edge, scope);
  }

  async addWorkflowOperation(edge: WorkflowOperationEdge, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addWorkflowOperation(edge, scope);
  }

  async upsertContractSpec(spec: ContractSpecNode, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.upsertContractSpec(spec, scope);
  }

  async addHasSpec(edge: ContractSpecEdge, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addHasSpec(edge, scope);
  }

  async addSemanticRelation(edge: SemanticRelationEdge, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addSemanticRelation(edge, scope);
  }

  async addSemanticRelationsBatch(edges: SemanticRelationEdge[], scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addSemanticRelationsBatch(edges, scope);
  }

  async clearSemanticRelationsForSpecs(specIds: string[], scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.clearSemanticRelationsForSpecs(specIds, scope);
  }

  async addContractEvidence(contractIdValue: string, evidenceIdValue: string, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addContractEvidence(contractIdValue, evidenceIdValue, scope);
  }

  async addRepoEvidence(repoIdValue: string, evidenceIdValue: string, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addRepoEvidence(repoIdValue, evidenceIdValue, scope);
  }

  async addContains(fromId: string, toId: string, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addContains(fromId, toId, scope);
  }

  async addImport(edge: ImportEdge, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addImport(edge, scope);
  }

  async addImportsBatch(edges: ImportEdge[], scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addImportsBatch(edges, scope);
  }

  async addCall(edge: CallEdge, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addCall(edge, scope);
  }

  async addCallsBatch(edges: CallEdge[], scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addCallsBatch(edges, scope);
  }

  async addMention(codeIdValue: string, entityIdValue: string, confidence: number, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addMention(codeIdValue, entityIdValue, confidence, scope);
  }

  async addSectionMention(sectionIdValue: string, entityIdValue: string, confidence: number, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addSectionMention(sectionIdValue, entityIdValue, confidence, scope);
  }

  async addSectionDescribesRepo(sectionIdValue: string, repoIdValue: string, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addSectionDescribesRepo(sectionIdValue, repoIdValue, scope);
  }

  async addSectionDocumentsCode(sectionIdValue: string, codeIdValue: string, confidence: number, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addSectionDocumentsCode(sectionIdValue, codeIdValue, confidence, scope);
  }

  async addSectionReferencesFile(sectionIdValue: string, fileIdValue: string, raw: string, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.addSectionReferencesFile(sectionIdValue, fileIdValue, raw, scope);
  }

  async clearRepoDependencies(repoIds: string[] | undefined, scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.clearRepoDependencies(repoIds, scope);
  }

  async clearRepoDependenciesForContracts(contractIds: string[], scope: PublicGraphGenerationScope): Promise<void> {
    await this.crud.clearRepoDependenciesForContracts(contractIds, scope);
  }

  async clearRepoIndexedArtifacts(repoId: string, scope: PublicGraphGenerationScope): Promise<void> {
    const params: Record<string, GraphValue> = {
      ...publicRelationshipScopeParams(scope),
      repoId
    };
    await withTransaction(this, async () => {
      const evidenceRows = await this.query<{ id: string }>(
        "MATCH (e:Evidence) WHERE e.workspaceId = $workspaceId AND e.generation = $generation AND e.repoId = $repoId RETURN e.id AS id;",
        params
      );
      const evidenceIds = evidenceRows.map((row) => row.id);
      const cleanupParams: Record<string, GraphValue> = evidenceIds.length > 0
        ? { ...params, evidenceIds }
        : params;
      const evidenceCondition = evidenceIds.length > 0 ? " OR r.evidenceId IN $evidenceIds" : "";
      await this.query(
        "MATCH (a)-[r]->(b) WHERE r.workspaceId = $workspaceId AND r.generation = $generation " +
        "AND a.workspaceId = $workspaceId AND a.generation = $generation " +
        "AND b.workspaceId = $workspaceId AND b.generation = $generation " +
        `AND (a.id = $repoId OR b.id = $repoId OR a.repoId = $repoId OR b.repoId = $repoId${evidenceCondition}) DELETE r;`,
        cleanupParams
      );
      for (const label of ["Evidence", "Code", "Section", "File", "ContractSpec"]) {
        await this.query(
          `MATCH (n:${label}) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId DELETE n;`,
          params
        );
      }
    });
  }

  async deletePublicGraphGeneration(scope: PublicGraphGenerationScope): Promise<void> {
    await this.transaction(async () => {
      const states = await this.query<{ activeGeneration?: string; pendingGeneration?: string }>(
        "MATCH (s:SchemaGenerationState {id: $id}) SET s.protocolNonce=$nonce RETURN s.activeGeneration AS activeGeneration, s.pendingGeneration AS pendingGeneration;",
        { id: `schema-generation-state:${scope.workspaceId}`, nonce: `public-cleanup:${scope.generation}` }
      );
      if (states[0]?.activeGeneration === scope.generation) {
        throw new Error(`Refusing to delete active public graph generation ${scope.generation}.`);
      }
      if (states[0]?.pendingGeneration === scope.generation) {
        throw new Error(`Refusing to delete reserved pending public graph generation ${scope.generation}.`);
      }
      await assertNoLivePublicGraphReadLeases(this, scope);
      await deletePublicGraphGeneration(this, scope);
    });
  }

  async beginGraphWriteBatch(journal: Omit<GraphWriteBatchJournal, "status" | "updatedAt"> & { updatedAt?: string }): Promise<void> {
    const updatedAt = journal.updatedAt ?? journal.startedAt;
    await withTransaction(this, async () => {
      await this.query(
      "MERGE (b:GraphWriteBatch {id: $id}) ON CREATE SET b.batchId=$batchId, b.generation=$generation, b.parentGeneration=$parentGeneration, b.repoIds=$repoIds, b.repoNames=$repoNames, b.writerMode=$writerMode, b.atomicityMode=$atomicityMode, b.workspaceId=$workspaceId, b.status=$status, b.startedAt=$startedAt, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error ON MATCH SET b.batchId=$batchId, b.generation=$generation, b.parentGeneration=$parentGeneration, b.repoIds=$repoIds, b.repoNames=$repoNames, b.writerMode=$writerMode, b.atomicityMode=$atomicityMode, b.workspaceId=$workspaceId, b.status=$status, b.startedAt=$startedAt, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error;",
      {
        id: `graph-write:${journal.batchId}`,
        batchId: journal.batchId,
        generation: journal.generation,
        parentGeneration: journal.parentGeneration ?? "",
        repoIds: encodeList(journal.repoIds),
        repoNames: encodeList(journal.repoNames),
        writerMode: journal.writerMode,
        atomicityMode: journal.atomicityMode,
        workspaceId: journal.workspaceId,
        status: "started",
        startedAt: journal.startedAt,
        updatedAt,
        completedStage: journal.completedStage ?? "pending-created",
        error: journal.error ?? ""
      }
      );
    });
  }

  async commitGraphWriteBatch(input: { batchId: string; updatedAt: string; completedStage?: string }): Promise<void> {
    await this.transaction(async () => {
      await this.query(
        "MATCH (b:GraphWriteBatch {id: $id}) SET b.status=$status, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error;",
        { id: `graph-write:${input.batchId}`, status: "committed", updatedAt: input.updatedAt, completedStage: input.completedStage ?? "commit", error: "" }
      );
    });
  }

  async failGraphWriteBatch(input: { batchId: string; updatedAt: string; error: string; completedStage?: string; awaitingCleanup?: boolean }): Promise<void> {
    await this.transaction(async () => {
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
    });
  }

  async recoverIncompleteGraphWriteBatches(input: { repoIds?: string[]; workspaceId?: string; generation?: string; updatedAt: string; cleanupBatch?: (journal: GraphWriteBatchJournal) => Promise<void> }): Promise<GraphWriteBatchJournal[]> {
    const rows = await this.query<{
      batchId: string;
      generation: string;
      parentGeneration?: string | null;
      repoIds: string;
      repoNames: string;
      writerMode: string;
      atomicityMode: GraphWriteAtomicityMode;
      workspaceId?: string | null;
      status: GraphWriteBatchStatus;
      startedAt: string;
      updatedAt: string;
      completedStage: string;
      error: string;
    }>(
      "MATCH (b:GraphWriteBatch) WHERE b.status = 'started' OR b.status = 'awaiting-cleanup' RETURN b.batchId AS batchId, b.generation AS generation, b.parentGeneration AS parentGeneration, b.repoIds AS repoIds, b.repoNames AS repoNames, b.writerMode AS writerMode, b.atomicityMode AS atomicityMode, b.workspaceId AS workspaceId, b.status AS status, b.startedAt AS startedAt, b.updatedAt AS updatedAt, b.completedStage AS completedStage, b.error AS error ORDER BY b.updatedAt DESC, b.startedAt DESC, b.batchId DESC;"
    );
    const repoFilter = input.repoIds && input.repoIds.length > 0 ? new Set(input.repoIds) : undefined;
    const journals = rows
      .map((row) => decodeJournalRow(row))
      .filter((journal) => !input.workspaceId || journal.workspaceId === input.workspaceId)
      .filter((journal) => !input.generation || journal.generation === input.generation)
      .filter((journal) => !repoFilter || journal.repoIds.some((repoId) => repoFilter.has(repoId)));
    for (const journal of journals) {
      const cleanupErrors: string[] = [];
      try {
        await this.cleanupGraphWriteBatch(journal.batchId);
      } catch (error) {
        cleanupErrors.push(`graph: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!input.cleanupBatch) {
        cleanupErrors.push("lexical: cleanup callback is required for a workspace-scoped journal");
      } else {
        try {
          await input.cleanupBatch?.(journal);
        } catch (error) {
          cleanupErrors.push(`lexical: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (cleanupErrors.length > 0) {
        await this.failGraphWriteBatch({
          batchId: journal.batchId,
          updatedAt: input.updatedAt,
          error: cleanupErrors.join("; "),
          completedStage: "recovery-cleanup-failed",
          awaitingCleanup: true
        });
        throw new Error(`Failed to recover graph write batch ${journal.batchId}: ${cleanupErrors.join("; ")}`);
      }
      try {
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
      } catch (error) {
        const message = `graph journal finalization: ${error instanceof Error ? error.message : String(error)}`;
        await this.failGraphWriteBatch({
          batchId: journal.batchId,
          updatedAt: input.updatedAt,
          error: message,
          completedStage: "recovery-cleanup-failed",
          awaitingCleanup: true
        });
        throw new Error(`Failed to recover graph write batch ${journal.batchId}: ${message}`);
      }
    }
    return journals;
  }

  async cleanupGraphWriteBatch(batchId: string): Promise<void> {
    await this.transaction(async () => {
      const rows = await this.query<{ workspaceId: string; generation: string; status: GraphWriteBatchStatus }>(
        "MATCH (b:GraphWriteBatch {id: $id}) RETURN b.workspaceId AS workspaceId, b.generation AS generation, b.status AS status;",
        { id: `graph-write:${batchId}` }
      );
      const row = rows[0];
      if (!row) throw new Error(`Missing graph write journal for batch ${batchId}.`);
      if (row.status === "committed") {
        throw new Error(`Refusing to clean committed graph write batch ${batchId}.`);
      }
      const activeRows = await this.query<{ activeGeneration?: string; pendingGeneration?: string }>(
        "MATCH (s:SchemaGenerationState) WHERE s.workspaceId = $workspaceId SET s.protocolNonce=$nonce RETURN s.activeGeneration AS activeGeneration, s.pendingGeneration AS pendingGeneration;",
        { workspaceId: row.workspaceId, nonce: `graph-cleanup:${batchId}` }
      );
      if (activeRows.some((state) => state.activeGeneration === row.generation)) {
        throw new Error(`Refusing to clean active public graph generation ${row.generation}.`);
      }
      if (activeRows.some((state) => state.pendingGeneration === row.generation)) {
        throw new Error(`Refusing to clean reserved pending public graph generation ${row.generation}.`);
      }
      await this.deletePublicGraphGeneration({ workspaceId: row.workspaceId, generation: row.generation });
    });
  }

  async markRepoArtifactsStale(input: { repoId: string; activeFileIds: string[]; batchId: string; indexedAt: string }, scope: PublicGraphGenerationScope): Promise<number> {
    const scopeParams = publicRelationshipScopeParams(scope);
    const staleRows = input.activeFileIds.length === 0
      ? await this.query<{ id: string }>(
        "MATCH (f:File) WHERE f.workspaceId = $workspaceId AND f.generation = $generation AND f.repoId = $repoId AND (f.active IS NULL OR f.active = true) RETURN f.id AS id;",
        { ...scopeParams, repoId: input.repoId }
      )
      : await this.query<{ id: string }>(
        "MATCH (f:File) WHERE f.workspaceId = $workspaceId AND f.generation = $generation AND f.repoId = $repoId AND NOT (f.id IN $activeFileIds) AND (f.active IS NULL OR f.active = true) RETURN f.id AS id;",
        { ...scopeParams, repoId: input.repoId, activeFileIds: input.activeFileIds }
      );
    const staleFileIds = staleRows.map((row) => row.id);

    const evidenceRows = input.activeFileIds.length === 0
      ? await this.query<{ id: string }>(
        "MATCH (e:Evidence) WHERE e.workspaceId = $workspaceId AND e.generation = $generation AND e.repoId = $repoId AND (e.active IS NULL OR e.active = true) RETURN e.id AS id;",
        { ...scopeParams, repoId: input.repoId }
      )
      : await this.query<{ id: string }>(
        "MATCH (e:Evidence) WHERE e.workspaceId = $workspaceId AND e.generation = $generation AND e.repoId = $repoId AND NOT (e.fileId IN $activeFileIds) AND (e.active IS NULL OR e.active = true) RETURN e.id AS id;",
        { ...scopeParams, repoId: input.repoId, activeFileIds: input.activeFileIds }
      );
    const staleEvidenceIds = evidenceRows.map((row) => row.id);

    if (staleFileIds.length === 0 && staleEvidenceIds.length === 0) return 0;

    await withTransaction(this, async () => {
      if (staleFileIds.length > 0) {
        const nodeParams = { ...scopeParams, staleFileIds, batchId: input.batchId, staleIndexedAt: input.indexedAt, active: false };
        const relParams = { ...scopeParams, staleFileIds, batchId: input.batchId, active: false };
        await this.query("MATCH (f:File) WHERE f.workspaceId = $workspaceId AND f.generation = $generation AND f.id IN $staleFileIds SET f.active = $active, f.batchId = $batchId, f.indexedAt = $staleIndexedAt;", nodeParams);
        await this.query("MATCH (c:Code) WHERE c.workspaceId = $workspaceId AND c.generation = $generation AND c.fileId IN $staleFileIds SET c.active = $active, c.batchId = $batchId, c.indexedAt = $staleIndexedAt;", nodeParams);
        await this.query("MATCH (s:Section) WHERE s.workspaceId = $workspaceId AND s.generation = $generation AND s.fileId IN $staleFileIds SET s.active = $active, s.batchId = $batchId, s.indexedAt = $staleIndexedAt;", nodeParams);
        await this.query("MATCH (e:Evidence) WHERE e.workspaceId = $workspaceId AND e.generation = $generation AND e.fileId IN $staleFileIds SET e.active = $active, e.batchId = $batchId, e.indexedAt = $staleIndexedAt;", nodeParams);
        await this.query("MATCH (a:File)-[r:IMPORTS]->(b:File) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND (a.id IN $staleFileIds OR b.id IN $staleFileIds) SET r.active = $active, r.batchId = $batchId;", relParams);
        await this.query("MATCH (a:Code)-[r:CALLS]->(b:Code) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND (a.fileId IN $staleFileIds OR b.fileId IN $staleFileIds) SET r.active = $active, r.batchId = $batchId;", relParams);
        const relTypes = ALL_EVIDENCE_REL_TYPES.join("|");
        await this.query(`MATCH ()-[r:${relTypes}]->(), (e:Evidence) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND e.workspaceId = $workspaceId AND e.generation = $generation AND r.evidenceId = e.id AND e.fileId IN $staleFileIds SET r.active = $active, r.batchId = $batchId;`, relParams);
        await this.query("MATCH (cs:ContractSpec) WHERE cs.workspaceId = $workspaceId AND cs.generation = $generation AND cs.fileId IN $staleFileIds SET cs.active = $active, cs.batchId = $batchId;", relParams);
        await this.query("MATCH (cs:ContractSpec)-[r:SEMANTIC_REL]->(cs2:ContractSpec) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND cs.fileId IN $staleFileIds SET r.active = $active, r.batchId = $batchId;", relParams);
        await this.query("MATCH (cs2:ContractSpec)-[r:SEMANTIC_REL]->(cs:ContractSpec) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND cs.fileId IN $staleFileIds SET r.active = $active, r.batchId = $batchId;", relParams);
      }

      if (staleEvidenceIds.length > 0) {
        const relParams = { ...scopeParams, staleEvidenceIds, batchId: input.batchId, active: false };
        await this.query("MATCH (e:Evidence) WHERE e.workspaceId = $workspaceId AND e.generation = $generation AND e.id IN $staleEvidenceIds SET e.active = $active, e.batchId = $batchId;", relParams);
        const relTypes = ALL_EVIDENCE_REL_TYPES.join("|");
        await this.query(`MATCH ()-[r:${relTypes}]->() WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.evidenceId IN $staleEvidenceIds SET r.active = $active, r.batchId = $batchId;`, relParams);
      }

      if (input.activeFileIds.length === 0) {
        await this.query(
          "MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND (a.id = $repoId OR b.id = $repoId) SET r.active = $active, r.batchId = $batchId;",
          { ...scopeParams, repoId: input.repoId, batchId: input.batchId, active: false }
        );
      }
    });
    // Return only the file count — the IndexState field is named "filesStale".
    return staleFileIds.length;
  }

  async upsertIndexState(state: Parameters<GraphDB["upsertIndexState"]>[0]): Promise<void> {
    await this.crud.upsertIndexState(state);
  }

  async updateGraphWriteBatch(input: { batchId: string; updatedAt: string; completedStage: string }): Promise<void> {
    await this.transaction(async () => {
      await this.query(
        "MATCH (b:GraphWriteBatch {id: $id}) SET b.updatedAt=$updatedAt, b.completedStage=$completedStage;",
        { id: `graph-write:${input.batchId}`, updatedAt: input.updatedAt, completedStage: input.completedStage }
      );
    });
  }

  async knownFileHashes(repoIdValue: string, scope: PublicGraphGenerationScope): Promise<Map<string, string>> {
    return this.crud.knownFileHashes(repoIdValue, scope);
  }

  async repoCount(scope: PublicGraphGenerationScope): Promise<number> {
    return this.crud.repoCount(scope);
  }

  async listRepos(scope: PublicGraphGenerationScope): Promise<RepoNode[]> {
    return this.crud.listRepos(scope);
  }

  async listActiveAliasOverrides(): Promise<ActiveAliasOverride[]> {
    return this.crud.listActiveAliasOverrides();
  }

  async rejectEvidence(input: { evidenceId: string; reason: string }, scope: PublicGraphGenerationScope): Promise<void> {
    const createdAt = new Date().toISOString();
    const scopeParams = publicRelationshipScopeParams(scope);
    await withTransaction(this, async () => {
      const states = await this.query<{ activeGeneration?: string; pendingGeneration?: string }>(
        "MATCH (s:SchemaGenerationState {id: $id}) SET s.protocolNonce=$nonce RETURN s.activeGeneration AS activeGeneration, s.pendingGeneration AS pendingGeneration;",
        { id: `schema-generation-state:${scope.workspaceId}`, nonce: `reject-evidence:${input.evidenceId}` }
      );
      const state = states[0];
      if (state?.activeGeneration !== scope.generation || state.pendingGeneration) {
        throw new Error("Evidence feedback cannot mutate a stale snapshot or run while a workspace generation is pending.");
      }
      await this.query(
        "MERGE (f:RelationFeedback {id: $id}) ON CREATE SET f.evidenceId=$evidenceId, f.action=$action, f.reason=$reason, f.createdAt=$createdAt ON MATCH SET f.action=$action, f.reason=$reason, f.createdAt=$createdAt;",
        { id: `feedback:${scope.workspaceId}:${scope.generation}:${input.evidenceId}:reject`, evidenceId: input.evidenceId, action: "reject", reason: input.reason, createdAt }
      );
      await this.query(
        "MATCH (e:Evidence {storageId: $storageId}) SET e.active = false;",
        { storageId: publicNodeStorageId(scope.generation, input.evidenceId) }
      );
      for (const rel of REJECT_EVIDENCE_REL_TYPES) {
        await this.query(
          `MATCH ()-[r:${rel}]->() WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.evidenceId = $evidenceId SET r.active = false;`,
          { ...scopeParams, evidenceId: input.evidenceId }
        );
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

  async listContracts(scope: PublicGraphGenerationScope, options: { limit?: number; kind?: ContractKind; repo?: string; direction?: "outgoing" | "incoming" } = {}): Promise<ContractSummaryRow[]> {
    const limit = options.limit ?? 100;
    const conditions: string[] = ["c.workspaceId = $workspaceId", "c.generation = $generation"];
    const params: Record<string, GraphValue> = publicRelationshipScopeParams(scope);

    if (options.kind) {
      conditions.push("c.kind = $kind");
      params.kind = options.kind;
    }

    if (options.repo) {
      params.repoId = options.repo;
      if (options.direction === "outgoing") {
        conditions.push(
          "(EXISTS { MATCH (r:Repo)-[p:PRODUCES]->(c) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.id = $repoId AND p.workspaceId = $workspaceId AND p.generation = $generation AND (p.active IS NULL OR p.active = true) }" +
          " OR EXISTS { MATCH (r:Repo)-[o:OWNS_PACKAGE]->(c) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.id = $repoId AND o.workspaceId = $workspaceId AND o.generation = $generation AND (o.active IS NULL OR o.active = true) })"
        );
      } else if (options.direction === "incoming") {
        conditions.push(
          "EXISTS { MATCH (r:Repo)-[u:CONSUMES]->(c) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.id = $repoId AND u.workspaceId = $workspaceId AND u.generation = $generation AND (u.active IS NULL OR u.active = true) }"
        );
      } else {
        conditions.push(
          "(EXISTS { MATCH (r:Repo)-[p:PRODUCES]->(c) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.id = $repoId AND p.workspaceId = $workspaceId AND p.generation = $generation AND (p.active IS NULL OR p.active = true) }" +
          " OR EXISTS { MATCH (r:Repo)-[o:OWNS_PACKAGE]->(c) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.id = $repoId AND o.workspaceId = $workspaceId AND o.generation = $generation AND (o.active IS NULL OR o.active = true) }" +
          " OR EXISTS { MATCH (r:Repo)-[u:CONSUMES]->(c) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.id = $repoId AND u.workspaceId = $workspaceId AND u.generation = $generation AND (u.active IS NULL OR u.active = true) }" +
          " OR EXISTS { MATCH (r:Repo)-[s:SHARES_CONTRACT]->(c) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.id = $repoId AND s.workspaceId = $workspaceId AND s.generation = $generation AND (s.active IS NULL OR s.active = true) })"
        );
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    return this.query<ContractSummaryRow>(
      `MATCH (c:Contract)
       ${whereClause}
       RETURN c.kind AS kind, c.key AS key, c.name AS name,
         COUNT { MATCH (:Repo)-[p:PRODUCES]->(c) WHERE p.workspaceId = $workspaceId AND p.generation = $generation AND (p.active IS NULL OR p.active = true) }
         + COUNT { MATCH (:Repo)-[o:OWNS_PACKAGE]->(c) WHERE o.workspaceId = $workspaceId AND o.generation = $generation AND (o.active IS NULL OR o.active = true) } AS producers,
         COUNT { MATCH (:Repo)-[u:CONSUMES]->(c) WHERE u.workspaceId = $workspaceId AND u.generation = $generation AND (u.active IS NULL OR u.active = true) } AS consumers,
         COUNT { MATCH (:Repo)-[s:SHARES_CONTRACT]->(c) WHERE s.workspaceId = $workspaceId AND s.generation = $generation AND (s.active IS NULL OR s.active = true) } AS shared
       ORDER BY c.kind, c.key
       LIMIT ${limit};`,
      Object.keys(params).length > 0 ? params : undefined
    );
  }

  async query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
    try {
      const active = this.activeTransaction();
      if (active) {
        return await this.queryWithConnection<T>(active.conn, cypher, params);
      }
      const conn = await this.createConnection();
      try {
        return await this.queryWithConnection<T>(conn, cypher, params);
      } finally {
        await conn.close();
      }
    } catch (error) {
      if (error instanceof GraphDatabaseClosedError) throw error;
      if (error instanceof GraphDatabaseOperationalError) throw error;
      const kind = classifyKuzuQueryError(error);
      if (!kind) throw error;
      throw new GraphDatabaseOperationalError({ cause: error, kind });
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

  async readPublicGraphStats(scope: PublicGraphGenerationScope): Promise<PublicGraphStatsSnapshot | undefined> {
    return this.crud.readPublicGraphStats(scope);
  }

  async computePublicGraphStats(scope: PublicGraphGenerationScope): Promise<Stats> {
    return this.crud.computePublicGraphStats(scope);
  }

  async initializePublicGraphStats(
    scope: PublicGraphGenerationScope,
    revision: string,
    stats: Readonly<Stats>
  ): Promise<void> {
    await this.crud.initializePublicGraphStats(scope, revision, stats);
  }

  async applyPublicGraphStatsDelta(
    scope: PublicGraphGenerationScope,
    update: PublicGraphStatsUpdate
  ): Promise<Stats> {
    return this.crud.applyPublicGraphStatsDelta(scope, update);
  }

  async stats(scope: PublicGraphGenerationScope): Promise<Stats> {
    return this.crud.stats(scope);
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

    if (this.retainHandleOnClose) {
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
    if (this.closed || !this.db) throw new GraphDatabaseClosedError();
    return this.db;
  }

  private activeTransaction(): KuzuTransactionContext | undefined {
    return this.txStorage.getStore() ?? this.manualTx;
  }

  private async serializeWriteTransaction<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTransactionTail;
    let release!: () => void;
    this.writeTransactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
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
