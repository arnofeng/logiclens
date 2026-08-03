import type { GraphDB, GraphValue } from "../graph-model/db.js";
import { publicNodeStorageId } from "../graph-model/publicGraphGeneration.js";
import { systemId } from "../graph-model/schema.js";
import type { GraphFactsBatch } from "../graph-model/facts.js";
import type { IncrementalIndexMutationSet } from "./incrementalMutation.js";
import { incrementalSchemaPublicGraphDelta } from "../schema/staging.js";
import type { SchemaInternalFactKind } from "../schema/generationStore.js";

const PUBLIC_NODE_LABELS = [
  "System",
  "Repo",
  "File",
  "Code",
  "Section",
  "Entity",
  "Operation",
  "Workflow",
  "Contract",
  "Evidence",
  "ContractSpec"
] as const;

type PublicNodeLabel = typeof PUBLIC_NODE_LABELS[number];

type EndpointRegistry = {
  upserts: Map<PublicNodeLabel, Set<string>>;
  deletes: Map<PublicNodeLabel, Set<string>>;
  required: Map<PublicNodeLabel, Map<string, Set<string>>>;
};

const INTERNAL_ENDPOINT_KINDS = ["declaration", "root", "relation"] as const;

type InternalEndpointKind = typeof INTERNAL_ENDPOINT_KINDS[number];

type InternalEndpointRegistry = {
  upserts: Map<InternalEndpointKind, Set<string>>;
  deletes: Map<InternalEndpointKind, Set<string>>;
  required: Map<InternalEndpointKind, Map<string, Set<string>>>;
};

const INTERNAL_FACT_TABLES: Partial<Record<SchemaInternalFactKind, string>> = {
  declarations: "TypeDeclarationFact",
  roots: "SchemaRootFact"
};

function emptySets(): Map<PublicNodeLabel, Set<string>> {
  return new Map(PUBLIC_NODE_LABELS.map((label) => [label, new Set<string>()]));
}

function createRegistry(): EndpointRegistry {
  return {
    upserts: emptySets(),
    deletes: emptySets(),
    required: new Map(PUBLIC_NODE_LABELS.map((label) => [label, new Map<string, Set<string>>()]))
  };
}

function createInternalRegistry(): InternalEndpointRegistry {
  return {
    upserts: new Map(INTERNAL_ENDPOINT_KINDS.map((kind) => [kind, new Set<string>()])),
    deletes: new Map(INTERNAL_ENDPOINT_KINDS.map((kind) => [kind, new Set<string>()])),
    required: new Map(INTERNAL_ENDPOINT_KINDS.map((kind) => [kind, new Map<string, Set<string>>()]))
  };
}

function addNode(target: Map<PublicNodeLabel, Set<string>>, label: PublicNodeLabel, id: string): void {
  target.get(label)!.add(id);
}

function requireNode(registry: EndpointRegistry, label: PublicNodeLabel, id: string, reason: string): void {
  if (!id) throw new Error(`Incremental ${reason} contains an empty ${label} endpoint.`);
  const reasons = registry.required.get(label)!.get(id) ?? new Set<string>();
  reasons.add(reason);
  registry.required.get(label)!.set(id, reasons);
}

function requireInternalEndpoint(
  registry: InternalEndpointRegistry,
  kind: InternalEndpointKind,
  id: string,
  reason: string
): void {
  if (!id) throw new Error(`Incremental ${reason} contains an empty Schema ${kind} endpoint.`);
  const reasons = registry.required.get(kind)!.get(id) ?? new Set<string>();
  reasons.add(reason);
  registry.required.get(kind)!.set(id, reasons);
}

