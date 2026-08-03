import type { GraphFactsBatch } from "../graph-model/facts.js";
import type {
  GraphWriteResult,
  GraphWriterSelection,
  IncrementalPublicGraphReplacementPlan,
  PreparedGraphSummaries
} from "./graphWrite.js";
import type { LexicalWriteResult } from "./lexicalWrite.js";
import type { LexicalDocument } from "../retrieval/types.js";
import type { ParsedGraphFile, RepoNode } from "../parsing/types.js";
import type { IncrementalSchemaMutation } from "../schema/staging.js";
import { canonicalSerialize } from "../schema/model.js";
import type { IncrementalDependencyMutation } from "../graph-model/rebuildRelations.js";
import type { StatsDelta } from "../graph-model/db.js";
import type { IncrementalSchemaSupportGcPlan } from "../schema/publicGraphGc.js";

export interface IncrementalPublicGraphMutation {
  facts: GraphFactsBatch;
  touchedFileIds: readonly string[];
  deletedFileIds: readonly string[];
  activeFileIdsByRepo: ReadonlyMap<string, readonly string[]>;
  replacement: IncrementalPublicGraphReplacementPlan;
}

export interface IncrementalLexicalMutation {
  upsertDocuments: readonly LexicalDocument[];
  // Source replacement and contribution reconciliation can add exact IDs at
  // commit time, but they may never request a generation clone or repo-wide
  // rewrite.
  deleteDocumentIds: string[];
}

export type IncrementalSummaryMutation =
  | { kind: "none" }
  | {
    kind: "prepared";
    payload: PreparedGraphSummaries;
  };

export interface IncrementalRepoMutation {
  batchId: string;
  indexedAt: string;
  repos: readonly RepoNode[];
  parsedFiles: readonly ParsedGraphFile[];
  selection: GraphWriterSelection;
  publicGraph: IncrementalPublicGraphMutation;
  schema: IncrementalSchemaMutation;
  lexical: IncrementalLexicalMutation;
  summaries: IncrementalSummaryMutation;
  reconcileLexicalRepos: boolean;
  lexicalProjectionDurationMs: number;
  applied?: {
    graphWrite: GraphWriteResult;
    lexicalWrite?: LexicalWriteResult;
    filesStaleByRepo: ReadonlyMap<string, number>;
  };
}

export interface IncrementalIndexMutationSet {
  workspaceId: string;
  targetGeneration: string;
  expectedActiveRevision: string;
  nextRevision: string;
  repoMutations: IncrementalRepoMutation[];
  dependencyMutation?: IncrementalDependencyMutation;
  schemaVisibility?: IncrementalSchemaMutation;
  schemaSupportGc?: IncrementalSchemaSupportGcPlan;
  lexicalMutation?: IncrementalLexicalMutation;
  publicGraphStatsDelta?: StatsDelta;
}

export function buildCombinedIncrementalLexicalMutation(
  mutationSet: IncrementalIndexMutationSet
): IncrementalLexicalMutation {
  if (!mutationSet.schemaVisibility) {
    throw new Error("Incremental mutation set is missing combined schema contribution visibility.");
  }
  const upserts = new Map<string, LexicalDocument>();
  const deletes = new Set<string>();
  for (const mutation of mutationSet.repoMutations) {
    for (const document of mutation.lexical.upsertDocuments) upserts.set(document.id, document);
    for (const documentId of mutation.lexical.deleteDocumentIds) deletes.add(documentId);
  }
  for (const document of mutationSet.schemaVisibility.upsertLexicalDocuments) {
    upserts.set(document.id, document);
  }
  for (const documentId of mutationSet.schemaVisibility.deleteLexicalDocumentIds) {
    deletes.add(documentId);
  }
  const conflictingIds = [...deletes].filter((documentId) => upserts.has(documentId)).sort();
  if (conflictingIds.length > 0) {
    throw new Error(
      `Incremental lexical replacement cannot both upsert and delete: ${conflictingIds.join(", ")}.`
    );
  }
  return {
    upsertDocuments: [...upserts.values()].sort((left, right) => left.id.localeCompare(right.id)),
    deleteDocumentIds: [...deletes].sort((left, right) => left.localeCompare(right))
  };
}

