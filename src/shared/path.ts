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

export type ParsedFileId = {
  repoName: string;
  filePath: string;
};

export function repoNameFromId(repoIdValue: string): string {
  return repoIdValue.replace(/^repo:/, "");
}

/**
 * Converts an internal file identity back into the repository name and
 * repository-relative path used at the CLI and filesystem boundaries.
 *
 * Canonical IDs have the form `file:repo:<repo-name>:<relative-path>`. The
 * fallback also accepts legacy `file:<repo-name>:<relative-path>` values and
 * already-normalized relative paths.
 */
export function parseFileId(fileIdValue: string, fallbackRepoId = ""): ParsedFileId {
  const fallbackRepoName = repoNameFromId(fallbackRepoId);
  const parts = fileIdValue.split(":");

  if (parts[0] === "file" && parts[1] === "repo" && parts.length >= 4) {
    return {
      repoName: parts[2] ?? fallbackRepoName,
      filePath: parts.slice(3).join(":"),
    };
  }

  if (parts[0] === "file" && parts.length >= 3) {
    return {
      repoName: parts[1] ?? fallbackRepoName,
      filePath: parts.slice(2).join(":"),
    };
  }

  return {
    repoName: fallbackRepoName,
    filePath: fileIdValue.replace(/^file:/, ""),
  };
}

export function sourceDirectory(relativePath: string): string {
  return path.posix.dirname(toPosixPath(relativePath));
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
