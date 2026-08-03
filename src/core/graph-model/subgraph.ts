import type { GraphDB } from "./db.js";
import { publicGraphActivePredicate, withPublicGraphSnapshotParams, type PublicGraphReadSnapshot } from "./readSnapshot.js";

export type EdgeRow = {
  fromCodeId?: string;
  toCodeId?: string;
  fromRepoId?: string;
  toRepoId?: string;
  fromPath?: string;
  toPath?: string;
  fromName: string;
  toName: string;
  fromFile: string;
  toFile: string;
  confidence: number;
  resolution: "exact" | "probable" | "heuristic";
  raw: string;
};

export async function callEdgesAround(db: GraphDB, snapshot: PublicGraphReadSnapshot, codeIds: string[], limit = 100): Promise<EdgeRow[]> {
  if (codeIds.length === 0) return [];
  if (!Number.isSafeInteger(limit) || limit < 1) return [];
  return db.query<EdgeRow>(
    `MATCH (fromRepo:Repo)-[fromRepoContains:CONTAINS]->(fromFile:File)-[fromFileContains:CONTAINS]->(a:Code)-[r:CALLS]->(b:Code)<-[toFileContains:CONTAINS]-(toFile:File)<-[toRepoContains:CONTAINS]-(toRepo:Repo)
     WHERE (a.id IN $ids OR b.id IN $ids)
       AND fromRepo.workspaceId = $workspaceId AND fromRepo.generation = $generation
       AND fromRepoContains.workspaceId = $workspaceId AND fromRepoContains.generation = $generation
       AND fromFile.workspaceId = $workspaceId AND fromFile.generation = $generation
       AND fromFileContains.workspaceId = $workspaceId AND fromFileContains.generation = $generation
       AND a.workspaceId = $workspaceId AND a.generation = $generation
       AND r.workspaceId = $workspaceId AND r.generation = $generation
       AND b.workspaceId = $workspaceId AND b.generation = $generation
       AND toFileContains.workspaceId = $workspaceId AND toFileContains.generation = $generation
       AND toFile.workspaceId = $workspaceId AND toFile.generation = $generation
       AND toRepoContains.workspaceId = $workspaceId AND toRepoContains.generation = $generation
       AND toRepo.workspaceId = $workspaceId AND toRepo.generation = $generation
       AND ${publicGraphActivePredicate("fromFile", "a", "r", "b", "toFile")}
     RETURN a.id AS fromCodeId, b.id AS toCodeId,
       fromRepo.id AS fromRepoId, toRepo.id AS toRepoId,
       fromFile.path AS fromPath, toFile.path AS toPath,
       a.qualifiedName AS fromName, b.qualifiedName AS toName,
       fromRepo.name + '/' + fromFile.path AS fromFile,
       toRepo.name + '/' + toFile.path AS toFile,
       r.confidence AS confidence,
       CASE WHEN r.resolution IS NULL OR r.resolution = "" THEN CASE WHEN r.confidence >= 0.9 THEN "exact" WHEN r.confidence >= 0.8 THEN "probable" ELSE "heuristic" END ELSE r.resolution END AS resolution,
       r.raw AS raw
     ORDER BY a.id, b.id, fromFile.path, toFile.path
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { ids: codeIds })
  );
}
