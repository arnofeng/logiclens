import { hashText } from "../../shared/hash.js";

/** Derives a stable identity from a logical workspace name, never a path. */
export function deriveWorkspaceId(systemName: string): string {
  const normalizedName = systemName.normalize("NFC").trim().toLocaleLowerCase("en-US");
  if (normalizedName.length === 0) {
    throw new Error("A workspace system name must not be empty.");
  }

  return `workspace:${hashText(normalizedName)}`;
}
