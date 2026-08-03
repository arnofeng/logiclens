import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WorkspaceLexicalStoreError,
  type InitializeLexicalGenerationRequest,
  type CleanupBatchRequest,
  type DeleteDocumentsRequest,
  type DocumentIdsForSourcesRequest,
  type IncrementalLexicalMutationRequest,
  type LexicalGenerationRequest,
  type LoadDocumentsRequest,
  type ReconcileRepoDocumentsRequest,
  type ReconcileRepoFileDocumentsRequest,
  type ReplaceSourceDocumentsRequest,
  type StageLexicalBatchRequest,
  type UpsertDocumentsRequest,
  type WorkspaceLexicalStore,
  type WorkspaceLexicalStoreErrorCode,
  type WorkspaceLexicalStoreErrorContext
} from "../../../core/retrieval/provider.js";
import { tokenizeLexicalText } from "../../../core/retrieval/tokenizer.js";
import { parseRenderRef } from "../../../core/retrieval/renderRef.js";
import {
  LEXICAL_DOCUMENT_KINDS,
  LEXICAL_PROJECTION_SCHEMA_VERSION,
  TOKENIZER_VERSION,
  type LexicalDocument,
  type LexicalDocumentKind,
  type LexicalHit,
  type LexicalIndexHealth,
  type LexicalQuery,
  type LexicalSearchOptions
} from "../../../core/retrieval/types.js";
import type { GraphValue } from "../../../core/graph-model/db.js";
import { assertNoLivePublicGraphReadLeases } from "../../../core/graph-model/readSnapshot.js";
import { encodeCsvValue, type CsvScalar } from "../../../core/graph-model/csvStaging.js";
import { brandedTempDirPrefix, getBrandedEnv } from "../../../shared/branding.js";
import { KuzuGraphDB } from "./KuzuGraphDB.js";

export const KUZU_LEXICAL_DOCUMENT_TABLE = "LexicalDocument";
export const KUZU_LEXICAL_METADATA_TABLE = "LexicalMetadata";
export const KUZU_LEXICAL_STATS_TABLE = "LexicalWorkspaceStats";
export const KUZU_WORKSPACE_FTS_INDEX = "workspace_lexical";
export const KUZU_MINIMUM_FTS_VERSION = "0.11.3";
export const KUZU_MAXIMUM_FTS_VERSION_EXCLUSIVE = "0.12.0";
export const KUZU_LEXICAL_STATS_SCHEMA_VERSION = "3";

const PROJECTION_METADATA_KEY = "projectionSchemaVersion";
const TOKENIZER_METADATA_KEY = "tokenizerVersion";
const STATS_METADATA_KEY = "lexicalStatsSchemaVersion";
const EXPECTED_FTS_PROPERTIES = ["ftsText"] as const;
const KUZU_LEXICAL_WRITE_CHUNK_SIZE = 500;
const COPY_SAFE_TOKEN = /^[\p{L}\p{M}\p{N}._/-]+$/u;
const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "declared", "defined", "does", "find", "for", "http", "is", "of",
  "on", "or", "owns", "service", "serves", "the", "to", "what", "where", "which", "who", "with"
]);

const DOCUMENT_COLUMNS = [
  ["documentId", "STRING"],
  ["generation", "STRING"],
  ["canonicalId", "STRING"],
  ["workspaceId", "STRING"],
  ["repoId", "STRING"],
  ["kind", "STRING"],
  ["title", "STRING"],
  ["qualifiedName", "STRING"],
  ["path", "STRING"],
  ["searchableText", "STRING"],
  ["tokens", "STRING[]"],
  ["active", "BOOL"],
  ["sourceHash", "STRING"],
  ["batchId", "STRING"],
  ["renderRef", "STRING"],
  ["fileId", "STRING"],
  ["ftsText", "STRING"],
  ["ftsSizeBytes", "INT64"]
] as const;
const DOCUMENT_LOAD_COLUMNS = [["storageId", "STRING"], ...DOCUMENT_COLUMNS] as const;
const DOCUMENT_COLUMN_NAMES = ["storageId", ...DOCUMENT_COLUMNS.map(([name]) => name)].join(", ");
const DOCUMENT_LOAD_BINDINGS = DOCUMENT_LOAD_COLUMNS
  .map(([name, type], index) => `CAST(COLUMN${index} AS ${type}) AS ${name}`)
  .join(", ");
const DOCUMENT_LOAD_SET = DOCUMENT_COLUMNS
  .map(([name]) => `n.${name} = ${name}`)
  .join(", ");

type TableRow = { name: string };
type ColumnRow = { name: string };
type IndexRow = {
  table_name: string;
  index_name: string;
  index_type: string;
  property_names: string[];
  extension_loaded: boolean;
};
type MetadataRow = { key: string; value: string };
type VersionRow = { version: string };
type WorkspaceStatsRow = {
  id?: string;
  workspaceId: string;
  generation: string;
  revision: string;
  documentCount: number | bigint;
  indexSizeBytes: number | bigint;
};
type ExistingDocumentStateRow = {
  storageId: string;
  workspaceId: string;
  active: boolean;
  ftsSizeBytes: number | bigint | null;
};
type DeactivationStatsRow = {
  documentCount: number | bigint;
  indexSizeBytes: number | bigint | null;
};
type DocumentRow = {
  storageId: string;
  documentId: string;
  generation: string;
  canonicalId: string;
  workspaceId: string;
  repoId: string;
  kind: string;
  title: string;
  qualifiedName: string | null;
  path: string | null;
  searchableText: string;
  tokens: string[];
  active: boolean;
  sourceHash: string;
  batchId: string;
  renderRef: string;
  fileId?: string | null;
  ftsText?: string | null;
  ftsSizeBytes?: number | bigint | null;
};
type SearchRow = {
  canonicalId: string;
  documentId: string;
  repoId: string;
  kind: string;
  renderRef: string;
  score: number;
};

type StoredDocument = {
  storageId: string;
  generation: string;
  document: LexicalDocument;
};

export class KuzuWorkspaceLexicalStore implements WorkspaceLexicalStore {
  constructor(readonly db: KuzuGraphDB) {
    db.retainNativeHandleOnClose();
  }

