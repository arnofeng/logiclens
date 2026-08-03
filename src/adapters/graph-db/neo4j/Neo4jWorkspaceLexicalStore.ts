import type { GraphValue } from "../../../core/graph-model/db.js";
import { withTransaction } from "../../../core/graph-model/db.js";
import { assertNoLivePublicGraphReadLeases } from "../../../core/graph-model/readSnapshot.js";
import { tokenizeLexicalText } from "../../../core/retrieval/tokenizer.js";
import { parseRenderRef } from "../../../core/retrieval/renderRef.js";
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
import { Neo4jGraphDB } from "./Neo4jGraphDB.js";

export const NEO4J_WORKSPACE_FTS_INDEX = "workspace_lexical";
export const NEO4J_LEXICAL_STATS_SCHEMA_VERSION = "3";
export const NEO4J_LEXICAL_UPSERT_CHUNK_SIZE = 500;
export const NEO4J_LEXICAL_INDEX_ONLINE_TIMEOUT_SECONDS = 300;
export const NEO4J_LEXICAL_ANALYZER = "standard-no-stop-words";

const PROJECTION_METADATA_KEY = "projectionSchemaVersion";
const TOKENIZER_METADATA_KEY = "tokenizerVersion";
const STATS_METADATA_KEY = "lexicalStatsSchemaVersion";
const ANALYZER_CONFIG_KEY = "fulltext.analyzer";
const EVENTUALLY_CONSISTENT_CONFIG_KEY = "fulltext.eventually_consistent";
const NEO4J_QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "consume", "consumes", "declared", "defined", "does", "find",
  "for", "http", "is", "of", "on", "or", "service", "the", "to", "what", "where",
  "which", "who", "with", "worker"
]);
const NEO4J_CJK_QUERY_STOP_CHARACTERS = new Set(Array.from(
  "什么哪个哪里如何谁服务接口稳定标识契约事件消费创建订单"
));
const SAFE_LUCENE_TOKEN = /^[\p{L}\p{M}\p{N}_]+$/u;
const LATIN_QUERY_TOKEN = /[\p{Script=Latin}\p{N}]/u;
const QUERY_PATH_PATTERN = /[\p{L}\p{M}\p{N}._-]+(?:\/[\p{L}\p{M}\p{N}._-]+)+/u;
const REPOSITORY_PATH_ROOTS = new Set(["app", "apps", "docs", "lib", "packages", "src", "test", "tests"]);

export const NEO4J_WORKSPACE_LEXICAL_REQUIREMENTS = Object.freeze({
  versionPolicy: "runtime-capability-check",
  requiredIndexType: "FULLTEXT",
  requiredQueryProcedure: "db.index.fulltext.queryNodes"
} as const);

export interface Neo4jWorkspaceLexicalCompatibility {
  indexTypes: readonly string[];
  procedures: readonly string[];
}

interface ExistingDocumentRow {
  storageId: string;
  workspaceId: string;
  active: boolean;
  ftsSizeBytes: number | bigint | null;
}

interface DocumentRow extends Omit<LexicalDocument, "id" | "qualifiedName" | "path"> {
  storageId: string;
  documentId: string;
  generation: string;
  qualifiedName: string | null;
  path: string | null;
  ftsText?: string | null;
  ftsSizeBytes?: number | bigint | null;
}

type StoredDocument = {
  storageId: string;
  generation: string;
  document: LexicalDocument;
};

interface IndexRow {
  name: string;
  type: string;
  state: string;
  labelsOrTypes: string[];
  properties: string[];
  failureMessage?: string | null;
  options?: {
    indexConfig?: Record<string, unknown>;
  } | null;
}

export interface Neo4jWorkspaceLexicalStoreOptions {
  /** Used by isolated integration harnesses; production uses the single default index. */
  indexName?: string;
}

export function supportsNeo4jWorkspaceLexical(
  compatibility: Readonly<Neo4jWorkspaceLexicalCompatibility>
): boolean {
  return compatibility.indexTypes.includes(NEO4J_WORKSPACE_LEXICAL_REQUIREMENTS.requiredIndexType)
    && compatibility.procedures.includes(NEO4J_WORKSPACE_LEXICAL_REQUIREMENTS.requiredQueryProcedure);
}

export class Neo4jWorkspaceLexicalStore implements WorkspaceLexicalStore {
  private readonly indexName: string;

  constructor(readonly db: Neo4jGraphDB, options: Readonly<Neo4jWorkspaceLexicalStoreOptions> = {}) {
    this.indexName = options.indexName ?? NEO4J_WORKSPACE_FTS_INDEX;
  }

