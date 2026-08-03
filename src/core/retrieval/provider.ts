import type {
  LexicalDocument,
  LexicalHit,
  LexicalIndexHealth,
  LexicalQuery,
  LexicalSearchOptions
} from "./types.js";
import {
  LEXICAL_PROJECTION_SCHEMA_VERSION,
  TOKENIZER_VERSION
} from "./types.js";
import type { GraphDB } from "../graph-model/db.js";
import {
  getGraphProviderRegistration,
  GraphProviderNotRegisteredError,
  type GraphProviderId
} from "../graph-model/factory.js";

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
  generation: string;
  repoId: string;
  batchId: string;
  activeDocumentIds: readonly string[];
}

export interface CleanupBatchRequest {
  workspaceId: string;
  batchId: string;
}

export interface StageLexicalBatchRequest extends CleanupBatchRequest {
  generation: string;
  repoIds: readonly string[];
}

export interface LexicalGenerationRequest {
  workspaceId: string;
  generation: string;
  /**
   * Immutable publication revision whose statistics must be observed. Full
   * generations use their generation id; incremental publications keep the
   * physical generation and advance only this revision.
   */
  revision?: string;
}

export type InitializeLexicalGenerationRequest = LexicalGenerationRequest;

export interface UpsertDocumentsRequest extends LexicalGenerationRequest {
  documents: readonly LexicalDocument[];
}

export interface DeleteDocumentsRequest extends LexicalGenerationRequest {
  documentIds: readonly string[];
}

/**
 * The lexical component of one already-validated incremental index mutation.
 * Logical document ids remain stable; the provider derives physical ids from
 * the active data generation. Callers apply this inside the same GraphDB
 * transaction as graph, internal-fact, and active-revision mutations.
 */
export interface IncrementalLexicalMutationRequest extends LexicalGenerationRequest {
  expectedRevision: string;
  nextRevision: string;
  upsertDocuments: readonly LexicalDocument[];
  deleteDocumentIds: readonly string[];
}

export interface LoadDocumentsRequest {
  workspaceId: string;
  generation: string;
  documentIds: readonly string[];
}
export interface DocumentIdsForSourcesRequest extends LexicalGenerationRequest {
  repoId: string;
  fileIds: readonly string[];
}
export interface ReconcileRepoFileDocumentsRequest {
  workspaceId: string;
  generation: string;
  repoId: string;
  batchId: string;
  activeFileIds: readonly string[];
}

export interface ReplaceSourceDocumentsRequest {
  workspaceId: string;
  generation: string;
  repoId: string;
  batchId: string;
  touchedFileIds: readonly string[];
  activeDocumentIds: readonly string[];
}

export type WorkspaceLexicalStoreOperation =
  | "ensureSchema"
  | "commitVersions"
  | "initializeGeneration"
  | "deleteGeneration"
  | "stageBatch"
  | "commitBatch"
  | "upsertDocuments"
  | "deleteDocuments"
  | "applyIncrementalMutation"
  | "reconcileRepoDocuments"
  | "reconcileRepoFileDocuments"
  | "replaceSourceDocuments"
  | "cleanupBatch"
  | "search"
  | "loadDocuments"
  | "documentIdsForSources"
  | "pendingHealth"
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
  generation?: string;
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
  /** Initializes one empty physical generation without reading the active corpus. */
  initializeGeneration(request: Readonly<InitializeLexicalGenerationRequest>): Promise<void>;
  /** Deletes only the selected physical generation and its staging markers. */
  deleteGeneration(request: Readonly<LexicalGenerationRequest>): Promise<void>;
  stageBatch?(request: Readonly<StageLexicalBatchRequest>): Promise<void>;
  commitBatch?(request: Readonly<CleanupBatchRequest>): Promise<void>;
  upsertDocuments(request: Readonly<UpsertDocumentsRequest>): Promise<void>;
  /** Idempotently removes exact logical documents from only one pending generation. */
  deleteDocuments(request: Readonly<DeleteDocumentsRequest>): Promise<void>;
  /**
   * Applies only exact logical-document deltas. This method deliberately does
   * not open a generation, clone a corpus, stage a batch, run DDL/COPY, or
   * commit a transaction; the workspace mutation coordinator owns the outer
   * provider transaction.
   */
  applyIncrementalMutation(request: Readonly<IncrementalLexicalMutationRequest>): Promise<void>;
  reconcileRepoDocuments(request: Readonly<ReconcileRepoDocumentsRequest>): Promise<void>;
  /** Marks only file-backed projections stale; repo-level projections are retained. */
  reconcileRepoFileDocuments(request: Readonly<ReconcileRepoFileDocumentsRequest>): Promise<void>;
  replaceSourceDocuments?(request: Readonly<ReplaceSourceDocumentsRequest>): Promise<void>;
  cleanupBatch(request: Readonly<CleanupBatchRequest>): Promise<void>;
  /** Returns provider-neutral hits in global workspace order with ranks starting at one. */
  search(query: Readonly<LexicalQuery>, options: Readonly<LexicalSearchOptions>): Promise<readonly LexicalHit[]>;
  loadDocuments(request: Readonly<LoadDocumentsRequest>): Promise<readonly LexicalDocument[]>;
  /** Loads only stable logical ids owned by explicitly touched/deleted sources. */
  documentIdsForSources(request: Readonly<DocumentIdsForSourcesRequest>): Promise<readonly string[]>;
  pendingHealth(request: Readonly<LexicalGenerationRequest>): Promise<LexicalIndexHealth>;
  health(request: Readonly<LexicalGenerationRequest>): Promise<LexicalIndexHealth>;
}

