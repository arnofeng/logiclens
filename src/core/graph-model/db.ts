import type {
  CallEdge,
  CodeSymbol,
  ContractKind,
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
  PackageUsageEdge,
  ContractEntityEdge,
  RepoContractEdge,
  RepoDependencyEdge,
  RepoNode,
  SemanticRelationEdge,
  WorkflowNode,
  WorkflowOperationEdge
} from "../parsing/types.js";

// Re-export KuzuGraphDB for backward compatibility (factory registration, tests)
export { KuzuGraphDB } from "../../adapters/graph-db/kuzu/KuzuGraphDB.js";

/**
 * Summary statistics representing the counts of different nodes and edges in the graph database.
 */
export type Stats = {
  /** Total number of repositories indexed */
  repos: number;
  /** Total number of source files indexed */
  files: number;
  /** Total number of code symbol nodes (classes, functions, etc.) */
  codeNodes: number;
  /** Total number of documentation section nodes (markdown sections, etc.) */
  sectionNodes: number;
  /** Total number of function/method call edges */
  callEdges: number;
  /** Total number of file-to-file import edges */
  importEdges: number;
  /** Total number of entity nodes discovered */
  entities: number;
};

export type GraphWriteAtomicityMode = "transactional" | "journaled-recoverable" | "best-effort";
export type GraphWriteBatchStatus = "started" | "committed" | "failed" | "recovered" | "awaiting-cleanup";

/**
 * Provider-agnostic value type for graph query parameters and results.
 * Replaces the Kuzu-specific `KuzuValue` in the public `GraphDB` interface.
 */
export type GraphValue = string | number | boolean | null | bigint | GraphValue[] | { [key: string]: GraphValue };

export type GraphWriteBatchJournal = {
  batchId: string;
  repoIds: string[];
  repoNames: string[];
  writerMode: string;
  atomicityMode: GraphWriteAtomicityMode;
  status: GraphWriteBatchStatus;
  startedAt: string;
  updatedAt: string;
  completedStage?: string;
  error?: string;
};

export type ActiveAliasOverride = { alias: string; targetRepoId: string };

/**
 * Summary statistics for a single contract, showing its producer/consumer distribution.
 */
export type ContractSummaryRow = {
  kind: string;
  key: string;
  name: string;
  producers: number;
  consumers: number;
  shared: number;
};