  async ensureSchema(): Promise<void> {
    const context = { operation: "ensureSchema" } as const;
    try {
      if (await this.hasCurrentSchema()) return;
      const statements = [
        "CREATE CONSTRAINT lexical_document_storage_id IF NOT EXISTS FOR (n:LexicalDocument) REQUIRE n.storageId IS UNIQUE",
        "CREATE CONSTRAINT lexical_metadata_key IF NOT EXISTS FOR (n:LexicalMetadata) REQUIRE n.key IS UNIQUE",
        "CREATE CONSTRAINT lexical_generation_stats_id IF NOT EXISTS FOR (n:LexicalWorkspaceStats) REQUIRE n.id IS UNIQUE",
        "CREATE INDEX lexical_generation_stats_scope IF NOT EXISTS FOR (n:LexicalWorkspaceStats) ON (n.workspaceId, n.generation)",
        "CREATE CONSTRAINT lexical_generation_batch_id IF NOT EXISTS FOR (n:LexicalGenerationBatch) REQUIRE n.id IS UNIQUE",
        "CREATE INDEX lexical_document_workspace IF NOT EXISTS FOR (n:LexicalDocument) ON (n.workspaceId)",
        "CREATE INDEX lexical_document_generation IF NOT EXISTS FOR (n:LexicalDocument) ON (n.generation)",
        "CREATE INDEX lexical_document_logical_id IF NOT EXISTS FOR (n:LexicalDocument) ON (n.documentId)",
        "CREATE INDEX lexical_document_repo IF NOT EXISTS FOR (n:LexicalDocument) ON (n.repoId)",
        "CREATE INDEX lexical_document_file IF NOT EXISTS FOR (n:LexicalDocument) ON (n.fileId)",
        "CREATE INDEX lexical_document_batch IF NOT EXISTS FOR (n:LexicalDocument) ON (n.batchId)",
        "CREATE INDEX lexical_document_active IF NOT EXISTS FOR (n:LexicalDocument) ON (n.active)"
      ];
      for (const statement of statements) await this.db.query(statement);
      await this.ensureSingleWorkspaceIndex();

      await withTransaction(this.db, async () => {
        await this.db.query(
          "MERGE (m:LexicalMetadata {key: $key}) ON CREATE SET m.value = $value",
          { key: PROJECTION_METADATA_KEY, value: LEXICAL_PROJECTION_SCHEMA_VERSION }
        );
        await this.db.query(
          "MERGE (m:LexicalMetadata {key: $key}) ON CREATE SET m.value = $value",
          { key: TOKENIZER_METADATA_KEY, value: TOKENIZER_VERSION }
        );
        await this.db.query(
          "MERGE (m:LexicalMetadata {key: $key}) ON CREATE SET m.value = $value",
          { key: STATS_METADATA_KEY, value: NEO4J_LEXICAL_STATS_SCHEMA_VERSION }
        );
      });
    } catch (error) {
      throw wrap("schema_failed", context, error);
    }
  }

  async commitVersions(): Promise<void> {
    const context = { operation: "commitVersions" } as const;
    try {
      await withTransaction(this.db, async () => {
        await this.db.query(
          "MERGE (m:LexicalMetadata {key: $key}) SET m.value = $value",
          { key: PROJECTION_METADATA_KEY, value: LEXICAL_PROJECTION_SCHEMA_VERSION }
        );
        await this.db.query(
          "MERGE (m:LexicalMetadata {key: $key}) SET m.value = $value",
          { key: TOKENIZER_METADATA_KEY, value: TOKENIZER_VERSION }
        );
      });
    } catch (error) {
      throw wrap("write_failed", context, error);
    }
  }

  async initializeGeneration(request: Readonly<InitializeLexicalGenerationRequest>): Promise<void> {
    const context = {
      operation: "initializeGeneration",
      workspaceId: request.workspaceId,
      generation: request.generation
    } as const;
    try {
      validateGenerationRequest(request);
      await withTransaction(this.db, async () => {
        await this.assertGenerationNotActive(request, { allowReservedPending: true });
        await this.deleteGenerationRows(request);
      });
      await this.replaceGenerationStats(
        request.workspaceId,
        request.generation,
        request.generation,
        0,
        0
      );
    } catch (error) {
      throw wrap("write_failed", context, error);
    }
  }

