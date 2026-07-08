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
import { systemId } from "../../../core/graph-model/schema.js";
import { createCypherCrud, type CypherCrud } from "../../../core/graph-model/cypherCrud.js";
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
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:System) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Repo) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:File) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Code) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Section) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Operation) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Workflow) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Contract) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Evidence) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:IndexState) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:GraphWriteBatch) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:RelationFeedback) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:AliasOverride) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:ContractSpec) REQUIRE n.id IS UNIQUE"
];

const INDEX_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS FOR (f:File) ON (f.repoId)",
  "CREATE INDEX IF NOT EXISTS FOR (c:Code) ON (c.repoId)",
  "CREATE INDEX IF NOT EXISTS FOR (c:Code) ON (c.fileId)",
  "CREATE INDEX IF NOT EXISTS FOR (s:Section) ON (s.repoId)",
  "CREATE INDEX IF NOT EXISTS FOR (s:Section) ON (s.fileId)",
  "CREATE INDEX IF NOT EXISTS FOR (e:Evidence) ON (e.repoId)",
  "CREATE INDEX IF NOT EXISTS FOR (e:Evidence) ON (e.fileId)",
  "CREATE INDEX IF NOT EXISTS FOR (i:IndexState) ON (i.repoId)",
  "CREATE INDEX IF NOT EXISTS FOR (g:GraphWriteBatch) ON (g.batchId)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.contractId)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.specKind)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.httpMethod)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.pathTemplate)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.eventTopic)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.canonicalKey)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.fileId)",
  "CREATE INDEX IF NOT EXISTS FOR (s:ContractSpec) ON (s.repoId)"
];

export class Neo4jGraphDB implements GraphDB {
  private driver: Driver;
  private closed = false;
  private activeSession: Session | null = null;
  private activeTx: any = null;
  private txDepth = 0;
  private readonly crud: CypherCrud;

  private constructor(driver: Driver) {
    this.driver = driver;
    this.crud = createCypherCrud(this);
  }

  static async open(url: string, credentials?: { username: string; password: string }): Promise<Neo4jGraphDB> {
    const auth = credentials
      ? neo4j.auth.basic(credentials.username, credentials.password)
      : neo4j.auth.basic("neo4j", "neo4j");
    const driver = neo4j.driver(url, auth);
    // Verify connectivity
    await driver.verifyConnectivity();
    return new Neo4jGraphDB(driver);
  }

  private getSession(mode: "READ" | "WRITE" = "WRITE"): Session {
    if (this.closed) throw new Error("Graph database is closed");
    const defaultAccessMode = mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE;
    return this.driver.session({ defaultAccessMode });
  }