  async ensureSchema(): Promise<void> {
    const context = { operation: "ensureSchema" } as const;
    try {
      await this.db.query("LOAD EXTENSION FTS;");
      if (await this.hasCurrentSchema()) return;
      const tables = await this.tableNames();
      if ([KUZU_LEXICAL_DOCUMENT_TABLE, KUZU_LEXICAL_METADATA_TABLE, KUZU_LEXICAL_STATS_TABLE, "LexicalGenerationBatch"]
        .some((table) => tables.has(table))) {
        throw new Error("Lexical projection schema is incompatible; remove generated graph/internal/lexical artifacts and run a clean full reindex.");
      }
      await this.db.query(
        "CREATE NODE TABLE LexicalDocument(" +
        "storageId STRING, documentId STRING, generation STRING, canonicalId STRING, workspaceId STRING, repoId STRING, kind STRING, " +
        "title STRING, qualifiedName STRING, path STRING, searchableText STRING, tokens STRING[], " +
        "active BOOL, sourceHash STRING, batchId STRING, renderRef STRING, fileId STRING, ftsText STRING, " +
        "ftsSizeBytes INT64, PRIMARY KEY(storageId));"
      );
      await this.db.query("CREATE NODE TABLE LexicalMetadata(key STRING, value STRING, PRIMARY KEY(key));");
      await this.db.query(
        "CREATE NODE TABLE LexicalWorkspaceStats(" +
        "id STRING, workspaceId STRING, generation STRING, revision STRING, " +
        "documentCount INT64, indexSizeBytes INT64, PRIMARY KEY(id));"
      );
      await this.db.query("CREATE NODE TABLE LexicalGenerationBatch(id STRING, workspaceId STRING, generation STRING, batchId STRING, PRIMARY KEY(id));");
      await this.ensureSingleWorkspaceIndex();
      await this.db.transaction(async () => {
        await this.db.query(
          "MERGE (m:LexicalMetadata {key: $key}) ON CREATE SET m.value = $value;",
          { key: PROJECTION_METADATA_KEY, value: LEXICAL_PROJECTION_SCHEMA_VERSION }
        );
        await this.db.query(
          "MERGE (m:LexicalMetadata {key: $key}) ON CREATE SET m.value = $value;",
          { key: TOKENIZER_METADATA_KEY, value: TOKENIZER_VERSION }
        );
        await this.db.query(
          "MERGE (m:LexicalMetadata {key: $key}) ON CREATE SET m.value = $value;",
          { key: STATS_METADATA_KEY, value: KUZU_LEXICAL_STATS_SCHEMA_VERSION }
        );
      });
    } catch (error) {
      throw wrap("schema_failed", context, error);
    }
  }

  /**
   * Advances compatibility metadata only after the caller has completed and
   * committed a full workspace rebuild. ensureSchema intentionally never
   * calls this method because schema readiness does not imply corpus readiness.
   */
  async commitVersions(): Promise<void> {
    const context = { operation: "commitVersions" } as const;
    try {
      await this.db.transaction(async () => {
        await this.db.query(
          "MERGE (m:LexicalMetadata {key: $key}) SET m.value = $value;",
          { key: PROJECTION_METADATA_KEY, value: LEXICAL_PROJECTION_SCHEMA_VERSION }
        );
        await this.db.query(
          "MERGE (m:LexicalMetadata {key: $key}) SET m.value = $value;",
          { key: TOKENIZER_METADATA_KEY, value: TOKENIZER_VERSION }
        );
      });
    } catch (error) {
      throw wrap("write_failed", context, error);
    }
  }

  async initializeGeneration(request: Readonly<InitializeLexicalGenerationRequest>): Promise<void> {
    const context = { operation: "initializeGeneration", workspaceId: request.workspaceId, generation: request.generation } as const;
    try {
      validateGenerationRequest(request);
      await this.db.transaction(async () => {
        await this.assertGenerationNotActive(request, { allowReservedPending: true });
        await this.deleteGenerationRows(request);
      });
      await this.replaceGenerationStats(request.workspaceId, request.generation, request.generation, 0, 0);
    } catch (error) {
      throw wrap("write_failed", context, error);
    }
  }

  async deleteGeneration(request: Readonly<LexicalGenerationRequest>): Promise<void> {
    const context = { operation: "deleteGeneration", workspaceId: request.workspaceId, generation: request.generation } as const;
    try {
      validateGenerationRequest(request);
      await this.db.transaction(async () => {
        await this.assertGenerationNotActive(request);
        await this.deleteGenerationRows(request);
      });
    } catch (error) {
      throw wrap("cleanup_failed", context, error);
    }
  }

  async deleteDocuments(request: Readonly<DeleteDocumentsRequest>): Promise<void> {
    const context = {
      operation: "deleteDocuments",
      workspaceId: request.workspaceId,
      generation: request.generation
    } as const;
    try {
      validateGenerationRequest(request);
      const documentIds = uniqueStrings(request.documentIds, "documentIds");
      if (documentIds.length === 0) return;
      await this.db.transaction(async () => {
        const rows = await this.db.query<DeactivationStatsRow>(
          "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation " +
          "AND n.documentId IN $documentIds AND n.active = true " +
          "RETURN count(*) AS documentCount, sum(n.ftsSizeBytes) AS indexSizeBytes;",
          { workspaceId: request.workspaceId, generation: request.generation, documentIds }
        );
        await this.db.query(
          "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation " +
          "AND n.documentId IN $documentIds DELETE n;",
          { workspaceId: request.workspaceId, generation: request.generation, documentIds }
        );
        await this.adjustGenerationStats(
          request.workspaceId,
          request.generation,
          -numeric(rows[0]?.documentCount),
          -numeric(rows[0]?.indexSizeBytes)
        );
      });
    } catch (error) {
      throw wrap("write_failed", context, error);
    }
  }

  async applyIncrementalMutation(request: Readonly<IncrementalLexicalMutationRequest>): Promise<void> {
    const context: WorkspaceLexicalStoreErrorContext = {
      operation: "applyIncrementalMutation",
      workspaceId: request.workspaceId,
      generation: request.generation,
      batchId: request.upsertDocuments[0]?.batchId
    };
    try {
      validateGenerationRequest(request);
      validateBoundary(request.expectedRevision, "expectedRevision");
      validateBoundary(request.nextRevision, "nextRevision");
      if (request.expectedRevision === request.nextRevision) {
        throw new TypeError("Incremental lexical mutation must advance its revision.");
      }
      const validated = request.upsertDocuments.length > 0
        ? validateDocuments(request.upsertDocuments)
        : [];
      if (validated[0] && validated[0].workspaceId !== request.workspaceId) {
        throw new TypeError("Incremental lexical upsert workspace does not match its generation request.");
      }
      const activeUpserts = validated.filter((document) => document.active);
      const upsertIds = new Set(activeUpserts.map((document) => document.id));
      const deleteDocumentIds = uniqueStrings([
        ...request.deleteDocumentIds,
        ...validated.filter((document) => !document.active).map((document) => document.id)
      ], "deleteDocumentIds").filter((documentId) => !upsertIds.has(documentId));
      const stored = activeUpserts.map((document) => storedDocument(document, request.generation));
      const deleteStorageIds = deleteDocumentIds.map((documentId) =>
        storageId(request.workspaceId, request.generation, documentId));
      const affectedStorageIds = [...new Set([
        ...deleteStorageIds,
        ...stored.map((document) => document.storageId)
      ])].sort(compareText);
      const existingRows = affectedStorageIds.length > 0
        ? await this.db.query<ExistingDocumentStateRow>(
          "MATCH (n:LexicalDocument) WHERE n.storageId IN $storageIds " +
          "RETURN n.storageId AS storageId, n.workspaceId AS workspaceId, n.active AS active, n.ftsSizeBytes AS ftsSizeBytes;",
          { storageIds: affectedStorageIds }
        )
        : [];
      const existing = new Map(existingRows.map((row) => [row.storageId, row]));
      for (const row of existingRows) {
        if (row.workspaceId !== request.workspaceId) {
          throw new TypeError(`Lexical physical document belongs to a different workspace: ${row.storageId}.`);
        }
      }

      let documentCountDelta = 0;
      let indexSizeBytesDelta = 0;
      for (const physicalId of deleteStorageIds) {
        const previous = existing.get(physicalId);
        if (!previous?.active) continue;
        documentCountDelta -= 1;
        indexSizeBytesDelta -= numeric(previous.ftsSizeBytes);
      }
      for (const item of stored) {
        const previous = existing.get(item.storageId);
        documentCountDelta += 1 - Number(previous?.active ?? false);
        indexSizeBytesDelta += ftsSizeBytes(item.document)
          - (previous?.active ? numeric(previous.ftsSizeBytes) : 0);
      }

      if (deleteStorageIds.length > 0) {
        writeLexicalTrace(`incremental delete documents=${deleteStorageIds.length}`);
        await this.db.query(
          "MATCH (n:LexicalDocument) WHERE n.storageId IN $storageIds DELETE n;",
          { storageIds: deleteStorageIds }
        );
      }
      writeLexicalTrace(`incremental upsert documents=${stored.length}`);
      for (const item of stored) await this.mergeStoredDocument(item);
      writeLexicalTrace(`incremental stats documentDelta=${documentCountDelta} byteDelta=${indexSizeBytesDelta}`);
      await this.applyExactStatsDelta(
        request.workspaceId,
        request.generation,
        request.expectedRevision,
        request.nextRevision,
        documentCountDelta,
        indexSizeBytesDelta
      );
      writeLexicalTrace("incremental complete");
    } catch (error) {
      throw wrap("write_failed", context, error);
    }
  }

