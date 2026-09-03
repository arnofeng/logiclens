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
import type { PublicGraphGenerationScope } from "./publicGraphGeneration.js";

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

export type StatsDelta = {
  [K in keyof Stats]: number;
};

export type PublicGraphStatsUpdate = {
  expectedRevision: string;
  nextRevision: string;
  delta: StatsDelta;
};

export type PublicGraphStatsSnapshot = Stats & {
  revision: string;
};

export type GraphWriteAtomicityMode = "transactional" | "journaled-recoverable" | "best-effort";
export type GraphWriteBatchStatus = "started" | "committed" | "failed" | "recovered" | "awaiting-cleanup";

/**
 * Provider-agnostic value type for graph query parameters and results.
 * Replaces the Kuzu-specific `KuzuValue` in the public `GraphDB` interface.
 */
export type GraphValue = string | number | boolean | null | bigint | GraphValue[] | { [key: string]: GraphValue };

export type GraphDatabaseOperationalFailureKind =
  | "connection"
  | "timeout"
  | "service-unavailable"
  | "transient";

/**
 * Provider contract for classifying only recoverable database failures.
 * Query syntax, schema, arguments, result conversion, and adapter bugs must
 * return undefined so that the original error propagates.
 */
export type GraphDatabaseErrorClassifier = (
  error: unknown
) => GraphDatabaseOperationalFailureKind | undefined;

/** A provider/database execution failure with a stable classification. */
export class GraphDatabaseOperationalError extends Error {
  readonly operation = "query";
  readonly kind: GraphDatabaseOperationalFailureKind;

  constructor(options?: ErrorOptions & { kind?: GraphDatabaseOperationalFailureKind }) {
    super("Graph database query failed", options);
    this.name = "GraphDatabaseOperationalError";
    this.kind = options?.kind ?? "service-unavailable";
  }
}

export class GraphDatabaseClosedError extends Error {
  constructor() {
    super("Graph database is closed");
    this.name = "GraphDatabaseClosedError";
  }
}

export type GraphWriteBatchJournal = {
  batchId: string;
  generation: string;
  parentGeneration?: string;
  repoIds: string[];
  repoNames: string[];
  writerMode: string;
  atomicityMode: GraphWriteAtomicityMode;
  workspaceId: string;
  status: GraphWriteBatchStatus;
  startedAt: string;
  updatedAt: string;
  completedStage?: string;
  error?: string;
};

/**
 * Publication guard for an incremental index mutation. The physical graph
 * generation remains stable while `activeRevision` advances. A caller must
 * reserve `nextRevision` before invoking the provider commit.
 */
export type IncrementalIndexCommitRequest = {
  workspaceId: string;
  expectedActiveGeneration: string;
  expectedActiveRevision: string;
  nextRevision: string;
  schemaIndexVersion: string;
};

