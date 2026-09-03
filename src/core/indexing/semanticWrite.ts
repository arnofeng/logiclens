import { rebuildRepoDependencies } from "../graph-model/rebuildRelations.js";
import type { GraphDB } from "../graph-model/db.js";
import type { RepoNode } from "../parsing/types.js";
import { runIndexPhase } from "./phases.js";
import type { PublicGraphGenerationScope } from "../graph-model/publicGraphGeneration.js";

export async function runStaleMarkPhase(input: {
  db: GraphDB;
  repo: RepoNode;
  activeFileIds: string[];
  batchId: string;
  indexedAt: string;
  scope: PublicGraphGenerationScope;
}): Promise<number> {
  const { db, repo, activeFileIds, batchId, indexedAt, scope } = input;
  const result = await runIndexPhase({ phase: "stale-mark", repoName: repo.name, repoId: repo.id, batchId }, async () => {
    // Only incremental/per-repo indexing calls this phase. Full and batched
    // paths retain their existing cleanup behavior in the graph writer.
    return db.markRepoArtifactsStale({ repoId: repo.id, activeFileIds, batchId, indexedAt }, scope);
  });
  return result.result;
}

export async function runRelationRebuildPhase(input: {
  db: GraphDB;
  repoIds?: string[];
  batchId: string;
  log: (message: string) => void;
  scope: PublicGraphGenerationScope;
}): Promise<number> {
  const { db, repoIds, batchId, log, scope } = input;
  const result = await runIndexPhase({ phase: "relation-rebuild", batchId }, async () => {
    const rebuilt = await rebuildRepoDependencies(db, { repoIds, batchId, logger: { log }, scope });
    return rebuilt.length;
  });
  return result.result;
}