function registerFacts(registry: EndpointRegistry, facts: GraphFactsBatch): void {
  addNode(registry.upserts, "System", systemId);
  for (const value of facts.repos) addNode(registry.upserts, "Repo", value.id);
  for (const value of facts.files) addNode(registry.upserts, "File", value.id);
  for (const value of facts.code) addNode(registry.upserts, "Code", value.id);
  for (const value of facts.sections) addNode(registry.upserts, "Section", value.id);
  for (const value of facts.entities) addNode(registry.upserts, "Entity", value.id);
  for (const value of facts.operations) addNode(registry.upserts, "Operation", value.id);
  for (const value of facts.workflows) addNode(registry.upserts, "Workflow", value.id);
  for (const value of facts.contracts) addNode(registry.upserts, "Contract", value.id);
  for (const value of facts.evidence) addNode(registry.upserts, "Evidence", value.id);
  for (const value of facts.contractSpecs) addNode(registry.upserts, "ContractSpec", value.id);

  // The merge/bulk writers materialize Repo-[HAS_EVIDENCE]->Evidence for
  // every Evidence node even though that derived edge is not stored in the
  // GraphFactsBatch relationship arrays.
  for (const value of facts.evidence) {
    requireNode(registry, "Repo", value.repoId, "HAS_EVIDENCE source");
  }

  for (const edge of facts.contains) {
    if (edge.fromId.startsWith("system:")) {
      requireNode(registry, "System", edge.fromId, "CONTAINS source");
      requireNode(registry, "Repo", edge.toId, "CONTAINS target");
    } else if (edge.fromId.startsWith("repo:")) {
      requireNode(registry, "Repo", edge.fromId, "CONTAINS source");
      requireNode(registry, "File", edge.toId, "CONTAINS target");
    } else if (edge.toId.startsWith("section:")) {
      requireNode(registry, "File", edge.fromId, "CONTAINS source");
      requireNode(registry, "Section", edge.toId, "CONTAINS target");
    } else {
      requireNode(registry, "File", edge.fromId, "CONTAINS source");
      requireNode(registry, "Code", edge.toId, "CONTAINS target");
    }
  }
  for (const edge of facts.imports) {
    requireNode(registry, "File", edge.fromFileId, "IMPORTS source");
    requireNode(registry, "File", edge.toFileId, "IMPORTS target");
  }
  for (const edge of facts.calls) {
    requireNode(registry, "Code", edge.fromCodeId, "CALLS source");
    requireNode(registry, "Code", edge.toCodeId, "CALLS target");
  }
  for (const edge of facts.mentions) {
    requireNode(registry, edge.sourceKind === "code" ? "Code" : "Section", edge.fromId, "MENTIONS source");
    requireNode(registry, "Entity", edge.entityId, "MENTIONS target");
  }
  for (const edge of facts.sectionDescribesRepos) {
    requireNode(registry, "Section", edge.sectionId, "DESCRIBES source");
    requireNode(registry, "Repo", edge.repoId, "DESCRIBES target");
  }
  for (const edge of facts.sectionDocumentsCode) {
    requireNode(registry, "Section", edge.sectionId, "DOCUMENTS source");
    requireNode(registry, "Code", edge.codeId, "DOCUMENTS target");
  }
  for (const edge of facts.sectionReferencesFile) {
    requireNode(registry, "Section", edge.sectionId, "REFERENCES source");
    requireNode(registry, "File", edge.fileId, "REFERENCES target");
  }
  for (const edge of facts.repoContracts) {
    requireNode(registry, "Repo", edge.repoId, `${edge.role.toUpperCase()} source`);
    requireNode(registry, "Contract", edge.contractId, `${edge.role.toUpperCase()} target`);
    requireNode(registry, "Evidence", edge.evidenceId, `${edge.role.toUpperCase()} evidence`);
  }
  for (const edge of facts.packageUsages) {
    requireNode(registry, "Repo", edge.repoId, "USES_PACKAGE source");
    requireNode(registry, "Contract", edge.packageContractId, "USES_PACKAGE target");
    requireNode(registry, "Evidence", edge.evidenceId, "USES_PACKAGE evidence");
  }
  for (const edge of facts.contractEntities) {
    requireNode(registry, "Contract", edge.contractId, "CONTRACT_MENTIONS source");
    requireNode(registry, "Entity", edge.entityId, "CONTRACT_MENTIONS target");
    requireNode(registry, "Evidence", edge.evidenceId, "CONTRACT_MENTIONS evidence");
  }
  for (const edge of facts.operationRepos) {
    requireNode(registry, "Repo", edge.repoId, "PARTICIPATES_IN source");
    requireNode(registry, "Operation", edge.operationId, "PARTICIPATES_IN target");
    requireNode(registry, "Evidence", edge.evidenceId, "PARTICIPATES_IN evidence");
  }
  for (const edge of facts.workflowOperations) {
    requireNode(registry, "Workflow", edge.workflowId, "WORKFLOW_STEP source");
    requireNode(registry, "Operation", edge.operationId, "WORKFLOW_STEP target");
    requireNode(registry, "Evidence", edge.evidenceId, "WORKFLOW_STEP evidence");
  }
  for (const edge of facts.repoDependencies) registerDependency(registry, edge, "DEPENDS_ON");
  for (const edge of facts.contractSpecEdges) {
    requireNode(registry, "Contract", edge.contractId, "HAS_SPEC source");
    requireNode(registry, "ContractSpec", edge.specId, "HAS_SPEC target");
    requireNode(registry, "Evidence", edge.evidenceId, "HAS_SPEC evidence");
  }
  for (const edge of facts.semanticRelations) registerSemanticRelation(registry, edge, "SEMANTIC_REL");
}

