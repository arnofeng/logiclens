import { LEXICAL_DOCUMENT_KINDS, type LexicalDocumentKind } from "./types.js";
import { BRAND } from "../../shared/branding.js";

const RENDER_REF_NAME = `${BRAND.cliName}-render-ref`;
const RENDER_REF_VERSION = "v1";
const RENDER_REF_PREFIX = `${RENDER_REF_NAME}:${RENDER_REF_VERSION}:`;
const FILE_BACKED_KINDS = new Set<LexicalDocumentKind>(["file", "code", "section", "contractSpec", "evidence"]);
const MAX_IDENTITY_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_ENCODED_PAYLOAD_LENGTH = 10_000;
const MAX_RENDER_REF_LENGTH = RENDER_REF_PREFIX.length + MAX_ENCODED_PAYLOAD_LENGTH;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export type RenderRefErrorCode = "format_invalid" | "version_unsupported" | "workspace_mismatch" | "field_invalid";

export class RenderRefError extends Error {
  constructor(readonly code: RenderRefErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "RenderRefError";
  }
}

export interface RenderRefInput {
  workspaceId: string;
  repoId: string;
  kind: LexicalDocumentKind;
  canonicalId: string;
  fileId?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
}

export interface ParsedRenderRef extends RenderRefInput {
  version: "v1";
}

function invalidField(message: string): never {
  throw new RenderRefError("field_invalid", message);
}

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalidField(`${field} must be a non-empty string`);
  if (value.length > MAX_IDENTITY_LENGTH) invalidField(`${field} exceeds the maximum length`);
  if (CONTROL_CHARACTER_PATTERN.test(value)) invalidField(`${field} must not contain control characters`);
  return value;
}

function normalizeRenderPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) invalidField("path must be a non-empty string");
  if (value.length > MAX_PATH_LENGTH) invalidField("path exceeds the maximum length");
  if (CONTROL_CHARACTER_PATTERN.test(value)) invalidField("path must not contain control characters");
  if (/^[a-zA-Z]:[\\/]/u.test(value) || /^[\\/]{1,2}/u.test(value) || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    invalidField("path must be relative");
  }

  const segments = value.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) invalidField("path must not escape its repository");
  const normalized = segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
  if (normalized.length === 0) invalidField("path must identify a file");
  if (normalized.length > MAX_PATH_LENGTH) invalidField("normalized path exceeds the maximum length");
  return normalized;
}

function normalizeLine(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalidField(`${field} must be a positive integer`);
  return value;
}

function validateInput(value: Record<string, unknown>): ParsedRenderRef {
  const workspaceId = requireIdentity(value.workspaceId, "workspaceId");
  const repoId = requireIdentity(value.repoId, "repoId");
  const canonicalId = requireIdentity(value.canonicalId, "canonicalId");
  if (typeof value.kind !== "string" || !(LEXICAL_DOCUMENT_KINDS as readonly string[]).includes(value.kind)) invalidField("kind is unknown");
  const kind = value.kind as LexicalDocumentKind;
  const fileId = value.fileId === undefined ? undefined : requireIdentity(value.fileId, "fileId");
  const path = normalizeRenderPath(value.path);
  const startLine = normalizeLine(value.startLine, "startLine");
  const endLine = normalizeLine(value.endLine, "endLine");

  if ((fileId === undefined) !== (path === undefined)) invalidField("fileId and path must be provided together");
  if (kind === "repo" && canonicalId !== repoId) invalidField("repo canonicalId must equal repoId");
  if (kind === "repo" && (fileId !== undefined || path !== undefined)) invalidField("repo references must not include file identity");
  if (kind === "file" && canonicalId !== fileId) invalidField("file canonicalId must equal fileId");
  if (FILE_BACKED_KINDS.has(kind) && (fileId === undefined || path === undefined)) invalidField(`${kind} references require fileId and path`);
  if ((startLine !== undefined || endLine !== undefined) && fileId === undefined) invalidField("line ranges require file identity");
  if (endLine !== undefined && startLine === undefined) invalidField("endLine requires startLine");
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) invalidField("endLine must not precede startLine");

  return {
    version: "v1",
    workspaceId,
    repoId,
    kind,
    canonicalId,
    ...(fileId === undefined ? {} : { fileId }),
    ...(path === undefined ? {} : { path }),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine })
  };
}

function encodePayload(value: ParsedRenderRef): string {
  const payload = {
    workspaceId: value.workspaceId,
    repoId: value.repoId,
    kind: value.kind,
    canonicalId: value.canonicalId,
    ...(value.fileId === undefined ? {} : { fileId: value.fileId }),
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.startLine === undefined ? {} : { startLine: value.startLine }),
    ...(value.endLine === undefined ? {} : { endLine: value.endLine })
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function createRenderRef(input: RenderRefInput): string {
  const encoded = encodePayload(validateInput(input as unknown as Record<string, unknown>));
  if (encoded.length > MAX_ENCODED_PAYLOAD_LENGTH) invalidField("encoded payload exceeds the maximum length");
  return `${RENDER_REF_PREFIX}${encoded}`;
}

export function parseRenderRef(renderRef: string, expectedWorkspaceId: string): ParsedRenderRef {
  if (typeof renderRef !== "string" || renderRef.length > MAX_RENDER_REF_LENGTH) {
    throw new RenderRefError("format_invalid", "render reference exceeds the maximum length");
  }
  if (!renderRef.startsWith(`${RENDER_REF_NAME}:`)) {
    throw new RenderRefError("format_invalid", "render reference prefix is invalid");
  }
  if (!renderRef.startsWith(RENDER_REF_PREFIX)) {
    throw new RenderRefError("version_unsupported", "render reference version is unsupported");
  }

  const encoded = renderRef.slice(RENDER_REF_PREFIX.length);
  if (encoded.length > MAX_ENCODED_PAYLOAD_LENGTH) throw new RenderRefError("format_invalid", "payload exceeds the maximum length");
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new RenderRefError("format_invalid", "payload encoding is invalid");

  let raw: unknown;
  try {
    const buffer = Buffer.from(encoded, "base64url");
    if (buffer.toString("base64url") !== encoded) throw new Error("non-canonical base64url");
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new RenderRefError("format_invalid", "payload is corrupted");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new RenderRefError("format_invalid", "payload must be an object");

  const parsed = validateInput(raw as Record<string, unknown>);
  if (parsed.workspaceId !== expectedWorkspaceId) throw new RenderRefError("workspace_mismatch", "render reference belongs to another workspace");
  return parsed;
}
