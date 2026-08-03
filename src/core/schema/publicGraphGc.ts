import { ALL_EVIDENCE_REL_TYPES, type GraphDB } from "../graph-model/db.js";
import type { GraphFactsBatch } from "../graph-model/facts.js";
import { publicNodeStorageId, type PublicGraphGenerationScope } from "../graph-model/publicGraphGeneration.js";
import type { IncrementalSchemaPublicGraphDelta } from "./staging.js";

type SchemaSpecSupportRow = {
  id: string;
  contractId: string;
  evidenceId?: string | null;
};

type IdRow = { id: string };

export interface IncrementalSchemaSupportGcPlan {
  deletedSpecIds: string[];
  evidenceIds: string[];
  contractIds: string[];
  entityIds: string[];
}

export function emptyIncrementalSchemaSupportGcPlan(): IncrementalSchemaSupportGcPlan {
  return {
    deletedSpecIds: [],
    evidenceIds: [],
    contractIds: [],
    entityIds: []
  };
}

function sortedIds(rows: readonly IdRow[]): string[] {
  return [...new Set(rows.map((row) => row.id))].sort();
}

/**
 * Resolves the exact support nodes made unreachable by contribution GC. All
 * discovery is bounded by schema-spec IDs that the contribution planner has
 * already proven invisible, and happens before the provider commit.
 */