export type LexicalProviderGateReasonCode =
  | "provider_not_registered"
  | "native_full_text_unsupported"
  | "lexical_binder_missing"
  | "configuration_scope_mismatch"
  | "capability_scope_mismatch"
  | "health_check_failed"
  | "provider_version_unknown"
  | "provider_version_incompatible"
  | "index_unavailable"
  | "projection_schema_version_mismatch"
  | "tokenizer_version_mismatch"
  | "index_unhealthy";

export type LexicalProviderGateStatus = "ready" | "unavailable";

type LexicalProviderGateBase = Readonly<{
  configuredProvider: GraphProviderId | "auto";
  effectiveProvider?: GraphProviderId;
  workspaceId: string;
  generation: string;
}>;

export type LexicalProviderReadyResult = LexicalProviderGateBase & Readonly<{
  status: "ready";
  effectiveProvider: GraphProviderId;
  reasonCodes: readonly [];
  capability: NativeLexicalCapabilities;
  store: WorkspaceLexicalStore;
  health: LexicalIndexHealth;
}>;

export type LexicalProviderUnavailableResult = LexicalProviderGateBase & Readonly<{
  status: "unavailable";
  reason: LexicalProviderGateReasonCode;
  reasonCodes: readonly LexicalProviderGateReasonCode[];
  capability?: NativeLexicalCapabilities;
  store?: WorkspaceLexicalStore;
  health?: LexicalIndexHealth;
}>;

export type LexicalProviderGateResult =
  | LexicalProviderReadyResult
  | LexicalProviderUnavailableResult;

export type LexicalProviderGateSummary = Readonly<{
  configuredProvider: GraphProviderId | "auto";
  effectiveProvider?: GraphProviderId;
  status: LexicalProviderGateStatus;
  reasonCodes: readonly LexicalProviderGateReasonCode[];
  providerVersion?: string;
  projectionSchemaVersion?: string;
  tokenizerVersion?: string;
  indexStatus?: LexicalIndexHealth["status"];
}>;

export type ResolveLexicalProviderInput = Readonly<{
  db: GraphDB | (() => Promise<GraphDB>);
  graphProvider: GraphProviderId;
  lexicalProvider: GraphProviderId | "auto";
  scope: string;
  workspaceId: string;
  generation: string;
}>;

export class LexicalProviderNotReadyError extends Error {
  readonly summary: LexicalProviderGateSummary;

  constructor(result: LexicalProviderUnavailableResult) {
    super(`Workspace lexical provider is not ready: ${result.reason}`);
    this.name = "LexicalProviderNotReadyError";
    this.summary = summarizeLexicalProviderGate(result);
  }
}