export function createIncrementalIndexMutationSet(input: {
  workspaceId: string;
  targetGeneration: string;
  expectedActiveRevision: string;
  nextRevision: string;
}): IncrementalIndexMutationSet {
  return {
    ...input,
    repoMutations: []
  };
}

export function addIncrementalRepoMutation(
  mutationSet: IncrementalIndexMutationSet,
  mutation: IncrementalRepoMutation
): void {
  if (mutation.publicGraph.facts.workspaceId !== mutationSet.workspaceId) {
    throw new Error(`Incremental batch ${mutation.batchId} belongs to a different workspace.`);
  }
  if (mutation.publicGraph.facts.generation !== mutationSet.targetGeneration) {
    throw new Error(`Incremental batch ${mutation.batchId} does not target the active physical generation.`);
  }
  if (mutation.publicGraph.facts.batchId !== mutation.batchId) {
    throw new Error(`Incremental batch ${mutation.batchId} contains graph facts from a different batch.`);
  }
  if (mutation.repos.length === 0) {
    throw new Error(`Incremental batch ${mutation.batchId} has no repository owner.`);
  }
  const existingRepoIds = new Set(mutationSet.repoMutations.flatMap((candidate) => candidate.repos.map((repo) => repo.id)));
  for (const repo of mutation.repos) {
    if (existingRepoIds.has(repo.id)) {
      throw new Error(`Incremental mutation set contains duplicate repository ${repo.id}.`);
    }
  }
  const documentIds = new Set<string>();
  for (const document of mutation.lexical.upsertDocuments) {
    if (document.workspaceId !== mutationSet.workspaceId || document.batchId !== mutation.batchId) {
      throw new Error(`Incremental lexical document ${document.id} has an invalid workspace or batch owner.`);
    }
    if (documentIds.has(document.id)) {
      throw new Error(`Incremental lexical document ${document.id} is duplicated.`);
    }
    documentIds.add(document.id);
  }
  mutationSet.repoMutations.push(mutation);
  mutationSet.repoMutations.sort((left, right) =>
    (left.repos[0]?.id ?? "").localeCompare(right.repos[0]?.id ?? ""));
}