export function validateIncrementalIndexCommitRequest(
  request: Readonly<IncrementalIndexCommitRequest>
): void {
  for (const [field, value] of Object.entries(request)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`Incremental index commit ${field} must be a non-empty string.`);
    }
  }
  if (request.nextRevision === request.expectedActiveRevision) {
    throw new TypeError("Incremental index commit nextRevision must differ from expectedActiveRevision.");
  }
}

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
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
  /** Executes all callback queries against one provider read snapshot. */
  readTransaction?<T>(fn: () => Promise<T>): Promise<T>;
  beginTransaction?(): Promise<void>;
  commitTransaction?(): Promise<void>;
  rollbackTransaction?(): Promise<void>;
  /**
   * Atomically applies an already prepared incremental mutation and advances
   * its revision. The callback may only perform provider-bound writes; scan,
   * parse, and mutation preparation must finish before this method is called.
   */
  applyIncrementalIndexMutation<T>(
    request: Readonly<IncrementalIndexCommitRequest>,
    apply: () => Promise<T>
  ): Promise<T>;
  initSchema(systemName?: string): Promise<void>;
  upsertSystem(systemName: string, scope: PublicGraphGenerationScope): Promise<void>;
  upsertRepo(repo: RepoNode, scope: PublicGraphGenerationScope): Promise<void>;
  updateRepoSummary(repoId: string, summary: string, scope: PublicGraphGenerationScope): Promise<void>;
  updateSystemSummary(summary: string, scope: PublicGraphGenerationScope): Promise<void>;
  upsertFile(file: FileNode, scope: PublicGraphGenerationScope): Promise<void>;
  upsertFilesBatch(files: FileNode[], scope: PublicGraphGenerationScope): Promise<void>;
  upsertCode(code: CodeSymbol, scope: PublicGraphGenerationScope): Promise<void>;
  upsertCodeBatch(code: CodeSymbol[], scope: PublicGraphGenerationScope): Promise<void>;
  upsertSection(section: DocSection, scope: PublicGraphGenerationScope): Promise<void>;
  upsertEntity(entity: EntityNode, scope: PublicGraphGenerationScope): Promise<void>;
  upsertOperation(operation: OperationNode, scope: PublicGraphGenerationScope): Promise<void>;
  upsertWorkflow(workflow: WorkflowNode, scope: PublicGraphGenerationScope): Promise<void>;
  upsertContract(contract: ContractNode, scope: PublicGraphGenerationScope): Promise<void>;
  upsertEvidence(evidence: EvidenceNode, scope: PublicGraphGenerationScope): Promise<void>;
  addRepoContract(edge: RepoContractEdge, scope: PublicGraphGenerationScope): Promise<void>;
  addRepoDependency(edge: RepoDependencyEdge, scope: PublicGraphGenerationScope): Promise<void>;
  addRepoDependenciesBatch(edges: RepoDependencyEdge[], scope: PublicGraphGenerationScope): Promise<void>;
  addPackageUsage(edge: PackageUsageEdge, scope: PublicGraphGenerationScope): Promise<void>;
  addContractEntity(edge: ContractEntityEdge, scope: PublicGraphGenerationScope): Promise<void>;
  addOperationRepo(edge: OperationRepoEdge, scope: PublicGraphGenerationScope): Promise<void>;
  addWorkflowOperation(edge: WorkflowOperationEdge, scope: PublicGraphGenerationScope): Promise<void>;
  upsertContractSpec(spec: ContractSpecNode, scope: PublicGraphGenerationScope): Promise<void>;
  addHasSpec(edge: ContractSpecEdge, scope: PublicGraphGenerationScope): Promise<void>;
  addSemanticRelation(edge: SemanticRelationEdge, scope: PublicGraphGenerationScope): Promise<void>;
  addSemanticRelationsBatch(edges: SemanticRelationEdge[], scope: PublicGraphGenerationScope): Promise<void>;
  /** Deletes only logical semantic relations incident to the supplied stable spec IDs. */
  clearSemanticRelationsForSpecs(specIds: string[], scope: PublicGraphGenerationScope): Promise<void>;
  addContractEvidence(contractId: string, evidenceId: string, scope: PublicGraphGenerationScope): Promise<void>;
  addRepoEvidence(repoId: string, evidenceId: string, scope: PublicGraphGenerationScope): Promise<void>;
  addContains(fromId: string, toId: string, scope: PublicGraphGenerationScope): Promise<void>;
  addImport(edge: ImportEdge, scope: PublicGraphGenerationScope): Promise<void>;
  addImportsBatch(edges: ImportEdge[], scope: PublicGraphGenerationScope): Promise<void>;
  addCall(edge: CallEdge, scope: PublicGraphGenerationScope): Promise<void>;
  addCallsBatch(edges: CallEdge[], scope: PublicGraphGenerationScope): Promise<void>;
  addMention(codeId: string, entityId: string, confidence: number, scope: PublicGraphGenerationScope): Promise<void>;
  addSectionMention(sectionId: string, entityId: string, confidence: number, scope: PublicGraphGenerationScope): Promise<void>;
  addSectionDescribesRepo(sectionId: string, repoId: string, scope: PublicGraphGenerationScope): Promise<void>;
  addSectionDocumentsCode(sectionId: string, codeId: string, confidence: number, scope: PublicGraphGenerationScope): Promise<void>;
  addSectionReferencesFile(sectionId: string, fileId: string, raw: string, scope: PublicGraphGenerationScope): Promise<void>;
  clearRepoDependencies(repoIds: string[] | undefined, scope: PublicGraphGenerationScope): Promise<void>;
  /** Deletes only materialized dependencies derived from the supplied stable contract IDs. */
  clearRepoDependenciesForContracts(contractIds: string[], scope: PublicGraphGenerationScope): Promise<void>;
  clearRepoIndexedArtifacts(repoId: string, scope: PublicGraphGenerationScope): Promise<void>;
  deletePublicGraphGeneration(scope: PublicGraphGenerationScope): Promise<void>;
  beginGraphWriteBatch(journal: Omit<GraphWriteBatchJournal, "status" | "updatedAt"> & { updatedAt?: string }): Promise<void>;
  updateGraphWriteBatch(input: { batchId: string; updatedAt: string; completedStage: string }): Promise<void>;
  commitGraphWriteBatch(input: { batchId: string; updatedAt: string; completedStage?: string }): Promise<void>;
  failGraphWriteBatch(input: { batchId: string; updatedAt: string; error: string; completedStage?: string; awaitingCleanup?: boolean }): Promise<void>;
  recoverIncompleteGraphWriteBatches(input: {
    repoIds?: string[];
    workspaceId?: string;
    generation?: string;
    updatedAt: string;
  }): Promise<GraphWriteBatchJournal[]>;
  cleanupGraphWriteBatch(batchId: string): Promise<void>;
  markRepoArtifactsStale(input: { repoId: string; activeFileIds: string[]; batchId: string; indexedAt: string }, scope: PublicGraphGenerationScope): Promise<number>;
  upsertIndexState(state: { repoId: string; repoName: string; lastBatchId: string; lastIndexedAt: string; lastCommitSha: string; filesScanned: number; filesChanged: number; filesStale: number; status: string; error?: string; graphWriteAtomicity?: GraphWriteAtomicityMode; graphWriteStatus?: GraphWriteBatchStatus }): Promise<void>;
  /** Returns a map of known file IDs to their content hashes for a given repo. */
  knownFileHashes(repoId: string, scope: PublicGraphGenerationScope): Promise<Map<string, string>>;
  /** Returns the total number of Repo nodes in the graph. */
  repoCount(scope: PublicGraphGenerationScope): Promise<number>;
  /** Returns all Repo nodes. */
  listRepos(scope: PublicGraphGenerationScope): Promise<RepoNode[]>;
  /** Returns all active AliasOverride entries. */
  listActiveAliasOverrides(): Promise<ActiveAliasOverride[]>;
  /** Rejects an evidence node by creating feedback and deactivating the evidence and all its related edges. */
  rejectEvidence(input: { evidenceId: string; reason: string }, scope: PublicGraphGenerationScope): Promise<void>;
  /** Upserts an alias override entry pointing an alias to a target repository. */
  upsertAliasOverride(input: { alias: string; targetRepoId: string; reason: string }): Promise<void>;
  /** Returns contract summaries with producer/consumer/shared counts. */
  listContracts(scope: PublicGraphGenerationScope, options?: { limit?: number; kind?: ContractKind; repo?: string; direction?: "outgoing" | "incoming" }): Promise<ContractSummaryRow[]>;
  query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]>;
  /** Reads generation stats metadata without falling back to graph-wide counts. */
  readPublicGraphStats(scope: PublicGraphGenerationScope): Promise<PublicGraphStatsSnapshot | undefined>;
  /** Computes counts for a complete pending full snapshot before its short commit transaction. */
  computePublicGraphStats(scope: PublicGraphGenerationScope): Promise<Stats>;
  /** Writes precomputed full-snapshot metadata inside the publication transaction. */
  initializePublicGraphStats(scope: PublicGraphGenerationScope, revision: string, stats: Readonly<Stats>): Promise<void>;
  /** Applies an already prepared stats delta in the provider publication transaction. */
  applyPublicGraphStatsDelta(scope: PublicGraphGenerationScope, update: PublicGraphStatsUpdate): Promise<Stats>;
  stats(scope: PublicGraphGenerationScope): Promise<Stats>;
  close(): Promise<void>;
}

export async function withTransaction<T>(db: GraphDB, fn: () => Promise<T>): Promise<T> {
  if (db.transaction) {
    return db.transaction(fn);
  }
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

