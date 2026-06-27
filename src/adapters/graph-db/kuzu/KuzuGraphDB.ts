import fs from "node:fs/promises";
import path from "node:path";
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
import type {
  GraphDB,
  GraphValue,
  GraphWriteAtomicityMode,
  GraphWriteBatchStatus,
  GraphWriteBatchJournal,
  ActiveAliasOverride,
  ContractSummaryRow,
  Stats
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

const managedKuzuHandles: Array<{ db?: kuzu.Database; conn?: kuzu.Connection }> = [];

// Kuzu reserves `maxDBSize` bytes of virtual address space via mmap up front.
// Passing 0 selects Kuzu's default of 8 TiB (2^43), which some constrained
// environments (notably GitHub Actions runners) refuse to mmap, surfacing as
// "Buffer manager exception: Mmap for size 8796093022208 failed". We instead
// reserve a generous-but-mappable 128 GiB by default — far beyond any realistic
// code-graph size — and allow an override for unusual deployments. Kuzu requires
// the value to be a power of two.
const DEFAULT_MAX_DB_SIZE = 137438953472; // 128 GiB (2^37)

function resolveMaxDBSize(): number {
  const raw = process.env.LOGICLENS_KUZU_MAX_DB_SIZE;
  if (!raw) return DEFAULT_MAX_DB_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_DB_SIZE;
  return Math.floor(parsed);
}

export class KuzuGraphDB implements GraphDB {
  private db?: kuzu.Database;
  private conn?: kuzu.Connection;
  private closed = false;

  private constructor(db: kuzu.Database, conn: kuzu.Connection) {
    this.db = db;
    this.conn = conn;
  }

  static async open(graphPath: string): Promise<KuzuGraphDB> {
    const resolved = path.resolve(graphPath);
    const dbPath = path.extname(resolved) ? resolved : path.join(resolved, "kuzu.db");
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
    const conn = new kuzu.Connection(db);
    await db.init();
    await conn.init();
    return new KuzuGraphDB(db, conn);
  }

  async initSchema(systemName = "default-system"): Promise<void> {
    const conn = this.connection();
    for (const statement of schemaStatements) await conn.query(statement);
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
    await this.connection().query(`ALTER TABLE ${tableName} ADD ${columnName} ${columnType};`);
  }

  async upsertRepo(repo: RepoNode): Promise<void> {
    await this.query(
      // NOTE: ON MATCH intentionally omits r.summary — summary is managed
      // separately via updateRepoSummary(). If upsertRepo were to overwrite
      // summary on MATCH, it would clobber AI-generated summaries with the
      // (possibly empty) default. Confirm this is the desired behaviour.
      "MERGE (r:Repo {id: $id}) ON CREATE SET r.name=$name, r.path=$path, r.remoteUrl=$remoteUrl, r.branch=$branch, r.commitSha=$commitSha, r.language=$language, r.indexedAt=$indexedAt, r.summary=$summary ON MATCH SET r.name=$name, r.path=$path, r.remoteUrl=$remoteUrl, r.branch=$branch, r.commitSha=$commitSha, r.language=$language, r.indexedAt=$indexedAt;",
      { ...repo, summary: repo.summary ?? "" } as unknown as Record<string, GraphValue>
    );
    await this.addContains(systemId, repo.id);
  }

  async updateRepoSummary(repoIdValue: string, summary: string): Promise<void> {
    await this.query("MATCH (r:Repo {id: $repoId}) SET r.summary = $summary;", { repoId: repoIdValue, summary });
  }

  async updateSystemSummary(summary: string): Promise<void> {
    await this.query("MATCH (s:System {id: $id}) SET s.summary = $summary;", { id: systemId, summary });
  }

  async upsertFile(file: FileNode): Promise<void> {
    await this.query(
      "MERGE (f:File {id: $id}) ON CREATE SET f.repoId=$repoId, f.path=$path, f.language=$language, f.hash=$hash, f.loc=$loc, f.batchId=$batchId, f.indexedAt=$indexedAt, f.active=$active ON MATCH SET f.repoId=$repoId, f.path=$path, f.language=$language, f.hash=$hash, f.loc=$loc, f.batchId=$batchId, f.indexedAt=$indexedAt, f.active=$active;",
      { ...file, batchId: file.batchId ?? "", indexedAt: file.indexedAt ?? "", active: file.active ?? true } as unknown as Record<string, GraphValue>
    );
  }

  async upsertCode(code: CodeSymbol): Promise<void> {
    const params = {
      id: code.id,
      repoId: code.repoId,
      fileId: code.fileId,
      kind: code.kind,
      name: code.name,
      qualifiedName: code.qualifiedName,
      startLine: code.startLine,
      endLine: code.endLine,
      signature: code.signature,
      summary: code.summary ?? "",
      hash: code.hash,
      batchId: code.batchId ?? "",
      indexedAt: code.indexedAt ?? "",
      active: code.active ?? true
    };
    await this.query(
      "MERGE (c:Code {id: $id}) ON CREATE SET c.repoId=$repoId, c.fileId=$fileId, c.kind=$kind, c.name=$name, c.qualifiedName=$qualifiedName, c.startLine=$startLine, c.endLine=$endLine, c.signature=$signature, c.summary=$summary, c.hash=$hash, c.batchId=$batchId, c.indexedAt=$indexedAt, c.active=$active ON MATCH SET c.repoId=$repoId, c.fileId=$fileId, c.kind=$kind, c.name=$name, c.qualifiedName=$qualifiedName, c.startLine=$startLine, c.endLine=$endLine, c.signature=$signature, c.summary=$summary, c.hash=$hash, c.batchId=$batchId, c.indexedAt=$indexedAt, c.active=$active;",
      params as unknown as Record<string, GraphValue>
    );
  }

  async upsertSection(section: DocSection): Promise<void> {
    const params = {
      id: section.id,
      repoId: section.repoId,
      fileId: section.fileId,
      heading: section.heading,
      level: section.level,
      startLine: section.startLine,
      endLine: section.endLine,
      text: section.text,
      summary: section.summary ?? "",
      hash: section.hash,
      batchId: section.batchId ?? "",
      indexedAt: section.indexedAt ?? "",
      active: section.active ?? true
    };
    await this.query(
      "MERGE (s:Section {id: $id}) ON CREATE SET s.repoId=$repoId, s.fileId=$fileId, s.heading=$heading, s.level=$level, s.startLine=$startLine, s.endLine=$endLine, s.text=$text, s.summary=$summary, s.hash=$hash, s.batchId=$batchId, s.indexedAt=$indexedAt, s.active=$active ON MATCH SET s.repoId=$repoId, s.fileId=$fileId, s.heading=$heading, s.level=$level, s.startLine=$startLine, s.endLine=$endLine, s.text=$text, s.summary=$summary, s.hash=$hash, s.batchId=$batchId, s.indexedAt=$indexedAt, s.active=$active;",
      params as unknown as Record<string, GraphValue>
    );
  }

  async upsertEntity(entity: EntityNode): Promise<void> {
    await this.query(
      "MERGE (e:Entity {id: $id}) ON CREATE SET e.name=$name, e.kind=$kind, e.description=$description ON MATCH SET e.name=$name, e.kind=$kind, e.description=$description;",
      entity as unknown as Record<string, GraphValue>
    );
  }

  async upsertOperation(operation: OperationNode): Promise<void> {
    await this.query(
      "MERGE (o:Operation {id: $id}) ON CREATE SET o.verb=$verb, o.entityName=$entityName, o.description=$description ON MATCH SET o.verb=$verb, o.entityName=$entityName, o.description=$description;",
      operation as unknown as Record<string, GraphValue>
    );
  }

  async upsertWorkflow(workflow: WorkflowNode): Promise<void> {
    await this.query(
      "MERGE (w:Workflow {id: $id}) ON CREATE SET w.name=$name, w.description=$description ON MATCH SET w.name=$name, w.description=$description;",
      workflow as unknown as Record<string, GraphValue>
    );
  }

  async upsertContract(contract: ContractNode): Promise<void> {
    await this.query(
      "MERGE (c:Contract {id: $id}) ON CREATE SET c.kind=$kind, c.key=$key, c.name=$name, c.description=$description ON MATCH SET c.kind=$kind, c.key=$key, c.name=$name, c.description=$description;",
      contract as unknown as Record<string, GraphValue>
    );
  }

  async upsertEvidence(evidence: EvidenceNode): Promise<void> {
    await this.query(
      "MERGE (e:Evidence {id: $id}) ON CREATE SET e.repoId=$repoId, e.fileId=$fileId, e.filePath=$filePath, e.line=$line, e.raw=$raw, e.rule=$rule, e.confidence=$confidence, e.batchId=$batchId, e.indexedAt=$indexedAt, e.active=$active ON MATCH SET e.repoId=$repoId, e.fileId=$fileId, e.filePath=$filePath, e.line=$line, e.raw=$raw, e.rule=$rule, e.confidence=$confidence, e.batchId=$batchId, e.indexedAt=$indexedAt, e.active=$active;",
      { ...evidence, batchId: evidence.batchId ?? "", indexedAt: evidence.indexedAt ?? "", active: evidence.active ?? true } as unknown as Record<string, GraphValue>
    );
  }

  async addRepoContract(edge: RepoContractEdge): Promise<void> {
    const rel = edge.role === "owner" ? "OWNS_PACKAGE" : edge.role === "producer" ? "PRODUCES" : edge.role === "consumer" ? "CONSUMES" : "SHARES_CONTRACT";
    await this.query(
      `MATCH (r:Repo {id: $repoId}), (c:Contract {id: $contractId}) MERGE (r)-[rel:${rel} {evidenceId: $evidenceId}]->(c) SET rel.confidence = $confidence, rel.batchId = $batchId, rel.active = $active;`,
      { repoId: edge.repoId, contractId: edge.contractId, evidenceId: edge.evidenceId, confidence: edge.confidence, batchId: edge.batchId ?? "", active: edge.active ?? true }
    );
  }

  async addRepoDependency(edge: RepoDependencyEdge): Promise<void> {
    await this.query(
      "MATCH (a:Repo {id: $fromRepoId}), (b:Repo {id: $toRepoId}) MERGE (a)-[r:DEPENDS_ON {dependencyType: $dependencyType, sourceContractId: $sourceContractId, targetContractId: $targetContractId, evidenceId: $evidenceId, raw: $raw}]->(b) SET r.confidence = $confidence, r.batchId = $batchId, r.active = $active;",
      { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>
    );
  }

  async addRepoDependenciesBatch(edges: RepoDependencyEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const batchSize = 5000;
    for (let i = 0; i < edges.length; i += batchSize) {
      const chunk = edges.slice(i, i + batchSize);
      const params = chunk.map((edge) => ({
        fromRepoId: edge.fromRepoId,
        toRepoId: edge.toRepoId,
        dependencyType: edge.dependencyType,
        sourceContractId: edge.sourceContractId,
        targetContractId: edge.targetContractId,
        evidenceId: edge.evidenceId,
        raw: edge.raw,
        confidence: edge.confidence,
        batchId: edge.batchId ?? "",
        active: edge.active ?? true
      }));
      await this.query(
        "UNWIND $batch AS edge " +
        "MATCH (a:Repo {id: edge.fromRepoId}), (b:Repo {id: edge.toRepoId}) " +
        "MERGE (a)-[r:DEPENDS_ON {dependencyType: edge.dependencyType, sourceContractId: edge.sourceContractId, targetContractId: edge.targetContractId, evidenceId: edge.evidenceId, raw: edge.raw}]->(b) " +
        "SET r.confidence = edge.confidence, r.batchId = edge.batchId, r.active = edge.active;",
        { batch: params as unknown as GraphValue }
      );
    }
  }

  async addPackageUsage(edge: PackageUsageEdge): Promise<void> {
    await this.query(
      "MATCH (r:Repo {id: $repoId}), (c:Contract {id: $packageContractId}) MERGE (r)-[u:USES_PACKAGE {packageName: $packageName, evidenceId: $evidenceId, raw: $raw}]->(c) SET u.confidence = $confidence, u.batchId = $batchId, u.active = $active;",
      { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>
    );
  }

  async addContractEntity(edge: ContractEntityEdge): Promise<void> {
    await this.query(
      "MATCH (c:Contract {id: $contractId}), (e:Entity {id: $entityId}) MERGE (c)-[r:CONTRACT_MENTIONS {evidenceId: $evidenceId}]->(e) SET r.confidence = $confidence, r.batchId = $batchId, r.active = $active;",
      { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>
    );
  }

  async addOperationRepo(edge: OperationRepoEdge): Promise<void> {
    await this.query(
      "MATCH (r:Repo {id: $repoId}), (o:Operation {id: $operationId}) MERGE (r)-[p:PARTICIPATES_IN {role: $role, evidenceId: $evidenceId}]->(o) SET p.confidence = $confidence, p.batchId = $batchId, p.active = $active;",
      { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>
    );
  }

  async addWorkflowOperation(edge: WorkflowOperationEdge): Promise<void> {
    await this.query(
      "MATCH (w:Workflow {id: $workflowId}), (o:Operation {id: $operationId}) MERGE (w)-[s:WORKFLOW_STEP {step: $step, evidenceId: $evidenceId}]->(o) SET s.confidence = $confidence, s.batchId = $batchId, s.active = $active;",
      { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>
    );
  }

  async upsertContractSpec(spec: ContractSpecNode): Promise<void> {
    await this.query(
      "MERGE (s:ContractSpec {id: $id}) ON CREATE SET s.contractId=$contractId, s.specKind=$specKind, s.repoId=$repoId, s.fileId=$fileId, s.evidenceId=$evidenceId, s.sourceSymbolId=$sourceSymbolId, s.canonicalKey=$canonicalKey, s.httpMethod=$httpMethod, s.pathTemplate=$pathTemplate, s.eventTopic=$eventTopic, s.framework=$framework, s.version=$version, s.specJson=$specJson, s.confidence=$confidence, s.batchId=$batchId, s.indexedAt=$indexedAt, s.active=$active ON MATCH SET s.contractId=$contractId, s.specKind=$specKind, s.repoId=$repoId, s.fileId=$fileId, s.evidenceId=$evidenceId, s.sourceSymbolId=$sourceSymbolId, s.canonicalKey=$canonicalKey, s.httpMethod=$httpMethod, s.pathTemplate=$pathTemplate, s.eventTopic=$eventTopic, s.framework=$framework, s.version=$version, s.specJson=$specJson, s.confidence=$confidence, s.batchId=$batchId, s.indexedAt=$indexedAt, s.active=$active;",
      { ...spec, sourceSymbolId: spec.sourceSymbolId ?? "", httpMethod: spec.httpMethod ?? "", pathTemplate: spec.pathTemplate ?? "", eventTopic: spec.eventTopic ?? "", framework: spec.framework ?? "", version: spec.version ?? "", batchId: spec.batchId ?? "", indexedAt: spec.indexedAt ?? "", active: spec.active ?? true } as unknown as Record<string, GraphValue>
    );
  }

  async addHasSpec(edge: ContractSpecEdge): Promise<void> {
    await this.query(
      "MATCH (c:Contract {id: $contractId}), (s:ContractSpec {id: $specId}) MERGE (c)-[r:HAS_SPEC {evidenceId: $evidenceId}]->(s) SET r.confidence = $confidence, r.batchId = $batchId, r.active = $active;",
      { contractId: edge.contractId, specId: edge.specId, evidenceId: edge.evidenceId, confidence: edge.confidence, batchId: edge.batchId ?? "", active: edge.active ?? true }
    );
  }

  async addSemanticRelation(edge: SemanticRelationEdge): Promise<void> {
    await this.query(
      "MATCH (a:ContractSpec {id: $fromSpecId}), (b:ContractSpec {id: $toSpecId}) MERGE (a)-[r:SEMANTIC_REL {kind: $kind, evidenceId: $evidenceId}]->(b) SET r.reason = $reason, r.confidence = $confidence, r.batchId = $batchId, r.active = $active;",
      { fromSpecId: edge.fromSpecId, toSpecId: edge.toSpecId, kind: edge.kind, evidenceId: edge.evidenceId, reason: edge.reason, confidence: edge.confidence, batchId: edge.batchId ?? "", active: edge.active ?? true }
    );
  }

  async addSemanticRelationsBatch(edges: SemanticRelationEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const batchSize = 5000;
    for (let i = 0; i < edges.length; i += batchSize) {
      const chunk = edges.slice(i, i + batchSize);
      const params = chunk.map((edge) => ({
        fromSpecId: edge.fromSpecId,
        toSpecId: edge.toSpecId,
        kind: edge.kind,
        evidenceId: edge.evidenceId,
        reason: edge.reason,
        confidence: edge.confidence,
        batchId: edge.batchId ?? "",
        active: edge.active ?? true
      }));
      await this.query(
        "UNWIND $batch AS edge " +
        "MATCH (a:ContractSpec {id: edge.fromSpecId}), (b:ContractSpec {id: edge.toSpecId}) " +
        "MERGE (a)-[r:SEMANTIC_REL {kind: edge.kind, evidenceId: edge.evidenceId}]->(b) " +
        "SET r.reason = edge.reason, r.confidence = edge.confidence, r.batchId = edge.batchId, r.active = edge.active;",
        { batch: params as unknown as GraphValue }
      );
    }
  }

  async addContractEvidence(contractIdValue: string, evidenceIdValue: string): Promise<void> {
    await this.query("MATCH (c:Contract {id: $contractId}), (e:Evidence {id: $evidenceId}) MERGE (c)-[:HAS_EVIDENCE]->(e);", { contractId: contractIdValue, evidenceId: evidenceIdValue });
  }

  async addRepoEvidence(repoIdValue: string, evidenceIdValue: string): Promise<void> {
    await this.query("MATCH (r:Repo {id: $repoId}), (e:Evidence {id: $evidenceId}) MERGE (r)-[:HAS_EVIDENCE]->(e);", { repoId: repoIdValue, evidenceId: evidenceIdValue });
  }

  async addContains(fromId: string, toId: string): Promise<void> {
    const query = fromId.startsWith("system:")
      ? "MATCH (a:System {id: $fromId}), (b:Repo {id: $toId}) MERGE (a)-[:CONTAINS]->(b);"
      : fromId.startsWith("repo:")
        ? "MATCH (a:Repo {id: $fromId}), (b:File {id: $toId}) MERGE (a)-[:CONTAINS]->(b);"
      : toId.startsWith("section:")
        ? "MATCH (a:File {id: $fromId}), (b:Section {id: $toId}) MERGE (a)-[:CONTAINS]->(b);"
        : "MATCH (a:File {id: $fromId}), (b:Code {id: $toId}) MERGE (a)-[:CONTAINS]->(b);";
    await this.query(query, { fromId, toId });
  }

  async addImport(edge: ImportEdge): Promise<void> {
    await this.query("MATCH (a:File {id: $fromFileId}), (b:File {id: $toFileId}) MERGE (a)-[r:IMPORTS {module: $module, raw: $raw}]->(b) SET r.batchId = $batchId, r.active = $active;", { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>);
  }

  async addCall(edge: CallEdge): Promise<void> {
    await this.query("MATCH (a:Code {id: $fromCodeId}), (b:Code {id: $toCodeId}) MERGE (a)-[r:CALLS {raw: $raw}]->(b) SET r.confidence = $confidence, r.resolution = $resolution, r.batchId = $batchId, r.active = $active;", { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>);
  }

  async addMention(codeIdValue: string, entityIdValue: string, confidence: number): Promise<void> {
    await this.query("MATCH (c:Code {id: $codeId}), (e:Entity {id: $entityId}) MERGE (c)-[r:MENTIONS {confidence: $confidence}]->(e);", { codeId: codeIdValue, entityId: entityIdValue, confidence });
  }

  async addSectionMention(sectionIdValue: string, entityIdValue: string, confidence: number): Promise<void> {
    await this.query("MATCH (s:Section {id: $sectionId}), (e:Entity {id: $entityId}) MERGE (s)-[r:MENTIONS {confidence: $confidence}]->(e);", { sectionId: sectionIdValue, entityId: entityIdValue, confidence });
  }

  async addSectionDescribesRepo(sectionIdValue: string, repoIdValue: string): Promise<void> {
    await this.query("MATCH (s:Section {id: $sectionId}), (r:Repo {id: $repoId}) MERGE (s)-[:DESCRIBES]->(r);", { sectionId: sectionIdValue, repoId: repoIdValue });
  }

  async addSectionDocumentsCode(sectionIdValue: string, codeIdValue: string, confidence: number): Promise<void> {
    await this.query("MATCH (s:Section {id: $sectionId}), (c:Code {id: $codeId}) MERGE (s)-[r:DOCUMENTS {confidence: $confidence}]->(c);", { sectionId: sectionIdValue, codeId: codeIdValue, confidence });
  }

  async addSectionReferencesFile(sectionIdValue: string, fileIdValue: string, raw: string): Promise<void> {
    await this.query("MATCH (s:Section {id: $sectionId}), (f:File {id: $fileId}) MERGE (s)-[r:REFERENCES {raw: $raw}]->(f);", { sectionId: sectionIdValue, fileId: fileIdValue, raw });
  }

  async clearRepoDependencies(repoIds?: string[]): Promise<void> {
    if (repoIds && repoIds.length > 0) {
      await this.query(
        "MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo) WHERE a.id IN $repoIds OR b.id IN $repoIds DELETE r;",
        { repoIds }
      );
      return;
    }
    await this.query("MATCH (:Repo)-[r:DEPENDS_ON]->(:Repo) DELETE r;");
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
    for (const statement of statements) await this.query(statement, params);
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
    if (staleFileIds.length === 0) return 0;
    for (const staleFileId of staleFileIds) {
      const nodeParams = { staleFileId, batchId: input.batchId, staleIndexedAt: input.indexedAt, active: false };
      const relParams = { staleFileId, batchId: input.batchId, active: false };
      await this.query("MATCH (f:File) WHERE f.id = $staleFileId SET f.active = $active, f.batchId = $batchId, f.indexedAt = $staleIndexedAt;", nodeParams);
      await this.query("MATCH (c:Code) WHERE c.fileId = $staleFileId SET c.active = $active, c.batchId = $batchId, c.indexedAt = $staleIndexedAt;", nodeParams);
      await this.query("MATCH (s:Section) WHERE s.fileId = $staleFileId SET s.active = $active, s.batchId = $batchId, s.indexedAt = $staleIndexedAt;", nodeParams);
      await this.query("MATCH (e:Evidence) WHERE e.fileId = $staleFileId SET e.active = $active, e.batchId = $batchId, e.indexedAt = $staleIndexedAt;", nodeParams);
      await this.query("MATCH (a:File)-[r:IMPORTS]->(b:File) WHERE a.id = $staleFileId OR b.id = $staleFileId SET r.active = $active, r.batchId = $batchId;", relParams);
      await this.query("MATCH (a:Code)-[r:CALLS]->(b:Code) WHERE a.fileId = $staleFileId OR b.fileId = $staleFileId SET r.active = $active, r.batchId = $batchId;", relParams);
      for (const rel of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON", "HAS_SPEC"]) {
        await this.query(`MATCH ()-[r:${rel}]->(), (e:Evidence) WHERE r.evidenceId = e.id AND e.fileId = $staleFileId SET r.active = $active, r.batchId = $batchId;`, relParams);
      }
      await this.query("MATCH (cs:ContractSpec) WHERE cs.fileId = $staleFileId SET cs.active = $active, cs.batchId = $batchId;", relParams);
      await this.query("MATCH (cs:ContractSpec)-[r:SEMANTIC_REL]->(cs2:ContractSpec) WHERE cs.fileId = $staleFileId SET r.active = $active, r.batchId = $batchId;", relParams);
      await this.query("MATCH (cs2:ContractSpec)-[r:SEMANTIC_REL]->(cs:ContractSpec) WHERE cs.fileId = $staleFileId SET r.active = $active, r.batchId = $batchId;", relParams);
    }
    const evidenceRows = input.activeFileIds.length === 0
      ? await this.query<{ id: string }>(
        "MATCH (e:Evidence) WHERE e.repoId = $repoId AND (e.active IS NULL OR e.active = true) RETURN e.id AS id;",
        { repoId: input.repoId }
      )
      : await this.query<{ id: string }>(
        "MATCH (e:Evidence) WHERE e.repoId = $repoId AND NOT (e.fileId IN $activeFileIds) AND (e.active IS NULL OR e.active = true) RETURN e.id AS id;",
        { repoId: input.repoId, activeFileIds: input.activeFileIds }
      );
    for (const evidenceIdValue of evidenceRows.map((row) => row.id)) {
      const relParams = { evidenceId: evidenceIdValue, batchId: input.batchId, active: false };
      await this.query("MATCH (e:Evidence) WHERE e.id = $evidenceId SET e.active = $active, e.batchId = $batchId;", relParams);
      for (const rel of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON", "HAS_SPEC"]) {
        await this.query(`MATCH ()-[r:${rel}]->() WHERE r.evidenceId = $evidenceId SET r.active = $active, r.batchId = $batchId;`, relParams);
      }
    }
    if (input.activeFileIds.length === 0) {
      await this.query(
        "MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo) WHERE a.id = $repoId OR b.id = $repoId SET r.active = $active, r.batchId = $batchId;",
        { repoId: input.repoId, batchId: input.batchId, active: false }
      );
    }
    return staleFileIds.length;
  }

  async upsertIndexState(state: { repoId: string; repoName: string; lastBatchId: string; lastIndexedAt: string; lastCommitSha: string; filesScanned: number; filesChanged: number; filesStale: number; status: string; error?: string; graphWriteAtomicity?: GraphWriteAtomicityMode; graphWriteStatus?: GraphWriteBatchStatus }): Promise<void> {
    await this.query(
      "MERGE (s:IndexState {id: $id}) ON CREATE SET s.repoId=$repoId, s.repoName=$repoName, s.lastBatchId=$lastBatchId, s.lastIndexedAt=$lastIndexedAt, s.lastCommitSha=$lastCommitSha, s.filesScanned=$filesScanned, s.filesChanged=$filesChanged, s.filesStale=$filesStale, s.status=$status, s.error=$error, s.graphWriteAtomicity=$graphWriteAtomicity, s.graphWriteStatus=$graphWriteStatus ON MATCH SET s.repoId=$repoId, s.repoName=$repoName, s.lastBatchId=$lastBatchId, s.lastIndexedAt=$lastIndexedAt, s.lastCommitSha=$lastCommitSha, s.filesScanned=$filesScanned, s.filesChanged=$filesChanged, s.filesStale=$filesStale, s.status=$status, s.error=$error, s.graphWriteAtomicity=$graphWriteAtomicity, s.graphWriteStatus=$graphWriteStatus;",
      { id: `index-state:${state.repoId}`, ...state, error: state.error ?? "", graphWriteAtomicity: state.graphWriteAtomicity ?? "", graphWriteStatus: state.graphWriteStatus ?? "" } as unknown as Record<string, GraphValue>
    );
  }

  async knownFileHashes(repoIdValue: string): Promise<Map<string, string>> {
    const rows = await this.query<{ id: string; hash: string }>(
      "MATCH (f:File) WHERE f.repoId = $repoId RETURN f.id AS id, f.hash AS hash;",
      { repoId: repoIdValue }
    );
    return new Map(rows.map((row) => [row.id, row.hash]));
  }

  async repoCount(): Promise<number> {
    const rows = await this.query<{ count: number }>("MATCH (r:Repo) RETURN count(r) AS count;");
    return Number(rows[0]?.count ?? 0);
  }

  async listRepos(): Promise<RepoNode[]> {
    return this.query<RepoNode>(
      "MATCH (r:Repo) RETURN r.id AS id, r.name AS name, r.path AS path, r.remoteUrl AS remoteUrl, r.branch AS branch, r.commitSha AS commitSha, r.language AS language, r.indexedAt AS indexedAt, r.summary AS summary;"
    );
  }

  async listActiveAliasOverrides(): Promise<ActiveAliasOverride[]> {
    return this.query<ActiveAliasOverride>(
      "MATCH (a:AliasOverride) WHERE a.active IS NULL OR a.active = true RETURN a.alias AS alias, a.targetRepoId AS targetRepoId;"
    );
  }

  async rejectEvidence(input: { evidenceId: string; reason: string }): Promise<void> {
    const createdAt = new Date().toISOString();
    await this.query(
      "MERGE (f:RelationFeedback {id: $id}) ON CREATE SET f.evidenceId=$evidenceId, f.action=$action, f.reason=$reason, f.createdAt=$createdAt ON MATCH SET f.action=$action, f.reason=$reason, f.createdAt=$createdAt;",
      { id: `feedback:${input.evidenceId}:reject`, evidenceId: input.evidenceId, action: "reject", reason: input.reason, createdAt }
    );
    await this.query("MATCH (e:Evidence) WHERE e.id = $evidenceId SET e.active = false;", { evidenceId: input.evidenceId });
    for (const rel of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON"]) {
      await this.query(`MATCH ()-[r:${rel}]->() WHERE r.evidenceId = $evidenceId SET r.active = false;`, { evidenceId: input.evidenceId });
    }
  }

  async upsertAliasOverride(input: { alias: string; targetRepoId: string; reason: string }): Promise<void> {
    const createdAt = new Date().toISOString();
    await this.query(
      "MERGE (a:AliasOverride {id: $id}) ON CREATE SET a.alias=$alias, a.targetRepoId=$targetRepoId, a.reason=$reason, a.createdAt=$createdAt, a.active=true ON MATCH SET a.targetRepoId=$targetRepoId, a.reason=$reason, a.createdAt=$createdAt, a.active=true;",
      { id: `alias:${input.alias.toLowerCase()}`, alias: input.alias, targetRepoId: input.targetRepoId, reason: input.reason, createdAt }
    );
  }

  async listContracts(options: { limit?: number; kind?: ContractKind } = {}): Promise<ContractSummaryRow[]> {
    const limit = options.limit ?? 100;
    const kindFilter = options.kind ? "WHERE c.kind = $kind" : "";
    return this.query<ContractSummaryRow>(
      `MATCH (c:Contract)
       ${kindFilter}
       RETURN c.kind AS kind, c.key AS key, c.name AS name,
         COUNT { MATCH (:Repo)-[p:PRODUCES]->(c) WHERE p.active IS NULL OR p.active = true }
         + COUNT { MATCH (:Repo)-[o:OWNS_PACKAGE]->(c) WHERE o.active IS NULL OR o.active = true } AS producers,
         COUNT { MATCH (:Repo)-[u:CONSUMES]->(c) WHERE u.active IS NULL OR u.active = true } AS consumers,
         COUNT { MATCH (:Repo)-[s:SHARES_CONTRACT]->(c) WHERE s.active IS NULL OR s.active = true } AS shared
       ORDER BY c.kind, c.key
       LIMIT ${limit};`,
      options.kind ? { kind: options.kind } : undefined
    );
  }

  async query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
    const conn = this.connection();
    if (params && Object.keys(params).length > 0) {
      const statement = await conn.prepare(cypher);
      if (!statement.isSuccess()) throw new Error(statement.getErrorMessage());
      return allRows(await conn.execute(statement, params)) as Promise<T[]>;
    }
    return allRows(await conn.query(cypher)) as Promise<T[]>;
  }

  async stats(): Promise<Stats> {
    const [repos, files, codeNodes, sectionNodes, callEdges, importEdges, entities] = await Promise.all([
      this.query<{ count: number }>("MATCH (n:Repo) RETURN count(n) AS count;"),
      this.query<{ count: number }>("MATCH (n:File) WHERE n.active IS NULL OR n.active = true RETURN count(n) AS count;"),
      this.query<{ count: number }>("MATCH (n:Code) WHERE n.active IS NULL OR n.active = true RETURN count(n) AS count;"),
      this.query<{ count: number }>("MATCH (n:Section) WHERE n.active IS NULL OR n.active = true RETURN count(n) AS count;"),
      this.query<{ count: number }>("MATCH (:Code)-[r:CALLS]->(:Code) WHERE r.active IS NULL OR r.active = true RETURN count(r) AS count;"),
      this.query<{ count: number }>("MATCH (:File)-[r:IMPORTS]->(:File) WHERE r.active IS NULL OR r.active = true RETURN count(r) AS count;"),
      this.query<{ count: number }>("MATCH (n:Entity) RETURN count(n) AS count;")
    ]);
    return {
      repos: Number(repos[0]?.count ?? 0),
      files: Number(files[0]?.count ?? 0),
      codeNodes: Number(codeNodes[0]?.count ?? 0),
      sectionNodes: Number(sectionNodes[0]?.count ?? 0),
      callEdges: Number(callEdges[0]?.count ?? 0),
      importEdges: Number(importEdges[0]?.count ?? 0),
      entities: Number(entities[0]?.count ?? 0)
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (shouldUseManagedKuzuClose()) {
      managedKuzuHandles.push({ db: this.db, conn: this.conn });
      return;
    }

    const conn = this.conn;
    const db = this.db;
    this.conn = undefined;
    this.db = undefined;
    if (conn) await conn.close();
    if (db) await db.close();
  }

  private connection(): kuzu.Connection {
    if (this.closed || !this.conn || !this.db) throw new Error("Graph database is closed");
    return this.conn;
  }
}

function shouldUseManagedKuzuClose(): boolean {
  const mode = process.env.LOGICLENS_KUZU_CLOSE_MODE?.toLowerCase();
  if (mode === "explicit") return false;
  return true;
}