  async upsertDocuments(request: Readonly<UpsertDocumentsRequest>): Promise<void> {
    const { documents } = request;
    const context: WorkspaceLexicalStoreErrorContext = {
      operation: "upsertDocuments",
      workspaceId: request.workspaceId,
      generation: request.generation,
      batchId: documents[0]?.batchId
    };
    try {
      validateGenerationRequest(request);
      if (documents.length === 0) return;
      const validationStarted = Date.now();
      const unique = validateDocuments(documents);
      if (unique[0]?.workspaceId !== request.workspaceId) {
        throw new TypeError("Lexical upsert workspace does not match its generation request.");
      }
      const stored = unique.map((document) => storedDocument(document, request.generation));
      writeLexicalTrace(`validate documents=${unique.length} duration=${Date.now() - validationStarted}ms`);
      const lookupStarted = Date.now();
      const existingRows = await this.db.query<ExistingDocumentStateRow>(
        "MATCH (n:LexicalDocument) WHERE n.storageId IN $storageIds " +
        "RETURN n.storageId AS storageId, n.workspaceId AS workspaceId, n.active AS active, n.ftsSizeBytes AS ftsSizeBytes;",
        { storageIds: stored.map((item) => item.storageId) }
      );
      const countRows = await this.db.query<{ count: number | bigint }>(
        "MATCH (n:LexicalDocument) RETURN count(*) AS count;"
      );
      const storedDocumentCount = numeric(countRows[0]?.count);
      writeLexicalTrace(`existing lookup documents=${unique.length} existing=${existingRows.length} stored=${storedDocumentCount} duration=${Date.now() - lookupStarted}ms`);
      const existing = new Map(existingRows.map((row) => [row.storageId, row]));
      let documentCountDelta = 0;
      let indexSizeBytesDelta = 0;
      // Kuzu 0.11.3 COPY is dramatically faster for an empty lexical table,
      // but repeated COPY appends can collide in the FTS extension's
      // auxiliary serial keys. Keep the fast path intentionally scoped to
      // the initial workspace import.
      const csvEligible = unique.every(hasCopySafeTokens);
      const copyEligible = storedDocumentCount === 0 && existingRows.length === 0 && csvEligible;
      const appendLoadEligible = storedDocumentCount > 0 && existingRows.length === 0 && csvEligible;
      if (copyEligible) {
        for (const document of unique) {
          if (!document.active) continue;
          documentCountDelta += 1;
          indexSizeBytesDelta += ftsSizeBytes(document);
        }
        await copyNewDocuments(this.db, stored);
      } else if (appendLoadEligible) {
        for (const document of unique) {
          if (!document.active) continue;
          documentCountDelta += 1;
          indexSizeBytesDelta += ftsSizeBytes(document);
        }
        await appendLoadNewDocuments(this.db, stored);
      } else {
        const mergeStarted = Date.now();
        for (const item of stored) {
          const { document } = item;
          const previous = existing.get(item.storageId);
          if (previous && previous.workspaceId !== document.workspaceId) {
            throw new TypeError(`Document id cannot move between workspaces: ${document.id}.`);
          }
          const previousCount = previous?.active ? 1 : 0;
          const previousBytes = previous?.active ? numeric(previous.ftsSizeBytes) : 0;
          const nextBytes = document.active ? ftsSizeBytes(document) : 0;
          documentCountDelta += (document.active ? 1 : 0) - previousCount;
          indexSizeBytesDelta += nextBytes - previousBytes;
        }
        await this.mergeStoredDocuments(stored);
        const reason = existingRows.length > 0
          ? "existing-documents"
          : !csvEligible
            ? "unsafe-token"
            : "nonempty-store";
        writeLexicalTrace(`writer=merge documents=${unique.length} duration=${Date.now() - mergeStarted}ms reason=${reason}`);
      }
      const statsStarted = Date.now();
      await this.adjustGenerationStats(request.workspaceId, request.generation, documentCountDelta, indexSizeBytesDelta);
      writeLexicalTrace(`stats documentDelta=${documentCountDelta} byteDelta=${indexSizeBytesDelta} duration=${Date.now() - statsStarted}ms`);
    } catch (error) {
      throw wrap("write_failed", context, error);
    }
  }

  async reconcileRepoDocuments(request: Readonly<ReconcileRepoDocumentsRequest>): Promise<void> {
    const context = {
      operation: "reconcileRepoDocuments",
      workspaceId: request.workspaceId,
      generation: request.generation,
      repoId: request.repoId,
      batchId: request.batchId
    } as const;
    try {
      validateBoundary(request.workspaceId, "workspaceId");
      validateBoundary(request.generation, "generation");
      validateBoundary(request.repoId, "repoId");
      validateBoundary(request.batchId, "batchId");
      const activeDocumentIds = uniqueStrings(request.activeDocumentIds, "activeDocumentIds");
      const idPredicate = activeDocumentIds.length === 0 ? "" : " AND NOT (n.documentId IN $activeDocumentIds)";
      const params: Record<string, GraphValue> = {
        workspaceId: request.workspaceId,
        generation: request.generation,
        repoId: request.repoId
      };
      if (activeDocumentIds.length > 0) params.activeDocumentIds = activeDocumentIds;
      await this.db.transaction(async () => {
        const deactivated = await this.db.query<DeactivationStatsRow>(
          "MATCH (n:LexicalDocument) " +
          `WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.active = true${idPredicate} ` +
          "RETURN count(*) AS documentCount, sum(n.ftsSizeBytes) AS indexSizeBytes;",
          params
        );
        await this.db.query(
          "MATCH (n:LexicalDocument) " +
          `WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId${idPredicate} SET n.active = false;`,
          params
        );
        await this.adjustGenerationStats(
          request.workspaceId,
          request.generation,
          -numeric(deactivated[0]?.documentCount),
          -numeric(deactivated[0]?.indexSizeBytes)
        );
      });
    } catch (error) {
      throw wrap("reconcile_failed", context, error);
    }
  }

