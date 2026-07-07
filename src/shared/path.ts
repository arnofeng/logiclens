import path from "node:path";

export function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

export function normalizeName(input: string): string {
  return input.trim().replace(/\\/g, "/").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function repoId(name: string): string {
  return `repo:${normalizeName(name)}`;
}

export function fileId(repoIdValue: string, relativePath: string): string {
  return `file:${repoIdValue}:${toPosixPath(relativePath)}`;
}

export function codeId(repoIdValue: string, relativePath: string, kind: string, qualifiedName: string, startLine: number): string {
  return `code:${repoIdValue}:${toPosixPath(relativePath)}:${kind}:${qualifiedName}:${startLine}`;
}

export function sectionId(repoIdValue: string, relativePath: string, heading: string, startLine: number): string {
  return `section:${repoIdValue}:${toPosixPath(relativePath)}:${normalizeName(heading || "document")}:${startLine}`;
}

export function entityId(name: string): string {
  return `entity:${normalizeName(name)}`;
}

export function contractId(kind: string, key: string): string {
  return `contract:${normalizeName(kind)}:${normalizeName(key)}`;
}

export function evidenceId(parts: string[]): string {
  return `evidence:${parts.map(normalizeName).join(":")}`;
}
