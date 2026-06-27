import type { GraphDB } from "../../core/graph-model/db.js";
import { PROBABLE_CONFIDENCE_THRESHOLD } from "../../shared/confidence.js";

export type LowConfidenceRelation = {
  evidenceId: string;
  repoName: string;
  contractKind: string;
  contractKey: string;
  role: string;
  confidence: number;
  filePath: string;
  line: number;
  rule: string;
  raw: string;
};

export type ConflictingContract = {
  contractKind: string;
  contractKey: string;
  producerCount: number;
  producers: string;
};

export type QualityAudit = {
  lowConfidence: LowConfidenceRelation[];
  conflicts: ConflictingContract[];
};

export async function auditRelationQuality(db: GraphDB, options: { minConfidence?: number; limit?: number } = {}): Promise<QualityAudit> {
  const minConfidence = options.minConfidence ?? PROBABLE_CONFIDENCE_THRESHOLD;
  const limit = options.limit ?? 50;
  const lowConfidence: LowConfidenceRelation[] = [];
  for (const [rel, role] of [["PRODUCES", "producer"], ["CONSUMES", "consumer"], ["SHARES_CONTRACT", "shared"], ["OWNS_PACKAGE", "owner"]] as const) {
    lowConfidence.push(...await db.query<LowConfidenceRelation>(
      `MATCH (r:Repo)-[edge:${rel}]->(c:Contract), (e:Evidence)
       WHERE edge.evidenceId = e.id
         AND (edge.active IS NULL OR edge.active = true)
         AND (e.active IS NULL OR e.active = true)
         AND edge.confidence < $minConfidence
       RETURN e.id AS evidenceId, r.name AS repoName, c.kind AS contractKind, c.key AS contractKey,
              '${role}' AS role, edge.confidence AS confidence, e.filePath AS filePath,
              e.line AS line, e.rule AS rule, e.raw AS raw
       LIMIT ${limit};`,
      { minConfidence }
    ));
  }
  const producerRows = await db.query<{ contractKind: string; contractKey: string; repoName: string }>(
    `MATCH (r:Repo)-[p:PRODUCES]->(c:Contract)
     WHERE (p.active IS NULL OR p.active = true)
     RETURN c.kind AS contractKind, c.key AS contractKey, r.name AS repoName;`
  );
  const producerGroups = new Map<string, Set<string>>();
  for (const row of producerRows) {
    const key = `${row.contractKind}:${row.contractKey}`;
    const producers = producerGroups.get(key) ?? new Set<string>();
    producers.add(row.repoName);
    producerGroups.set(key, producers);
  }
  const conflicts = [...producerGroups.entries()]
    .map(([key, producers]) => {
      const [contractKind, ...contractKeyParts] = key.split(":");
      return { contractKind, contractKey: contractKeyParts.join(":"), producerCount: producers.size, producers: [...producers].sort().join(", ") };
    })
    .filter((row) => row.producerCount > 1)
    .slice(0, limit);
  lowConfidence.sort((a, b) => a.confidence - b.confidence || a.contractKey.localeCompare(b.contractKey));
  return { lowConfidence: lowConfidence.slice(0, limit), conflicts };
}

export async function rejectEvidence(db: GraphDB, input: { evidenceId: string; reason: string }): Promise<void> {
  return db.rejectEvidence(input);
}

export async function upsertAliasOverride(db: GraphDB, input: { alias: string; targetRepoId: string; reason: string }): Promise<void> {
  return db.upsertAliasOverride(input);
}
