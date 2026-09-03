import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import neo4j, { type Driver, type Session, type Record as Neo4jRecord, type Integer } from "neo4j-driver";
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
import { createCypherCrud, type CypherCrud } from "../../../core/graph-model/cypherCrud.js";
import {
  PUBLIC_GRAPH_NODE_LABELS,
  deletePublicGraphGeneration,
  publicGraphStatsId,
  publicNodeStorageId,
  publicRelationshipScopeParams,
  type PublicGraphGenerationScope
} from "../../../core/graph-model/publicGraphGeneration.js";
import { assertNoLivePublicGraphReadLeases } from "../../../core/graph-model/readSnapshot.js";
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

type Neo4jCodedError = Error & { code?: unknown };

type Neo4jTransaction = ReturnType<Session["beginTransaction"]>;

type Neo4jTransactionContext = {
  session: Session;
  transaction: Neo4jTransaction;
  depth: number;
};

type Neo4jConstraintRow = {
  name?: unknown;
  labelsOrTypes?: unknown;
  properties?: unknown;
  type?: unknown;
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

function neo4jIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

export const classifyNeo4jQueryError: GraphDatabaseErrorClassifier = (error) => {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Neo4jCodedError).code;
  if (typeof code !== "string") return undefined;
  if (code === "ServiceUnavailable") return "service-unavailable";
  if (code === "SessionExpired") return "connection";
  if (code.startsWith("Neo.TransientError.")) {
    return /timeout|timedout/i.test(code) ? "timeout" : "transient";
  }
  return undefined;
};

export function neo4jQueryAccessMode(cypher: string): "READ" | "WRITE" {
  const normalized = cypher.trim().toUpperCase();
  return /\b(CREATE|MERGE|SET|DELETE|REMOVE|DETACH|DROP)\b/.test(normalized) ? "WRITE" : "READ";
}

/**
 * Convert a GraphValue to a Neo4j-compatible value.
 * Neo4j driver handles most types natively, but bigint needs conversion.
 */
export function toNeo4jValue(value: GraphValue): unknown {
  if (typeof value === "bigint") return neo4j.int(value);
  if (Array.isArray(value)) return value.map(toNeo4jValue);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = toNeo4jValue(v as GraphValue);
    }
    return result;
  }
  return value;
}

export function toNeo4jParams(params?: Record<string, GraphValue>): Record<string, unknown> {
  if (!params) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    result[key] = toNeo4jValue(value);
  }
  return result;
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (neo4j.isInt(value)) return (value as Integer).toNumber();
  return Number(value);
}

export function recordToPlain(record: Neo4jRecord): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const key of record.keys) {
    const strKey = String(key);
    const value = record.get(strKey);
    if (neo4j.isInt(value)) {
      obj[strKey] = (value as Integer).toNumber();
    } else if (value && typeof value === "object" && "properties" in value) {
      obj[strKey] = (value as { properties: Record<string, unknown> }).properties;
    } else {
      obj[strKey] = value;
    }
  }
  return obj;
}

const CONSTRAINT_STATEMENTS = [
  ...PUBLIC_GRAPH_NODE_LABELS.map((label) =>
    `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.storageId IS UNIQUE`
  ),
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:IndexState) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:GraphWriteBatch) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:PublicGraphStats) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:RelationFeedback) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:AliasOverride) REQUIRE n.id IS UNIQUE",
  ...["SchemaGeneration", "SchemaGenerationState", "SchemaGenerationReadLease", "SchemaSourceReplacement", "SchemaBehaviorReplacement", "SchemaContributionReplacement", "TypeDeclarationFact", "ResolutionContextFact", "ResolutionScopeDependencyFact", "SchemaRootFact", "SchemaDependencyFact", "SchemaProvenanceFact", "SchemaDiagnosticFact", "SchemaBehaviorFingerprintFact", "SchemaContribution"]
    .map((label) => `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`)
];