  async reconcileRepoFileDocuments(request: Readonly<ReconcileRepoFileDocumentsRequest>): Promise<void> {
    const context = { operation: "reconcileRepoFileDocuments", workspaceId: request.workspaceId, generation: request.generation, repoId: request.repoId, batchId: request.batchId } as const;
    try {
      validateBoundary(request.generation, "generation");
      const activeFileIds = uniqueStrings(request.activeFileIds, "activeFileIds");
      const staleCondition = activeFileIds.length === 0 ? "" : " AND NOT (n.fileId IN $activeFileIds)";
      const reconcileParams: Record<string, GraphValue> = { workspaceId: request.workspaceId, generation: request.generation, repoId: request.repoId };
      if (activeFileIds.length > 0) reconcileParams.activeFileIds = activeFileIds;
      await this.db.transaction(async () => {
        const rows = await this.db.query<DeactivationStatsRow>(
          "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.active = true AND n.fileId IS NOT NULL" + staleCondition + " RETURN count(*) AS documentCount, sum(n.ftsSizeBytes) AS indexSizeBytes;",
          reconcileParams
        );
        await this.db.query(
          "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.active = true AND n.fileId IS NOT NULL" + staleCondition + " SET n.active = false, n.batchId = $batchId;",
          { ...reconcileParams, batchId: request.batchId }
        );
        await this.adjustGenerationStats(request.workspaceId, request.generation, -numeric(rows[0]?.documentCount), -numeric(rows[0]?.indexSizeBytes));
      });
    } catch (error) { throw wrap("reconcile_failed", context, error); }
  }

  async stageBatch(request: Readonly<StageLexicalBatchRequest>): Promise<void> {
    validateGenerationRequest(request);
    await this.db.transaction(async () => {
      await this.db.query(
        "MERGE (b:LexicalGenerationBatch {id: $id}) SET b.workspaceId=$workspaceId, b.generation=$generation, b.batchId=$batchId;",
        { id: batchMarkerId(request.workspaceId, request.batchId), workspaceId: request.workspaceId, generation: request.generation, batchId: request.batchId }
      );
    });
  }