export async function prepareIncrementalSchemaSupportGc(input: {
  db: GraphDB;
  scope: PublicGraphGenerationScope;
  schemaDelta: IncrementalSchemaPublicGraphDelta;
  graphFacts?: readonly GraphFactsBatch[];
  replacedSourceFileIds?: readonly string[];
  alreadyDeletedEvidenceIds?: readonly string[];
  alreadyDeletedContractIds?: readonly string[];
  alreadyDeletedEntityIds?: readonly string[];
}): Promise<IncrementalSchemaSupportGcPlan> {
  const deletedSpecIds = [...new Set(input.schemaDelta.deleteSpecIds)].sort();
  if (deletedSpecIds.length === 0) return emptyIncrementalSchemaSupportGcPlan();

  const scopeParams = {
    workspaceId: input.scope.workspaceId,
    generation: input.scope.generation
  };
  const specs = await input.db.query<SchemaSpecSupportRow>(
    "MATCH (n:ContractSpec) WHERE n.workspaceId=$workspaceId AND n.generation=$generation " +
    "AND n.id IN $deletedSpecIds AND (n.active IS NULL OR n.active=true) " +
    "RETURN n.id AS id, n.contractId AS contractId, n.evidenceId AS evidenceId;",
    { ...scopeParams, deletedSpecIds }
  );
  const candidateEvidenceIds = [...new Set(specs.flatMap((spec) => spec.evidenceId ? [spec.evidenceId] : []))].sort();
  const candidateContractIds = [...new Set(specs.map((spec) => spec.contractId))].sort();
  const graphFacts = input.graphFacts ?? [];

  const retainedEvidenceIds = candidateEvidenceIds.length === 0
    ? new Set<string>()
    : new Set(sortedIds(await input.db.query<IdRow>(
      "MATCH (n:ContractSpec) WHERE n.workspaceId=$workspaceId AND n.generation=$generation " +
      "AND n.evidenceId IN $candidateEvidenceIds AND NOT (n.id IN $deletedSpecIds) " +
      "AND (n.active IS NULL OR n.active=true) RETURN n.evidenceId AS id;",
      { ...scopeParams, candidateEvidenceIds, deletedSpecIds }
    )));
  if (candidateEvidenceIds.length > 0) {
    for (const relation of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "USES_PACKAGE"] as const) {
      for (const row of await input.db.query<IdRow>(
        `MATCH ()-[r:${relation}]->(n:Contract) WHERE r.workspaceId=$workspaceId AND r.generation=$generation ` +
        "AND r.evidenceId IN $candidateEvidenceIds AND NOT (n.id IN $candidateContractIds) " +
        "AND (r.active IS NULL OR r.active=true) RETURN r.evidenceId AS id;",
        { ...scopeParams, candidateEvidenceIds, candidateContractIds }
      )) retainedEvidenceIds.add(row.id);
    }
    for (const row of await input.db.query<IdRow>(
      "MATCH (source:Contract)-[r:CONTRACT_MENTIONS]->(:Entity) " +
      "WHERE r.workspaceId=$workspaceId AND r.generation=$generation " +
      "AND r.evidenceId IN $candidateEvidenceIds AND NOT (source.id IN $candidateContractIds) " +
      "AND (r.active IS NULL OR r.active=true) RETURN r.evidenceId AS id;",
      { ...scopeParams, candidateEvidenceIds, candidateContractIds }
    )) retainedEvidenceIds.add(row.id);
    for (const relation of ["PARTICIPATES_IN", "WORKFLOW_STEP", "DEPENDS_ON"] as const) {
      for (const row of await input.db.query<IdRow>(
        `MATCH ()-[r:${relation}]->() WHERE r.workspaceId=$workspaceId AND r.generation=$generation ` +
        "AND r.evidenceId IN $candidateEvidenceIds AND (r.active IS NULL OR r.active=true) " +
        "RETURN r.evidenceId AS id;",
        { ...scopeParams, candidateEvidenceIds }
      )) retainedEvidenceIds.add(row.id);
    }
    for (const row of await input.db.query<IdRow>(
      "MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec) " +
      "WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND r.evidenceId IN $candidateEvidenceIds " +
      "AND NOT (a.id IN $deletedSpecIds) AND NOT (b.id IN $deletedSpecIds) " +
      "AND (r.active IS NULL OR r.active=true) RETURN r.evidenceId AS id;",
      { ...scopeParams, candidateEvidenceIds, deletedSpecIds }
    )) retainedEvidenceIds.add(row.id);
  }
  const alreadyDeletedEvidence = new Set(input.alreadyDeletedEvidenceIds ?? []);
  for (const facts of graphFacts) {
    for (const evidence of facts.evidence) {
      if (candidateEvidenceIds.includes(evidence.id)) retainedEvidenceIds.add(evidence.id);
    }
    for (const spec of facts.contractSpecs) {
      if (spec.evidenceId && candidateEvidenceIds.includes(spec.evidenceId) && !deletedSpecIds.includes(spec.id)) {
        retainedEvidenceIds.add(spec.evidenceId);
      }
    }
    for (const edge of [
      ...facts.repoContracts,
      ...facts.packageUsages,
      ...facts.contractEntities,
      ...facts.operationRepos,
      ...facts.workflowOperations,
      ...facts.repoDependencies,
      ...facts.contractSpecEdges,
      ...facts.semanticRelations
    ]) {
      if (candidateEvidenceIds.includes(edge.evidenceId)) retainedEvidenceIds.add(edge.evidenceId);
    }
  }
  const evidenceIds = candidateEvidenceIds
    .filter((id) => !retainedEvidenceIds.has(id) && !alreadyDeletedEvidence.has(id));

  const retainedContractIds = candidateContractIds.length === 0
    ? new Set<string>()
    : new Set(sortedIds(await input.db.query<IdRow>(
      "MATCH (n:Contract)-[r:HAS_SPEC]->(s:ContractSpec) " +
      "WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND n.id IN $candidateContractIds " +
      "AND r.workspaceId=$workspaceId AND r.generation=$generation " +
      "AND s.workspaceId=$workspaceId AND s.generation=$generation AND NOT (s.id IN $deletedSpecIds) " +
      "AND (r.active IS NULL OR r.active=true) AND (s.active IS NULL OR s.active=true) RETURN n.id AS id;",
      { ...scopeParams, candidateContractIds, deletedSpecIds }
    )));
  const alreadyDeletedContracts = new Set(input.alreadyDeletedContractIds ?? []);
  for (const facts of graphFacts) {
    for (const contract of facts.contracts) {
      if (candidateContractIds.includes(contract.id)) retainedContractIds.add(contract.id);
    }
    for (const spec of facts.contractSpecs) {
      if (candidateContractIds.includes(spec.contractId) && !deletedSpecIds.includes(spec.id)) {
        retainedContractIds.add(spec.contractId);
      }
    }
    for (const edge of facts.repoContracts) {
      if (candidateContractIds.includes(edge.contractId)) retainedContractIds.add(edge.contractId);
    }
    for (const edge of facts.contractEntities) {
      if (candidateContractIds.includes(edge.contractId)) retainedContractIds.add(edge.contractId);
    }
  }
  if (candidateContractIds.length > 0) {
    if (evidenceIds.length === 0) {
      for (const id of candidateContractIds) retainedContractIds.add(id);
    } else {
      for (const relation of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "USES_PACKAGE"] as const) {
        for (const row of await input.db.query<IdRow>(
          `MATCH ()-[r:${relation}]->(n:Contract) WHERE r.workspaceId=$workspaceId AND r.generation=$generation ` +
          "AND n.id IN $candidateContractIds AND NOT (r.evidenceId IN $deletedEvidenceIds) " +
          "AND (r.active IS NULL OR r.active=true) RETURN n.id AS id;",
          { ...scopeParams, candidateContractIds, deletedEvidenceIds: evidenceIds }
        )) retainedContractIds.add(row.id);
      }
    }
  }
  const contractIds = candidateContractIds
    .filter((id) => !retainedContractIds.has(id) && !alreadyDeletedContracts.has(id));

  const candidateEntityIds = contractIds.length === 0
    ? []
    : sortedIds(await input.db.query<IdRow>(
      "MATCH (source:Contract)-[r:CONTRACT_MENTIONS]->(n:Entity) " +
      "WHERE source.workspaceId=$workspaceId AND source.generation=$generation AND source.id IN $contractIds " +
      "AND r.workspaceId=$workspaceId AND r.generation=$generation " +
      "AND n.workspaceId=$workspaceId AND n.generation=$generation RETURN n.id AS id;",
      { ...scopeParams, contractIds }
    ));
  const retainedEntityIds = new Set<string>();
  if (candidateEntityIds.length > 0) {
    const replacedSourceFileIds = [...new Set(input.replacedSourceFileIds ?? [])].sort();
    const survivingSourcePredicate = replacedSourceFileIds.length > 0
      ? "AND NOT (source.fileId IN $replacedSourceFileIds) "
      : "";
    for (const query of [
      `MATCH (source:Code)-[r:MENTIONS]->(n:Entity) WHERE source.workspaceId=$workspaceId AND source.generation=$generation ${survivingSourcePredicate}AND r.workspaceId=$workspaceId AND r.generation=$generation AND n.workspaceId=$workspaceId AND n.generation=$generation AND n.id IN $candidateEntityIds AND (source.active IS NULL OR source.active=true) RETURN n.id AS id;`,
      `MATCH (source:Section)-[r:MENTIONS]->(n:Entity) WHERE source.workspaceId=$workspaceId AND source.generation=$generation ${survivingSourcePredicate}AND r.workspaceId=$workspaceId AND r.generation=$generation AND n.workspaceId=$workspaceId AND n.generation=$generation AND n.id IN $candidateEntityIds AND (source.active IS NULL OR source.active=true) RETURN n.id AS id;`,
      `MATCH (source:Code)-[r:OPERATES_ON]->(n:Entity) WHERE source.workspaceId=$workspaceId AND source.generation=$generation ${survivingSourcePredicate}AND r.workspaceId=$workspaceId AND r.generation=$generation AND n.workspaceId=$workspaceId AND n.generation=$generation AND n.id IN $candidateEntityIds AND (source.active IS NULL OR source.active=true) RETURN n.id AS id;`
    ]) {
      for (const row of await input.db.query<IdRow>(query, {
        ...scopeParams,
        candidateEntityIds,
        ...(replacedSourceFileIds.length > 0 ? { replacedSourceFileIds } : {})
      })) {
        retainedEntityIds.add(row.id);
      }
    }
    const deletedEvidenceForPredicate = [...new Set([
      ...evidenceIds,
      ...(input.alreadyDeletedEvidenceIds ?? [])
    ])].sort();
    if (deletedEvidenceForPredicate.length === 0) {
      for (const id of candidateEntityIds) retainedEntityIds.add(id);
    } else {
      for (const row of await input.db.query<IdRow>(
        "MATCH (source:Contract)-[r:CONTRACT_MENTIONS]->(n:Entity) " +
        "WHERE source.workspaceId=$workspaceId AND source.generation=$generation " +
        "AND r.workspaceId=$workspaceId AND r.generation=$generation AND NOT (r.evidenceId IN $deletedEvidenceIds) " +
        "AND n.workspaceId=$workspaceId AND n.generation=$generation AND n.id IN $candidateEntityIds " +
        "AND (r.active IS NULL OR r.active=true) RETURN n.id AS id;",
        { ...scopeParams, candidateEntityIds, deletedEvidenceIds: deletedEvidenceForPredicate }
      )) retainedEntityIds.add(row.id);
    }
  }
  const alreadyDeletedEntities = new Set(input.alreadyDeletedEntityIds ?? []);
  for (const facts of graphFacts) {
    for (const entity of facts.entities) {
      if (candidateEntityIds.includes(entity.id)) retainedEntityIds.add(entity.id);
    }
    for (const edge of facts.mentions) {
      if (candidateEntityIds.includes(edge.entityId)) retainedEntityIds.add(edge.entityId);
    }
    for (const edge of facts.contractEntities) {
      if (candidateEntityIds.includes(edge.entityId)) retainedEntityIds.add(edge.entityId);
    }
  }
  const entityIds = candidateEntityIds
    .filter((id) => !retainedEntityIds.has(id) && !alreadyDeletedEntities.has(id));

  return { deletedSpecIds, evidenceIds, contractIds, entityIds };
}

/** Applies only the prevalidated stable-ID deletes inside the provider commit. */
export async function applyIncrementalSchemaSupportGc(input: {
  db: GraphDB;
  scope: PublicGraphGenerationScope;
  plan: IncrementalSchemaSupportGcPlan;
}): Promise<void> {
  const { db, scope, plan } = input;
  if (plan.evidenceIds.length > 0) {
    for (const relation of [...ALL_EVIDENCE_REL_TYPES, "SEMANTIC_REL"] as const) {
      await db.query(
        `MATCH ()-[r:${relation}]->() WHERE r.workspaceId=$workspaceId AND r.generation=$generation AND r.evidenceId IN $evidenceIds DELETE r;`,
        { ...scope, evidenceIds: plan.evidenceIds }
      );
    }
  }
  for (const [label, ids] of [
    ["Evidence", plan.evidenceIds],
    ["Contract", plan.contractIds],
    ["Entity", plan.entityIds]
  ] as const) {
    if (ids.length === 0) continue;
    await db.query(
      `MATCH (n:${label}) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND n.storageId IN $storageIds DETACH DELETE n;`,
      { ...scope, storageIds: ids.map((id) => publicNodeStorageId(scope.generation, id)) }
    );
  }
}
