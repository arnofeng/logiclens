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
  WorkflowNode,
  WorkflowOperationEdge
} from "../../parsers/types.js";
import { systemId } from "../schema.js";
import type {
  GraphDB,
  GraphValue,
  GraphWriteAtomicityMode,
  GraphWriteBatchStatus,
  GraphWriteBatchJournal,
  ActiveAliasOverride,
  ContractSummaryRow,
  Stats
} from "../db.js";

/**
 * Convert a GraphValue to a Neo4j-compatible value.
 * Neo4j driver handles most types natively, but bigint needs conversion.
 */
function toNeo4jValue(value: GraphValue): unknown {
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

function toNeo4jParams(params?: Record<string, GraphValue>): Record<string, unknown> {
  if (!params) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    result[key] = toNeo4jValue(value);
  }
  return result;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (neo4j.isInt(value)) return (value as Integer).toNumber();
  return Number(value);
}

function recordToPlain(record: Neo4jRecord): Record<string, unknown> {
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
  "CREATE CONSTRAINT IF NOT EXISTS FOR (n:AliasOverride) REQUIRE n.id IS UNIQUE"
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
  "CREATE INDEX IF NOT EXISTS FOR (g:GraphWriteBatch) ON (g.batchId)"
];

export class Neo4jGraphDB implements GraphDB {
  private driver: Driver;
  private closed = false;

  private constructor(driver: Driver) {
    this.driver = driver;
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

  private getSession(): Session {
    if (this.closed) throw new Error("Graph database is closed");
    return this.driver.session({ defaultAccessMode: neo4j.session.WRITE });
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
      "MATCH (a:Repo {id: $fromRepoId}), (b:Repo {id: $toRepoId}) MERGE (a)-[r:DEPENDS_ON {dependencyType: $dependencyType, sourceContractId: $sourceContractId, targetContractId: $targetContractId, evidenceId: $evidenceId}]->(b) SET r.raw = $raw, r.confidence = $confidence, r.batchId = $batchId, r.active = $active;",
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
        "MERGE (a)-[r:DEPENDS_ON {dependencyType: edge.dependencyType, sourceContractId: edge.sourceContractId, targetContractId: edge.targetContractId, evidenceId: edge.evidenceId}]->(b) " +
        "SET r.raw = edge.raw, r.confidence = edge.confidence, r.batchId = edge.batchId, r.active = edge.active;",
        { batch: params as unknown as GraphValue }
      );
    }
  }

  async addPackageUsage(edge: PackageUsageEdge): Promise<void> {
    await this.query(
      "MATCH (r:Repo {id: $repoId}), (c:Contract {id: $packageContractId}) MERGE (r)-[u:USES_PACKAGE {packageName: $packageName, evidenceId: $evidenceId}]->(c) SET u.raw = $raw, u.confidence = $confidence, u.batchId = $batchId, u.active = $active;",
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
    await this.query("MATCH (a:File {id: $fromFileId}), (b:File {id: $toFileId}) MERGE (a)-[r:IMPORTS {module: $module}]->(b) SET r.raw = $raw, r.batchId = $batchId, r.active = $active;", { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>);
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
    for (const table of ["File", "Code", "Section", "Evidence"]) {
      await this.query(`MATCH (n:${table}) WHERE n.batchId = $batchId SET n.active = $active;`, params);
    }
    for (const rel of ["IMPORTS", "CALLS", "OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON"]) {
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

    const batchParams = { staleFileIds, batchId: input.batchId, staleIndexedAt: input.indexedAt, active: false };

    // Batch-update File, Code, Section, Evidence nodes
    await this.query("UNWIND $staleFileIds AS staleFileId MATCH (f:File) WHERE f.id = staleFileId SET f.active = $active, f.batchId = $batchId, f.indexedAt = $staleIndexedAt;", batchParams);
    await this.query("UNWIND $staleFileIds AS staleFileId MATCH (c:Code) WHERE c.fileId = staleFileId SET c.active = $active, c.batchId = $batchId, c.indexedAt = $staleIndexedAt;", batchParams);
    await this.query("UNWIND $staleFileIds AS staleFileId MATCH (s:Section) WHERE s.fileId = staleFileId SET s.active = $active, s.batchId = $batchId, s.indexedAt = $staleIndexedAt;", batchParams);
    await this.query("UNWIND $staleFileIds AS staleFileId MATCH (e:Evidence) WHERE e.fileId = staleFileId SET e.active = $active, e.batchId = $batchId, e.indexedAt = $staleIndexedAt;", batchParams);

    // Batch-update relationships tied to stale file IDs
    await this.query("UNWIND $staleFileIds AS staleFileId MATCH (a:File)-[r:IMPORTS]->(b:File) WHERE a.id = staleFileId OR b.id = staleFileId SET r.active = $active, r.batchId = $batchId;", batchParams);
    await this.query("UNWIND $staleFileIds AS staleFileId MATCH (a:Code)-[r:CALLS]->(b:Code) WHERE a.fileId = staleFileId OR b.fileId = staleFileId SET r.active = $active, r.batchId = $batchId;", batchParams);
    for (const rel of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON"]) {
      await this.query(`UNWIND $staleFileIds AS staleFileId MATCH ()-[r:${rel}]->(), (e:Evidence) WHERE r.evidenceId = e.id AND e.fileId = staleFileId SET r.active = $active, r.batchId = $batchId;`, batchParams);
    }

    // Handle stale evidence
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
    if (staleEvidenceIds.length > 0) {
      const evidenceBatchParams = { staleEvidenceIds, batchId: input.batchId, active: false };
      await this.query("UNWIND $staleEvidenceIds AS evidenceId MATCH (e:Evidence) WHERE e.id = evidenceId SET e.active = $active, e.batchId = $batchId;", evidenceBatchParams);
      for (const rel of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON"]) {
        await this.query(`UNWIND $staleEvidenceIds AS evidenceId MATCH ()-[r:${rel}]->() WHERE r.evidenceId = evidenceId SET r.active = $active, r.batchId = $batchId;`, evidenceBatchParams);
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
    return toNumber(rows[0]?.count ?? 0);
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
        for (const rel of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON"]) {
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

  async listContracts(options: { limit?: number; kind?: ContractKind } = {}): Promise<ContractSummaryRow[]> {
    const limit = options.limit ?? 100;
    const kindFilter = options.kind ? "WHERE c.kind = $kind" : "";
    const params: Record<string, GraphValue> = { limit };
    if (options.kind) params.kind = options.kind;
    return this.query<ContractSummaryRow>(
      `MATCH (c:Contract)
       ${kindFilter}
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

  async query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
    const session = this.getSession();
    try {
      const result = await session.run(cypher, toNeo4jParams(params));
      return result.records.map((record) => recordToPlain(record) as T);
    } finally {
      await session.close();
    }
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
      repos: toNumber(repos[0]?.count ?? 0),
      files: toNumber(files[0]?.count ?? 0),
      codeNodes: toNumber(codeNodes[0]?.count ?? 0),
      sectionNodes: toNumber(sectionNodes[0]?.count ?? 0),
      callEdges: toNumber(callEdges[0]?.count ?? 0),
      importEdges: toNumber(importEdges[0]?.count ?? 0),
      entities: toNumber(entities[0]?.count ?? 0)
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.driver.close();
  }
}

function decodeList(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
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