  async commitBatch(request: Readonly<CleanupBatchRequest>): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.query("MATCH (b:LexicalGenerationBatch) WHERE b.workspaceId=$workspaceId AND b.batchId=$batchId DELETE b;", request);
    });
  }

  async replaceSourceDocuments(request: Readonly<ReplaceSourceDocumentsRequest>): Promise<void> {
    const context = { operation: "replaceSourceDocuments", workspaceId: request.workspaceId, generation: request.generation, repoId: request.repoId, batchId: request.batchId } as const;
    try {
      validateBoundary(request.generation, "generation");
      const touchedFileIds = uniqueStrings(request.touchedFileIds, "touchedFileIds");
      const activeDocumentIds = uniqueStrings(request.activeDocumentIds, "activeDocumentIds");
      if (touchedFileIds.length === 0) return;
      await this.db.transaction(async () => {
        const matchParams = { workspaceId: request.workspaceId, generation: request.generation, repoId: request.repoId, touchedFileIds, activeDocumentIds };
        const rows = await this.db.query<DeactivationStatsRow>(
          "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.active = true AND n.fileId IN $touchedFileIds AND NOT (n.documentId IN $activeDocumentIds) RETURN count(*) AS documentCount, sum(n.ftsSizeBytes) AS indexSizeBytes;",
          matchParams
        );
        await this.db.query(
          "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.active = true AND n.fileId IN $touchedFileIds AND NOT (n.documentId IN $activeDocumentIds) SET n.active = false, n.batchId = $batchId;",
          { ...matchParams, batchId: request.batchId }
        );
        await this.adjustGenerationStats(request.workspaceId, request.generation, -numeric(rows[0]?.documentCount), -numeric(rows[0]?.indexSizeBytes));
      });
    } catch (error) { throw wrap("reconcile_failed", context, error); }
  }

  async cleanupBatch(request: Readonly<CleanupBatchRequest>): Promise<void> {
    const context = {
      operation: "cleanupBatch",
      workspaceId: request.workspaceId,
      batchId: request.batchId
    } as const;
    try {
      validateBoundary(request.workspaceId, "workspaceId");
      validateBoundary(request.batchId, "batchId");
      await this.db.transaction(async () => {
        await this.db.query(
          "MATCH (b:LexicalGenerationBatch) WHERE b.workspaceId=$workspaceId AND b.batchId=$batchId DELETE b;",
          request
        );
      });
    } catch (error) {
      throw wrap("cleanup_failed", context, error);
    }
  }

  async search(
    query: Readonly<LexicalQuery>,
    options: Readonly<LexicalSearchOptions>
  ): Promise<readonly LexicalHit[]> {
    const context = { operation: "search", workspaceId: query.workspaceId } as const;
    try {
      validateBoundary(query.workspaceId, "workspaceId");
      validateBoundary(query.generation, "generation");
      if (!Number.isSafeInteger(options.topK) || options.topK <= 0) {
        throw new TypeError("topK must be a positive safe integer.");
      }
      const ftsQuery = ftsQueryText(query.text);
      if (!ftsQuery) return [];
      const rows = await this.db.query<SearchRow>(
        "CALL QUERY_FTS_INDEX('LexicalDocument', 'workspace_lexical', $text) " +
        "WHERE node.workspaceId = $workspaceId AND node.generation = $generation AND node.active = true " +
        "RETURN node.canonicalId AS canonicalId, node.documentId AS documentId, node.repoId AS repoId, " +
        "node.kind AS kind, node.renderRef AS renderRef, score " +
        "ORDER BY score DESC, documentId ASC LIMIT $topK;",
        { text: ftsQuery, workspaceId: query.workspaceId, generation: query.generation, topK: options.topK }
      );
      return rows.map((row, index) => ({
        canonicalId: row.canonicalId,
        documentId: row.documentId,
        repoId: row.repoId,
        kind: lexicalKind(row.kind),
        rank: index + 1,
        matchReasons: ["full-text"],
        renderRef: row.renderRef
      }));
    } catch (error) {
      throw wrap("search_failed", context, error);
    }
  }

  async loadDocuments(request: Readonly<LoadDocumentsRequest>): Promise<readonly LexicalDocument[]> {
    const context = { operation: "loadDocuments", workspaceId: request.workspaceId } as const;
    try {
      validateBoundary(request.workspaceId, "workspaceId");
      validateBoundary(request.generation, "generation");
      const documentIds = uniqueStrings(request.documentIds, "documentIds");
      if (documentIds.length === 0) return [];
      const rows = await this.db.query<DocumentRow>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.documentId IN $documentIds " +
        documentReturnClause() + " ORDER BY n.documentId;",
        { workspaceId: request.workspaceId, generation: request.generation, documentIds }
      );
      return rows.map(documentFromRow);
    } catch (error) {
      throw wrap("load_failed", context, error);
    }
  }

  async pendingHealth(request: Readonly<LexicalGenerationRequest>): Promise<LexicalIndexHealth> {
    return this.generationHealth(request, "pendingHealth");
  }

  async documentIdsForSources(request: Readonly<DocumentIdsForSourcesRequest>): Promise<readonly string[]> {
    const context: WorkspaceLexicalStoreErrorContext = {
      operation: "documentIdsForSources",
      workspaceId: request.workspaceId,
      repoId: request.repoId,
      generation: request.generation
    };
    try {
      validateGenerationRequest(request);
      validateBoundary(request.repoId, "repoId");
      const fileIds = uniqueStrings(request.fileIds, "fileIds");
      if (fileIds.length === 0) return [];
      const rows = await this.db.query<{ documentId: string }>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation " +
        "AND n.repoId = $repoId AND n.active = true AND n.fileId IN $fileIds " +
        "RETURN n.documentId AS documentId ORDER BY n.documentId;",
        { workspaceId: request.workspaceId, generation: request.generation, repoId: request.repoId, fileIds }
      );
      return [...new Set(rows.map((row) => row.documentId))].sort(compareText);
    } catch (error) {
      throw wrap("load_failed", context, error);
    }
  }

  async health(request: Readonly<LexicalGenerationRequest>): Promise<LexicalIndexHealth> {
    return this.generationHealth(request, "health");
  }

  private async generationHealth(request: Readonly<LexicalGenerationRequest>, operation: "health" | "pendingHealth"): Promise<LexicalIndexHealth> {
    const { workspaceId, generation } = request;
    const context = { operation, workspaceId, generation } as const;
    try {
      validateBoundary(workspaceId, "workspaceId");
      validateBoundary(generation, "generation");
      const reasons: string[] = [];
      const versionRows = await this.db.query<VersionRow>("CALL DB_VERSION() RETURN version;");
      const tables = await this.tableNames();
      const indexes = await this.indexRows();
      const providerVersion = String(versionRows[0]?.version ?? "unknown");
      const hasDocuments = tables.has(KUZU_LEXICAL_DOCUMENT_TABLE);
      const hasMetadata = tables.has(KUZU_LEXICAL_METADATA_TABLE);
      const hasStats = tables.has(KUZU_LEXICAL_STATS_TABLE);
      const versionReason = kuzuVersionReason(providerVersion);
      if (versionReason) reasons.push(versionReason);
      if (!hasDocuments) reasons.push("lexical_document_table_missing");
      if (!hasMetadata) reasons.push("lexical_metadata_table_missing");
      if (!hasStats) reasons.push("lexical_stats_table_missing");

      const lexicalIndexes = indexes.filter((index) =>
        index.table_name === KUZU_LEXICAL_DOCUMENT_TABLE && index.index_type === "FTS"
      );
      const workspaceIndex = lexicalIndexes.find((index) => index.index_name === KUZU_WORKSPACE_FTS_INDEX);
      if (!workspaceIndex) reasons.push("fts_index_missing");
      if (workspaceIndex && !workspaceIndex.extension_loaded) reasons.push("fts_extension_not_loaded");
      if (workspaceIndex && !sameStrings(workspaceIndex.property_names, EXPECTED_FTS_PROPERTIES)) {
        reasons.push("fts_index_definition_mismatch");
      }
      if (lexicalIndexes.some((index) => index.index_name !== KUZU_WORKSPACE_FTS_INDEX)) {
        reasons.push("unexpected_additional_fts_index");
      }

      let projectionSchemaVersion = "missing";
      let tokenizerVersion = "missing";
      if (hasMetadata) {
        const metadata = await this.db.query<MetadataRow>(
          "MATCH (m:LexicalMetadata) RETURN m.key AS key, m.value AS value ORDER BY key;"
        );
        const values = new Map(metadata.map((entry) => [entry.key, entry.value]));
        projectionSchemaVersion = values.get(PROJECTION_METADATA_KEY) ?? "missing";
        tokenizerVersion = values.get(TOKENIZER_METADATA_KEY) ?? "missing";
        if (values.get(STATS_METADATA_KEY) !== KUZU_LEXICAL_STATS_SCHEMA_VERSION) {
          reasons.push("lexical_stats_version_mismatch");
        }
      }
      if (projectionSchemaVersion !== LEXICAL_PROJECTION_SCHEMA_VERSION) {
        reasons.push("projection_schema_version_mismatch");
      }
      if (tokenizerVersion !== TOKENIZER_VERSION) reasons.push("tokenizer_version_mismatch");

      let documentCount = 0;
      let indexSizeBytes = 0;
      if (hasStats) {
        const revision = await this.resolveStatsRevision(request, operation);
        const statsRows = await this.db.query<WorkspaceStatsRow>(
          "MATCH (s:LexicalWorkspaceStats {id: $id}) " +
          "RETURN s.workspaceId AS workspaceId, s.generation AS generation, s.revision AS revision, " +
          "s.documentCount AS documentCount, s.indexSizeBytes AS indexSizeBytes;",
          { id: generationStatsId(workspaceId, generation, revision) }
        );
        const stats = statsRows[0];
        if (!stats || stats.workspaceId !== workspaceId || stats.generation !== generation
          || stats.revision !== revision) {
          reasons.push("lexical_stats_revision_missing");
        } else {
          documentCount = numeric(stats.documentCount);
          indexSizeBytes = numeric(stats.indexSizeBytes);
        }
      }

      return {
        providerVersion,
        projectionSchemaVersion,
        tokenizerVersion,
        status: reasons.length === 0 ? "healthy" : "unhealthy",
        reasons,
        metrics: { documentCount, indexSizeBytes }
      };
    } catch (error) {
      throw wrap("health_check_failed", context, error);
    }
  }

  private async tableNames(): Promise<Set<string>> {
    const rows = await this.db.query<TableRow>("CALL SHOW_TABLES() RETURN name;");
    return new Set(rows.map((row) => row.name));
  }

  private async indexRows(): Promise<IndexRow[]> {
    return this.db.query<IndexRow>(
      "CALL SHOW_INDEXES() RETURN table_name, index_name, index_type, property_names, extension_loaded;"
    );
  }

  private async metadataValue(key: string): Promise<string | undefined> {
    const rows = await this.db.query<{ value: string }>(
      "MATCH (m:LexicalMetadata {key: $key}) RETURN m.value AS value;",
      { key }
    );
    return rows[0]?.value;
  }

  /** Current clean-cut schemas never run row backfills during ordinary startup. */
  private async hasCurrentSchema(): Promise<boolean> {
    const tables = await this.tableNames();
    if (![KUZU_LEXICAL_DOCUMENT_TABLE, KUZU_LEXICAL_METADATA_TABLE, KUZU_LEXICAL_STATS_TABLE, "LexicalGenerationBatch"]
      .every((table) => tables.has(table))) return false;
    const metadata = await this.db.query<MetadataRow>(
      "MATCH (m:LexicalMetadata) RETURN m.key AS key, m.value AS value ORDER BY key;"
    );
    const values = new Map(metadata.map((entry) => [entry.key, entry.value]));
    if (values.get(PROJECTION_METADATA_KEY) !== LEXICAL_PROJECTION_SCHEMA_VERSION
      || values.get(TOKENIZER_METADATA_KEY) !== TOKENIZER_VERSION
      || values.get(STATS_METADATA_KEY) !== KUZU_LEXICAL_STATS_SCHEMA_VERSION) return false;
    const columns = await this.db.query<ColumnRow>(
      `CALL table_info('${KUZU_LEXICAL_DOCUMENT_TABLE}') RETURN name;`
    );
    const names = new Set(columns.map((column) => column.name));
    if (!DOCUMENT_LOAD_COLUMNS.every(([name]) => names.has(name))) return false;
    const statsColumns = await this.db.query<ColumnRow>(
      `CALL table_info('${KUZU_LEXICAL_STATS_TABLE}') RETURN name;`
    );
    const statsNames = new Set(statsColumns.map((column) => column.name));
    if (!["id", "workspaceId", "generation", "revision", "documentCount", "indexSizeBytes"]
      .every((name) => statsNames.has(name))) return false;
    const lexicalIndexes = (await this.indexRows()).filter((index) =>
      index.table_name === KUZU_LEXICAL_DOCUMENT_TABLE && index.index_type === "FTS"
    );
    return lexicalIndexes.length === 1
      && lexicalIndexes[0]?.index_name === KUZU_WORKSPACE_FTS_INDEX
      && lexicalIndexes[0].extension_loaded
      && sameStrings(lexicalIndexes[0].property_names, EXPECTED_FTS_PROPERTIES);
  }

  private async resolveStatsRevision(
    request: Readonly<LexicalGenerationRequest>,
    operation: "health" | "pendingHealth"
  ): Promise<string> {
    if (request.revision !== undefined) {
      validateBoundary(request.revision, "revision");
      return request.revision;
    }
    if (operation === "pendingHealth") return request.generation;
    if (!(await this.tableNames()).has("SchemaGenerationState")) return request.generation;
    const rows = await this.db.query<{ activeGeneration?: GraphValue; activeRevision?: GraphValue }>(
      "MATCH (s:SchemaGenerationState {id: $id}) " +
      "RETURN s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision;",
      { id: `schema-generation-state:${request.workspaceId}` }
    );
    const row = rows[0];
    return row?.activeGeneration === request.generation
      && typeof row.activeRevision === "string"
      && row.activeRevision.length > 0
      ? row.activeRevision
      : request.generation;
  }

  private async adjustGenerationStats(
    workspaceId: string,
    generation: string,
    documentCountDelta: number,
    indexSizeBytesDelta: number
  ): Promise<void> {
    await this.db.query(
      "MERGE (s:LexicalWorkspaceStats {id: $id}) " +
      "ON CREATE SET s.workspaceId = $workspaceId, s.generation = $generation, s.revision = $revision, " +
      "s.documentCount = 0, s.indexSizeBytes = 0 " +
      "SET s.documentCount = s.documentCount + $documentCountDelta, " +
      "s.indexSizeBytes = s.indexSizeBytes + $indexSizeBytesDelta;",
      {
        id: generationStatsId(workspaceId, generation, generation),
        workspaceId,
        generation,
        revision: generation,
        documentCountDelta,
        indexSizeBytesDelta
      }
    );
  }

  private async applyExactStatsDelta(
    workspaceId: string,
    generation: string,
    expectedRevision: string,
    nextRevision: string,
    documentCountDelta: number,
    indexSizeBytesDelta: number
  ): Promise<void> {
    const rows = await this.db.query<WorkspaceStatsRow>(
      "MATCH (s:LexicalWorkspaceStats {id: $id}) " +
      "RETURN s.id AS id, s.workspaceId AS workspaceId, s.generation AS generation, s.revision AS revision, " +
      "s.documentCount AS documentCount, s.indexSizeBytes AS indexSizeBytes;",
      { id: generationStatsId(workspaceId, generation, expectedRevision) }
    );
    const current = rows[0];
    if (!current || current.workspaceId !== workspaceId || current.generation !== generation
      || current.revision !== expectedRevision) {
      throw new TypeError(`Missing lexical statistics for active revision ${expectedRevision}.`);
    }
    const documentCount = numeric(current.documentCount) + documentCountDelta;
    const indexSizeBytes = numeric(current.indexSizeBytes) + indexSizeBytesDelta;
    if (!Number.isSafeInteger(documentCount) || documentCount < 0
      || !Number.isSafeInteger(indexSizeBytes) || indexSizeBytes < 0) {
      throw new TypeError(`Incremental lexical statistics underflow for generation ${generation}.`);
    }
    const nextId = generationStatsId(workspaceId, generation, nextRevision);
    const existingNext = await this.db.query<{ id: string }>(
      "MATCH (s:LexicalWorkspaceStats {id: $id}) RETURN s.id AS id;",
      { id: nextId }
    );
    if (existingNext.length > 0) {
      throw new Error(`Lexical statistics revision ${nextRevision} already exists.`);
    }
    await this.db.query(
      "MERGE (s:LexicalWorkspaceStats {id: $id}) " +
      "ON CREATE SET s.workspaceId=$workspaceId, s.generation=$generation, s.revision=$revision, " +
      "s.documentCount=$documentCount, s.indexSizeBytes=$indexSizeBytes;",
      {
        id: nextId,
        workspaceId,
        generation,
        revision: nextRevision,
        documentCount,
        indexSizeBytes
      }
    );
  }

  private async replaceGenerationStats(
    workspaceId: string,
    generation: string,
    revision: string,
    documentCount: number,
    indexSizeBytes: number
  ): Promise<void> {
    await this.db.query(
      "MERGE (s:LexicalWorkspaceStats {id: $id}) SET s.workspaceId=$workspaceId, s.generation=$generation, " +
      "s.revision=$revision, s.documentCount=$documentCount, s.indexSizeBytes=$indexSizeBytes;",
      { id: generationStatsId(workspaceId, generation, revision), workspaceId, generation, revision, documentCount, indexSizeBytes }
    );
  }

  private async deleteGenerationRows(request: Readonly<LexicalGenerationRequest>): Promise<void> {
    const generation = { workspaceId: request.workspaceId, generation: request.generation };
    await this.db.query(
      "MATCH (b:LexicalGenerationBatch) WHERE b.workspaceId=$workspaceId AND b.generation=$generation DELETE b;",
      generation
    );
    await this.db.query(
      "MATCH (n:LexicalDocument) WHERE n.workspaceId=$workspaceId AND n.generation=$generation DELETE n;",
      generation
    );
    await this.db.query(
      "MATCH (s:LexicalWorkspaceStats) WHERE s.workspaceId=$workspaceId AND s.generation=$generation DELETE s;",
      generation
    );
  }

  private async assertGenerationNotActive(
    request: Readonly<LexicalGenerationRequest>,
    options: { allowReservedPending?: boolean } = {}
  ): Promise<void> {
    if (!(await this.tableNames()).has("SchemaGenerationState")) return;
    const rows = await this.db.query<{ activeGeneration?: GraphValue; pendingGeneration?: GraphValue }>(
      "MATCH (s:SchemaGenerationState {id: $id}) SET s.protocolNonce=$nonce RETURN s.activeGeneration AS activeGeneration, s.pendingGeneration AS pendingGeneration;",
      { id: `schema-generation-state:${request.workspaceId}`, nonce: `lexical-cleanup:${request.generation}` }
    );
    if (rows[0]?.activeGeneration === request.generation) {
      throw new TypeError(`Cannot delete active lexical generation ${request.generation}.`);
    }
    if (rows[0]?.pendingGeneration === request.generation && !options.allowReservedPending) {
      throw new TypeError(`Cannot delete reserved pending lexical generation ${request.generation}.`);
    }
    if (typeof rows[0]?.pendingGeneration === "string" && rows[0].pendingGeneration
      && rows[0].pendingGeneration !== request.generation) {
      throw new TypeError(`Cannot initialize lexical generation ${request.generation} while ${rows[0].pendingGeneration} is reserved.`);
    }
    if (!options.allowReservedPending) {
      await assertNoLivePublicGraphReadLeases(this.db, request);
    }
  }

  private async mergeStoredDocuments(documents: readonly StoredDocument[]): Promise<void> {
    for (let offset = 0; offset < documents.length; offset += KUZU_LEXICAL_WRITE_CHUNK_SIZE) {
      const chunk = documents.slice(offset, offset + KUZU_LEXICAL_WRITE_CHUNK_SIZE);
      await this.db.transaction(async () => {
        for (const document of chunk) await this.mergeStoredDocument(document);
      });
    }
  }

  private async mergeStoredDocument(item: StoredDocument): Promise<void> {
    await this.db.query(
      "MERGE (n:LexicalDocument {storageId: $storageId}) " +
      "SET n.documentId=$documentId, n.generation=$generation, n.canonicalId=$canonicalId, n.workspaceId=$workspaceId, " +
      "n.repoId=$repoId, n.kind=$kind, n.title=$title, n.qualifiedName=$qualifiedName, n.path=$path, " +
      "n.searchableText=$searchableText, n.tokens=$tokens, n.active=$active, n.sourceHash=$sourceHash, " +
      "n.batchId=$batchId, n.renderRef=$renderRef, n.fileId=$fileId, n.ftsText=$ftsText, n.ftsSizeBytes=$ftsSizeBytes;",
      storedDocumentParameters(item)
    );
  }

  private async ensureSingleWorkspaceIndex(): Promise<void> {
    const indexes = (await this.indexRows()).filter((index) =>
      index.table_name === KUZU_LEXICAL_DOCUMENT_TABLE && index.index_type === "FTS"
    );
    for (const index of indexes) {
      const expected = index.index_name === KUZU_WORKSPACE_FTS_INDEX
        && sameStrings(index.property_names, EXPECTED_FTS_PROPERTIES);
      if (!expected) {
        await this.db.query(
          `CALL DROP_FTS_INDEX('${KUZU_LEXICAL_DOCUMENT_TABLE}', '${escapeLiteral(index.index_name)}');`
        );
      }
    }
    const valid = indexes.some((index) =>
      index.index_name === KUZU_WORKSPACE_FTS_INDEX
      && sameStrings(index.property_names, EXPECTED_FTS_PROPERTIES)
    );
    if (!valid) {
      await this.db.query(
        "CALL CREATE_FTS_INDEX('LexicalDocument', 'workspace_lexical', ['ftsText']);"
      );
    }
  }
}