  async initSchema(systemName = "default-system"): Promise<void> {
    for (const statement of CONSTRAINT_STATEMENTS) {
      await this.query(statement);
    }
    for (const statement of INDEX_STATEMENTS) {
      await this.query(statement);
    }
    await this.query("MERGE (s:System {id: $id}) ON CREATE SET s.name = $name, s.summary = '' ON MATCH SET s.name = $name;", { id: systemId, name: systemName });
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
      "MATCH (r:Repo {id: $repoId}), (c:Contract {id: $packageContractId}) MERGE (r)-[u:USES_PACKAGE {packageName: $packageName, evidenceId: $evidenceId}]->(c) SET u.raw = $raw, u.confidence = $confidence, u.batchId = $batchId, u.active = $active;",
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
    // Uses a single transaction to ensure atomicity — partial cleanup would leave
    // orphaned relationships. Other write methods use independent queries because
    // they are idempotent MERGEs that can safely be retried.
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
      "MATCH (e:Evidence) WHERE e.repoId = $repoId DELETE e;",
      "MATCH (c:Code) WHERE c.repoId = $repoId DELETE c;",
      "MATCH (s:Section) WHERE s.repoId = $repoId DELETE s;",
      "MATCH (f:File) WHERE f.repoId = $repoId DELETE f;"
    ];
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        for (const statement of statements) {
          await tx.run(statement, { repoId });
        }
      });
    } finally {
      await session.close();
    }
  }

  async beginGraphWriteBatch(journal: Omit<GraphWriteBatchJournal, "status" | "updatedAt"> & { updatedAt?: string }): Promise<void> {
    const updatedAt = journal.updatedAt ?? journal.startedAt;
    await this.query(
      "MERGE (b:GraphWriteBatch {id: $id}) ON CREATE SET b.batchId=$batchId, b.repoIds=$repoIds, b.repoNames=$repoNames, b.writerMode=$writerMode, b.atomicityMode=$atomicityMode, b.status=$status, b.startedAt=$startedAt, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error ON MATCH SET b.batchId=$batchId, b.repoIds=$repoIds, b.repoNames=$repoNames, b.writerMode=$writerMode, b.atomicityMode=$atomicityMode, b.status=$status, b.startedAt=$startedAt, b.updatedAt=$updatedAt, b.completedStage=$completedStage, b.error=$error;",
      {
        id: `graph-write:${journal.batchId}`,
        batchId: journal.batchId,
        repoIds: JSON.stringify(journal.repoIds),
        repoNames: JSON.stringify(journal.repoNames),
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
      const batchParams = { staleFileIds, batchId: input.batchId, staleIndexedAt: input.indexedAt, active: false };

      if (staleFileIds.length > 0) {
        // Batch-update File, Code, Section, Evidence nodes
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (f:File) WHERE f.id = staleFileId SET f.active = $active, f.batchId = $batchId, f.indexedAt = $staleIndexedAt;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (c:Code) WHERE c.fileId = staleFileId SET c.active = $active, c.batchId = $batchId, c.indexedAt = $staleIndexedAt;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (s:Section) WHERE s.fileId = staleFileId SET s.active = $active, s.batchId = $batchId, s.indexedAt = $staleIndexedAt;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (e:Evidence) WHERE e.fileId = staleFileId SET e.active = $active, e.batchId = $batchId, e.indexedAt = $staleIndexedAt;", batchParams);

        // Batch-update relationships tied to stale file IDs
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (a:File)-[r:IMPORTS]->(b:File) WHERE a.id = staleFileId OR b.id = staleFileId SET r.active = $active, r.batchId = $batchId;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (a:Code)-[r:CALLS]->(b:Code) WHERE a.fileId = staleFileId OR b.fileId = staleFileId SET r.active = $active, r.batchId = $batchId;", batchParams);
        const relTypes = ALL_EVIDENCE_REL_TYPES.join("|");
        await this.query(`UNWIND $staleFileIds AS staleFileId MATCH ()-[r:${relTypes}]->(), (e:Evidence) WHERE r.evidenceId = e.id AND e.fileId = staleFileId SET r.active = $active, r.batchId = $batchId;`, batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (cs:ContractSpec) WHERE cs.fileId = staleFileId SET cs.active = $active, cs.batchId = $batchId;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH (cs:ContractSpec)-[r:SEMANTIC_REL]->() WHERE cs.fileId = staleFileId SET r.active = $active, r.batchId = $batchId;", batchParams);
        await this.query("UNWIND $staleFileIds AS staleFileId MATCH ()-[r:SEMANTIC_REL]->(cs:ContractSpec) WHERE cs.fileId = staleFileId SET r.active = $active, r.batchId = $batchId;", batchParams);
      }

      if (staleEvidenceIds.length > 0) {
        const evidenceBatchParams = { staleEvidenceIds, batchId: input.batchId, active: false };
        await this.query("UNWIND $staleEvidenceIds AS evidenceId MATCH (e:Evidence) WHERE e.id = evidenceId SET e.active = $active, e.batchId = $batchId;", evidenceBatchParams);
        const relTypes = ALL_EVIDENCE_REL_TYPES.join("|");
        await this.query(`UNWIND $staleEvidenceIds AS evidenceId MATCH ()-[r:${relTypes}]->() WHERE r.evidenceId = evidenceId SET r.active = $active, r.batchId = $batchId;`, evidenceBatchParams);
      }

      if (input.activeFileIds.length === 0) {
        await this.query(
          "MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo) WHERE a.id = $repoId OR b.id = $repoId SET r.active = $active, r.batchId = $batchId;",
          { repoId: input.repoId, batchId: input.batchId, active: false }
        );
      }
    });
    // Return only the file count — the IndexState field is named "filesStale".
    // Mixing in staleEvidenceIds.length would write an evidence count under a
    // field that callers expect to contain a file count.
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
    // All three steps in a single transaction to ensure atomicity — partial
    // execution would leave evidence active while its relationships are gone.
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        const baseParams = toNeo4jParams({
          id: `feedback:${input.evidenceId}:reject`,
          evidenceId: input.evidenceId,
          action: "reject",
          reason: input.reason,
          createdAt
        });
        await tx.run(
          "MERGE (f:RelationFeedback {id: $id}) ON CREATE SET f.evidenceId=$evidenceId, f.action=$action, f.reason=$reason, f.createdAt=$createdAt ON MATCH SET f.action=$action, f.reason=$reason, f.createdAt=$createdAt;",
          baseParams
        );
        const evParams = toNeo4jParams({ evidenceId: input.evidenceId });
        await tx.run("MATCH (e:Evidence) WHERE e.id = $evidenceId SET e.active = false;", evParams);
        for (const rel of REJECT_EVIDENCE_REL_TYPES) {
          await tx.run(`MATCH ()-[r:${rel}]->() WHERE r.evidenceId = $evidenceId SET r.active = false;`, evParams);
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

  async listContracts(options: { limit?: number; kind?: ContractKind; repo?: string; direction?: "outgoing" | "incoming" } = {}): Promise<ContractSummaryRow[]> {
    const limit = options.limit ?? 100;
    const conditions: string[] = [];
    const params: Record<string, GraphValue> = { limit };
    if (options.kind) params.kind = options.kind;

    if (options.kind) {
      conditions.push("c.kind = $kind");
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
       LIMIT $limit;`,
      params
    );
  }

  private isReadQuery(cypher: string): boolean {
    const normalized = cypher.trim().toUpperCase();
    if (/\b(CREATE|MERGE|SET|DELETE|REMOVE|DETACH)\b/.test(normalized)) {
      return false;
    }
    return true;
  }

  async query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
    if (this.activeTx) {
      const result = await this.activeTx.run(cypher, toNeo4jParams(params));
      return result.records.map((record: any) => recordToPlain(record) as T);
    }
    // Non-transactional path: each query gets its own session with the
    // correct access mode.  High-volume write paths use withTransaction
    // (activeTx) so the per-query session overhead only affects ad-hoc
    // reads like stats(), listRepos(), etc.
    const mode = this.isReadQuery(cypher) ? "READ" : "WRITE";
    const session = this.getSession(mode);
    try {
      const result = await session.run(cypher, toNeo4jParams(params));
      return result.records.map((record: any) => recordToPlain(record) as T);
    } finally {
      await session.close();
    }
  }

  async beginTransaction(): Promise<void> {
    if (this.activeTx) {
      this.txDepth++;
      return;
    }
    this.activeSession = this.getSession();
    this.activeTx = this.activeSession.beginTransaction();
    this.txDepth = 1;
  }

  async commitTransaction(): Promise<void> {
    if (!this.activeTx) {
      throw new Error("No transaction in progress");
    }
    this.txDepth--;
    if (this.txDepth > 0) return;
    try {
      await this.activeTx.commit();
    } finally {
      this.activeTx = null;
      if (this.activeSession) {
        await this.activeSession.close();
        this.activeSession = null;
      }
    }
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.activeTx) {
      return;
    }
    try {
      await this.activeTx.rollback();
    } finally {
      this.activeTx = null;
      this.txDepth = 0;
      if (this.activeSession) {
        await this.activeSession.close();
        this.activeSession = null;
      }
    }
  }

  async stats(): Promise<Stats> {
    return this.crud.stats();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.driver.close();
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
