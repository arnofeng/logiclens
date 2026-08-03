export const LEXICAL_PROJECTION_SCHEMA_VERSION = "5";
export const TOKENIZER_VERSION = "1";

export const LEXICAL_DOCUMENT_KINDS = ["repo", "file", "code", "section", "contract", "contractSpec", "operation", "workflow", "entity", "package", "evidence"] as const;
export type LexicalDocumentKind = (typeof LEXICAL_DOCUMENT_KINDS)[number];

export interface LexicalDocument {
  id: string;
  canonicalId: string;
  workspaceId: string;
  repoId: string;
  kind: LexicalDocumentKind;
  title: string;
  qualifiedName?: string;
  path?: string;
  searchableText: string;
  tokens: string[];
  active: boolean;
  sourceHash: string;
  batchId: string;
  renderRef: string;
}

export interface LexicalQuery {
  workspaceId: string;
  generation: string;
  text: string;
}

/** A globally ordered workspace hit; rank starts at one. */
export interface LexicalHit {
  canonicalId: string;
  documentId: string;
  repoId: string;
  kind: LexicalDocumentKind;
  rank: number;
  matchReasons: string[];
  renderRef: string;
}

/** topK applies across the complete workspace, never each repository. */
export interface LexicalSearchOptions {
  topK: number;
}

export type LexicalIndexStatus = "healthy" | "unhealthy" | "unavailable";

export interface LexicalIndexMetrics {
  documentCount: number;
  indexSizeBytes: number;
  buildDurationMs?: number;
  queryDurationMs?: number;
}

export interface LexicalIndexHealth {
  providerVersion: string;
  projectionSchemaVersion: string;
  tokenizerVersion: string;
  status: LexicalIndexStatus;
  reasons: string[];
  metrics: LexicalIndexMetrics;
}