function registerSemanticRelation(
  registry: EndpointRegistry,
  edge: { fromSpecId: string; toSpecId: string; evidenceId: string },
  reason: string
): void {
  requireNode(registry, "ContractSpec", edge.fromSpecId, `${reason} source`);
  requireNode(registry, "ContractSpec", edge.toSpecId, `${reason} target`);
  requireNode(registry, "Evidence", edge.evidenceId, `${reason} evidence`);
}

function registerDependency(
  registry: EndpointRegistry,
  edge: {
    fromRepoId: string;
    toRepoId: string;
    sourceContractId: string;
    targetContractId: string;
    evidenceId: string;
  },
  reason: string
): void {
  requireNode(registry, "Repo", edge.fromRepoId, `${reason} source repo`);
  requireNode(registry, "Repo", edge.toRepoId, `${reason} target repo`);
  requireNode(registry, "Contract", edge.sourceContractId, `${reason} source contract`);
  requireNode(registry, "Contract", edge.targetContractId, `${reason} target contract`);
  requireNode(registry, "Evidence", edge.evidenceId, `${reason} evidence`);
}

function registerDeletes(registry: EndpointRegistry, mutationSet: IncrementalIndexMutationSet): void {
  for (const mutation of mutationSet.repoMutations) {
    const replacement = mutation.publicGraph.replacement;
    for (const id of replacement.deletedFileIds) addNode(registry.deletes, "File", id);
    for (const id of replacement.staleCodeIds) addNode(registry.deletes, "Code", id);
    for (const id of replacement.staleSectionIds) addNode(registry.deletes, "Section", id);
    for (const id of replacement.staleEvidenceIds) addNode(registry.deletes, "Evidence", id);
    for (const id of replacement.staleSpecIds) addNode(registry.deletes, "ContractSpec", id);
    for (const id of replacement.orphanEntityIds) addNode(registry.deletes, "Entity", id);
    for (const id of replacement.orphanOperationIds) addNode(registry.deletes, "Operation", id);
    for (const id of replacement.orphanWorkflowIds) addNode(registry.deletes, "Workflow", id);
    for (const id of replacement.orphanContractIds) addNode(registry.deletes, "Contract", id);
  }
  for (const change of mutationSet.schemaVisibility?.visibilityChanges ?? []) {
    if (change.entityKind === "schema-spec" && change.nextCount === 0) {
      addNode(registry.deletes, "ContractSpec", change.entityId);
    }
  }
  for (const id of mutationSet.schemaSupportGc?.evidenceIds ?? []) addNode(registry.deletes, "Evidence", id);
  for (const id of mutationSet.schemaSupportGc?.contractIds ?? []) addNode(registry.deletes, "Contract", id);
  for (const id of mutationSet.schemaSupportGc?.entityIds ?? []) addNode(registry.deletes, "Entity", id);
}

