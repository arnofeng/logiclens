import type { GraphValue } from "../../../core/graph-model/db.js";
import { withTransaction } from "../../../core/graph-model/db.js";
import { tokenizeLexicalText } from "../../../core/retrieval/tokenizer.js";
import {
  WorkspaceLexicalStoreError,
  type CleanupBatchRequest,
  type LoadDocumentsRequest,
  type ReconcileRepoDocumentsRequest,
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
export const NEO4J_LEXICAL_STATS_SCHEMA_VERSION = "1";
export const NEO4J_LEXICAL_UPSERT_CHUNK_SIZE = 500;
export const NEO4J_LEXICAL_INDEX_ONLINE_TIMEOUT_SECONDS = 300;
export const NEO4J_LEXICAL_ANALYZER = "standard-no-stop-words";

const PROJECTION_METADATA_KEY = "projectionSchemaVersion";
const TOKENIZER_METADATA_KEY = "tokenizerVersion";
const STATS_METADATA_KEY = "lexicalStatsSchemaVersion";
const INCOMPLETE_STATS_METADATA_VALUE = "incomplete";
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
  id: string;
  workspaceId: string;
  active: boolean;
  ftsSizeBytes: number | bigint | null;
}

interface DocumentRow extends Omit<LexicalDocument, "qualifiedName" | "path"> {
  qualifiedName: string | null;
  path: string | null;
}

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
      const statements = [
        "CREATE CONSTRAINT lexical_document_id IF NOT EXISTS FOR (n:LexicalDocument) REQUIRE n.id IS UNIQUE",
        "CREATE CONSTRAINT lexical_metadata_key IF NOT EXISTS FOR (n:LexicalMetadata) REQUIRE n.key IS UNIQUE",
        "CREATE CONSTRAINT lexical_workspace_stats_id IF NOT EXISTS FOR (n:LexicalWorkspaceStats) REQUIRE n.workspaceId IS UNIQUE",
        "CREATE INDEX lexical_document_workspace IF NOT EXISTS FOR (n:LexicalDocument) ON (n.workspaceId)",
        "CREATE INDEX lexical_document_repo IF NOT EXISTS FOR (n:LexicalDocument) ON (n.repoId)",
        "CREATE INDEX lexical_document_batch IF NOT EXISTS FOR (n:LexicalDocument) ON (n.batchId)",
        "CREATE INDEX lexical_document_active IF NOT EXISTS FOR (n:LexicalDocument) ON (n.active)"
      ];
      for (const statement of statements) await this.db.query(statement);
      await this.ensureSingleWorkspaceIndex();

      await withTransaction(this.db, async () => {
        // ON CREATE preserves older versions until commitVersions confirms a
        // complete corpus rebuild. Schema readiness alone cannot upgrade them.
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
          { key: STATS_METADATA_KEY, value: INCOMPLETE_STATS_METADATA_VALUE }
        );
      });

      await this.migratePayloadSizes();
      if (await this.metadataValue(STATS_METADATA_KEY) !== NEO4J_LEXICAL_STATS_SCHEMA_VERSION) {
        await this.rebuildWorkspaceStats();
      }
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

  async upsertDocuments(documents: readonly LexicalDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const context: WorkspaceLexicalStoreErrorContext = {
      operation: "upsertDocuments",
      workspaceId: documents[0]?.workspaceId,
      batchId: documents[0]?.batchId
    };
    try {
      const unique = validateDocuments(documents);
      await withTransaction(this.db, async () => {
        const existingRows = await this.db.query<ExistingDocumentRow>(
          "MATCH (n:LexicalDocument) WHERE n.id IN $documentIds " +
          "RETURN n.id AS id, n.workspaceId AS workspaceId, n.active AS active, n.ftsSizeBytes AS ftsSizeBytes",
          { documentIds: unique.map((document) => document.id) }
        );
        const existing = new Map(existingRows.map((row) => [row.id, row]));
        let documentCountDelta = 0;
        let indexSizeBytesDelta = 0;
        for (const document of unique) {
          const previous = existing.get(document.id);
          if (previous && previous.workspaceId !== document.workspaceId) {
            throw new TypeError(`Document id cannot move between workspaces: ${document.id}.`);
          }
          documentCountDelta += Number(document.active) - Number(previous?.active ?? false);
          indexSizeBytesDelta += (document.active ? payloadSize(document) : 0)
            - (previous?.active ? numeric(previous.ftsSizeBytes) : 0);
        }

        for (let offset = 0; offset < unique.length; offset += NEO4J_LEXICAL_UPSERT_CHUNK_SIZE) {
          const rows = unique.slice(offset, offset + NEO4J_LEXICAL_UPSERT_CHUNK_SIZE).map(documentParameters);
          const written = await this.db.query<{ written: number }>(
            "UNWIND $documents AS document " +
            "MERGE (n:LexicalDocument {id: document.id}) " +
            "ON CREATE SET n.workspaceId = document.workspaceId " +
            "WITH n, document WHERE n.workspaceId = document.workspaceId " +
            "SET n.canonicalId = document.canonicalId, n.workspaceId = document.workspaceId, " +
            "n.repoId = document.repoId, n.kind = document.kind, n.title = document.title, " +
            "n.qualifiedName = document.qualifiedName, n.path = document.path, " +
            "n.searchableText = document.searchableText, n.tokens = document.tokens, " +
            "n.active = document.active, n.sourceHash = document.sourceHash, " +
            "n.batchId = document.batchId, n.renderRef = document.renderRef, " +
            "n.ftsText = document.ftsText, n.ftsSizeBytes = document.ftsSizeBytes " +
            "RETURN count(n) AS written",
            { documents: rows }
          );
          if (numeric(written[0]?.written) !== rows.length) {
            throw new TypeError("Document id cannot move between workspaces.");
          }
        }
        await this.adjustWorkspaceStats(unique[0]!.workspaceId, documentCountDelta, indexSizeBytesDelta);
      });
    } catch (error) {
      throw wrap("write_failed", context, error);
    }
  }

  async reconcileRepoDocuments(request: Readonly<ReconcileRepoDocumentsRequest>): Promise<void> {
    const context = {
      operation: "reconcileRepoDocuments",
      workspaceId: request.workspaceId,
      repoId: request.repoId,
      batchId: request.batchId
    } as const;
    try {
      validateBoundary(request.workspaceId, "workspaceId");
      validateBoundary(request.repoId, "repoId");
      validateBoundary(request.batchId, "batchId");
      const activeDocumentIds = uniqueStrings(request.activeDocumentIds, "activeDocumentIds");
      await withTransaction(this.db, async () => {
        const rows = await this.db.query<{ documentCount: number; indexSizeBytes: number | null }>(
          "MATCH (n:LexicalDocument) " +
          "WHERE n.workspaceId = $workspaceId AND n.repoId = $repoId AND n.active = true " +
          "AND NOT n.id IN $activeDocumentIds " +
          "WITH collect(n) AS stale, count(n) AS documentCount, coalesce(sum(n.ftsSizeBytes), 0) AS indexSizeBytes " +
          "FOREACH (n IN stale | SET n.active = false) " +
          "RETURN documentCount, indexSizeBytes",
          { workspaceId: request.workspaceId, repoId: request.repoId, activeDocumentIds }
        );
        await this.adjustWorkspaceStats(
          request.workspaceId,
          -numeric(rows[0]?.documentCount),
          -numeric(rows[0]?.indexSizeBytes)
        );
      });
    } catch (error) {
      throw wrap("reconcile_failed", context, error);
    }
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
        const rows = await this.db.query<{ documentCount: number; indexSizeBytes: number | null }>(
          "MATCH (n:LexicalDocument) " +
          "WHERE n.workspaceId = $workspaceId AND n.batchId = $batchId AND n.active = true " +
          "WITH collect(n) AS failed, count(n) AS documentCount, coalesce(sum(n.ftsSizeBytes), 0) AS indexSizeBytes " +
          "FOREACH (n IN failed | SET n.active = false) " +
          "RETURN documentCount, indexSizeBytes",
          { workspaceId: request.workspaceId, batchId: request.batchId }
        );
        await this.adjustWorkspaceStats(
          request.workspaceId,
          -numeric(rows[0]?.documentCount),
          -numeric(rows[0]?.indexSizeBytes)
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
        "WHERE node.workspaceId = $workspaceId AND node.active = true " +
        "RETURN node.canonicalId AS canonicalId, node.id AS documentId, node.repoId AS repoId, " +
        "node.kind AS kind, node.renderRef AS renderRef, score " +
        "ORDER BY score DESC, documentId ASC LIMIT $topK",
        { indexName: this.indexName, text: normalizedQuery, workspaceId: query.workspaceId, topK: options.topK }
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
      const documentIds = uniqueStrings(request.documentIds, "documentIds");
      if (documentIds.length === 0) return [];
      const rows = await this.db.query<DocumentRow>(
        "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.id IN $documentIds " +
        documentReturnClause() + " ORDER BY n.id",
        { workspaceId: request.workspaceId, documentIds }
      );
      return rows.map(documentFromRow);
    } catch (error) {
      throw wrap("load_failed", context, error);
    }
  }

  async health(workspaceId: string): Promise<LexicalIndexHealth> {
    const context = { operation: "health", workspaceId } as const;
    try {
      validateBoundary(workspaceId, "workspaceId");
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

      const statsRows = await this.db.query<{ documentCount: number; indexSizeBytes: number }>(
        "MATCH (s:LexicalWorkspaceStats {workspaceId: $workspaceId}) " +
        "RETURN s.documentCount AS documentCount, s.indexSizeBytes AS indexSizeBytes",
        { workspaceId }
      );
      return {
        providerVersion,
        projectionSchemaVersion,
        tokenizerVersion,
        status: reasons.length === 0 ? "healthy" : "unhealthy",
        reasons,
        metrics: {
          documentCount: numeric(statsRows[0]?.documentCount),
          indexSizeBytes: numeric(statsRows[0]?.indexSizeBytes)
        }
      };
    } catch (error) {
      throw wrap("health_check_failed", context, error);
    }
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

  private async migratePayloadSizes(): Promise<void> {
    const rows = await this.db.query<{ id: string; ftsText: string | null }>(
      "MATCH (n:LexicalDocument) WHERE n.ftsSizeBytes IS NULL " +
      "RETURN n.id AS id, coalesce(n.ftsText, n.searchableText, '') AS ftsText ORDER BY n.id"
    );
    if (rows.length === 0) return;
    await this.db.query(
      "MERGE (m:LexicalMetadata {key: $key}) SET m.value = $value",
      { key: STATS_METADATA_KEY, value: INCOMPLETE_STATS_METADATA_VALUE }
    );
    await withTransaction(this.db, async () => {
      for (let offset = 0; offset < rows.length; offset += NEO4J_LEXICAL_UPSERT_CHUNK_SIZE) {
        const migrations = rows.slice(offset, offset + NEO4J_LEXICAL_UPSERT_CHUNK_SIZE).map((row) => ({
          id: row.id,
          ftsText: row.ftsText ?? "",
          ftsSizeBytes: Buffer.byteLength(row.ftsText ?? "", "utf8")
        }));
        await this.db.query(
          "UNWIND $documents AS document MATCH (n:LexicalDocument {id: document.id}) " +
          "SET n.ftsText = document.ftsText, n.ftsSizeBytes = document.ftsSizeBytes",
          { documents: migrations }
        );
      }
    });
  }

  private async rebuildWorkspaceStats(): Promise<void> {
    // Neo4j does not expose a stable per-full-text-index physical byte size.
    // Persist the UTF-8 bytes of active ftsText instead: it is deterministic,
    // transactionally maintained with lifecycle changes, rebuildable, and lets
    // health remain O(1) without scanning document bodies.
    await withTransaction(this.db, async () => {
      await this.db.query("MATCH (s:LexicalWorkspaceStats) DELETE s");
      await this.db.query(
        "MATCH (n:LexicalDocument) WHERE n.active = true " +
        "WITH n.workspaceId AS workspaceId, count(n) AS documentCount, " +
        "coalesce(sum(n.ftsSizeBytes), 0) AS indexSizeBytes " +
        "MERGE (s:LexicalWorkspaceStats {workspaceId: workspaceId}) " +
        "SET s.documentCount = documentCount, s.indexSizeBytes = indexSizeBytes"
      );
      await this.db.query(
        "MERGE (m:LexicalMetadata {key: $key}) SET m.value = $value",
        { key: STATS_METADATA_KEY, value: NEO4J_LEXICAL_STATS_SCHEMA_VERSION }
      );
    });
  }

  private async adjustWorkspaceStats(
    workspaceId: string,
    documentCountDelta: number,
    indexSizeBytesDelta: number
  ): Promise<void> {
    await this.db.query(
      "MERGE (s:LexicalWorkspaceStats {workspaceId: $workspaceId}) " +
      "ON CREATE SET s.documentCount = 0, s.indexSizeBytes = 0 " +
      "SET s.documentCount = s.documentCount + $documentCountDelta, " +
      "s.indexSizeBytes = s.indexSizeBytes + $indexSizeBytesDelta",
      { workspaceId, documentCountDelta, indexSizeBytesDelta }
    );
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

function documentParameters(document: LexicalDocument): Record<string, GraphValue> {
  const ftsText = indexedText(document);
  return {
    id: document.id,
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
    ftsText,
    ftsSizeBytes: Buffer.byteLength(ftsText, "utf8")
  };
}

function indexedText(document: LexicalDocument): string {
  return [document.searchableText, ...document.tokens].filter(Boolean).join(" ");
}

function payloadSize(document: LexicalDocument): number {
  return Buffer.byteLength(indexedText(document), "utf8");
}

function documentReturnClause(): string {
  return "RETURN n.id AS id, n.canonicalId AS canonicalId, n.workspaceId AS workspaceId, " +
    "n.repoId AS repoId, n.kind AS kind, n.title AS title, n.qualifiedName AS qualifiedName, " +
    "n.path AS path, n.searchableText AS searchableText, n.tokens AS tokens, n.active AS active, " +
    "n.sourceHash AS sourceHash, n.batchId AS batchId, n.renderRef AS renderRef";
}

function documentFromRow(row: DocumentRow): LexicalDocument {
  return {
    id: row.id,
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
    const identifier = tokens
      .filter((token) => token.startsWith("ident_"))
      .sort((left, right) => right.length - left.length || compareText(left, right))[0];
    if (identifier) return identifier;
  }

  for (const run of text.normalize("NFKC").match(/[\p{Script=Han}]+/gu) ?? []) {
    const characters = Array.from(run);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      const token = characters[index]! + characters[index + 1]!;
      if (Array.from(token).every((character) => !NEO4J_CJK_QUERY_STOP_CHARACTERS.has(character))) {
        return `cjk_${token}`;
      }
    }
  }

  return tokens
    .filter((token) => !token.startsWith("cjk_") && !NEO4J_QUERY_STOP_WORDS.has(token))
    .sort((left, right) => right.length - left.length || compareText(left, right))[0]
    ?? tokens[0]
    ?? "";
}

function wrap(
  code: WorkspaceLexicalStoreErrorCode,
  context: WorkspaceLexicalStoreErrorContext,
  cause: unknown
): WorkspaceLexicalStoreError {
  if (cause instanceof WorkspaceLexicalStoreError) return cause;
  return new WorkspaceLexicalStoreError(code, context, { cause });
}