  async deleteGeneration(request: Readonly<LexicalGenerationRequest>): Promise<void> {
    const context = {
      operation: "deleteGeneration",
      workspaceId: request.workspaceId,
      generation: request.generation
    } as const;
    try {
      validateGenerationRequest(request);
      await withTransaction(this.db, async () => {
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
      await withTransaction(this.db, async () => {
        const rows = await this.db.query<{ documentCount: number; indexSizeBytes: number | null }>(
          "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId " +
          "AND n.generation = $generation AND n.documentId IN $documentIds AND n.active = true " +
          "RETURN count(n) AS documentCount, coalesce(sum(n.ftsSizeBytes), 0) AS indexSizeBytes",
          { workspaceId: request.workspaceId, generation: request.generation, documentIds }
        );
        await this.db.query(
          "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId " +
          "AND n.generation = $generation AND n.documentId IN $documentIds DELETE n",
          { workspaceId: request.workspaceId, generation: request.generation, documentIds }
        );
        await this.adjustGenerationStats(
          request.workspaceId,
          request.generation,
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
        throw new TypeError("Incremental lexical mutation must advance to a distinct revision.");
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
      let documentCountDelta = 0;
      let indexSizeBytesDelta = 0;
      if (activeUpserts.length > 0 || deleteDocumentIds.length > 0) {
        const stored = activeUpserts.map((document) => storedDocument(document, request.generation));
        const deleteStorageIds = deleteDocumentIds.map((documentId) =>
          storageId(request.workspaceId, request.generation, documentId));
        const affectedStorageIds = [...new Set([
          ...deleteStorageIds,
          ...stored.map((document) => document.storageId)
        ])].sort(compareText);
        const existingRows = await this.db.query<ExistingDocumentRow>(
          "MATCH (n:LexicalDocument) WHERE n.storageId IN $storageIds " +
          "RETURN n.storageId AS storageId, n.workspaceId AS workspaceId, " +
          "n.active AS active, n.ftsSizeBytes AS ftsSizeBytes",
          { storageIds: affectedStorageIds }
        );
        const existing = new Map(existingRows.map((row) => [row.storageId, row]));
        for (const row of existingRows) {
          if (row.workspaceId !== request.workspaceId) {
            throw new TypeError(`Lexical physical document belongs to a different workspace: ${row.storageId}.`);
          }
        }

        for (const physicalId of deleteStorageIds) {
          const previous = existing.get(physicalId);
          if (!previous?.active) continue;
          documentCountDelta -= 1;
          indexSizeBytesDelta -= numeric(previous.ftsSizeBytes);
        }
        for (const item of stored) {
          const previous = existing.get(item.storageId);
          documentCountDelta += 1 - Number(previous?.active ?? false);
          indexSizeBytesDelta += payloadSize(item.document)
            - (previous?.active ? numeric(previous.ftsSizeBytes) : 0);
        }

        if (deleteStorageIds.length > 0) {
          await this.db.query(
            "MATCH (n:LexicalDocument) WHERE n.storageId IN $storageIds DELETE n",
            { storageIds: deleteStorageIds }
          );
        }
        await this.writeStoredDocuments(stored);
      }
      await this.applyExactStatsDelta(
        request.workspaceId,
        request.generation,
        request.expectedRevision,
        request.nextRevision,
        documentCountDelta,
        indexSizeBytesDelta
      );
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
      const unique = validateDocuments(documents);
      if (unique[0]?.workspaceId !== request.workspaceId) {
        throw new TypeError("Lexical upsert workspace does not match its generation request.");
      }
      const stored = unique.map((document) => storedDocument(document, request.generation));
      const existingRows = await this.db.query<ExistingDocumentRow>(
        "MATCH (n:LexicalDocument) WHERE n.storageId IN $storageIds " +
        "RETURN n.storageId AS storageId, n.workspaceId AS workspaceId, " +
        "n.active AS active, n.ftsSizeBytes AS ftsSizeBytes",
        { storageIds: stored.map((item) => item.storageId) }
      );
      const existing = new Map(existingRows.map((row) => [row.storageId, row]));
      let documentCountDelta = 0;
      let indexSizeBytesDelta = 0;
      for (const item of stored) {
        const { document } = item;
        const previous = existing.get(item.storageId);
        if (previous && previous.workspaceId !== document.workspaceId) {
          throw new TypeError(`Document id cannot move between workspaces: ${document.id}.`);
        }
        documentCountDelta += Number(document.active) - Number(previous?.active ?? false);
        indexSizeBytesDelta += (document.active ? payloadSize(document) : 0)
          - (previous?.active ? numeric(previous.ftsSizeBytes) : 0);
      }
      await this.writeStoredDocuments(stored);
      await this.adjustGenerationStats(
        request.workspaceId,
        request.generation,
        request.generation,
        documentCountDelta,
        indexSizeBytesDelta
      );
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
      await withTransaction(this.db, async () => {
        const rows = await this.db.query<{ documentCount: number; indexSizeBytes: number | null }>(
          "MATCH (n:LexicalDocument) " +
          "WHERE n.workspaceId = $workspaceId AND n.generation = $generation " +
          "AND n.repoId = $repoId AND n.active = true " +
          "AND NOT n.documentId IN $activeDocumentIds " +
          "WITH collect(n) AS stale, count(n) AS documentCount, coalesce(sum(n.ftsSizeBytes), 0) AS indexSizeBytes " +
          "FOREACH (n IN stale | SET n.active = false) " +
          "RETURN documentCount, indexSizeBytes",
          {
            workspaceId: request.workspaceId,
            generation: request.generation,
            repoId: request.repoId,
            activeDocumentIds
          }
        );
        await this.adjustGenerationStats(
          request.workspaceId,
          request.generation,
          request.generation,
          -numeric(rows[0]?.documentCount),
          -numeric(rows[0]?.indexSizeBytes)
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
      await withTransaction(this.db, async () => {
        const rows = await this.db.query<{ documentCount: number; indexSizeBytes: number | null }>(
          "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.active = true AND n.fileId IS NOT NULL AND NOT (n.fileId IN $activeFileIds) WITH collect(n) AS stale, count(n) AS documentCount, coalesce(sum(n.ftsSizeBytes), 0) AS indexSizeBytes FOREACH (n IN stale | SET n.active = false, n.batchId = $batchId) RETURN documentCount, indexSizeBytes",
          { workspaceId: request.workspaceId, generation: request.generation, repoId: request.repoId, batchId: request.batchId, activeFileIds }
        );
        await this.adjustGenerationStats(request.workspaceId, request.generation, request.generation, -numeric(rows[0]?.documentCount), -numeric(rows[0]?.indexSizeBytes));
      });
    } catch (error) { throw wrap("reconcile_failed", context, error); }
  }

  async stageBatch(request: Readonly<StageLexicalBatchRequest>): Promise<void> {
    validateGenerationRequest(request);
    await withTransaction(this.db, async () => {
      await this.db.query(
        "MERGE (b:LexicalGenerationBatch {id: $id}) " +
        "SET b.workspaceId = $workspaceId, b.generation = $generation, b.batchId = $batchId",
        {
          id: batchMarkerId(request.workspaceId, request.batchId),
          workspaceId: request.workspaceId,
          generation: request.generation,
          batchId: request.batchId
        }
      );
    });
  }

  async commitBatch(request: Readonly<CleanupBatchRequest>): Promise<void> {
    await withTransaction(this.db, async () => {
      await this.db.query(
        "MATCH (b:LexicalGenerationBatch) " +
        "WHERE b.workspaceId = $workspaceId AND b.batchId = $batchId DELETE b",
        request
      );
    });
  }

  async replaceSourceDocuments(request: Readonly<ReplaceSourceDocumentsRequest>): Promise<void> {
    const context = { operation: "replaceSourceDocuments", workspaceId: request.workspaceId, generation: request.generation, repoId: request.repoId, batchId: request.batchId } as const;
    try {
      validateBoundary(request.generation, "generation");
      const touchedFileIds = uniqueStrings(request.touchedFileIds, "touchedFileIds");
      const activeDocumentIds = uniqueStrings(request.activeDocumentIds, "activeDocumentIds");
      if (touchedFileIds.length === 0) return;
      await withTransaction(this.db, async () => {
        const rows = await this.db.query<{ documentCount: number; indexSizeBytes: number | null }>(
          "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.active = true AND n.fileId IN $touchedFileIds AND NOT (n.documentId IN $activeDocumentIds) WITH collect(n) AS stale, count(n) AS documentCount, coalesce(sum(n.ftsSizeBytes), 0) AS indexSizeBytes FOREACH (n IN stale | SET n.active = false, n.batchId = $batchId) RETURN documentCount, indexSizeBytes",
          { workspaceId: request.workspaceId, generation: request.generation, repoId: request.repoId, touchedFileIds, activeDocumentIds, batchId: request.batchId }
        );
        await this.adjustGenerationStats(request.workspaceId, request.generation, request.generation, -numeric(rows[0]?.documentCount), -numeric(rows[0]?.indexSizeBytes));
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
      await withTransaction(this.db, async () => {
        await this.db.query(
          "MATCH (b:LexicalGenerationBatch) " +
          "WHERE b.workspaceId = $workspaceId AND b.batchId = $batchId DELETE b",
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
    const context = { operation: "search", workspaceId: query.workspaceId, generation: query.generation } as const;
    try {
      validateBoundary(query.workspaceId, "workspaceId");
      validateBoundary(query.generation, "generation");
      if (!Number.isSafeInteger(options.topK) || options.topK <= 0) {
        throw new TypeError("topK must be a positive safe integer.");
      }
      const normalizedQuery = normalizeNeo4jFullTextQuery(query.text);
      if (!normalizedQuery) return [];
      const rows = await this.db.query<{
        canonicalId: string;
        documentId: string;
        repoId: string;
        kind: string;
        renderRef: string;
        score: number;
      }>(
        "CALL db.index.fulltext.queryNodes($indexName, $text) YIELD node, score " +
        "WHERE node.workspaceId = $workspaceId AND node.generation = $generation AND node.active = true " +
        "RETURN node.canonicalId AS canonicalId, node.documentId AS documentId, node.repoId AS repoId, " +
        "node.kind AS kind, node.renderRef AS renderRef, score " +
        "ORDER BY score DESC, documentId ASC LIMIT toInteger($topK)",
        {
          indexName: this.indexName,
          text: normalizedQuery,
          workspaceId: query.workspaceId,
          generation: query.generation,
          topK: options.topK
        }
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
    const context = { operation: "loadDocuments", workspaceId: request.workspaceId, generation: request.generation } as const;
    try {
      validateBoundary(request.workspaceId, "workspaceId");
      validateBoundary(request.generation, "generation");
      const documentIds = uniqueStrings(request.documentIds, "documentIds");
      if (documentIds.length === 0) return [];
      const rows = await this.db.query<DocumentRow>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId " +
        "AND n.generation = $generation AND n.documentId IN $documentIds " +
        documentReturnClause() + " ORDER BY n.documentId",
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
        "RETURN n.documentId AS documentId ORDER BY n.documentId",
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

  private async generationHealth(
    request: Readonly<LexicalGenerationRequest>,
    operation: "health" | "pendingHealth"
  ): Promise<LexicalIndexHealth> {
    const { workspaceId, generation } = request;
    const context = { operation, workspaceId, generation } as const;
    try {
      validateBoundary(workspaceId, "workspaceId");
      validateBoundary(generation, "generation");
      const reasons: string[] = [];
      const versionRows = await this.db.query<{ version: string }>(
        "CALL dbms.components() YIELD versions RETURN versions[0] AS version"
      );
      const providerVersion = String(versionRows[0]?.version ?? "unknown");
      if (!isCompatibleVersion(providerVersion)) {
        reasons.push(providerVersion === "unknown" ? "provider_version_unknown" : "provider_version_incompatible");
      }

      const indexes = await this.indexRows();
      const target = indexes.find((index) => index.name === this.indexName);
      if (!target) reasons.push("fts_index_missing");
      if (target && target.type !== "FULLTEXT") reasons.push("fts_index_type_mismatch");
      if (target && (!sameStrings(target.labelsOrTypes, ["LexicalDocument"]) || !sameStrings(target.properties, ["ftsText"]))) {
        reasons.push("fts_index_definition_mismatch");
      }
      if (target && !hasExpectedAnalyzer(target)) reasons.push("fts_index_analyzer_mismatch");
      if (target && !hasSynchronousUpdates(target)) reasons.push("fts_index_consistency_mismatch");
      if (target?.state === "POPULATING") reasons.push("fts_index_populating");
      else if (target?.state === "FAILED") reasons.push("fts_index_failed");
      else if (target && target.state !== "ONLINE") reasons.push("fts_index_not_online");
      if (indexes.some((index) => index.type === "FULLTEXT" && index.name !== this.indexName
        && index.labelsOrTypes.includes("LexicalDocument"))) {
        reasons.push("unexpected_additional_fts_index");
      }

      const metadataRows = await this.db.query<{ key: string; value: string }>(
        "MATCH (m:LexicalMetadata) RETURN m.key AS key, m.value AS value ORDER BY key"
      );
      const metadata = new Map(metadataRows.map((row) => [row.key, row.value]));
      const projectionSchemaVersion = metadata.get(PROJECTION_METADATA_KEY) ?? "missing";
      const tokenizerVersion = metadata.get(TOKENIZER_METADATA_KEY) ?? "missing";
      if (projectionSchemaVersion !== LEXICAL_PROJECTION_SCHEMA_VERSION) reasons.push("projection_schema_version_mismatch");
      if (tokenizerVersion !== TOKENIZER_VERSION) reasons.push("tokenizer_version_mismatch");
      if (metadata.get(STATS_METADATA_KEY) !== NEO4J_LEXICAL_STATS_SCHEMA_VERSION) {
        reasons.push("lexical_stats_version_mismatch");
      }

      const revision = await this.resolveHealthRevision(request, operation);
      const statsRows = await this.db.query<{
        workspaceId: string;
        generation: string;
        revision: string;
        documentCount: number;
        indexSizeBytes: number;
      }>(
        "MATCH (s:LexicalWorkspaceStats {id: $id}) " +
        "RETURN s.workspaceId AS workspaceId, s.generation AS generation, s.revision AS revision, " +
        "s.documentCount AS documentCount, s.indexSizeBytes AS indexSizeBytes",
        { id: generationStatsId(workspaceId, generation, revision) }
      );
      const stats = statsRows[0];
      const validStats = stats?.workspaceId === workspaceId && stats.generation === generation
        && stats.revision === revision
        ? stats
        : undefined;
      if (!validStats) {
        reasons.push("lexical_stats_revision_missing");
      }
      return {
        providerVersion,
        projectionSchemaVersion,
        tokenizerVersion,
        status: reasons.length === 0 ? "healthy" : "unhealthy",
        reasons,
        metrics: {
          documentCount: validStats ? numeric(validStats.documentCount) : 0,
          indexSizeBytes: validStats ? numeric(validStats.indexSizeBytes) : 0
        }
      };
    } catch (error) {
      throw wrap("health_check_failed", context, error);
    }
  }

  private async resolveHealthRevision(
    request: Readonly<LexicalGenerationRequest>,
    operation: "health" | "pendingHealth"
  ): Promise<string> {
    if (request.revision) {
      validateBoundary(request.revision, "revision");
      return request.revision;
    }
    if (operation === "pendingHealth") return request.generation;
    const rows = await this.db.query<{ activeGeneration?: GraphValue; activeRevision?: GraphValue }>(
      "MATCH (s:SchemaGenerationState {id: $id}) " +
      "RETURN s.activeGeneration AS activeGeneration, s.activeRevision AS activeRevision",
      { id: `schema-generation-state:${request.workspaceId}` }
    );
    const activeRevision = rows[0]?.activeRevision;
    return rows[0]?.activeGeneration === request.generation
      && typeof activeRevision === "string" && activeRevision.length > 0
      ? activeRevision
      : request.generation;
  }

  private async indexRows(): Promise<IndexRow[]> {
    return this.db.query<IndexRow>(
      "SHOW INDEXES YIELD name, type, state, labelsOrTypes, properties, options, failureMessage " +
      "RETURN name, type, state, labelsOrTypes, properties, options, failureMessage"
    );
  }

  private async ensureSingleWorkspaceIndex(): Promise<void> {
    const indexes = await this.indexRows();
    for (const index of indexes) {
      const invalidTarget = index.name === this.indexName
        && (index.type !== "FULLTEXT" || !sameStrings(index.labelsOrTypes, ["LexicalDocument"])
          || !sameStrings(index.properties, ["ftsText"]) || !hasExpectedAnalyzer(index)
          || !hasSynchronousUpdates(index));
      const additionalLexicalFullText = index.type === "FULLTEXT"
        && index.labelsOrTypes.includes("LexicalDocument") && index.name !== this.indexName;
      if (invalidTarget || additionalLexicalFullText) {
        await this.db.query(`DROP INDEX ${identifier(index.name)} IF EXISTS`);
      }
    }
    const validTarget = indexes.find((index) => index.name === this.indexName
      && index.type === "FULLTEXT" && sameStrings(index.labelsOrTypes, ["LexicalDocument"])
      && sameStrings(index.properties, ["ftsText"]) && hasExpectedAnalyzer(index)
      && hasSynchronousUpdates(index));
    if (!validTarget) {
      await this.db.query(
        `CREATE FULLTEXT INDEX ${identifier(this.indexName)} IF NOT EXISTS ` +
        "FOR (n:LexicalDocument) ON EACH [n.ftsText] " +
        "OPTIONS { indexConfig: { `fulltext.analyzer`: 'standard-no-stop-words', " +
        "`fulltext.eventually_consistent`: false } }"
      );
    }
    if (!validTarget || validTarget.state !== "ONLINE") {
      await this.db.query(
        "CALL db.awaitIndex($indexName, $timeoutSeconds)",
        { indexName: this.indexName, timeoutSeconds: NEO4J_LEXICAL_INDEX_ONLINE_TIMEOUT_SECONDS }
      );
      const ready = (await this.indexRows()).find((index) => index.name === this.indexName);
      if (!ready || ready.type !== "FULLTEXT" || ready.state !== "ONLINE"
        || !sameStrings(ready.labelsOrTypes, ["LexicalDocument"])
        || !sameStrings(ready.properties, ["ftsText"]) || !hasExpectedAnalyzer(ready)
        || !hasSynchronousUpdates(ready)) {
        throw new TypeError("Neo4j workspace full-text index did not become synchronously queryable.");
      }
    }
  }

  private async metadataValue(key: string): Promise<string | undefined> {
    const rows = await this.db.query<{ value: string }>(
      "MATCH (m:LexicalMetadata {key: $key}) RETURN m.value AS value",
      { key }
    );
    return rows[0]?.value;
  }

  private async adjustGenerationStats(
    workspaceId: string,
    generation: string,
    revision: string,
    documentCountDelta: number,
    indexSizeBytesDelta: number
  ): Promise<void> {
    await this.db.query(
      "MERGE (s:LexicalWorkspaceStats {id: $id}) " +
      "ON CREATE SET s.workspaceId = $workspaceId, s.generation = $generation, s.revision = $revision, " +
      "s.documentCount = 0, s.indexSizeBytes = 0 " +
      "SET s.documentCount = s.documentCount + $documentCountDelta, " +
      "s.indexSizeBytes = s.indexSizeBytes + $indexSizeBytesDelta",
      {
        id: generationStatsId(workspaceId, generation, revision),
        workspaceId,
        generation,
        revision,
        documentCountDelta,
        indexSizeBytesDelta
      }
    );
  }

  /** Current clean-cut schemas never run row backfills during ordinary startup. */
  private async hasCurrentSchema(): Promise<boolean> {
    const [projectionVersion, tokenizerVersion, statsVersion] = await Promise.all([
      this.metadataValue(PROJECTION_METADATA_KEY),
      this.metadataValue(TOKENIZER_METADATA_KEY),
      this.metadataValue(STATS_METADATA_KEY)
    ]);
    if (projectionVersion !== LEXICAL_PROJECTION_SCHEMA_VERSION
      || tokenizerVersion !== TOKENIZER_VERSION
      || statsVersion !== NEO4J_LEXICAL_STATS_SCHEMA_VERSION) return false;
    const lexicalIndexes = (await this.indexRows()).filter((index) =>
      index.type === "FULLTEXT" && index.labelsOrTypes.includes("LexicalDocument")
    );
    return lexicalIndexes.length === 1
      && lexicalIndexes[0]?.name === this.indexName
      && lexicalIndexes[0].state === "ONLINE"
      && sameStrings(lexicalIndexes[0].properties, ["ftsText"])
      && hasExpectedAnalyzer(lexicalIndexes[0])
      && hasSynchronousUpdates(lexicalIndexes[0]);
  }

  private async applyExactStatsDelta(
    workspaceId: string,
    generation: string,
    expectedRevision: string,
    nextRevision: string,
    documentCountDelta: number,
    indexSizeBytesDelta: number
  ): Promise<void> {
    const rows = await this.db.query<{
      workspaceId: string;
      generation: string;
      revision: string;
      documentCount: number | bigint;
      indexSizeBytes: number | bigint;
    }>(
      "MATCH (s:LexicalWorkspaceStats {id: $id}) " +
      "RETURN s.workspaceId AS workspaceId, s.generation AS generation, s.revision AS revision, " +
      "s.documentCount AS documentCount, s.indexSizeBytes AS indexSizeBytes",
      { id: generationStatsId(workspaceId, generation, expectedRevision) }
    );
    const current = rows[0];
    if (!current || current.workspaceId !== workspaceId || current.generation !== generation
      || current.revision !== expectedRevision) {
      throw new TypeError(
        `Missing lexical statistics for generation ${generation} at revision ${expectedRevision}.`
      );
    }
    const documentCount = numeric(current.documentCount) + documentCountDelta;
    const indexSizeBytes = numeric(current.indexSizeBytes) + indexSizeBytesDelta;
    if (!Number.isSafeInteger(documentCount) || documentCount < 0
      || !Number.isSafeInteger(indexSizeBytes) || indexSizeBytes < 0) {
      throw new TypeError(`Incremental lexical statistics underflow for generation ${generation}.`);
    }
    const nextId = generationStatsId(workspaceId, generation, nextRevision);
    const existingNext = await this.db.query<{ id: string }>(
      "MATCH (s:LexicalWorkspaceStats {id: $id}) RETURN s.id AS id",
      { id: nextId }
    );
    if (existingNext.length > 0) {
      throw new Error(`Lexical statistics revision ${nextRevision} already exists.`);
    }
    await this.db.query(
      "CREATE (:LexicalWorkspaceStats {id: $id, workspaceId: $workspaceId, generation: $generation, " +
      "revision: $revision, documentCount: $documentCount, indexSizeBytes: $indexSizeBytes})",
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
      "MERGE (s:LexicalWorkspaceStats {id: $id}) " +
      "SET s.workspaceId = $workspaceId, s.generation = $generation, s.revision = $revision, " +
      "s.documentCount = $documentCount, s.indexSizeBytes = $indexSizeBytes",
      {
        id: generationStatsId(workspaceId, generation, revision),
        workspaceId,
        generation,
        revision,
        documentCount,
        indexSizeBytes
      }
    );
  }

  private async deleteGenerationRows(request: Readonly<LexicalGenerationRequest>): Promise<void> {
    const generation = { workspaceId: request.workspaceId, generation: request.generation };
    await this.db.query(
      "MATCH (b:LexicalGenerationBatch) " +
      "WHERE b.workspaceId = $workspaceId AND b.generation = $generation DELETE b",
      generation
    );
    await this.db.query(
      "MATCH (n:LexicalDocument) " +
      "WHERE n.workspaceId = $workspaceId AND n.generation = $generation DELETE n",
      generation
    );
    await this.db.query(
      "MATCH (s:LexicalWorkspaceStats) " +
      "WHERE s.workspaceId = $workspaceId AND s.generation = $generation DELETE s",
      generation
    );
  }

  private async assertGenerationNotActive(
    request: Readonly<LexicalGenerationRequest>,
    options: { allowReservedPending?: boolean } = {}
  ): Promise<void> {
    const rows = await this.db.query<{ activeGeneration?: GraphValue; pendingGeneration?: GraphValue }>(
      "MATCH (s:SchemaGenerationState {id: $id}) SET s.protocolNonce=$nonce RETURN s.activeGeneration AS activeGeneration, s.pendingGeneration AS pendingGeneration",
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

  private async writeStoredDocuments(documents: readonly StoredDocument[]): Promise<void> {
    for (let offset = 0; offset < documents.length; offset += NEO4J_LEXICAL_UPSERT_CHUNK_SIZE) {
      const rows = documents
        .slice(offset, offset + NEO4J_LEXICAL_UPSERT_CHUNK_SIZE)
        .map(storedDocumentParameters);
      const written = await this.db.query<{ written: number }>(
        "UNWIND $documents AS document " +
        "MERGE (n:LexicalDocument {storageId: document.storageId}) " +
        "ON CREATE SET n.workspaceId = document.workspaceId, n.generation = document.generation " +
        "WITH n, document WHERE n.workspaceId = document.workspaceId AND n.generation = document.generation " +
        "SET n.documentId = document.documentId, n.canonicalId = document.canonicalId, " +
        "n.repoId = document.repoId, n.kind = document.kind, n.title = document.title, " +
        "n.qualifiedName = document.qualifiedName, n.path = document.path, " +
        "n.searchableText = document.searchableText, n.tokens = document.tokens, " +
        "n.active = document.active, n.sourceHash = document.sourceHash, " +
        "n.batchId = document.batchId, n.renderRef = document.renderRef, n.fileId = document.fileId, " +
        "n.ftsText = document.ftsText, n.ftsSizeBytes = document.ftsSizeBytes " +
        "RETURN count(n) AS written",
        { documents: rows }
      );
      if (numeric(written[0]?.written) !== rows.length) {
        throw new TypeError("Lexical physical document identity is inconsistent.");
      }
    }
  }
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

function payloadSize(document: LexicalDocument): number {
  return Buffer.byteLength(indexedText(document), "utf8");
}

function documentReturnClause(): string {
  return "RETURN n.storageId AS storageId, n.documentId AS documentId, n.generation AS generation, " +
    "n.canonicalId AS canonicalId, n.workspaceId AS workspaceId, " +
    "n.repoId AS repoId, n.kind AS kind, n.title AS title, n.qualifiedName AS qualifiedName, " +
    "n.path AS path, n.searchableText AS searchableText, n.tokens AS tokens, n.active AS active, " +
    "n.sourceHash AS sourceHash, n.batchId AS batchId, n.renderRef AS renderRef, " +
    "n.ftsText AS ftsText, n.ftsSizeBytes AS ftsSizeBytes";
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
    tokens: [...row.tokens],
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

function numeric(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`Invalid lexical statistics value: ${String(value)}.`);
  }
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identifier(value: string): string {
  return `\`${value.replace(/`/gu, "``")}\``;
}

function isCompatibleVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/u.exec(version);
  return !!match && Number(match[1]) >= 5;
}

function hasSynchronousUpdates(index: Readonly<IndexRow>): boolean {
  return index.options?.indexConfig?.[EVENTUALLY_CONSISTENT_CONFIG_KEY] === false;
}

function hasExpectedAnalyzer(index: Readonly<IndexRow>): boolean {
  return index.options?.indexConfig?.[ANALYZER_CONFIG_KEY] === NEO4J_LEXICAL_ANALYZER;
}

/**
 * Converts user text to one deterministic token that cannot be interpreted as
 * Lucene syntax. Projection-generated ident_* and cjk_* tokens are preferred
 * so paths, contracts, identifiers, and mixed-language queries stay symmetric.
 */
export function normalizeNeo4jFullTextQuery(text: string): string {
  const tokens = tokenizeLexicalText(text).filter((token) => SAFE_LUCENE_TOKEN.test(token));
  if (tokens.length === 0) return "";

  if (/[._/\\-]/u.test(text)) {
    const repositoryRelativePath = repositoryRelativePathToken(text);
    if (repositoryRelativePath) return repositoryRelativePath;
    const identifier = tokens
      .filter((token) => token.startsWith("ident_"))
      .sort((left, right) => right.length - left.length || compareText(left, right))[0];
    if (identifier) return identifier;
  }

  const latinToken = tokens
    .filter((token) => !token.startsWith("cjk_") && LATIN_QUERY_TOKEN.test(token)
      && !NEO4J_QUERY_STOP_WORDS.has(token))
    .sort((left, right) => right.length - left.length || compareText(left, right))[0];
  if (latinToken) return latinToken;

  for (const run of text.normalize("NFKC").match(/[\p{Script=Han}]+/gu) ?? []) {
    const characters = Array.from(run);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      const token = characters[index]! + characters[index + 1]!;
      if (Array.from(token).every((character) => !NEO4J_CJK_QUERY_STOP_CHARACTERS.has(character))) {
        return `cjk_${token}`;
      }
    }
  }

  return tokens[0] ?? "";
}

function repositoryRelativePathToken(text: string): string | undefined {
  const path = QUERY_PATH_PATTERN.exec(text.normalize("NFKC").replace(/\\/gu, "/"))?.[0];
  if (!path) return undefined;
  const segments = path.split("/").filter(Boolean);
  const rootIndex = segments.findIndex((segment) => REPOSITORY_PATH_ROOTS.has(segment.toLowerCase()));
  if (rootIndex <= 0) return undefined;
  return `ident_${segments.slice(rootIndex).join("_").replace(/[^\p{L}\p{M}\p{N}]+/gu, "_").toLowerCase()}`;
}

function wrap(
  code: WorkspaceLexicalStoreErrorCode,
  context: WorkspaceLexicalStoreErrorContext,
  cause: unknown
): WorkspaceLexicalStoreError {
  if (cause instanceof WorkspaceLexicalStoreError) return cause;
  return new WorkspaceLexicalStoreError(code, context, { cause });
}