const INDEX_STATEMENTS = [
  ...PUBLIC_GRAPH_NODE_LABELS.map((label) =>
    `CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.workspaceId, n.generation, n.id)`
  ),
  "CREATE INDEX IF NOT EXISTS FOR (f:File) ON (f.repoId)",
  "CREATE INDEX IF NOT EXISTS FOR (f:File) ON (f.workspaceId, f.generation, f.repoId, f.language, f.directory)",
  "CREATE INDEX IF NOT EXISTS FOR (c:Code) ON (c.repoId)",
  "CREATE INDEX IF NOT EXISTS FOR (c:Code) ON (c.fileId)",
  "CREATE INDEX IF NOT EXISTS FOR (s:Section) ON (s.repoId)",
  "CREATE INDEX IF NOT EXISTS FOR (s:Section) ON (s.fileId)",
  "CREATE INDEX IF NOT EXISTS FOR (e:Evidence) ON (e.repoId)",
  "CREATE INDEX IF NOT EXISTS FOR (e:Evidence) ON (e.fileId)",
  "CREATE INDEX IF NOT EXISTS FOR (i:IndexState) ON (i.repoId)",
  "CREATE INDEX IF NOT EXISTS FOR (g:GraphWriteBatch) ON (g.batchId)",
  "CREATE INDEX IF NOT EXISTS FOR (s:PublicGraphStats) ON (s.workspaceId, s.generation)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.contractId)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.specKind)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.httpMethod)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.pathTemplate)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.eventTopic)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.canonicalKey)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.fileId)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.repoId)",
  ...["TypeDeclarationFact", "ResolutionContextFact", "ResolutionScopeDependencyFact", "SchemaRootFact", "SchemaDependencyFact", "SchemaProvenanceFact", "SchemaDiagnosticFact", "SchemaBehaviorFingerprintFact", "SchemaContribution", "SchemaContributionReplacement"]
    .map((label) => `CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.generation)`),
  ...["TypeDeclarationFact", "ResolutionContextFact", "ResolutionScopeDependencyFact", "SchemaRootFact", "SchemaDependencyFact", "SchemaProvenanceFact", "SchemaDiagnosticFact", "SchemaBehaviorFingerprintFact"]
    .map((label) => `CREATE INDEX IF NOT EXISTS FOR (n:${label}) ON (n.generation, n.repoId, n.fileId)`),
  "CREATE INDEX IF NOT EXISTS FOR (n:SchemaDependencyFact) ON (n.generation, n.declarationId)",
  "CREATE INDEX IF NOT EXISTS FOR (n:SchemaRootFact) ON (n.generation, n.rootReferenceId)",
  "CREATE INDEX IF NOT EXISTS FOR (n:SchemaContribution) ON (n.generation, n.rootReferenceId)",
  "CREATE INDEX IF NOT EXISTS FOR (n:SchemaContribution) ON (n.generation, n.entityKind, n.entityId)",
  "CREATE INDEX IF NOT EXISTS FOR (n:SchemaContributionReplacement) ON (n.generation, n.rootReferenceId)",
  "CREATE INDEX IF NOT EXISTS FOR (n:SchemaBehaviorReplacement) ON (n.generation, n.repoId, n.languageId, n.resolutionScopeId)"
];

export class Neo4jGraphDB implements GraphDB {
  private driver: Driver;
  private closed = false;
  private manualSession: Session | null = null;
  private manualTransaction: Neo4jTransaction | null = null;
  private manualTransactionDepth = 0;
  private readonly transactionStorage = new AsyncLocalStorage<Neo4jTransactionContext>();
  private readonly crud: CypherCrud;
  private readonly databaseName?: string;

  private constructor(driver: Driver, databaseName?: string) {
    this.driver = driver;
    this.databaseName = databaseName;
    this.crud = createCypherCrud(this);
  }

