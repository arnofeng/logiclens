import type {
  CallEdge,
  CodeSymbol,
  ContractEntityEdge,
  ContractNode,
  ContractSpecEdge,
  ContractSpecNode,
  DocSection,
  EntityNode,
  EvidenceNode,
  FileNode,
  ImportEdge,
  OperationNode,
  OperationRepoEdge,
  RepoContractEdge,
  RepoDependencyEdge,
  RepoNode,
  SemanticRelationEdge,
  WorkflowNode,
  WorkflowOperationEdge
} from "../parsing/types.js";
import { chunk } from "../../shared/chunk.js";
import { systemId } from "./schema.js";
import type { ActiveAliasOverride, GraphValue, GraphWriteAtomicityMode, GraphWriteBatchStatus, Stats } from "./db.js";

const BATCH_SIZE = 5000;

export type CypherExecutor = {
  query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]>;
};

export type CypherCrud = ReturnType<typeof createCypherCrud>;

export function createCypherCrud(executor: CypherExecutor) {
  const query = executor.query.bind(executor);

  async function addContains(fromId: string, toId: string): Promise<void> {
    const cypher = fromId.startsWith("system:")
      ? "MATCH (a:System {id: $fromId}), (b:Repo {id: $toId}) MERGE (a)-[:CONTAINS]->(b);"
      : fromId.startsWith("repo:")
        ? "MATCH (a:Repo {id: $fromId}), (b:File {id: $toId}) MERGE (a)-[:CONTAINS]->(b);"
        : toId.startsWith("section:")
          ? "MATCH (a:File {id: $fromId}), (b:Section {id: $toId}) MERGE (a)-[:CONTAINS]->(b);"
          : "MATCH (a:File {id: $fromId}), (b:Code {id: $toId}) MERGE (a)-[:CONTAINS]->(b);";
    await query(cypher, { fromId, toId });
  }

  return {
    async upsertRepo(repo: RepoNode): Promise<void> {
      await query(
        // NOTE: ON MATCH intentionally omits r.summary — summary is managed
        // separately via updateRepoSummary().
        "MERGE (r:Repo {id: $id}) ON CREATE SET r.name=$name, r.path=$path, r.remoteUrl=$remoteUrl, r.branch=$branch, r.commitSha=$commitSha, r.language=$language, r.indexedAt=$indexedAt, r.summary=$summary ON MATCH SET r.name=$name, r.path=$path, r.remoteUrl=$remoteUrl, r.branch=$branch, r.commitSha=$commitSha, r.language=$language, r.indexedAt=$indexedAt;",
        { ...repo, summary: repo.summary ?? "" } as unknown as Record<string, GraphValue>
      );
      await addContains(systemId, repo.id);
    },

    async updateRepoSummary(repoIdValue: string, summary: string): Promise<void> {
      await query("MATCH (r:Repo {id: $repoId}) SET r.summary = $summary;", { repoId: repoIdValue, summary });
    },

    async updateSystemSummary(summary: string): Promise<void> {
      await query("MATCH (s:System {id: $id}) SET s.summary = $summary;", { id: systemId, summary });
    },

    async upsertFile(file: FileNode): Promise<void> {
      await query(
        "MERGE (f:File {id: $id}) ON CREATE SET f.repoId=$repoId, f.path=$path, f.language=$language, f.hash=$hash, f.loc=$loc, f.batchId=$batchId, f.indexedAt=$indexedAt, f.active=$active ON MATCH SET f.repoId=$repoId, f.path=$path, f.language=$language, f.hash=$hash, f.loc=$loc, f.batchId=$batchId, f.indexedAt=$indexedAt, f.active=$active;",
        { ...file, batchId: file.batchId ?? "", indexedAt: file.indexedAt ?? "", active: file.active ?? true } as unknown as Record<string, GraphValue>
      );
    },

    async upsertFilesBatch(files: FileNode[]): Promise<void> {
      for (const items of chunk(files, BATCH_SIZE)) {
        const params = items.map((f) => ({
          id: f.id, repoId: f.repoId, path: f.path, language: f.language,
          hash: f.hash, loc: f.loc, batchId: f.batchId ?? "", indexedAt: f.indexedAt ?? "", active: f.active ?? true
        }));
        await query(
          "UNWIND $batch AS row " +
          "MERGE (f:File {id: row.id}) " +
          "ON CREATE SET f.repoId=row.repoId, f.path=row.path, f.language=row.language, f.hash=row.hash, f.loc=row.loc, f.batchId=row.batchId, f.indexedAt=row.indexedAt, f.active=row.active " +
          "ON MATCH SET f.repoId=row.repoId, f.path=row.path, f.language=row.language, f.hash=row.hash, f.loc=row.loc, f.batchId=row.batchId, f.indexedAt=row.indexedAt, f.active=row.active;",
          { batch: params as unknown as GraphValue }
        );
      }
    },

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
      await query(
        "MERGE (c:Code {id: $id}) ON CREATE SET c.repoId=$repoId, c.fileId=$fileId, c.kind=$kind, c.name=$name, c.qualifiedName=$qualifiedName, c.startLine=$startLine, c.endLine=$endLine, c.signature=$signature, c.summary=$summary, c.hash=$hash, c.batchId=$batchId, c.indexedAt=$indexedAt, c.active=$active ON MATCH SET c.repoId=$repoId, c.fileId=$fileId, c.kind=$kind, c.name=$name, c.qualifiedName=$qualifiedName, c.startLine=$startLine, c.endLine=$endLine, c.signature=$signature, c.summary=$summary, c.hash=$hash, c.batchId=$batchId, c.indexedAt=$indexedAt, c.active=$active;",
        params as unknown as Record<string, GraphValue>
      );
    },

    async upsertCodeBatch(codes: CodeSymbol[]): Promise<void> {
      for (const items of chunk(codes, BATCH_SIZE)) {
        const params = items.map((c) => ({
          id: c.id, repoId: c.repoId, fileId: c.fileId, kind: c.kind,
          name: c.name, qualifiedName: c.qualifiedName, startLine: c.startLine,
          endLine: c.endLine, signature: c.signature, summary: c.summary ?? "",
          hash: c.hash, batchId: c.batchId ?? "", indexedAt: c.indexedAt ?? "", active: c.active ?? true
        }));
        await query(
          "UNWIND $batch AS row " +
          "MERGE (c:Code {id: row.id}) " +
          "ON CREATE SET c.repoId=row.repoId, c.fileId=row.fileId, c.kind=row.kind, c.name=row.name, c.qualifiedName=row.qualifiedName, c.startLine=row.startLine, c.endLine=row.endLine, c.signature=row.signature, c.summary=row.summary, c.hash=row.hash, c.batchId=row.batchId, c.indexedAt=row.indexedAt, c.active=row.active " +
          "ON MATCH SET c.repoId=row.repoId, c.fileId=row.fileId, c.kind=row.kind, c.name=row.name, c.qualifiedName=row.qualifiedName, c.startLine=row.startLine, c.endLine=row.endLine, c.signature=row.signature, c.summary=row.summary, c.hash=row.hash, c.batchId=row.batchId, c.indexedAt=row.indexedAt, c.active=row.active;",
          { batch: params as unknown as GraphValue }
        );
      }
    },

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
      await query(
        "MERGE (s:Section {id: $id}) ON CREATE SET s.repoId=$repoId, s.fileId=$fileId, s.heading=$heading, s.level=$level, s.startLine=$startLine, s.endLine=$endLine, s.text=$text, s.summary=$summary, s.hash=$hash, s.batchId=$batchId, s.indexedAt=$indexedAt, s.active=$active ON MATCH SET s.repoId=$repoId, s.fileId=$fileId, s.heading=$heading, s.level=$level, s.startLine=$startLine, s.endLine=$endLine, s.text=$text, s.summary=$summary, s.hash=$hash, s.batchId=$batchId, s.indexedAt=$indexedAt, s.active=$active;",
        params as unknown as Record<string, GraphValue>
      );
    },

    async upsertEntity(entity: EntityNode): Promise<void> {
      await query(
        "MERGE (e:Entity {id: $id}) ON CREATE SET e.name=$name, e.kind=$kind, e.description=$description ON MATCH SET e.name=$name, e.kind=$kind, e.description=$description;",
        entity as unknown as Record<string, GraphValue>
      );
    },

    async upsertOperation(operation: OperationNode): Promise<void> {
      await query(
        "MERGE (o:Operation {id: $id}) ON CREATE SET o.verb=$verb, o.entityName=$entityName, o.description=$description ON MATCH SET o.verb=$verb, o.entityName=$entityName, o.description=$description;",
        operation as unknown as Record<string, GraphValue>
      );
    },

    async upsertWorkflow(workflow: WorkflowNode): Promise<void> {
      await query(
        "MERGE (w:Workflow {id: $id}) ON CREATE SET w.name=$name, w.description=$description ON MATCH SET w.name=$name, w.description=$description;",
        workflow as unknown as Record<string, GraphValue>
      );
    },

    async upsertContract(contract: ContractNode): Promise<void> {
      await query(
        "MERGE (c:Contract {id: $id}) ON CREATE SET c.kind=$kind, c.key=$key, c.name=$name, c.description=$description ON MATCH SET c.kind=$kind, c.key=$key, c.name=$name, c.description=$description;",
        contract as unknown as Record<string, GraphValue>
      );
    },

    async upsertEvidence(evidence: EvidenceNode): Promise<void> {
      await query(
        "MERGE (e:Evidence {id: $id}) ON CREATE SET e.repoId=$repoId, e.fileId=$fileId, e.filePath=$filePath, e.line=$line, e.raw=$raw, e.rule=$rule, e.confidence=$confidence, e.batchId=$batchId, e.indexedAt=$indexedAt, e.active=$active ON MATCH SET e.repoId=$repoId, e.fileId=$fileId, e.filePath=$filePath, e.line=$line, e.raw=$raw, e.rule=$rule, e.confidence=$confidence, e.batchId=$batchId, e.indexedAt=$indexedAt, e.active=$active;",
        { ...evidence, batchId: evidence.batchId ?? "", indexedAt: evidence.indexedAt ?? "", active: evidence.active ?? true } as unknown as Record<string, GraphValue>
      );
    },

    async addRepoContract(edge: RepoContractEdge): Promise<void> {
      const rel = edge.role === "owner" ? "OWNS_PACKAGE" : edge.role === "producer" ? "PRODUCES" : edge.role === "consumer" ? "CONSUMES" : "SHARES_CONTRACT";
      await query(
        `MATCH (r:Repo {id: $repoId}), (c:Contract {id: $contractId}) MERGE (r)-[rel:${rel} {evidenceId: $evidenceId}]->(c) SET rel.confidence = $confidence, rel.batchId = $batchId, rel.active = $active;`,
        { repoId: edge.repoId, contractId: edge.contractId, evidenceId: edge.evidenceId, confidence: edge.confidence, batchId: edge.batchId ?? "", active: edge.active ?? true }
      );
    },

    async addRepoDependency(edge: RepoDependencyEdge): Promise<void> {
      await query(
        "MATCH (a:Repo {id: $fromRepoId}), (b:Repo {id: $toRepoId}) MERGE (a)-[r:DEPENDS_ON {dependencyType: $dependencyType, sourceContractId: $sourceContractId, targetContractId: $targetContractId, evidenceId: $evidenceId}]->(b) SET r.raw = $raw, r.confidence = $confidence, r.batchId = $batchId, r.active = $active;",
        { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>
      );
    },

    async addRepoDependenciesBatch(edges: RepoDependencyEdge[]): Promise<void> {
      for (const items of chunk(edges, BATCH_SIZE)) {
        const params = items.map((edge) => ({
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
        await query(
          "UNWIND $batch AS edge " +
          "MATCH (a:Repo {id: edge.fromRepoId}), (b:Repo {id: edge.toRepoId}) " +
          "MERGE (a)-[r:DEPENDS_ON {dependencyType: edge.dependencyType, sourceContractId: edge.sourceContractId, targetContractId: edge.targetContractId, evidenceId: edge.evidenceId}]->(b) " +
          "SET r.raw = edge.raw, r.confidence = edge.confidence, r.batchId = edge.batchId, r.active = edge.active;",
          { batch: params as unknown as GraphValue }
        );
      }
    },

    async addContractEntity(edge: ContractEntityEdge): Promise<void> {
      await query(
        "MATCH (c:Contract {id: $contractId}), (e:Entity {id: $entityId}) MERGE (c)-[r:CONTRACT_MENTIONS {evidenceId: $evidenceId}]->(e) SET r.confidence = $confidence, r.batchId = $batchId, r.active = $active;",
        { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>
      );
    },

    async addOperationRepo(edge: OperationRepoEdge): Promise<void> {
      await query(
        "MATCH (r:Repo {id: $repoId}), (o:Operation {id: $operationId}) MERGE (r)-[p:PARTICIPATES_IN {role: $role, evidenceId: $evidenceId}]->(o) SET p.confidence = $confidence, p.batchId = $batchId, p.active = $active;",
        { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>
      );
    },

    async addWorkflowOperation(edge: WorkflowOperationEdge): Promise<void> {
      await query(
        "MATCH (w:Workflow {id: $workflowId}), (o:Operation {id: $operationId}) MERGE (w)-[s:WORKFLOW_STEP {step: $step, evidenceId: $evidenceId}]->(o) SET s.confidence = $confidence, s.batchId = $batchId, s.active = $active;",
        { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>
      );
    },

    async upsertContractSpec(spec: ContractSpecNode): Promise<void> {
      await query(
        "MERGE (s:ContractSpec {id: $id}) ON CREATE SET s.contractId=$contractId, s.specKind=$specKind, s.repoId=$repoId, s.fileId=$fileId, s.evidenceId=$evidenceId, s.sourceSymbolId=$sourceSymbolId, s.canonicalKey=$canonicalKey, s.httpMethod=$httpMethod, s.pathTemplate=$pathTemplate, s.eventTopic=$eventTopic, s.framework=$framework, s.version=$version, s.specJson=$specJson, s.confidence=$confidence, s.batchId=$batchId, s.indexedAt=$indexedAt, s.active=$active ON MATCH SET s.contractId=$contractId, s.specKind=$specKind, s.repoId=$repoId, s.fileId=$fileId, s.evidenceId=$evidenceId, s.sourceSymbolId=$sourceSymbolId, s.canonicalKey=$canonicalKey, s.httpMethod=$httpMethod, s.pathTemplate=$pathTemplate, s.eventTopic=$eventTopic, s.framework=$framework, s.version=$version, s.specJson=$specJson, s.confidence=$confidence, s.batchId=$batchId, s.indexedAt=$indexedAt, s.active=$active;",
        { ...spec, sourceSymbolId: spec.sourceSymbolId ?? "", httpMethod: spec.httpMethod ?? "", pathTemplate: spec.pathTemplate ?? "", eventTopic: spec.eventTopic ?? "", framework: spec.framework ?? "", version: spec.version ?? "", batchId: spec.batchId ?? "", indexedAt: spec.indexedAt ?? "", active: spec.active ?? true } as unknown as Record<string, GraphValue>
      );
    },

    async addHasSpec(edge: ContractSpecEdge): Promise<void> {
      await query(
        "MATCH (c:Contract {id: $contractId}), (s:ContractSpec {id: $specId}) MERGE (c)-[r:HAS_SPEC {evidenceId: $evidenceId}]->(s) SET r.confidence = $confidence, r.batchId = $batchId, r.active = $active;",
        { contractId: edge.contractId, specId: edge.specId, evidenceId: edge.evidenceId, confidence: edge.confidence, batchId: edge.batchId ?? "", active: edge.active ?? true }
      );
    },

    async addSemanticRelation(edge: SemanticRelationEdge): Promise<void> {
      await query(
        "MATCH (a:ContractSpec {id: $fromSpecId}), (b:ContractSpec {id: $toSpecId}) MERGE (a)-[r:SEMANTIC_REL {kind: $kind, evidenceId: $evidenceId}]->(b) SET r.reason = $reason, r.confidence = $confidence, r.batchId = $batchId, r.active = $active;",
        { fromSpecId: edge.fromSpecId, toSpecId: edge.toSpecId, kind: edge.kind, evidenceId: edge.evidenceId, reason: edge.reason, confidence: edge.confidence, batchId: edge.batchId ?? "", active: edge.active ?? true }
      );
    },

    async addSemanticRelationsBatch(edges: SemanticRelationEdge[]): Promise<void> {
      for (const items of chunk(edges, BATCH_SIZE)) {
        const params = items.map((edge) => ({
          fromSpecId: edge.fromSpecId,
          toSpecId: edge.toSpecId,
          kind: edge.kind,
          evidenceId: edge.evidenceId,
          reason: edge.reason,
          confidence: edge.confidence,
          batchId: edge.batchId ?? "",
          active: edge.active ?? true
        }));
        await query(
          "UNWIND $batch AS edge " +
          "MATCH (a:ContractSpec {id: edge.fromSpecId}), (b:ContractSpec {id: edge.toSpecId}) " +
          "MERGE (a)-[r:SEMANTIC_REL {kind: edge.kind, evidenceId: edge.evidenceId}]->(b) " +
          "SET r.reason = edge.reason, r.confidence = edge.confidence, r.batchId = edge.batchId, r.active = edge.active;",
          { batch: params as unknown as GraphValue }
        );
      }
    },

    async addContractEvidence(contractIdValue: string, evidenceIdValue: string): Promise<void> {
      await query("MATCH (c:Contract {id: $contractId}), (e:Evidence {id: $evidenceId}) MERGE (c)-[:HAS_EVIDENCE]->(e);", { contractId: contractIdValue, evidenceId: evidenceIdValue });
    },

    async addRepoEvidence(repoIdValue: string, evidenceIdValue: string): Promise<void> {
      await query("MATCH (r:Repo {id: $repoId}), (e:Evidence {id: $evidenceId}) MERGE (r)-[:HAS_EVIDENCE]->(e);", { repoId: repoIdValue, evidenceId: evidenceIdValue });
    },

    addContains,

    async addImport(edge: ImportEdge): Promise<void> {
      await query("MATCH (a:File {id: $fromFileId}), (b:File {id: $toFileId}) MERGE (a)-[r:IMPORTS {module: $module}]->(b) SET r.raw = $raw, r.batchId = $batchId, r.active = $active;", { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>);
    },

    async addImportsBatch(edges: ImportEdge[]): Promise<void> {
      for (const items of chunk(edges, BATCH_SIZE)) {
        const params = items.map((e) => ({
          fromFileId: e.fromFileId, toFileId: e.toFileId, module: e.module,
          raw: e.raw, batchId: e.batchId ?? "", active: e.active ?? true
        }));
        await query(
          "UNWIND $batch AS row " +
          "MATCH (a:File {id: row.fromFileId}), (b:File {id: row.toFileId}) " +
          "MERGE (a)-[r:IMPORTS {module: row.module}]->(b) " +
          "SET r.raw = row.raw, r.batchId = row.batchId, r.active = row.active;",
          { batch: params as unknown as GraphValue }
        );
      }
    },

    async addCall(edge: CallEdge): Promise<void> {
      await query("MATCH (a:Code {id: $fromCodeId}), (b:Code {id: $toCodeId}) MERGE (a)-[r:CALLS {raw: $raw}]->(b) SET r.confidence = $confidence, r.resolution = $resolution, r.batchId = $batchId, r.active = $active;", { ...edge, batchId: edge.batchId ?? "", active: edge.active ?? true } as unknown as Record<string, GraphValue>);
    },

    async addCallsBatch(edges: CallEdge[]): Promise<void> {
      for (const items of chunk(edges, BATCH_SIZE)) {
        const params = items.map((e) => ({
          fromCodeId: e.fromCodeId, toCodeId: e.toCodeId, raw: e.raw,
          confidence: e.confidence, resolution: e.resolution ?? "",
          batchId: e.batchId ?? "", active: e.active ?? true
        }));
        await query(
          "UNWIND $batch AS row " +
          "MATCH (a:Code {id: row.fromCodeId}), (b:Code {id: row.toCodeId}) " +
          "MERGE (a)-[r:CALLS {raw: row.raw}]->(b) " +
          "SET r.confidence = row.confidence, r.resolution = row.resolution, r.batchId = row.batchId, r.active = row.active;",
          { batch: params as unknown as GraphValue }
        );
      }
    },

    async addMention(codeIdValue: string, entityIdValue: string, confidence: number): Promise<void> {
      await query("MATCH (c:Code {id: $codeId}), (e:Entity {id: $entityId}) MERGE (c)-[r:MENTIONS {confidence: $confidence}]->(e);", { codeId: codeIdValue, entityId: entityIdValue, confidence });
    },

    async addSectionMention(sectionIdValue: string, entityIdValue: string, confidence: number): Promise<void> {
      await query("MATCH (s:Section {id: $sectionId}), (e:Entity {id: $entityId}) MERGE (s)-[r:MENTIONS {confidence: $confidence}]->(e);", { sectionId: sectionIdValue, entityId: entityIdValue, confidence });
    },

    async addSectionDescribesRepo(sectionIdValue: string, repoIdValue: string): Promise<void> {
      await query("MATCH (s:Section {id: $sectionId}), (r:Repo {id: $repoId}) MERGE (s)-[:DESCRIBES]->(r);", { sectionId: sectionIdValue, repoId: repoIdValue });
    },

    async addSectionDocumentsCode(sectionIdValue: string, codeIdValue: string, confidence: number): Promise<void> {
      await query("MATCH (s:Section {id: $sectionId}), (c:Code {id: $codeId}) MERGE (s)-[r:DOCUMENTS {confidence: $confidence}]->(c);", { sectionId: sectionIdValue, codeId: codeIdValue, confidence });
    },

    async addSectionReferencesFile(sectionIdValue: string, fileIdValue: string, raw: string): Promise<void> {
      await query("MATCH (s:Section {id: $sectionId}), (f:File {id: $fileId}) MERGE (s)-[r:REFERENCES {raw: $raw}]->(f);", { sectionId: sectionIdValue, fileId: fileIdValue, raw });
    },

    async clearRepoDependencies(repoIds?: string[]): Promise<void> {
      if (repoIds && repoIds.length > 0) {
        await query(
          "MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo) WHERE a.id IN $repoIds OR b.id IN $repoIds DELETE r;",
          { repoIds }
        );
        return;
      }
      await query("MATCH (:Repo)-[r:DEPENDS_ON]->(:Repo) DELETE r;");
    },

    async upsertIndexState(state: { repoId: string; repoName: string; lastBatchId: string; lastIndexedAt: string; lastCommitSha: string; filesScanned: number; filesChanged: number; filesStale: number; status: string; error?: string; graphWriteAtomicity?: GraphWriteAtomicityMode; graphWriteStatus?: GraphWriteBatchStatus }): Promise<void> {
      await query(
        "MERGE (s:IndexState {id: $id}) ON CREATE SET s.repoId=$repoId, s.repoName=$repoName, s.lastBatchId=$lastBatchId, s.lastIndexedAt=$lastIndexedAt, s.lastCommitSha=$lastCommitSha, s.filesScanned=$filesScanned, s.filesChanged=$filesChanged, s.filesStale=$filesStale, s.status=$status, s.error=$error, s.graphWriteAtomicity=$graphWriteAtomicity, s.graphWriteStatus=$graphWriteStatus ON MATCH SET s.repoId=$repoId, s.repoName=$repoName, s.lastBatchId=$lastBatchId, s.lastIndexedAt=$lastIndexedAt, s.lastCommitSha=$lastCommitSha, s.filesScanned=$filesScanned, s.filesChanged=$filesChanged, s.filesStale=$filesStale, s.status=$status, s.error=$error, s.graphWriteAtomicity=$graphWriteAtomicity, s.graphWriteStatus=$graphWriteStatus;",
        { id: `index-state:${state.repoId}`, ...state, error: state.error ?? "", graphWriteAtomicity: state.graphWriteAtomicity ?? "", graphWriteStatus: state.graphWriteStatus ?? "" } as unknown as Record<string, GraphValue>
      );
    },

    async knownFileHashes(repoIdValue: string): Promise<Map<string, string>> {
      const rows = await query<{ id: string; hash: string }>(
        "MATCH (f:File) WHERE f.repoId = $repoId RETURN f.id AS id, f.hash AS hash;",
        { repoId: repoIdValue }
      );
      return new Map(rows.map((row) => [row.id, row.hash]));
    },

    async repoCount(): Promise<number> {
      const rows = await query<{ count: number }>("MATCH (r:Repo) RETURN count(r) AS count;");
      return Number(rows[0]?.count ?? 0);
    },

    async listRepos(): Promise<RepoNode[]> {
      return query<RepoNode>(
        "MATCH (r:Repo) RETURN r.id AS id, r.name AS name, r.path AS path, r.remoteUrl AS remoteUrl, r.branch AS branch, r.commitSha AS commitSha, r.language AS language, r.indexedAt AS indexedAt, r.summary AS summary;"
      );
    },

    async listActiveAliasOverrides(): Promise<ActiveAliasOverride[]> {
      return query<ActiveAliasOverride>(
        "MATCH (a:AliasOverride) WHERE a.active IS NULL OR a.active = true RETURN a.alias AS alias, a.targetRepoId AS targetRepoId;"
      );
    },

    async stats(): Promise<Stats> {
      const [repos, files, codeNodes, sectionNodes, callEdges, importEdges, entities] = await Promise.all([
        query<{ count: number }>("MATCH (n:Repo) RETURN count(n) AS count;"),
        query<{ count: number }>("MATCH (n:File) WHERE n.active IS NULL OR n.active = true RETURN count(n) AS count;"),
        query<{ count: number }>("MATCH (n:Code) WHERE n.active IS NULL OR n.active = true RETURN count(n) AS count;"),
        query<{ count: number }>("MATCH (n:Section) WHERE n.active IS NULL OR n.active = true RETURN count(n) AS count;"),
        query<{ count: number }>("MATCH (:Code)-[r:CALLS]->(:Code) WHERE r.active IS NULL OR r.active = true RETURN count(r) AS count;"),
        query<{ count: number }>("MATCH (:File)-[r:IMPORTS]->(:File) WHERE r.active IS NULL OR r.active = true RETURN count(r) AS count;"),
        query<{ count: number }>("MATCH (n:Entity) RETURN count(n) AS count;")
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
  };
}
