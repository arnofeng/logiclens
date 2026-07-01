import type { GraphDB } from "./db.js";

export type EdgeRow = {
  fromName: string;
  toName: string;
  fromFile: string;
  toFile: string;
  confidence: number;
  resolution: "exact" | "probable" | "heuristic";
  raw: string;
};

export async function callEdgesAround(db: GraphDB, codeIds: string[]): Promise<EdgeRow[]> {
  if (codeIds.length === 0) return [];
  return db.query<EdgeRow>(
    `MATCH (fromRepo:Repo)-[:CONTAINS]->(fromFile:File)-[:CONTAINS]->(a:Code)-[r:CALLS]->(b:Code)<-[:CONTAINS]-(toFile:File)<-[:CONTAINS]-(toRepo:Repo)
     WHERE (a.id IN $ids OR b.id IN $ids)
       AND (fromFile.active IS NULL OR fromFile.active = true)
       AND (toFile.active IS NULL OR toFile.active = true)
       AND (a.active IS NULL OR a.active = true)
       AND (b.active IS NULL OR b.active = true)
       AND (r.active IS NULL OR r.active = true)
     RETURN a.qualifiedName AS fromName, b.qualifiedName AS toName,
       fromRepo.name + '/' + fromFile.path AS fromFile,
       toRepo.name + '/' + toFile.path AS toFile,
       r.confidence AS confidence,
       CASE WHEN r.resolution IS NULL OR r.resolution = "" THEN CASE WHEN r.confidence >= 0.9 THEN "exact" WHEN r.confidence >= 0.8 THEN "probable" ELSE "heuristic" END ELSE r.resolution END AS resolution,
       r.raw AS raw
     LIMIT 100;`,
    { ids: codeIds }
  );
}
