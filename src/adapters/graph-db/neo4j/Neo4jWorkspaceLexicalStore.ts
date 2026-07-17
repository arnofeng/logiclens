import {
  WorkspaceLexicalStoreError,
  type CleanupBatchRequest,
  type LoadDocumentsRequest,
  type ReconcileRepoDocumentsRequest,
  type WorkspaceLexicalStore,
  type WorkspaceLexicalStoreErrorCode,
  type WorkspaceLexicalStoreErrorContext
} from "../../../core/retrieval/provider.js";
import type {
  LexicalDocument,
  LexicalHit,
  LexicalIndexHealth,
  LexicalQuery,
  LexicalSearchOptions
} from "../../../core/retrieval/types.js";
import { Neo4jGraphDB } from "./Neo4jGraphDB.js";

const PHASE_THREE_REQUIRED = new Error(
  "Neo4j workspace lexical lifecycle is not implemented until phase 3"
);

export const NEO4J_WORKSPACE_LEXICAL_REQUIREMENTS = Object.freeze({
  versionPolicy: "runtime-capability-check",
  requiredIndexType: "FULLTEXT",
  requiredQueryProcedure: "db.index.fulltext.queryNodes"
} as const);

export interface Neo4jWorkspaceLexicalCompatibility {
  indexTypes: readonly string[];
  procedures: readonly string[];
}

export function supportsNeo4jWorkspaceLexical(
  compatibility: Readonly<Neo4jWorkspaceLexicalCompatibility>
): boolean {
  return compatibility.indexTypes.includes(NEO4J_WORKSPACE_LEXICAL_REQUIREMENTS.requiredIndexType)
    && compatibility.procedures.includes(NEO4J_WORKSPACE_LEXICAL_REQUIREMENTS.requiredQueryProcedure);
}

export class Neo4jWorkspaceLexicalStore implements WorkspaceLexicalStore {
  constructor(readonly db: Neo4jGraphDB) {}

  async ensureSchema(): Promise<void> {
    throw unavailable("schema_failed", { operation: "ensureSchema" });
  }

  async commitVersions(): Promise<void> {
    throw unavailable("write_failed", { operation: "commitVersions" });
  }

  async upsertDocuments(documents: readonly LexicalDocument[]): Promise<void> {
    throw unavailable("write_failed", {
      operation: "upsertDocuments",
      workspaceId: documents[0]?.workspaceId,
      batchId: documents[0]?.batchId
    });
  }

  async reconcileRepoDocuments(request: Readonly<ReconcileRepoDocumentsRequest>): Promise<void> {
    throw unavailable("reconcile_failed", {
      operation: "reconcileRepoDocuments",
      workspaceId: request.workspaceId,
      repoId: request.repoId,
      batchId: request.batchId
    });
  }

  async cleanupBatch(request: Readonly<CleanupBatchRequest>): Promise<void> {
    throw unavailable("cleanup_failed", {
      operation: "cleanupBatch",
      workspaceId: request.workspaceId,
      batchId: request.batchId
    });
  }

  async search(
    query: Readonly<LexicalQuery>,
    _options: Readonly<LexicalSearchOptions>
  ): Promise<readonly LexicalHit[]> {
    throw unavailable("search_failed", {
      operation: "search",
      workspaceId: query.workspaceId
    });
  }

  async loadDocuments(request: Readonly<LoadDocumentsRequest>): Promise<readonly LexicalDocument[]> {
    throw unavailable("load_failed", {
      operation: "loadDocuments",
      workspaceId: request.workspaceId
    });
  }

  async health(workspaceId: string): Promise<LexicalIndexHealth> {
    throw unavailable("health_check_failed", { operation: "health", workspaceId });
  }
}

function unavailable(
  code: WorkspaceLexicalStoreErrorCode,
  context: WorkspaceLexicalStoreErrorContext
): WorkspaceLexicalStoreError {
  return new WorkspaceLexicalStoreError(code, context, { cause: PHASE_THREE_REQUIRED });
}
