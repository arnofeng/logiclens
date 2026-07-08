import type { GraphDB } from "../../core/graph-model/db.js";
import { listLowConfidenceRelations, listProducerContracts } from "../../core/graph-model/queries.js";
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
  const lowConfidence = await listLowConfidenceRelations(db, { minConfidence, limit });
  const producerRows = await listProducerContracts(db);
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