function unavailable(
  input: ResolveLexicalProviderInput,
  reason: LexicalProviderGateReasonCode,
  details: Omit<LexicalProviderUnavailableResult, keyof LexicalProviderGateBase | "status" | "reason" | "reasonCodes"> & {
    effectiveProvider?: GraphProviderId;
  } = {}
): LexicalProviderUnavailableResult {
  return Object.freeze({
    configuredProvider: input.lexicalProvider,
    workspaceId: input.workspaceId,
    generation: input.generation,
    status: "unavailable",
    reason,
    reasonCodes: Object.freeze([reason]),
    ...details
  });
}

function healthGateReason(health: LexicalIndexHealth): LexicalProviderGateReasonCode | undefined {
  if (health.status === "unavailable") return "index_unavailable";
  if (health.reasons.includes("provider_version_unknown") || health.providerVersion === "unknown") {
    return "provider_version_unknown";
  }
  if (health.reasons.includes("provider_version_incompatible")) return "provider_version_incompatible";
  if (health.projectionSchemaVersion !== LEXICAL_PROJECTION_SCHEMA_VERSION) {
    return "projection_schema_version_mismatch";
  }
  if (health.tokenizerVersion !== TOKENIZER_VERSION) return "tokenizer_version_mismatch";
  if (health.status !== "healthy") return "index_unhealthy";
  return undefined;
}

export async function resolveLexicalProvider(
  input: ResolveLexicalProviderInput
): Promise<LexicalProviderGateResult> {
  const effectiveProvider = input.lexicalProvider === "auto"
    ? input.graphProvider
    : input.lexicalProvider;
  let registration;
  try {
    registration = await getGraphProviderRegistration(effectiveProvider);
  } catch (error) {
    if (error instanceof GraphProviderNotRegisteredError) {
      return unavailable(input, "provider_not_registered", { effectiveProvider });
    }
    throw error;
  }

  const capability = registration.capabilities.nativeFullText;
  if (!capability) {
    return unavailable(input, "native_full_text_unsupported", { effectiveProvider });
  }
  if (!registration.bindLexical) {
    return unavailable(input, "lexical_binder_missing", { effectiveProvider, capability });
  }
  if (input.scope !== "workspace") {
    return unavailable(input, "configuration_scope_mismatch", { effectiveProvider, capability });
  }
  if (capability.scope !== "workspace" || capability.scope !== input.scope) {
    return unavailable(input, "capability_scope_mismatch", { effectiveProvider, capability });
  }

  const db = typeof input.db === "function" ? await input.db() : input.db;
  const store = registration.bindLexical(db);
  let health: LexicalIndexHealth;
  try {
    health = await store.health({ workspaceId: input.workspaceId, generation: input.generation });
  } catch (error) {
    if (error instanceof WorkspaceLexicalStoreError) {
      return unavailable(input, "health_check_failed", { effectiveProvider, capability, store });
    }
    throw error;
  }
  const reason = healthGateReason(health);
  if (reason) {
    return unavailable(input, reason, { effectiveProvider, capability, store, health });
  }
  return Object.freeze({
    configuredProvider: input.lexicalProvider,
    effectiveProvider,
    workspaceId: input.workspaceId,
    generation: input.generation,
    status: "ready",
    reasonCodes: Object.freeze([] as const),
    capability,
    store,
    health
  });
}

export function assertLexicalProviderReady(
  result: LexicalProviderGateResult
): asserts result is LexicalProviderReadyResult {
  if (result.status !== "ready") throw new LexicalProviderNotReadyError(result);
}

export function summarizeLexicalProviderGate(
  result: LexicalProviderGateResult
): LexicalProviderGateSummary {
  return Object.freeze({
    configuredProvider: result.configuredProvider,
    ...(result.effectiveProvider ? { effectiveProvider: result.effectiveProvider } : {}),
    status: result.status,
    reasonCodes: Object.freeze([...result.reasonCodes]),
    ...(result.health ? {
      providerVersion: result.health.providerVersion,
      projectionSchemaVersion: result.health.projectionSchemaVersion,
      tokenizerVersion: result.health.tokenizerVersion,
      indexStatus: result.health.status
    } : {})
  });
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
