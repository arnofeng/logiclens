import path from "node:path";
import type { GraphFactsBatch } from "../graph-model/facts.js";
import type { FileNode, RepoNode } from "../parsing/types.js";
import { hashText } from "../../shared/hash.js";
import { createRenderRef } from "./renderRef.js";
import { tokenizeLexicalText } from "./tokenizer.js";
import { LEXICAL_PROJECTION_SCHEMA_VERSION, TOKENIZER_VERSION, type LexicalDocument, type LexicalDocumentKind } from "./types.js";

type FactLifecycle = {
  batchId?: string;
  active?: boolean;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function meaningfulText(values: Array<string | undefined>): string {
  return values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)).join(" ");
}

function projectionFingerprint(kind: LexicalDocumentKind, fields: unknown[]): string {
  return hashText(JSON.stringify([LEXICAL_PROJECTION_SCHEMA_VERSION, TOKENIZER_VERSION, kind, ...fields]));
}

export function lexicalDocumentId(workspaceId: string, repoId: string, kind: LexicalDocumentKind, canonicalId: string): string {
  return `lexical:${kind}:${hashText(JSON.stringify([workspaceId, repoId, kind, canonicalId]))}`;
}

export function normalizeProjectionPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error("Projection path must be a non-empty repository-relative path.");
  if (/^[a-zA-Z]:[\\/]/u.test(input) || /^[\\/]{1,2}/u.test(input) || /^[a-z][a-z0-9+.-]*:/iu.test(input)) {
    throw new Error("Projection path must be repository-relative.");
  }
  const segments = input.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) throw new Error("Projection path must not escape its repository.");
  const normalized = segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
  if (normalized.length === 0) throw new Error("Projection path must identify a file.");
  return normalized;
}

function factBatchId(fact: FactLifecycle, batch: GraphFactsBatch): string {
  return fact.batchId ?? batch.batchId;
}

function factActive(fact: FactLifecycle): boolean {
  return fact.active ?? true;
}

function projectRepo(repo: RepoNode, facts: GraphFactsBatch, workspaceId: string): LexicalDocument {
  const lifecycle = repo as RepoNode & FactLifecycle;
  const searchableText = meaningfulText([repo.name, repo.summary, repo.language, repo.remoteUrl, repo.branch]);
  const renderRef = createRenderRef({ workspaceId, repoId: repo.id, kind: "repo", canonicalId: repo.id });
  return {
    id: lexicalDocumentId(workspaceId, repo.id, "repo", repo.id),
    canonicalId: repo.id,
    workspaceId,
    repoId: repo.id,
    kind: "repo",
    title: repo.name,
    searchableText,
    tokens: tokenizeLexicalText(searchableText),
    active: factActive(lifecycle),
    sourceHash: projectionFingerprint("repo", [repo.id, repo.name, repo.summary ?? "", repo.language, repo.remoteUrl, repo.branch, renderRef]),
    batchId: factBatchId(lifecycle, facts),
    renderRef
  };
}

function projectFile(file: FileNode, facts: GraphFactsBatch, workspaceId: string): LexicalDocument {
  const normalizedPath = normalizeProjectionPath(file.path);
  const basename = path.posix.basename(normalizedPath);
  const extension = path.posix.extname(normalizedPath).slice(1);
  const searchableText = meaningfulText([normalizedPath, basename, extension, file.language, file.repoId]);
  const renderRef = createRenderRef({
    workspaceId,
    repoId: file.repoId,
    kind: "file",
    canonicalId: file.id,
    fileId: file.id,
    path: normalizedPath
  });
  return {
    id: lexicalDocumentId(workspaceId, file.repoId, "file", file.id),
    canonicalId: file.id,
    workspaceId,
    repoId: file.repoId,
    kind: "file",
    title: normalizedPath,
    path: normalizedPath,
    searchableText,
    tokens: tokenizeLexicalText(searchableText),
    active: factActive(file),
    sourceHash: projectionFingerprint("file", [file.id, file.repoId, normalizedPath, file.language, file.hash, renderRef]),
    batchId: factBatchId(file, facts),
    renderRef
  };
}

export function projectRepoDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  return facts.repos.map((repo) => projectRepo(repo, facts, workspaceId)).sort((left, right) => compareText(left.id, right.id));
}

export function projectFileDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  return facts.files.map((file) => projectFile(file, facts, workspaceId)).sort((left, right) => compareText(left.id, right.id));
}
