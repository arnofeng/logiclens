import type {
  LexicalDocument,
  LexicalHit,
  LexicalIndexHealth,
  LexicalQuery,
  LexicalSearchOptions
} from "./types.js";
import type { GraphDB } from "../graph-model/db.js";
import { getGraphProviderRegistration, type GraphProviderId } from "../graph-model/factory.js";

export interface NativeLexicalCapabilities {
  scope: "workspace";
  updateConsistency: "transactional" | "synchronous";
  supportsFieldBoost: boolean;
  supportsPrefix: boolean;
}

export interface GraphProviderCapabilities {
  nativeFullText?: NativeLexicalCapabilities;
}

export interface ReconcileRepoDocumentsRequest {
  workspaceId: string;
  repoId: string;
  batchId: string;
  activeDocumentIds: readonly string[];
}

export interface CleanupBatchRequest {
  workspaceId: string;
  batchId: string;
}

export interface LoadDocumentsRequest {
  workspaceId: string;
  documentIds: readonly string[];
}
export interface ReconcileRepoFileDocumentsRequest {
  workspaceId: string;
  repoId: string;
  batchId: string;
  activeFileIds: readonly string[];
}

export type WorkspaceLexicalStoreOperation =
  | "ensureSchema"
  | "commitVersions"
  | "upsertDocuments"
  | "reconcileRepoDocuments"
  | "cleanupBatch"
  | "search"
  | "loadDocuments"
  | "health";

export type WorkspaceLexicalStoreErrorCode =
  | "schema_failed"
  | "write_failed"
  | "reconcile_failed"
  | "cleanup_failed"
  | "search_failed"
  | "load_failed"
  | "health_check_failed";

export interface WorkspaceLexicalStoreErrorContext {
  operation: WorkspaceLexicalStoreOperation;
  workspaceId?: string;
  repoId?: string;
  batchId?: string;
}

/** A provider-neutral failure boundary; adapter error text is retained only as a cause. */
export class WorkspaceLexicalStoreError extends Error {
  readonly code: WorkspaceLexicalStoreErrorCode;
  readonly context: Readonly<WorkspaceLexicalStoreErrorContext>;

  constructor(
    code: WorkspaceLexicalStoreErrorCode,
    context: WorkspaceLexicalStoreErrorContext,
    options?: ErrorOptions
  ) {
    super(`Workspace lexical store operation failed: ${code}`, options);
    this.name = "WorkspaceLexicalStoreError";
    this.code = code;
    this.context = context;
  }
}

export interface WorkspaceLexicalStore {
  ensureSchema(): Promise<void>;
  /** Advances projection/tokenizer metadata only after a complete rebuild commits. */
  commitVersions(): Promise<void>;
  upsertDocuments(documents: readonly LexicalDocument[]): Promise<void>;
  reconcileRepoDocuments(request: Readonly<ReconcileRepoDocumentsRequest>): Promise<void>;
  /** Marks only file-backed projections stale; repo-level projections are retained. */
  reconcileRepoFileDocuments(request: Readonly<ReconcileRepoFileDocumentsRequest>): Promise<void>;
  cleanupBatch(request: Readonly<CleanupBatchRequest>): Promise<void>;
  /** Returns provider-neutral hits in global workspace order with ranks starting at one. */
  search(query: Readonly<LexicalQuery>, options: Readonly<LexicalSearchOptions>): Promise<readonly LexicalHit[]>;
  loadDocuments(request: Readonly<LoadDocumentsRequest>): Promise<readonly LexicalDocument[]>;
  health(workspaceId: string): Promise<LexicalIndexHealth>;
}

export async function resolveWorkspaceLexicalStore(input: {
  db: GraphDB | (() => Promise<GraphDB>);
  graphProvider: GraphProviderId;
  lexicalProvider: GraphProviderId | "auto";
  scope: NativeLexicalCapabilities["scope"];
}): Promise<WorkspaceLexicalStore> {
  const providerId = input.lexicalProvider === "auto"
    ? input.graphProvider
    : input.lexicalProvider;
  const registration = await getGraphProviderRegistration(providerId);
  const capability = registration.capabilities.nativeFullText;
  if (!capability) {
    throw new Error(`Lexical provider "${providerId}" does not declare nativeFullText capability`);
  }
  if (!registration.bindLexical) {
    throw new Error(`Lexical provider "${providerId}" does not provide bindLexical`);
  }
  if (capability.scope !== input.scope) {
    throw new Error(
      `Lexical provider "${providerId}" does not support configured scope ` +
      `"${input.scope}" (supports "${capability.scope}")`
    );
  }
  const db = typeof input.db === "function" ? await input.db() : input.db;
  return registration.bindLexical(db);
}
