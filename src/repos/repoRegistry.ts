import path from "node:path";
import type { LogicLensConfig } from "../config/schema.js";
import { repoId } from "../utils/path.js";
import type { RepoNode } from "../parsers/types.js";

export function toRepoNode(repo: LogicLensConfig["repos"][number], cwd: string): RepoNode {
  return {
    id: repoId(repo.name),
    name: repo.name,
    path: path.resolve(cwd, repo.path),
    remoteUrl: "",
    branch: "",
    commitSha: "",
    language: "typescript",
    indexedAt: new Date().toISOString()
  };
}