async function registerInternalSchemaEndpoints(
  db: GraphDB,
  mutationSet: IncrementalIndexMutationSet,
  publicRegistry: EndpointRegistry,
  registry: InternalEndpointRegistry
): Promise<void> {
  for (const change of mutationSet.schemaVisibility?.visibilityChanges ?? []) {
    if (change.entityKind !== "logical-relation") continue;
    registry[change.nextCount > 0 ? "upserts" : "deletes"].get("relation")!.add(change.entityId);
  }

  const sourceReplacements = mutationSet.repoMutations.flatMap((mutation) => mutation.schema.sourceFactReplacements);
  for (const replacement of sourceReplacements) {
    if (replacement.kind === "declarations") {
      for (const fact of replacement.facts) registry.upserts.get("declaration")!.add(fact.id);
      continue;
    }
    if (replacement.kind === "roots") {
      for (const fact of replacement.facts) registry.upserts.get("root")!.add(fact.id);
      continue;
    }
    if (replacement.kind === "dependencies") {
      for (const fact of replacement.facts) {
        const value = schemaFactRecord(fact);
        requireInternalEndpoint(
          registry,
          "root",
          stringProperty(value, "rootReferenceId"),
          `Schema dependency ${fact.id}`
        );
        requireInternalEndpoint(
          registry,
          "declaration",
          stringProperty(value, "declarationId"),
          `Schema dependency ${fact.id}`
        );
      }
      continue;
    }
    if (replacement.kind !== "provenance") continue;
    for (const fact of replacement.facts) {
      const value = schemaFactRecord(fact);
      requireInternalEndpoint(
        registry,
        "root",
        stringProperty(value, "rootReferenceId"),
        `Schema provenance ${fact.id}`
      );
      requireInternalEndpoint(
        registry,
        "relation",
        stringProperty(value, "relationId"),
        `Schema provenance ${fact.id}`
      );
      const declarationIds = value.declarationIds;
      if (!Array.isArray(declarationIds)) {
        throw new Error(`Incremental Schema provenance ${fact.id} has invalid declaration endpoints.`);
      }
      for (const declarationId of declarationIds) {
        requireInternalEndpoint(
          registry,
          "declaration",
          typeof declarationId === "string" ? declarationId : "",
          `Schema provenance ${fact.id}`
        );
      }
      if (value.evidenceId !== undefined) {
        requireNode(
          publicRegistry,
          "Evidence",
          typeof value.evidenceId === "string" ? value.evidenceId : "",
          `Schema provenance ${fact.id}`
        );
      }
    }
  }

  // A source replacement is an overlay: facts omitted by the replacement are
  // deleted in the next view. Resolve those tombstones with exact source reads
  // so a pending dependency cannot keep pointing at a declaration/root that
  // disappears in the same mutation.
  for (const replacement of sourceReplacements) {
    const table = INTERNAL_FACT_TABLES[replacement.kind];
    const endpointKind = replacement.kind === "declarations"
      ? "declaration"
      : replacement.kind === "roots" ? "root" : undefined;
    if (!table || !endpointKind) continue;
    const rows = await db.query<{ factId?: GraphValue }>(
      `MATCH (f:${table}) WHERE f.generation = $generation AND f.repoId = $repoId ` +
      "AND f.fileId = $fileId RETURN f.factId AS factId;",
      {
        generation: mutationSet.targetGeneration,
        repoId: replacement.repoId,
        fileId: replacement.fileId
      }
    );
    const replacementIds = new Set(replacement.facts.map((fact) => fact.id));
    for (const row of rows) {
      if (typeof row.factId === "string" && !replacementIds.has(row.factId)) {
        registry.deletes.get(endpointKind)!.add(row.factId);
      }
    }
  }
}

async function validateInternalSchemaEndpoints(
  db: GraphDB,
  mutationSet: IncrementalIndexMutationSet,
  registry: InternalEndpointRegistry
): Promise<void> {
  for (const kind of INTERNAL_ENDPOINT_KINDS) {
    const upserts = registry.upserts.get(kind)!;
    const deletes = registry.deletes.get(kind)!;
    const required = registry.required.get(kind)!;
    const existingIds = [...required.keys()].filter((id) => !upserts.has(id));
    const deletedRequired = existingIds.filter((id) => deletes.has(id));
    if (deletedRequired.length > 0) throwMissingInternal(kind, deletedRequired, required);
    const lookupIds = existingIds.filter((id) => !deletes.has(id)).sort();
    if (lookupIds.length === 0) continue;
    const rows = kind === "relation"
      ? await db.query<{ id?: GraphValue }>(
        "MATCH (c:SchemaContribution) WHERE c.generation = $generation AND c.entityKind = $entityKind " +
        "AND c.entityId IN $entityIds RETURN DISTINCT c.entityId AS id;",
        {
          generation: mutationSet.targetGeneration,
          entityKind: "logical-relation",
          entityIds: lookupIds
        }
      )
      : await db.query<{ id?: GraphValue }>(
        `MATCH (f:${kind === "declaration" ? "TypeDeclarationFact" : "SchemaRootFact"}) ` +
        "WHERE f.generation = $generation AND f.factId IN $factIds RETURN f.factId AS id;",
        { generation: mutationSet.targetGeneration, factIds: lookupIds }
      );
    const found = new Set(rows.flatMap((row) => typeof row.id === "string" ? [row.id] : []));
    const missing = lookupIds.filter((id) => !found.has(id));
    if (missing.length > 0) throwMissingInternal(kind, missing, required);
  }
}