async function copyNewDocuments(db: KuzuGraphDB, documents: readonly StoredDocument[]): Promise<void> {
  await withStagedDocuments("lexical-copy", documents, async (filePath, stageDurationMs) => {
    const copyStarted = Date.now();
    await db.query(`COPY LexicalDocument (${DOCUMENT_COLUMN_NAMES}) FROM "${toKuzuPath(filePath)}" (PARALLEL=false);`);
    writeLexicalTrace(`writer=copy documents=${documents.length} stage=${stageDurationMs}ms copy=${Date.now() - copyStarted}ms`);
  });
}

async function appendLoadNewDocuments(db: KuzuGraphDB, documents: readonly StoredDocument[]): Promise<void> {
  await withStagedDocuments("lexical-append-load", documents, async (filePath, stageDurationMs) => {
    const loadStarted = Date.now();
    await db.query(
      `LOAD FROM "${toKuzuPath(filePath)}" (PARALLEL=false) WITH ${DOCUMENT_LOAD_BINDINGS} ` +
      `MERGE (n:LexicalDocument {storageId: storageId}) SET ${DOCUMENT_LOAD_SET};`
    );
    writeLexicalTrace(`writer=append-load documents=${documents.length} stage=${stageDurationMs}ms load=${Date.now() - loadStarted}ms`);
  });
}

