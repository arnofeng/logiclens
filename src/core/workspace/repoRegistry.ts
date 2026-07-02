import path from "node:path";
import type { AppConfig } from "../../config/schema.js";
import { repoId } from "../../shared/path.js";
import type { RepoNode } from "../parsing/types.js";

export function toRepoNode(repo: AppConfig["repos"][number], cwd: string): RepoNode {
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