function schemaFactRecord(fact: object): Record<string, unknown> {
  return fact as unknown as Record<string, unknown>;
}

function stringProperty(value: Readonly<Record<string, unknown>>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

/**
 * Verifies every relationship endpoint against the immutable parent snapshot
 * plus this mutation's node upserts. Queries are exact stable-ID lookups and
 * execute before the provider write transaction starts.
 */
export async function validateIncrementalIndexMutationEndpoints(
  db: GraphDB,
  mutationSet: IncrementalIndexMutationSet
): Promise<void> {
  const registry = createRegistry();
  const internalRegistry = createInternalRegistry();
  for (const mutation of mutationSet.repoMutations) registerFacts(registry, mutation.publicGraph.facts);
  if (mutationSet.schemaVisibility) {
    const schemaDelta = incrementalSchemaPublicGraphDelta(mutationSet.schemaVisibility);
    for (const spec of schemaDelta.upsertSpecs) addNode(registry.upserts, "ContractSpec", spec.id);
    for (const edge of schemaDelta.upsertRelations) {
      registerSemanticRelation(registry, edge, "schema contribution SEMANTIC_REL");
    }
  }
  registerDeletes(registry, mutationSet);
  for (const label of PUBLIC_NODE_LABELS) {
    const upserts = registry.upserts.get(label)!;
    const deletes = registry.deletes.get(label)!;
    const conflicts = [...upserts].filter((id) => deletes.has(id)).sort();
    if (conflicts.length > 0) {
      throw new Error(
        `Incremental public graph mutation cannot both upsert and delete ${label}: ${conflicts.join(", ")}.`
      );
    }
  }
  for (const edge of mutationSet.dependencyMutation?.upsertSemanticRelations ?? []) {
    registerSemanticRelation(registry, edge, "prepared SEMANTIC_REL");
  }
  for (const edge of mutationSet.dependencyMutation?.upsertRepoDependencies ?? []) {
    registerDependency(registry, edge, "prepared DEPENDS_ON");
  }
  await registerInternalSchemaEndpoints(db, mutationSet, registry, internalRegistry);
  await validateInternalSchemaEndpoints(db, mutationSet, internalRegistry);

  for (const label of PUBLIC_NODE_LABELS) {
    const upserts = registry.upserts.get(label)!;
    const deletes = registry.deletes.get(label)!;
    const required = registry.required.get(label)!;
    const existingIds = [...required.keys()].filter((id) => !upserts.has(id));
    const deletedRequired = existingIds.filter((id) => deletes.has(id));
    if (deletedRequired.length > 0) throwMissing(label, deletedRequired, required);
    const lookupIds = existingIds.filter((id) => !deletes.has(id)).sort();
    if (lookupIds.length === 0) continue;
    const rows = await db.query<{ id: string }>(
      `MATCH (n:${label}) WHERE n.workspaceId = $workspaceId AND n.generation = $generation ` +
      `AND n.storageId IN $storageIds${hasActiveProperty(label) ? " AND (n.active IS NULL OR n.active = true)" : ""} ` +
      "RETURN n.id AS id;",
      {
        workspaceId: mutationSet.workspaceId,
        generation: mutationSet.targetGeneration,
        storageIds: lookupIds.map((id) => publicNodeStorageId(mutationSet.targetGeneration, id))
      }
    );
    const found = new Set(rows.map((row) => row.id));
    const missing = lookupIds.filter((id) => !found.has(id));
    if (missing.length > 0) throwMissing(label, missing, required);
  }
}

function hasActiveProperty(label: PublicNodeLabel): boolean {
  return label === "File" || label === "Code" || label === "Section"
    || label === "Evidence" || label === "ContractSpec";
}

function throwMissing(
  label: PublicNodeLabel,
  ids: readonly string[],
  required: ReadonlyMap<string, ReadonlySet<string>>
): never {
  const details = ids.map((id) => `${id} (${[...(required.get(id) ?? [])].sort().join(", ")})`).join("; ");
  throw new Error(`Incremental mutation contains dangling ${label} endpoint(s): ${details}.`);
}

function throwMissingInternal(
  kind: InternalEndpointKind,
  ids: readonly string[],
  required: ReadonlyMap<string, ReadonlySet<string>>
): never {
  const details = ids.map((id) => `${id} (${[...(required.get(id) ?? [])].sort().join(", ")})`).join("; ");
  throw new Error(`Incremental mutation contains dangling Schema ${kind} endpoint(s): ${details}.`);
}