async function withStagedDocuments(
  prefix: string,
  documents: readonly StoredDocument[],
  write: (filePath: string, stageDurationMs: number) => Promise<void>
): Promise<void> {
  const stagingStarted = Date.now();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), brandedTempDirPrefix(prefix)));
  const filePath = path.join(directory, "LexicalDocument.csv");
  try {
    const rows = documents.map((document) => documentCsvRow(document).map(encodeCsvValue).join(","));
    await fs.writeFile(filePath, rows.join("\n"), "utf8");
    await write(filePath, Date.now() - stagingStarted);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function documentCsvRow(item: StoredDocument): CsvScalar[] {
  const { document } = item;
  const ftsText = indexedText(document);
  return [
    item.storageId,
    document.id,
    item.generation,
    document.canonicalId,
    document.workspaceId,
    document.repoId,
    document.kind,
    document.title,
    document.qualifiedName,
    document.path,
    document.searchableText,
    `[${document.tokens.join(",")}]`,
    document.active,
    document.sourceHash,
    document.batchId,
    document.renderRef,
    fileIdFromRenderRef(document),
    ftsText,
    Buffer.byteLength(ftsText, "utf8")
  ];
}

function hasCopySafeTokens(document: LexicalDocument): boolean {
  return document.tokens.every((token) => COPY_SAFE_TOKEN.test(token));
}

function toKuzuPath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/").replace(/"/g, '\\"');
}

function shouldWriteLexicalTrace(): boolean {
  const value = getBrandedEnv("LEXICAL_TRACE");
  return value === "1" || value === "true";
}

function writeLexicalTrace(message: string): void {
  if (shouldWriteLexicalTrace()) process.stderr.write(`Lexical write ${message}\n`);
}

