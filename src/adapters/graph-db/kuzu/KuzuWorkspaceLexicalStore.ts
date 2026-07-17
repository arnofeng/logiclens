import {
  WorkspaceLexicalStoreError,
  type CleanupBatchRequest,
  type LoadDocumentsRequest,
  type ReconcileRepoDocumentsRequest,
  type WorkspaceLexicalStore,
  type WorkspaceLexicalStoreErrorCode,
  type WorkspaceLexicalStoreErrorContext
} from "../../../core/retrieval/provider.js";
import { tokenizeLexicalText } from "../../../core/retrieval/tokenizer.js";
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
import { KuzuGraphDB } from "./KuzuGraphDB.js";

export const KUZU_LEXICAL_DOCUMENT_TABLE = "LexicalDocument";
export const KUZU_LEXICAL_METADATA_TABLE = "LexicalMetadata";
export const KUZU_LEXICAL_STATS_TABLE = "LexicalWorkspaceStats";
export const KUZU_WORKSPACE_FTS_INDEX = "workspace_lexical";
export const KUZU_MINIMUM_FTS_VERSION = "0.11.3";
export const KUZU_MAXIMUM_FTS_VERSION_EXCLUSIVE = "0.12.0";
export const KUZU_LEXICAL_STATS_SCHEMA_VERSION = "1";

const PROJECTION_METADATA_KEY = "projectionSchemaVersion";
const TOKENIZER_METADATA_KEY = "tokenizerVersion";
const STATS_METADATA_KEY = "lexicalStatsSchemaVersion";
const INCOMPLETE_STATS_METADATA_VALUE = "incomplete";
const EXPECTED_FTS_PROPERTIES = ["ftsText"] as const;
const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "declared", "defined", "does", "find", "for", "http", "is", "of",
  "on", "or", "owns", "service", "serves", "the", "to", "what", "where", "which", "who", "with"
]);