  static async open(url: string, credentials?: { username: string; password: string; database?: string }): Promise<Neo4jGraphDB> {
    const databaseName = credentials?.database?.trim();
    if (credentials?.database !== undefined && !databaseName) {
      throw new TypeError("Neo4j database name must not be empty or whitespace-only when explicitly configured.");
    }
    const auth = credentials
      ? neo4j.auth.basic(credentials.username, credentials.password)
      : neo4j.auth.basic("neo4j", "neo4j");
    const driver = neo4j.driver(url, auth);
    // Verify connectivity
    await driver.verifyConnectivity();
    return new Neo4jGraphDB(driver, databaseName);
  }

  private getSession(mode: "READ" | "WRITE" = "WRITE"): Session {
    if (this.closed) throw new GraphDatabaseClosedError();
    const defaultAccessMode = mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE;
    return this.driver.session({
      defaultAccessMode,
      ...(this.databaseName ? { database: this.databaseName } : {})
    });
  }

  async initSchema(_systemName = "default-system"): Promise<void> {
    const constraints = await this.query<Neo4jConstraintRow>(
      "SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties, type RETURN name, labelsOrTypes, properties, type"
    );
    const publicLabels = new Set<string>(PUBLIC_GRAPH_NODE_LABELS);
    for (const constraint of constraints) {
      const labels = Array.isArray(constraint.labelsOrTypes) ? constraint.labelsOrTypes : [];
      const properties = Array.isArray(constraint.properties) ? constraint.properties : [];
      if (typeof constraint.name !== "string" || labels.length !== 1 || properties.length !== 1) continue;
      if (!publicLabels.has(String(labels[0])) || properties[0] !== "id") continue;
      if (typeof constraint.type === "string" && !constraint.type.includes("UNIQUE")) continue;
      await this.query(`DROP CONSTRAINT ${neo4jIdentifier(constraint.name)} IF EXISTS`);
    }
    for (const statement of CONSTRAINT_STATEMENTS) {
      await this.query(statement);
    }
    for (const statement of INDEX_STATEMENTS) {
      await this.query(statement);
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
    // Uses a single transaction to ensure atomicity — partial cleanup would leave
    // orphaned relationships. Other write methods use independent queries because
    // they are idempotent MERGEs that can safely be retried.
    const params: Record<string, GraphValue> = { ...publicRelationshipScopeParams(scope), repoId };
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
        "MATCH (s:SchemaGenerationState {id: $id}) SET s.protocolNonce=$nonce RETURN s.activeGeneration AS activeGeneration, s.pendingGeneration AS pendingGeneration",
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
    await this.query(
      "MERGE (b:GraphWriteBatch {id: $id}) ON CREATE SET b.batchId=$batchId, b.generation=$generation, b.parentGeneration=$parentGeneration, b.repoIds=$repoIds, b.repoNames=$repoNames, b.writerMode=$writerMode, b.atomicityMode=$atomicityMode, b.workspaceId=$workspaceId, b.status=$status, b.startedAt=$startedAt, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error ON MATCH SET b.batchId=$batchId, b.generation=$generation, b.parentGeneration=$parentGeneration, b.repoIds=$repoIds, b.repoNames=$repoNames, b.writerMode=$writerMode, b.atomicityMode=$atomicityMode, b.workspaceId=$workspaceId, b.status=$status, b.startedAt=$startedAt, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error;",
      {
        id: `graph-write:${journal.batchId}`,
        batchId: journal.batchId,
        generation: journal.generation,
        parentGeneration: journal.parentGeneration ?? "",
        repoIds: JSON.stringify(journal.repoIds),
        repoNames: JSON.stringify(journal.repoNames),
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

  async recoverIncompleteGraphWriteBatches(input: { repoIds?: string[]; workspaceId?: string; generation?: string; updatedAt: string }): Promise<GraphWriteBatchJournal[]> {
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
        "MATCH (s:SchemaGenerationState) WHERE s.workspaceId = $workspaceId SET s.protocolNonce=$nonce RETURN s.activeGeneration AS activeGeneration, s.pendingGeneration AS pendingGeneration",
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
      const batchParams = { ...scopeParams, staleFileIds, batchId: input.batchId, staleIndexedAt: input.indexedAt, active: false };

      if (staleFileIds.length > 0) {
        // Batch-update File, Code, Section, Evidence nodes
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (f:File) WHERE f.workspaceId = $workspaceId AND f.generation = $generation AND f.id = staleFileId SET f.active = $active, f.batchId = $batchId, f.indexedAt = $staleIndexedAt;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (c:Code) WHERE c.workspaceId = $workspaceId AND c.generation = $generation AND c.fileId = staleFileId SET c.active = $active, c.batchId = $batchId, c.indexedAt = $staleIndexedAt;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (s:Section) WHERE s.workspaceId = $workspaceId AND s.generation = $generation AND s.fileId = staleFileId SET s.active = $active, s.batchId = $batchId, s.indexedAt = $staleIndexedAt;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (e:Evidence) WHERE e.workspaceId = $workspaceId AND e.generation = $generation AND e.fileId = staleFileId SET e.active = $active, e.batchId = $batchId, e.indexedAt = $staleIndexedAt;", batchParams);

        // Batch-update relationships tied to stale file IDs
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (a:File)-[r:IMPORTS]->(b:File) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND (a.id = staleFileId OR b.id = staleFileId) SET r.active = $active, r.batchId = $batchId;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (a:Code)-[r:CALLS]->(b:Code) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND (a.fileId = staleFileId OR b.fileId = staleFileId) SET r.active = $active, r.batchId = $batchId;", batchParams);
        const relTypes = ALL_EVIDENCE_REL_TYPES.join("|");
        await this.query(`UNWIND $staleFileIds AS staleFileId MATCH ()-[r:${relTypes}]->(), (e:Evidence) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND e.workspaceId = $workspaceId AND e.generation = $generation AND r.evidenceId = e.id AND e.fileId = staleFileId SET r.active = $active, r.batchId = $batchId;`, batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (cs:ContractSpec) WHERE cs.workspaceId = $workspaceId AND cs.generation = $generation AND cs.fileId = staleFileId SET cs.active = $active, cs.batchId = $batchId;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (cs:ContractSpec)-[r:SEMANTIC_REL]->() WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND cs.fileId = staleFileId SET r.active = $active, r.batchId = $batchId;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH ()-[r:SEMANTIC_REL]->(cs:ContractSpec) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND cs.fileId = staleFileId SET r.active = $active, r.batchId = $batchId;", batchParams);
      }

      if (staleEvidenceIds.length > 0) {
        const evidenceBatchParams = { ...scopeParams, staleEvidenceIds, batchId: input.batchId, active: false };
        await this.query("UNWIND $staleEvidenceIds AS evidenceId MATCH (e:Evidence) WHERE e.workspaceId = $workspaceId AND e.generation = $generation AND e.id = evidenceId SET e.active = $active, e.batchId = $batchId;", evidenceBatchParams);
        const relTypes = ALL_EVIDENCE_REL_TYPES.join("|");
        await this.query(`UNWIND $staleEvidenceIds AS evidenceId MATCH ()-[r:${relTypes}]->() WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.evidenceId = evidenceId SET r.active = $active, r.batchId = $batchId;`, evidenceBatchParams);
      }

      if (input.activeFileIds.length === 0) {
        await this.query(
          "MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND (a.id = $repoId OR b.id = $repoId) SET r.active = $active, r.batchId = $batchId;",
          { ...scopeParams, repoId: input.repoId, batchId: input.batchId, active: false }
        );
      }
    });
    // Return only the file count — the IndexState field is named "filesStale".
    // Mixing in staleEvidenceIds.length would write an evidence count under a
    // field that callers expect to contain a file count.
    return staleFileIds.length;
  }

  async upsertIndexState(state: Parameters<GraphDB["upsertIndexState"]>[0]): Promise<void> {
    await this.crud.upsertIndexState(state);
  }

  async updateGraphWriteBatch(input: { batchId: string; updatedAt: string; completedStage: string }): Promise<void> {
    await this.query(
      "MATCH (b:GraphWriteBatch {id: $id}) SET b.updatedAt=$updatedAt, b.completedStage=$completedStage;",
      { id: `graph-write:${input.batchId}`, updatedAt: input.updatedAt, completedStage: input.completedStage }
    );
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
    // All three steps in a single transaction to ensure atomicity — partial
    // execution would leave evidence active while its relationships are gone.
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        const stateResult = await tx.run(
          "MATCH (s:SchemaGenerationState {id: $id}) SET s.protocolNonce=$nonce RETURN s.activeGeneration AS activeGeneration, s.pendingGeneration AS pendingGeneration",
          toNeo4jParams({
            id: `schema-generation-state:${scope.workspaceId}`,
            nonce: `reject-evidence:${input.evidenceId}`
          })
        );
        const state = stateResult.records[0];
        const activeGeneration = state?.get("activeGeneration");
        const pendingGeneration = state?.get("pendingGeneration");
        if (activeGeneration !== scope.generation || (typeof pendingGeneration === "string" && pendingGeneration)) {
          throw new Error("Evidence feedback cannot mutate a stale snapshot or run while a workspace generation is pending.");
        }
        const baseParams = toNeo4jParams({
          id: `feedback:${scope.workspaceId}:${scope.generation}:${input.evidenceId}:reject`,
          evidenceId: input.evidenceId,
          action: "reject",
          reason: input.reason,
          createdAt
        });
        await tx.run(
          "MERGE (f:RelationFeedback {id: $id}) ON CREATE SET f.evidenceId=$evidenceId, f.action=$action, f.reason=$reason, f.createdAt=$createdAt ON MATCH SET f.action=$action, f.reason=$reason, f.createdAt=$createdAt;",
          baseParams
        );
        const evParams = toNeo4jParams({
          ...publicRelationshipScopeParams(scope),
          storageId: publicNodeStorageId(scope.generation, input.evidenceId),
          evidenceId: input.evidenceId
        });
        await tx.run("MATCH (e:Evidence {storageId: $storageId}) SET e.active = false;", evParams);
        for (const rel of REJECT_EVIDENCE_REL_TYPES) {
          await tx.run(`MATCH ()-[r:${rel}]->() WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.evidenceId = $evidenceId SET r.active = false;`, evParams);
        }
      });
    } finally {
      await session.close();
    }
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
    const params: Record<string, GraphValue> = { ...publicRelationshipScopeParams(scope), limit };
    if (options.kind) params.kind = options.kind;

    if (options.kind) {
      conditions.push("c.kind = $kind");
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
       LIMIT toInteger($limit);`,
      params
    );
  }

  async query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
    const activeTransaction = this.activeTransaction();
    if (activeTransaction) {
      let result;
      try {
        result = await activeTransaction.run(cypher, toNeo4jParams(params));
      } catch (error) {
        const kind = classifyNeo4jQueryError(error);
        if (!kind) throw error;
        throw new GraphDatabaseOperationalError({ cause: error, kind });
      }
      return result.records.map((record) => recordToPlain(record) as T);
    }
    // Non-transactional path: each query gets its own session with the
    // correct access mode. High-volume write paths use an async-context-bound
    // transaction, so the per-query session overhead only affects ad-hoc
    // reads like stats(), listRepos(), etc.
    const mode = neo4jQueryAccessMode(cypher);
    const session = this.getSession(mode);
    try {
      let result;
      try {
        result = await session.run(cypher, toNeo4jParams(params));
      } catch (error) {
        const kind = classifyNeo4jQueryError(error);
        if (!kind) throw error;
        throw new GraphDatabaseOperationalError({ cause: error, kind });
      }
      return result.records.map((record) => recordToPlain(record) as T);
    } finally {
      await session.close();
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = this.transactionStorage.getStore();
    if (existing) {
      existing.depth++;
      try {
        return await fn();
      } finally {
        existing.depth--;
      }
    }

    const session = this.getSession();
    const transaction = session.beginTransaction();
    const context: Neo4jTransactionContext = { session, transaction, depth: 1 };
    try {
      const result = await this.transactionStorage.run(context, fn);
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {}
      throw error;
    } finally {
      await session.close();
    }
  }

  async readTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = this.transactionStorage.getStore();
    if (existing) {
      existing.depth++;
      try {
        return await fn();
      } finally {
        existing.depth--;
      }
    }

    const session = this.getSession("READ");
    const transaction = session.beginTransaction();
    const context: Neo4jTransactionContext = { session, transaction, depth: 1 };
    try {
      const result = await this.transactionStorage.run(context, fn);
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {}
      throw error;
    } finally {
      await session.close();
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

      // The callback contains only the already-prepared graph and schema delta.
      // AsyncLocalStorage keeps all nested provider calls on
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
        "SET g.activeRevision=$nextRevision, g.schemaIndexVersion=$schemaIndexVersion, g.updatedAt=$updatedAt " +
        "RETURN g.id AS id;",
        {
          generation: request.expectedActiveGeneration,
          workspaceId: request.workspaceId,
          nextRevision: request.nextRevision,
          schemaIndexVersion: request.schemaIndexVersion,
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
        "s.schemaIndexVersion=$schemaIndexVersion, s.protocolNonce=$lockNonce " +
        "RETURN s.activeRevision AS activeRevision;",
        {
          stateId,
          expectedActiveGeneration: request.expectedActiveGeneration,
          expectedActiveRevision: request.expectedActiveRevision,
          nextRevision: request.nextRevision,
          pendingLeaseUntil: leaseUntil,
          schemaIndexVersion: request.schemaIndexVersion,
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
    const managed = this.transactionStorage.getStore();
    if (managed) {
      managed.depth++;
      return;
    }
    if (this.manualTransaction) {
      this.manualTransactionDepth++;
      return;
    }
    this.manualSession = this.getSession();
    this.manualTransaction = this.manualSession.beginTransaction();
    this.manualTransactionDepth = 1;
  }

  async commitTransaction(): Promise<void> {
    const managed = this.transactionStorage.getStore();
    if (managed) {
      managed.depth--;
      return;
    }
    if (!this.manualTransaction) {
      throw new Error("No transaction in progress");
    }
    this.manualTransactionDepth--;
    if (this.manualTransactionDepth > 0) return;
    const transaction = this.manualTransaction;
    const session = this.manualSession;
    this.manualTransaction = null;
    this.manualSession = null;
    try {
      await transaction.commit();
    } finally {
      await session?.close();
    }
  }

  async rollbackTransaction(): Promise<void> {
    const managed = this.transactionStorage.getStore();
    if (managed) {
      managed.depth = 0;
      await managed.transaction.rollback();
      return;
    }
    if (!this.manualTransaction) {
      return;
    }
    const transaction = this.manualTransaction;
    const session = this.manualSession;
    this.manualTransaction = null;
    this.manualSession = null;
    this.manualTransactionDepth = 0;
    try {
      await transaction.rollback();
    } finally {
      await session?.close();
    }
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
    if (this.manualTransaction) {
      const transaction = this.manualTransaction;
      const session = this.manualSession;
      this.manualTransaction = null;
      this.manualSession = null;
      this.manualTransactionDepth = 0;
      try {
        await transaction.rollback();
      } catch {}
      await session?.close();
    }
    await this.driver.close();
  }

  private activeTransaction(): Neo4jTransaction | undefined {
    return this.transactionStorage.getStore()?.transaction ?? this.manualTransaction ?? undefined;
  }
}

export function decodeList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

export function decodeJournalRow(row: {
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