function validateDocuments(documents: readonly LexicalDocument[]): LexicalDocument[] {
  const workspaceId = documents[0]!.workspaceId;
  const batchId = documents[0]!.batchId;
  validateBoundary(workspaceId, "workspaceId");
  validateBoundary(batchId, "batchId");
  const byId = new Map<string, LexicalDocument>();
  for (const document of documents) {
    validateBoundary(document.id, "document.id");
    validateBoundary(document.canonicalId, "document.canonicalId");
    validateBoundary(document.repoId, "document.repoId");
    validateBoundary(document.renderRef, "document.renderRef");
    if (document.workspaceId !== workspaceId || document.batchId !== batchId) {
      throw new TypeError("All documents in one upsert must share workspaceId and batchId.");
    }
    lexicalKind(document.kind);
    if (!Array.isArray(document.tokens) || document.tokens.some((token) => typeof token !== "string")) {
      throw new TypeError("document.tokens must be an array of strings.");
    }
    const previous = byId.get(document.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(document)) {
      throw new TypeError(`Conflicting documents share id: ${document.id}.`);
    }
    if (!previous) byId.set(document.id, document);
  }
  return [...byId.values()].sort((left, right) => compareText(left.id, right.id));
}

function validateGenerationRequest(request: Readonly<LexicalGenerationRequest>): void {
  validateBoundary(request.workspaceId, "workspaceId");
  validateBoundary(request.generation, "generation");
}

function storageId(workspaceId: string, generation: string, documentId: string): string {
  return `lexical-storage:${JSON.stringify([workspaceId, generation, documentId])}`;
}

function storedDocument(document: LexicalDocument, generation: string): StoredDocument {
  return {
    storageId: storageId(document.workspaceId, generation, document.id),
    generation,
    document
  };
}

function generationStatsId(workspaceId: string, generation: string, revision: string): string {
  return `lexical-stats:${JSON.stringify([workspaceId, generation, revision])}`;
}

function batchMarkerId(workspaceId: string, batchId: string): string {
  return `lexical-batch:${JSON.stringify([workspaceId, batchId])}`;
}

function ftsQueryText(text: string): string {
  const tokens = tokenizeLexicalText(text).filter((token) => !QUERY_STOP_WORDS.has(token));
  if (/[._/-]/u.test(text)) {
    const exactIdentifier = tokens
      .filter((token) => token.startsWith("ident_"))
      .sort((left, right) => right.length - left.length || compareText(left, right))[0];
    if (exactIdentifier) return exactIdentifier;
  }
  return tokens.join(" ");
}

function storedDocumentParameters(item: StoredDocument): Record<string, GraphValue> {
  const { document } = item;
  const ftsText = indexedText(document);
  return {
    storageId: item.storageId,
    documentId: document.id,
    generation: item.generation,
    canonicalId: document.canonicalId,
    workspaceId: document.workspaceId,
    repoId: document.repoId,
    kind: document.kind,
    title: document.title,
    qualifiedName: document.qualifiedName ?? null,
    path: document.path ?? null,
    searchableText: document.searchableText,
    tokens: [...document.tokens],
    active: document.active,
    sourceHash: document.sourceHash,
    batchId: document.batchId,
    renderRef: document.renderRef,
    fileId: fileIdFromRenderRef(document),
    ftsText,
    ftsSizeBytes: Buffer.byteLength(ftsText, "utf8")
  };
}

function fileIdFromRenderRef(document: LexicalDocument): string | null {
  return fileIdFromIdentity(document);
}

function fileIdFromIdentity(document: { workspaceId: string; repoId: string; kind: string; canonicalId: string; renderRef: string }): string | null {
  const parsed = parseRenderRef(document.renderRef, document.workspaceId);
  if (parsed.repoId !== document.repoId || parsed.kind !== document.kind || parsed.canonicalId !== document.canonicalId) {
    throw new TypeError(`Render reference identity does not match lexical document ${document.canonicalId}.`);
  }
  return parsed.fileId ?? null;
}

function indexedText(document: LexicalDocument): string {
  return [document.searchableText, ...document.tokens].filter(Boolean).join(" ");
}

function ftsSizeBytes(document: LexicalDocument): number {
  return Buffer.byteLength(indexedText(document), "utf8");
}

function documentReturnClause(): string {
  return "RETURN n.storageId AS storageId, n.documentId AS documentId, n.generation AS generation, n.canonicalId AS canonicalId, n.workspaceId AS workspaceId, " +
    "n.repoId AS repoId, n.kind AS kind, n.title AS title, n.qualifiedName AS qualifiedName, " +
    "n.path AS path, n.searchableText AS searchableText, n.tokens AS tokens, n.active AS active, " +
    "n.sourceHash AS sourceHash, n.batchId AS batchId, n.renderRef AS renderRef, " +
    "n.fileId AS fileId, n.ftsText AS ftsText, n.ftsSizeBytes AS ftsSizeBytes";
}

function documentFromRow(row: DocumentRow): LexicalDocument {
  return {
    id: row.documentId,
    canonicalId: row.canonicalId,
    workspaceId: row.workspaceId,
    repoId: row.repoId,
    kind: lexicalKind(row.kind),
    title: row.title,
    ...(row.qualifiedName === null ? {} : { qualifiedName: row.qualifiedName }),
    ...(row.path === null ? {} : { path: row.path }),
    searchableText: row.searchableText,
    tokens: [...(row.tokens ?? [])],
    active: row.active,
    sourceHash: row.sourceHash,
    batchId: row.batchId,
    renderRef: row.renderRef
  };
}

function lexicalKind(value: string): LexicalDocumentKind {
  if (!(LEXICAL_DOCUMENT_KINDS as readonly string[]).includes(value)) {
    throw new TypeError(`Unknown lexical document kind: ${value}.`);
  }
  return value as LexicalDocumentKind;
}

function validateBoundary(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
}

function uniqueStrings(values: readonly string[], name: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError(`${name} must contain only non-empty strings.`);
  }
  return [...new Set(values)].sort(compareText);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function numeric(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`Invalid lexical statistics value: ${String(value)}.`);
  }
  return result;
}

function kuzuVersionReason(version: string): string | undefined {
  const parsed = parseVersion(version);
  if (!parsed) return "provider_version_unknown";
  const minimum = parseVersion(KUZU_MINIMUM_FTS_VERSION)!;
  const maximum = parseVersion(KUZU_MAXIMUM_FTS_VERSION_EXCLUSIVE)!;
  if (compareVersion(parsed, minimum) < 0 || compareVersion(parsed, maximum) >= 0) {
    return "provider_version_incompatible";
  }
  return undefined;
}

function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number {
  for (let index = 0; index < left.length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function wrap(
  code: WorkspaceLexicalStoreErrorCode,
  context: WorkspaceLexicalStoreErrorContext,
  cause: unknown
): WorkspaceLexicalStoreError {
  if (cause instanceof WorkspaceLexicalStoreError) return cause;
  return new WorkspaceLexicalStoreError(code, context, { cause });
}
