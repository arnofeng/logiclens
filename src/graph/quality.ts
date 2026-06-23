import type { GraphDB } from "./db.js";
import { PROBABLE_CONFIDENCE_THRESHOLD } from "../confidence.js";

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
  const createdAt = new Date().toISOString();
  await db.query(
    "MERGE (f:RelationFeedback {id: $id}) ON CREATE SET f.evidenceId=$evidenceId, f.action=$action, f.reason=$reason, f.createdAt=$createdAt ON MATCH SET f.action=$action, f.reason=$reason, f.createdAt=$createdAt;",
    { id: `feedback:${input.evidenceId}:reject`, evidenceId: input.evidenceId, action: "reject", reason: input.reason, createdAt }
  );
  await db.query("MATCH (e:Evidence) WHERE e.id = $evidenceId SET e.active = false;", { evidenceId: input.evidenceId });
  for (const rel of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "CONTRACT_MENTIONS", "PARTICIPATES_IN", "WORKFLOW_STEP", "USES_PACKAGE", "DEPENDS_ON"]) {
    await db.query(`MATCH ()-[r:${rel}]->() WHERE r.evidenceId = $evidenceId SET r.active = false;`, { evidenceId: input.evidenceId });
  }
}

export async function upsertAliasOverride(db: GraphDB, input: { alias: string; targetRepoId: string; reason: string }): Promise<void> {
  const createdAt = new Date().toISOString();
  await db.query(
    "MERGE (a:AliasOverride {id: $id}) ON CREATE SET a.alias=$alias, a.targetRepoId=$targetRepoId, a.reason=$reason, a.createdAt=$createdAt, a.active=true ON MATCH SET a.targetRepoId=$targetRepoId, a.reason=$reason, a.createdAt=$createdAt, a.active=true;",
    { id: `alias:${input.alias.toLowerCase()}`, alias: input.alias, targetRepoId: input.targetRepoId, reason: input.reason, createdAt }
  );
}