export function validateIncrementalIndexMutationSet(mutationSet: IncrementalIndexMutationSet): void {
  if (!mutationSet.workspaceId || !mutationSet.targetGeneration
    || !mutationSet.expectedActiveRevision || !mutationSet.nextRevision) {
    throw new Error("Incremental mutation publication identities must be non-empty.");
  }
  if (mutationSet.expectedActiveRevision === mutationSet.nextRevision) {
    throw new Error("Incremental mutation must advance to a distinct revision.");
  }
  const batchIds = new Set<string>();
  const repoIds = new Set<string>();
  const nodePayloads = new Map<string, string>();
  const relationshipPayloads = new Map<string, string>();
  const sourceReplacementOwners = new Set<string>();
  const behaviorReplacementOwners = new Set<string>();
  const contributionReplacementOwners = new Set<string>();
  const factOwners = new Map<string, string>();
  const lexicalPayloads = new Map<string, string>();
  const lexicalDeletes = new Set<string>();
  for (const mutation of mutationSet.repoMutations) {
    if (batchIds.has(mutation.batchId)) {
      throw new Error(`Incremental mutation set contains duplicate batch ${mutation.batchId}.`);
    }
    batchIds.add(mutation.batchId);
    for (const repo of mutation.repos) {
      if (repoIds.has(repo.id)) {
        throw new Error(`Incremental mutation set contains duplicate repository ${repo.id}.`);
      }
      repoIds.add(repo.id);
    }
    validatePreparedSummaries(mutation);
    const touched = new Set(mutation.publicGraph.touchedFileIds);
    for (const file of mutation.parsedFiles) {
      if (!touched.has(file.fileId)) {
        throw new Error(`Incremental source ${file.fileId} is missing from its replacement manifest.`);
      }
    }
    const active = new Set([...mutation.publicGraph.activeFileIdsByRepo.values()].flat());
    for (const removedFileId of mutation.publicGraph.deletedFileIds) {
      if (active.has(removedFileId)) {
        throw new Error(`Incremental source ${removedFileId} cannot be both active and deleted.`);
      }
    }
    validatePublicGraphIdentity(mutation.publicGraph.facts, nodePayloads, relationshipPayloads);
    for (const replacement of mutation.schema.sourceFactReplacements) {
      const owner = `${replacement.kind}\0${replacement.repoId}\0${replacement.fileId}`;
      if (sourceReplacementOwners.has(owner)) {
        throw new Error(`Incremental schema mutation contains duplicate source replacement ${owner}.`);
      }
      sourceReplacementOwners.add(owner);
      const ids = new Set<string>();
      for (const fact of replacement.facts) {
        if (ids.has(fact.id)) {
          throw new Error(`Incremental schema source replacement ${owner} contains duplicate fact ${fact.id}.`);
        }
        ids.add(fact.id);
        const previousOwner = factOwners.get(fact.id);
        if (previousOwner && previousOwner !== owner) {
          throw new Error(`Incremental schema fact ${fact.id} is owned by both ${previousOwner} and ${owner}.`);
        }
        factOwners.set(fact.id, owner);
      }
    }
    for (const replacement of mutation.schema.behaviorFingerprintReplacements) {
      const owner = `${replacement.repoId}\0${replacement.languageId}\0${replacement.resolutionScopeId}`;
      if (behaviorReplacementOwners.has(owner)) {
        throw new Error(`Incremental schema mutation contains duplicate behavior replacement ${owner}.`);
      }
      behaviorReplacementOwners.add(owner);
      const ids = new Set<string>();
      for (const fact of replacement.facts) {
        if (ids.has(fact.id)) {
          throw new Error(`Incremental schema behavior replacement ${owner} contains duplicate fact ${fact.id}.`);
        }
        ids.add(fact.id);
        const value = fact as Partial<import("../schema/model.js").SchemaBehaviorFingerprint>;
        if (value.repoId !== replacement.repoId || value.languageId !== replacement.languageId
          || value.resolutionScopeId !== replacement.resolutionScopeId) {
          throw new Error(`Incremental schema behavior fingerprint ${fact.id} does not match owner ${owner}.`);
        }
      }
    }
    for (const replacement of mutation.schema.contributionReplacements) {
      if (contributionReplacementOwners.has(replacement.rootReferenceId)) {
        throw new Error(`Incremental schema mutation contains duplicate root replacement ${replacement.rootReferenceId}.`);
      }
      contributionReplacementOwners.add(replacement.rootReferenceId);
      const entities = new Set<string>();
      for (const contribution of replacement.contributions) {
        const entity = `${contribution.entityKind}\0${contribution.entityId}`;
        if (entities.has(entity)) {
          throw new Error(`Incremental root ${replacement.rootReferenceId} contains duplicate contribution ${entity}.`);
        }
        entities.add(entity);
      }
    }
    for (const document of mutation.lexical.upsertDocuments) {
      registerLexicalPayload(mutationSet.workspaceId, document, lexicalPayloads);
    }
    for (const documentId of mutation.lexical.deleteDocumentIds) lexicalDeletes.add(documentId);
  }
  if (!mutationSet.schemaVisibility) {
    throw new Error("Incremental mutation set is missing combined schema contribution visibility.");
  }
  if (!mutationSet.schemaSupportGc) {
    throw new Error("Incremental mutation set is missing its prepared schema support GC delta.");
  }
  for (const [kind, ids] of Object.entries(mutationSet.schemaSupportGc)) {
    const seenIds = new Set<string>();
    for (const id of ids) {
      if (!id || seenIds.has(id)) {
        throw new Error(`Incremental schema support GC contains an invalid or duplicate ${kind} ID ${id}.`);
      }
      seenIds.add(id);
    }
  }
  if (!mutationSet.lexicalMutation) {
    throw new Error("Incremental mutation set is missing its combined lexical replacement.");
  }
  if (!mutationSet.publicGraphStatsDelta) {
    throw new Error("Incremental mutation set is missing its public graph stats delta.");
  }
  for (const [field, value] of Object.entries(mutationSet.publicGraphStatsDelta)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Incremental public graph stats delta ${field} must be a safe integer.`);
    }
  }
  if (!mutationSet.dependencyMutation) {
    throw new Error("Incremental mutation set is missing its prepared dependency replacement.");
  }
  const affectedSpecs = new Set<string>();
  for (const specId of mutationSet.dependencyMutation.affectedSpecIds) {
    if (!specId || affectedSpecs.has(specId)) {
      throw new Error(`Incremental dependency replacement contains an invalid or duplicate spec ID ${specId}.`);
    }
    affectedSpecs.add(specId);
  }
  const affectedContracts = new Set<string>();
  for (const contractId of mutationSet.dependencyMutation.affectedContractIds) {
    if (!contractId || affectedContracts.has(contractId)) {
      throw new Error(`Incremental dependency replacement contains an invalid or duplicate contract ID ${contractId}.`);
    }
    affectedContracts.add(contractId);
  }
  for (const relation of mutationSet.dependencyMutation.upsertSemanticRelations) {
    if (!affectedSpecs.has(relation.fromSpecId) && !affectedSpecs.has(relation.toSpecId)) {
      throw new Error(`Incremental semantic relation ${relation.fromSpecId} -> ${relation.toSpecId} is outside the affected spec set.`);
    }
  }
  for (const dependency of mutationSet.dependencyMutation.upsertRepoDependencies) {
    if (!affectedContracts.has(dependency.sourceContractId)
      && !affectedContracts.has(dependency.targetContractId)) {
      throw new Error(`Incremental dependency ${dependency.sourceContractId} -> ${dependency.targetContractId} is outside the affected contract set.`);
    }
  }
  for (const document of mutationSet.schemaVisibility.upsertLexicalDocuments) {
    registerLexicalPayload(mutationSet.workspaceId, document, lexicalPayloads);
  }
  for (const documentId of mutationSet.schemaVisibility.deleteLexicalDocumentIds) lexicalDeletes.add(documentId);
  for (const documentId of lexicalDeletes) {
    if (lexicalPayloads.has(documentId)) {
      throw new Error(`Incremental lexical document ${documentId} cannot be both upserted and deleted.`);
    }
  }
  const combinedUpsertIds = mutationSet.lexicalMutation.upsertDocuments.map((document) => document.id);
  const expectedUpsertIds = [...lexicalPayloads.keys()].sort();
  if (canonicalSerialize([...combinedUpsertIds].sort()) !== canonicalSerialize(expectedUpsertIds)) {
    throw new Error("Incremental combined lexical upserts do not match the prepared source/schema mutations.");
  }
  const combinedDeleteIds = [...new Set(mutationSet.lexicalMutation.deleteDocumentIds)].sort();
  if (canonicalSerialize(combinedDeleteIds) !== canonicalSerialize([...lexicalDeletes].sort())) {
    throw new Error("Incremental combined lexical deletes do not match the prepared source/schema mutations.");
  }
}

function validatePreparedSummaries(mutation: IncrementalRepoMutation): void {
  if (mutation.summaries.kind === "none") return;
  const expectedRepoIds = mutation.repos.map((repo) => repo.id).sort((left, right) => left.localeCompare(right));
  const summaryRepoIds = mutation.summaries.payload.repoSummaries.map((summary) => summary.repoId);
  if (summaryRepoIds.some((repoId) => !repoId)) {
    throw new Error(`Incremental batch ${mutation.batchId} contains a summary with no repository identity.`);
  }
  if (new Set(summaryRepoIds).size !== summaryRepoIds.length) {
    throw new Error(`Incremental batch ${mutation.batchId} contains duplicate repository summaries.`);
  }
  const sortedSummaryRepoIds = [...summaryRepoIds].sort((left, right) => left.localeCompare(right));
  if (canonicalSerialize(summaryRepoIds) !== canonicalSerialize(sortedSummaryRepoIds)) {
    throw new Error(`Incremental batch ${mutation.batchId} repository summaries are not canonically ordered.`);
  }
  if (canonicalSerialize(summaryRepoIds) !== canonicalSerialize(expectedRepoIds)) {
    throw new Error(`Incremental batch ${mutation.batchId} repository summaries do not match its repository owners.`);
  }
}

function validatePublicGraphIdentity(
  facts: GraphFactsBatch,
  nodes: Map<string, string>,
  relationships: Map<string, string>
): void {
  for (const [label, values] of [
    ["Repo", facts.repos],
    ["File", facts.files],
    ["Code", facts.code],
    ["Section", facts.sections],
    ["Entity", facts.entities],
    ["Operation", facts.operations],
    ["Workflow", facts.workflows],
    ["Contract", facts.contracts],
    ["Evidence", facts.evidence],
    ["ContractSpec", facts.contractSpecs]
  ] as const) {
    for (const value of values) registerStablePayload(nodes, `${label}\0${value.id}`, value, "node");
  }
  const relationCollections: Array<readonly [string, readonly unknown[]]> = [
    ["CONTAINS", facts.contains.map((edge) => ({ key: `${edge.fromId}\0${edge.toId}`, edge }))],
    ["IMPORTS", facts.imports.map((edge) => ({ key: `${edge.fromFileId}\0${edge.toFileId}\0${edge.module}\0${edge.raw}`, edge }))],
    ["CALLS", facts.calls.map((edge) => ({ key: `${edge.fromCodeId}\0${edge.toCodeId}\0${edge.raw}`, edge }))],
    ["MENTIONS", facts.mentions.map((edge) => ({ key: `${edge.sourceKind}\0${edge.fromId}\0${edge.entityId}`, edge }))],
    ["DESCRIBES", facts.sectionDescribesRepos.map((edge) => ({ key: `${edge.sectionId}\0${edge.repoId}`, edge }))],
    ["DOCUMENTS", facts.sectionDocumentsCode.map((edge) => ({ key: `${edge.sectionId}\0${edge.codeId}`, edge }))],
    ["REFERENCES", facts.sectionReferencesFile.map((edge) => ({ key: `${edge.sectionId}\0${edge.fileId}\0${edge.raw}`, edge }))],
    ["REPO_CONTRACT", facts.repoContracts.map((edge) => ({ key: `${edge.repoId}\0${edge.contractId}\0${edge.role}\0${edge.evidenceId}`, edge }))],
    ["USES_PACKAGE", facts.packageUsages.map((edge) => ({ key: `${edge.repoId}\0${edge.packageContractId}\0${edge.evidenceId}`, edge }))],
    ["CONTRACT_MENTIONS", facts.contractEntities.map((edge) => ({ key: `${edge.contractId}\0${edge.entityId}\0${edge.evidenceId}`, edge }))],
    ["PARTICIPATES_IN", facts.operationRepos.map((edge) => ({ key: `${edge.repoId}\0${edge.operationId}\0${edge.role}\0${edge.evidenceId}`, edge }))],
    ["WORKFLOW_STEP", facts.workflowOperations.map((edge) => ({ key: `${edge.workflowId}\0${edge.operationId}\0${edge.step}\0${edge.evidenceId}`, edge }))],
    ["DEPENDS_ON", facts.repoDependencies.map((edge) => ({ key: `${edge.fromRepoId}\0${edge.toRepoId}\0${edge.dependencyType}\0${edge.evidenceId}`, edge }))],
    ["HAS_SPEC", facts.contractSpecEdges.map((edge) => ({ key: `${edge.contractId}\0${edge.specId}\0${edge.evidenceId}`, edge }))],
    ["SEMANTIC_REL", facts.semanticRelations.map((edge) => ({ key: `${edge.fromSpecId}\0${edge.toSpecId}\0${edge.kind}`, edge }))]
  ];
  for (const [kind, entries] of relationCollections) {
    for (const entry of entries as readonly { key: string; edge: unknown }[]) {
      registerStablePayload(relationships, `${kind}\0${entry.key}`, entry.edge, "relationship");
    }
  }
}

function registerLexicalPayload(
  workspaceId: string,
  document: LexicalDocument,
  payloads: Map<string, string>
): void {
  if (document.workspaceId !== workspaceId) {
    throw new Error(`Incremental lexical document ${document.id} belongs to a different workspace.`);
  }
  registerStablePayload(payloads, document.id, document, "lexical document");
}

function registerStablePayload(
  registry: Map<string, string>,
  identity: string,
  value: unknown,
  kind: string
): void {
  const payload = canonicalSerialize(withoutPublicationMetadata(value));
  const previous = registry.get(identity);
  if (previous !== undefined && previous !== payload) {
    throw new Error(`Incremental ${kind} identity ${identity} has conflicting payloads.`);
  }
  registry.set(identity, payload);
}

function withoutPublicationMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPublicationMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "active" && key !== "batchId" && key !== "indexedAt" && key !== "generation")
    .map(([key, item]) => [key, withoutPublicationMetadata(item)]));
}

export function incrementalMutationIsEmpty(mutationSet: IncrementalIndexMutationSet): boolean {
  return mutationSet.repoMutations.length === 0;
}
