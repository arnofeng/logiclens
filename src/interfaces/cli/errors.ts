import { findMcpOwner } from "../mcp/ownerRpc.js";

const KUZU_LOCK_ERROR_FRAGMENT = "Could not set lock on file";

export function isKuzuLockError(error: unknown): boolean {
  return errorMessage(error).includes(KUZU_LOCK_ERROR_FRAGMENT);
}

export async function formatCliError(error: unknown, cwd = process.cwd()): Promise<string> {
  const message = errorMessage(error);
  if (!isKuzuLockError(error)) return message;

  const databasePath = extractLockedDatabasePath(message);
  const owner = await findMcpOwner(cwd).catch(() => null);

  if (owner) {
    return [
      `RepoHelix database is currently in use by the MCP server (PID ${owner.pid}).`,
      "",
      "Kuzu permits only one read-write database owner for this workspace.",
      "Use the RepoHelix MCP tools, or disconnect the MCP server before running this CLI command.",
      ...(databasePath ? ["", `Database: ${databasePath}`] : [])
    ].join("\n");
  }

  return [
    "RepoHelix database is currently in use by another process.",
    "",
    "Close the other RepoHelix or Kuzu process and retry.",
    ...(databasePath ? ["", `Database: ${databasePath}`] : [])
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractLockedDatabasePath(message: string): string | undefined {
  const markerIndex = message.indexOf(KUZU_LOCK_ERROR_FRAGMENT);
  if (markerIndex < 0) return undefined;
  const suffix = message.slice(markerIndex + KUZU_LOCK_ERROR_FRAGMENT.length);
  const firstLine = suffix.split(/\r?\n/u, 1)[0]?.replace(/^\s*:\s*/u, "").trim();
  return firstLine || undefined;
}