const DOCUMENT_COLUMNS = [
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
  ["ftsText", "STRING"],
  ["ftsSizeBytes", "INT64"]
] as const;

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
  workspaceId: string;
  documentCount: number | bigint;
  indexSizeBytes: number | bigint;
};
type ExistingDocumentStateRow = {
  id: string;
  workspaceId: string;
  active: boolean;
  ftsSizeBytes: number | bigint | null;
};
type DeactivationStatsRow = {
  documentCount: number | bigint;
  indexSizeBytes: number | bigint | null;
};
type DocumentRow = {
  id: string;
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

export class KuzuWorkspaceLexicalStore implements WorkspaceLexicalStore {
  constructor(readonly db: KuzuGraphDB) {}

  async ensureSchema(): Promise<void> {
    const context = { operation: "ensureSchema" } as const;
    try {
      await this.db.query("LOAD EXTENSION FTS;");
      const tables = await this.tableNames();
      if (!tables.has(KUZU_LEXICAL_DOCUMENT_TABLE)) {
        await this.db.query(
          "CREATE NODE TABLE LexicalDocument(" +
          "id STRING, canonicalId STRING, workspaceId STRING, repoId STRING, kind STRING, " +
          "title STRING, qualifiedName STRING, path STRING, searchableText STRING, tokens STRING[], " +
          "active BOOL, sourceHash STRING, batchId STRING, renderRef STRING, ftsText STRING, " +
          "ftsSizeBytes INT64, PRIMARY KEY(id));"
        );
      } else {
        await this.ensureDocumentColumns();
        await this.db.query(
          "MATCH (n:LexicalDocument) WHERE n.ftsText IS NULL SET n.ftsText = n.searchableText;"
        );
      }

      if (!tables.has(KUZU_LEXICAL_METADATA_TABLE)) {
        await this.db.query(
          "CREATE NODE TABLE LexicalMetadata(key STRING, value STRING, PRIMARY KEY(key));"
        );
      }
      if (!tables.has(KUZU_LEXICAL_STATS_TABLE)) {
        // DDL is not atomic with the data rebuild. Invalidate a surviving
        // marker first so a crash after table creation remains retryable.
        await this.markStatsIncomplete();
        // Kuzu 0.11.x exposes index definitions but no physical FTS size.
        // Persist the exact UTF-8 byte size of indexed payloads so health is
        // O(1), deterministic, and does not mislabel total database storage.
        await this.db.query(
          "CREATE NODE TABLE LexicalWorkspaceStats(" +
          "workspaceId STRING, documentCount INT64, indexSizeBytes INT64, PRIMARY KEY(workspaceId));"
        );
      }

      // This is deliberately checked on every initialization. ALTER TABLE can
      // commit before an interrupted backfill transaction, so column presence
      // alone is not evidence that every legacy document has been migrated.
      await this.migrateFtsSizes();
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
      });
      const statsVersion = await this.metadataValue(STATS_METADATA_KEY);
      if (statsVersion !== KUZU_LEXICAL_STATS_SCHEMA_VERSION) {
        await this.rebuildAllWorkspaceStats();
      }
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

  async upsertDocuments(documents: readonly LexicalDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const context: WorkspaceLexicalStoreErrorContext = {
      operation: "upsertDocuments",
      workspaceId: documents[0]?.workspaceId,
      batchId: documents[0]?.batchId
    };
    try {
      const unique = validateDocuments(documents);
      await this.db.transaction(async () => {
        const existingRows = await this.db.query<ExistingDocumentStateRow>(
          "MATCH (n:LexicalDocument) WHERE n.id IN $documentIds " +
          "RETURN n.id AS id, n.workspaceId AS workspaceId, n.active AS active, n.ftsSizeBytes AS ftsSizeBytes;",
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
          const previousCount = previous?.active ? 1 : 0;
          const previousBytes = previous?.active ? numeric(previous.ftsSizeBytes) : 0;
          const nextBytes = document.active ? ftsSizeBytes(document) : 0;
          documentCountDelta += (document.active ? 1 : 0) - previousCount;
          indexSizeBytesDelta += nextBytes - previousBytes;
          await this.db.query(
            "MERGE (n:LexicalDocument {id: $id}) " +
            "SET n.canonicalId = $canonicalId, n.workspaceId = $workspaceId, n.repoId = $repoId, " +
            "n.kind = $kind, n.title = $title, n.qualifiedName = $qualifiedName, n.path = $path, " +
            "n.searchableText = $searchableText, n.tokens = $tokens, n.active = $active, " +
            "n.sourceHash = $sourceHash, n.batchId = $batchId, n.renderRef = $renderRef, " +
            "n.ftsText = $ftsText, n.ftsSizeBytes = $ftsSizeBytes;",
            documentParameters(document)
          );
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
      const idPredicate = activeDocumentIds.length === 0 ? "" : " AND NOT (n.id IN $activeDocumentIds)";
      const params: Record<string, GraphValue> = {
        workspaceId: request.workspaceId,
        repoId: request.repoId
      };
      if (activeDocumentIds.length > 0) params.activeDocumentIds = activeDocumentIds;
      await this.db.transaction(async () => {
        const deactivated = await this.db.query<DeactivationStatsRow>(
          "MATCH (n:LexicalDocument) " +
          `WHERE n.workspaceId = $workspaceId AND n.repoId = $repoId AND n.active = true${idPredicate} ` +
          "RETURN count(*) AS documentCount, sum(n.ftsSizeBytes) AS indexSizeBytes;",
          params
        );
        await this.db.query(
          "MATCH (n:LexicalDocument) " +
          `WHERE n.workspaceId = $workspaceId AND n.repoId = $repoId${idPredicate} SET n.active = false;`,
          params
        );
        await this.adjustWorkspaceStats(
          request.workspaceId,
          -numeric(deactivated[0]?.documentCount),
          -numeric(deactivated[0]?.indexSizeBytes)
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
      const params = { workspaceId: request.workspaceId, batchId: request.batchId };
      await this.db.transaction(async () => {
        const deactivated = await this.db.query<DeactivationStatsRow>(
          "MATCH (n:LexicalDocument) " +
          "WHERE n.workspaceId = $workspaceId AND n.batchId = $batchId AND n.active = true " +
          "RETURN count(*) AS documentCount, sum(n.ftsSizeBytes) AS indexSizeBytes;",
          params
        );
        await this.db.query(
          "MATCH (n:LexicalDocument) " +
          "WHERE n.workspaceId = $workspaceId AND n.batchId = $batchId SET n.active = false;",
          params
        );
        await this.adjustWorkspaceStats(
          request.workspaceId,
          -numeric(deactivated[0]?.documentCount),
          -numeric(deactivated[0]?.indexSizeBytes)
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
      const ftsQuery = ftsQueryText(query.text);
      if (!ftsQuery) return [];
      const rows = await this.db.query<SearchRow>(
        "CALL QUERY_FTS_INDEX('LexicalDocument', 'workspace_lexical', $text) " +
        "WHERE node.workspaceId = $workspaceId AND node.active = true " +
        "RETURN node.canonicalId AS canonicalId, node.id AS documentId, node.repoId AS repoId, " +
        "node.kind AS kind, node.renderRef AS renderRef, score " +
        "ORDER BY score DESC, documentId ASC LIMIT $topK;",
        { text: ftsQuery, workspaceId: query.workspaceId, topK: options.topK }
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
        documentReturnClause() + " ORDER BY n.id;",
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
        const statsRows = await this.db.query<WorkspaceStatsRow>(
          "MATCH (s:LexicalWorkspaceStats {workspaceId: $workspaceId}) " +
          "RETURN s.workspaceId AS workspaceId, s.documentCount AS documentCount, s.indexSizeBytes AS indexSizeBytes;",
          { workspaceId }
        );
        documentCount = numeric(statsRows[0]?.documentCount);
        indexSizeBytes = numeric(statsRows[0]?.indexSizeBytes);
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

  private async ensureDocumentColumns(): Promise<void> {
    const columns = await this.db.query<ColumnRow>("CALL table_info('LexicalDocument') RETURN name;");
    const existing = new Set(columns.map((column) => column.name));
    for (const [column, type] of DOCUMENT_COLUMNS) {
      if (!existing.has(column)) {
        await this.db.query(`ALTER TABLE LexicalDocument ADD ${column} ${type};`);
      }
    }
  }

  private async migrateFtsSizes(): Promise<void> {
    const rows = await this.db.query<{ id: string; ftsText: string | null }>(
      "MATCH (n:LexicalDocument) WHERE n.ftsSizeBytes IS NULL RETURN n.id AS id, n.ftsText AS ftsText ORDER BY n.id;"
    );
    if (rows.length === 0) return;
    await this.markStatsIncomplete();
    await this.db.transaction(async () => {
      for (const row of rows) {
        await this.db.query(
          "MATCH (n:LexicalDocument {id: $id}) SET n.ftsSizeBytes = $ftsSizeBytes;",
          { id: row.id, ftsSizeBytes: Buffer.byteLength(row.ftsText ?? "", "utf8") }
        );
      }
    });
  }

  private async markStatsIncomplete(): Promise<void> {
    await this.db.query(
      "MERGE (m:LexicalMetadata {key: $key}) SET m.value = $value;",
      { key: STATS_METADATA_KEY, value: INCOMPLETE_STATS_METADATA_VALUE }
    );
  }

  private async rebuildAllWorkspaceStats(): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.query("MATCH (s:LexicalWorkspaceStats) DELETE s;");
      const rows = await this.db.query<WorkspaceStatsRow>(
        "MATCH (n:LexicalDocument) WHERE n.active = true " +
        "RETURN n.workspaceId AS workspaceId, count(*) AS documentCount, " +
        "sum(n.ftsSizeBytes) AS indexSizeBytes ORDER BY workspaceId;"
      );
      for (const row of rows) {
        await this.db.query(
          "CREATE (:LexicalWorkspaceStats {workspaceId: $workspaceId, " +
          "documentCount: $documentCount, indexSizeBytes: $indexSizeBytes});",
          {
            workspaceId: row.workspaceId,
            documentCount: numeric(row.documentCount),
            indexSizeBytes: numeric(row.indexSizeBytes)
          }
        );
      }
      await this.db.query(
        "MERGE (m:LexicalMetadata {key: $key}) SET m.value = $value;",
        { key: STATS_METADATA_KEY, value: KUZU_LEXICAL_STATS_SCHEMA_VERSION }
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
      "s.indexSizeBytes = s.indexSizeBytes + $indexSizeBytesDelta;",
      { workspaceId, documentCountDelta, indexSizeBytesDelta }
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

function ftsSizeBytes(document: LexicalDocument): number {
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