export interface GraphDB {
  beginTransaction?(): Promise<void>;
  commitTransaction?(): Promise<void>;
  rollbackTransaction?(): Promise<void>;
  initSchema(systemName?: string): Promise<void>;
  upsertRepo(repo: RepoNode): Promise<void>;
  updateRepoSummary(repoId: string, summary: string): Promise<void>;
  updateSystemSummary(summary: string): Promise<void>;
  upsertFile(file: FileNode): Promise<void>;
  upsertFilesBatch(files: FileNode[]): Promise<void>;
  upsertCode(code: CodeSymbol): Promise<void>;
  upsertCodeBatch(code: CodeSymbol[]): Promise<void>;
  upsertSection(section: DocSection): Promise<void>;
  upsertEntity(entity: EntityNode): Promise<void>;
  upsertOperation(operation: OperationNode): Promise<void>;
  upsertWorkflow(workflow: WorkflowNode): Promise<void>;
  upsertContract(contract: ContractNode): Promise<void>;
  upsertEvidence(evidence: EvidenceNode): Promise<void>;
  addRepoContract(edge: RepoContractEdge): Promise<void>;
  addRepoDependency(edge: RepoDependencyEdge): Promise<void>;
  addRepoDependenciesBatch(edges: RepoDependencyEdge[]): Promise<void>;
  addPackageUsage(edge: PackageUsageEdge): Promise<void>;
  addContractEntity(edge: ContractEntityEdge): Promise<void>;
  addOperationRepo(edge: OperationRepoEdge): Promise<void>;
  addWorkflowOperation(edge: WorkflowOperationEdge): Promise<void>;
  upsertContractSpec(spec: ContractSpecNode): Promise<void>;
  addHasSpec(edge: ContractSpecEdge): Promise<void>;
  addSemanticRelation(edge: SemanticRelationEdge): Promise<void>;
  addSemanticRelationsBatch(edges: SemanticRelationEdge[]): Promise<void>;
  addContractEvidence(contractId: string, evidenceId: string): Promise<void>;
  addRepoEvidence(repoId: string, evidenceId: string): Promise<void>;
  addContains(fromId: string, toId: string): Promise<void>;
  addImport(edge: ImportEdge): Promise<void>;
  addImportsBatch(edges: ImportEdge[]): Promise<void>;
  addCall(edge: CallEdge): Promise<void>;
  addCallsBatch(edges: CallEdge[]): Promise<void>;
  addMention(codeId: string, entityId: string, confidence: number): Promise<void>;
  addSectionMention(sectionId: string, entityId: string, confidence: number): Promise<void>;
  addSectionDescribesRepo(sectionId: string, repoId: string): Promise<void>;
  addSectionDocumentsCode(sectionId: string, codeId: string, confidence: number): Promise<void>;
  addSectionReferencesFile(sectionId: string, fileId: string, raw: string): Promise<void>;
  clearRepoDependencies(repoIds?: string[]): Promise<void>;
  clearRepoIndexedArtifacts(repoId: string): Promise<void>;
  beginGraphWriteBatch(journal: Omit<GraphWriteBatchJournal, "status" | "updatedAt"> & { updatedAt?: string }): Promise<void>;
  commitGraphWriteBatch(input: { batchId: string; updatedAt: string; completedStage?: string }): Promise<void>;
  failGraphWriteBatch(input: { batchId: string; updatedAt: string; error: string; completedStage?: string; awaitingCleanup?: boolean }): Promise<void>;
  recoverIncompleteGraphWriteBatches(input: { repoIds?: string[]; updatedAt: string }): Promise<GraphWriteBatchJournal[]>;
  cleanupGraphWriteBatch(batchId: string): Promise<void>;
  markRepoArtifactsStale(input: { repoId: string; activeFileIds: string[]; batchId: string; indexedAt: string }): Promise<number>;
  upsertIndexState(state: { repoId: string; repoName: string; lastBatchId: string; lastIndexedAt: string; lastCommitSha: string; filesScanned: number; filesChanged: number; filesStale: number; status: string; error?: string; graphWriteAtomicity?: GraphWriteAtomicityMode; graphWriteStatus?: GraphWriteBatchStatus }): Promise<void>;
  /** Returns a map of known file IDs to their content hashes for a given repo. */
  knownFileHashes(repoId: string): Promise<Map<string, string>>;
  /** Returns the total number of Repo nodes in the graph. */
  repoCount(): Promise<number>;
  /** Returns all Repo nodes. */
  listRepos(): Promise<RepoNode[]>;
  /** Returns all active AliasOverride entries. */
  listActiveAliasOverrides(): Promise<ActiveAliasOverride[]>;
  /** Rejects an evidence node by creating feedback and deactivating the evidence and all its related edges. */
  rejectEvidence(input: { evidenceId: string; reason: string }): Promise<void>;
  /** Upserts an alias override entry pointing an alias to a target repository. */
  upsertAliasOverride(input: { alias: string; targetRepoId: string; reason: string }): Promise<void>;
  /** Returns contract summaries with producer/consumer/shared counts. */
  listContracts(options?: { limit?: number; kind?: ContractKind; repo?: string; direction?: "outgoing" | "incoming" }): Promise<ContractSummaryRow[]>;
  query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]>;
  stats(): Promise<Stats>;
  close(): Promise<void>;
}

export async function withTransaction<T>(db: GraphDB, fn: () => Promise<T>): Promise<T> {
  if (db.beginTransaction) {
    await db.beginTransaction();
  }
  try {
    const result = await fn();
    if (db.commitTransaction) {
      await db.commitTransaction();
    }
    return result;
  } catch (error) {
    if (db.rollbackTransaction) {
      try {
        await db.rollbackTransaction();
      } catch (rollbackError) {
        // Ignore rollback error to avoid masking original error
      }
    }
    throw error;
  }
}

export const ALL_EVIDENCE_REL_TYPES = [
  "OWNS_PACKAGE",
  "PRODUCES",
  "CONSUMES",
  "SHARES_CONTRACT",
  "CONTRACT_MENTIONS",
  "PARTICIPATES_IN",
  "WORKFLOW_STEP",
  "USES_PACKAGE",
  "DEPENDS_ON",
  "HAS_SPEC"
];

export const REJECT_EVIDENCE_REL_TYPES = [
  "OWNS_PACKAGE",
  "PRODUCES",
  "CONSUMES",
  "SHARES_CONTRACT",
  "CONTRACT_MENTIONS",
  "PARTICIPATES_IN",
  "WORKFLOW_STEP",
  "USES_PACKAGE",
  "DEPENDS_ON"
];

