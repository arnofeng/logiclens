import { buildRepoDependenciesFromParticipants, type ContractParticipant } from "../extractors/crossRepoContracts.js";
import type { ContractKind, ContractRole, RepoDependencyEdge } from "../parsers/types.js";
import type { GraphDB } from "./db.js";

type ParticipantRow = {
  repoId: string;
  contractId: string;
  role: ContractRole;
  evidenceId: string;
  confidence: number;
  kind: ContractKind;
  key: string;
  name: string;
  description: string;
  evidenceRepoId: string;
  fileId: string;
  filePath: string;
  line: number;
  raw: string;
  rule: string;
  evidenceConfidence: number;
};

export type RebuildRepoDependenciesLogger = {
  log?: (message: string) => void;
  createProgressBar?: (label: string, total: number) => any;
};

function toContractParticipants(rows: ParticipantRow[]): ContractParticipant[] {
  return rows.map((row) => ({
    repoId: row.repoId,
    contractId: row.contractId,
    role: row.role,
    evidenceId: row.evidenceId,
    confidence: row.confidence,
    contract: {
      id: row.contractId,
      kind: row.kind,
      key: row.key,
      name: row.name,
      description: row.description
    },
    evidence: {
      id: row.evidenceId,
      repoId: row.evidenceRepoId,
      fileId: row.fileId,
      filePath: row.filePath,
      line: row.line,
      raw: row.raw,
      rule: row.rule,
      confidence: row.evidenceConfidence
    }
  }));
}

function activeParticipantWhere(extra?: string): string {
  return [
    "edge.evidenceId = e.id",
    "(edge.active IS NULL OR edge.active = true)",
    "(e.active IS NULL OR e.active = true)",
    extra
  ].filter(Boolean).join(" AND ");
}

async function roleRows(db: GraphDB, rel: string, role: ContractRole, extraWhere?: string, params: Record<string, any> = {}): Promise<ParticipantRow[]> {
  return db.query<ParticipantRow>(
    `MATCH (r:Repo)-[edge:${rel}]->(c:Contract)-[:HAS_EVIDENCE]->(e:Evidence)
     WHERE ${activeParticipantWhere(extraWhere)}
     RETURN r.id AS repoId, c.id AS contractId, '${role}' AS role, edge.evidenceId AS evidenceId, edge.confidence AS confidence,
            c.kind AS kind, c.key AS key, c.name AS name, c.description AS description,
            e.repoId AS evidenceRepoId, e.fileId AS fileId, e.filePath AS filePath, e.line AS line,
            e.raw AS raw, e.rule AS rule, e.confidence AS evidenceConfidence;`,
    params
  );
}

async function participantRows(db: GraphDB, extraWhere?: string, params: Record<string, any> = {}): Promise<ParticipantRow[]> {
  const roles: ContractRole[] = ["owner", "producer", "consumer", "shared"];
  const rels = ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT"];
  
  const promises = rels.map((rel, i) => roleRows(db, rel, roles[i]!, extraWhere, params));
  const results = await Promise.all(promises);
  return results.flat();
}

export async function loadContractParticipants(db: GraphDB): Promise<ContractParticipant[]> {
  return toContractParticipants(await participantRows(db));
}

export async function loadContractParticipantsForRepos(db: GraphDB, repoIds: string[]): Promise<ContractParticipant[]> {
  if (repoIds.length === 0) return [];
  return toContractParticipants(await participantRows(db, "r.id IN $repoIds", { repoIds }));
}

export async function loadContractParticipantsForContracts(db: GraphDB, contractIds: string[]): Promise<ContractParticipant[]> {
  if (contractIds.length === 0) return [];
  return toContractParticipants(await participantRows(db, "c.id IN $contractIds", { contractIds }));
}

export async function rebuildRepoDependencies(db: GraphDB, options: { repoIds?: string[]; batchId?: string; logger?: RebuildRepoDependenciesLogger } = {}): Promise<RepoDependencyEdge[]> {
  const targetRepoIds = options.repoIds && options.repoIds.length > 0 ? new Set(options.repoIds) : undefined;
  const targetParticipants = targetRepoIds ? await loadContractParticipantsForRepos(db, [...targetRepoIds]) : undefined;
  const targetContractIds = targetParticipants ? [...new Set(targetParticipants.map((participant) => participant.contractId))] : undefined;
  const participants = targetContractIds ? await loadContractParticipantsForContracts(db, targetContractIds) : await loadContractParticipants(db);
  const dependencies = buildRepoDependenciesFromParticipants(participants, targetRepoIds);
  await db.clearRepoDependencies(options.repoIds);
  
  const progress = options.logger?.createProgressBar?.("Rebuilding dependencies", dependencies.length);
  const batchSize = 5000;
  for (let i = 0; i < dependencies.length; i += batchSize) {
    const chunk = dependencies.slice(i, i + batchSize).map((d) => ({
      ...d,
      batchId: options.batchId ?? "",
      active: true
    }));
    await db.addRepoDependenciesBatch(chunk);
    progress?.update(Math.min(i + batchSize, dependencies.length));
  }
  progress?.complete();

  if (targetRepoIds) {
    options.logger?.log?.(
      `Targeted dependency rebuild: repos=${targetRepoIds.size} contracts=${targetContractIds?.length ?? 0} participants=${participants.length} dependencies=${dependencies.length}`
    );
  }
  return dependencies;
}
