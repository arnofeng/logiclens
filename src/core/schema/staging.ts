import type { CrossRepoExtraction } from "../contracts/extraction/crossRepoContracts.js";
import type { ParsedGraphFile } from "../parsing/types.js";
import type { LexicalDocument } from "../retrieval/types.js";
import { schemaSpecId, stableFactId } from "./model.js";
import { SchemaGenerationStore, type OwnedSchemaFact, type SchemaBehaviorFingerprintReplacement, type SchemaInternalFactKind } from "./generationStore.js";
import { collapseSemanticRelations, semanticRelationDedupKey } from "../contracts/extraction/dedup.js";
import type { GraphDB } from "../graph-model/db.js";
import { publicNodeStorageId } from "../graph-model/publicGraphGeneration.js";
import type { ContractSpecNode, SemanticRelationEdge } from "../parsing/types.js";

export interface SchemaSourceFactReplacement {
  kind: SchemaInternalFactKind;
  repoId: string;
  fileId: string;
  facts: readonly OwnedSchemaFact[];
}

export interface IncrementalSchemaMutation {
  sourceFactReplacements: SchemaSourceFactReplacement[];
  behaviorFingerprintReplacements: SchemaBehaviorFingerprintReplacement[];
  contributionReplacements: import("./generationStore.js").SchemaContributionReplacement[];
  visibilityChanges: import("./generationStore.js").SchemaContributionVisibilityChange[];
  upsertLexicalDocuments: LexicalDocument[];
  deleteLexicalDocumentIds: string[];
}

export interface IncrementalSchemaPublicGraphDelta {
  upsertSpecs: ContractSpecNode[];
  deleteSpecIds: string[];
  upsertRelations: SemanticRelationEdge[];
  deleteRelations: Array<Pick<SemanticRelationEdge, "fromSpecId" | "toSpecId" | "kind">>;
}

export async function stageSchemaGenerationFacts(input: {
  store: SchemaGenerationStore;
  generation: string;
  parsedFiles: readonly ParsedGraphFile[];
  extraction: CrossRepoExtraction;
  lexicalDocuments: readonly LexicalDocument[];
}): Promise<string[]> {
  const { store, generation, parsedFiles, extraction } = input;
  const rootsById = new Map(extraction.schemaInternalFacts.roots.map((root) => [root.id, root]));
  const collections: Record<Exclude<SchemaInternalFactKind, "fingerprints">, readonly OwnedSchemaFact[]> = {
    declarations: extraction.schemaInternalFacts.declarations.map((fact) => ({ ...fact, repoId: fact.identity.repoId, sourceFileId: fact.fileId })),
    resolutionContexts: extraction.schemaInternalFacts.resolutionContexts.map((fact) => ({ ...fact, sourceFileId: fact.fileId })),
    resolutionScopeDependencies: extraction.schemaInternalFacts.resolutionScopeDependencies.map((fact) => {
      const sourceFileId = extraction.schemaInternalFacts.resolutionContexts.find((context) =>
        context.languageId === fact.from.languageId
        && context.repoId === fact.from.repoId
        && context.resolutionScopeId === fact.from.resolutionScopeId)?.fileId;
      return { ...fact, repoId: fact.from.repoId, ...(sourceFileId ? { sourceFileId } : {}) };
    }),
    roots: extraction.schemaInternalFacts.roots.map((fact) => ({ ...fact, sourceFileId: fact.ownerFileId })),
    dependencies: extraction.schemaInternalFacts.dependencies.map((fact) => ownedByRoot(fact, rootsById)),
    provenance: extraction.schemaInternalFacts.provenance.map((fact) => ownedByRoot(fact, rootsById)),
    diagnostics: extraction.schemaInternalFacts.diagnostics
  };

  const touchedRepoIds = new Set(parsedFiles.map((file) => file.repoId));
  const replacementSources = new Map(parsedFiles.map((file) => [
    `${file.repoId}\0${file.fileId}`,
    { repoId: file.repoId, fileId: file.fileId }
  ]));
  for (const root of extraction.schemaInternalFacts.roots) {
    if (!touchedRepoIds.has(root.repoId)) continue;
    replacementSources.set(`${root.repoId}\0${root.ownerFileId}`, {
      repoId: root.repoId,
      fileId: root.ownerFileId
    });
  }
  for (const fingerprint of extraction.schemaInternalFacts.fingerprints) {
    await store.replaceBehaviorFingerprints({
      generation,
      replacement: {
        repoId: fingerprint.repoId,
        languageId: fingerprint.languageId,
        resolutionScopeId: fingerprint.resolutionScopeId,
        facts: [{ ...fingerprint, generation }]
      }
    });
  }

  for (const source of [...replacementSources.values()].sort((left, right) =>
    left.repoId.localeCompare(right.repoId) || left.fileId.localeCompare(right.fileId))) {
    for (const [kind, facts] of Object.entries(collections) as [SchemaInternalFactKind, readonly OwnedSchemaFact[]][]) {
      const sourceFacts = facts
        .filter((fact) => (fact.repoId === undefined || fact.repoId === source.repoId)
          && (fact.sourceFileId === undefined || fact.sourceFileId === source.fileId))
        .map((fact) => ({ ...fact, generation }));
      await store.replaceSourceFacts({ generation, kind, repoId: source.repoId, fileId: source.fileId, facts: sourceFacts });
    }
  }
  const currentSchemaSpecs = extraction.contractSpecs.filter((spec) => spec.specKind === "schema");
  const candidateSchemaSpecIds = new Set(extraction.schemaInternalFacts.declarations.flatMap((fact) => fact.candidate
    ? [schemaSpecId({ declarationId: fact.id, canonicalTypeArguments: [] })]
    : []));
  for (const spec of currentSchemaSpecs) {
    if (candidateSchemaSpecIds.has(spec.id)) {
      await store.replaceContributions({ generation, rootReferenceId: `declaration:${spec.id}`, contributions: [] });
      continue;
    }
    const ownedRelations = collapseSemanticRelations(
      extraction.semanticRelations.filter((relation) => relation.fromSpecId === spec.id)
    );
    await store.replaceContributions({
      generation,
      rootReferenceId: `declaration:${spec.id}`,
      contributions: [
        { entityKind: "schema-spec", entityId: spec.id, payload: spec },
        ...ownedRelations.map((relation) => ({ entityKind: "logical-relation" as const, entityId: relationContributionId(relation), payload: relationContributionPayload(relation) })),
        ...input.lexicalDocuments.filter((document) => document.canonicalId === spec.id)
          .map((document) => ({ entityKind: "lexical-document" as const, entityId: document.id, payload: document }))
      ]
    });
  }
  const activeLexicalDocuments: LexicalDocument[] = [];
  for (const root of extraction.schemaInternalFacts.roots) {
    const relations = reachableRelations(root.ownerSpecId, extraction.semanticRelations);
    const targetIds = new Set(relations.flatMap((relation) => [relation.fromSpecId, relation.toSpecId]));
    targetIds.delete(root.ownerSpecId);
    const contributions = [
      ...[...targetIds].map((entityId) => ({ entityKind: "schema-spec" as const, entityId })),
      ...relations.map((relation) => ({
        entityKind: "logical-relation" as const,
        entityId: relationContributionId(relation),
        payload: relationContributionPayload(
          relation,
          rootEvidenceId(root.id, relation, extraction.schemaInternalFacts.provenance)
        )
      })),
      ...[...new Map([...activeLexicalDocuments, ...input.lexicalDocuments].map((document) => [document.id, document])).values()]
        .filter((document) => targetIds.has(document.canonicalId))
        .map((document) => ({ entityKind: "lexical-document" as const, entityId: document.id, payload: document }))
    ];
    await store.replaceContributions({ generation, rootReferenceId: root.id, contributions });
  }
  return [];
}

/**
 * Builds a source/root owned schema delta without mutating the active dataset.
 * Every empty collection is retained as an explicit replacement tombstone.
 */
export async function buildIncrementalSchemaMutation(input: {
  store: SchemaGenerationStore;
  generation: string;
  parsedFiles: readonly ParsedGraphFile[];
  removedSources: readonly { repoId: string; fileId: string }[];
  extraction: CrossRepoExtraction;
  lexicalDocuments: readonly LexicalDocument[];
  activeFileIdsByRepo: ReadonlyMap<string, readonly string[]>;
}): Promise<IncrementalSchemaMutation> {
  const rootsById = new Map(input.extraction.schemaInternalFacts.roots.map((root) => [root.id, root]));
  const collections: Record<Exclude<SchemaInternalFactKind, "fingerprints">, readonly OwnedSchemaFact[]> = {
    declarations: input.extraction.schemaInternalFacts.declarations.map((fact) => ({ ...fact, repoId: fact.identity.repoId, sourceFileId: fact.fileId })),
    resolutionContexts: input.extraction.schemaInternalFacts.resolutionContexts.map((fact) => ({ ...fact, sourceFileId: fact.fileId })),
    resolutionScopeDependencies: input.extraction.schemaInternalFacts.resolutionScopeDependencies.map((fact) => {
      const context = input.extraction.schemaInternalFacts.resolutionContexts.find((candidate) =>
        candidate.languageId === fact.from.languageId
        && candidate.repoId === fact.from.repoId
        && candidate.resolutionScopeId === fact.from.resolutionScopeId);
      return { ...fact, repoId: fact.from.repoId, ...(context ? { sourceFileId: context.fileId } : {}) };
    }),
    roots: input.extraction.schemaInternalFacts.roots.map((fact) => ({ ...fact, sourceFileId: fact.ownerFileId })),
    dependencies: input.extraction.schemaInternalFacts.dependencies.map((fact) => ownedByRoot(fact, rootsById)),
    provenance: input.extraction.schemaInternalFacts.provenance.map((fact) => ownedByRoot(fact, rootsById)),
    diagnostics: input.extraction.schemaInternalFacts.diagnostics
  };

  const parsedSources = input.parsedFiles.map((file) => ({ repoId: file.repoId, fileId: file.fileId }));
  const replacementSources = new Map([...parsedSources, ...input.removedSources]
    .map((source) => [`${source.repoId}\0${source.fileId}`, source]));
  for (const root of input.extraction.schemaInternalFacts.roots) {
    if (input.activeFileIdsByRepo.has(root.repoId)) {
      replacementSources.set(`${root.repoId}\0${root.ownerFileId}`, { repoId: root.repoId, fileId: root.ownerFileId });
    }
  }
  const initialSources = [...replacementSources.values()];
  const oldDeclarations = await input.store.factsBySources<OwnedSchemaFact & { fileId?: string }>("declarations", initialSources, input.generation);
  const changedDeclarationIds = [...new Set([
    ...oldDeclarations.map((fact) => fact.id),
    ...input.extraction.schemaInternalFacts.declarations
      .filter((fact) => replacementSources.has(`${fact.identity.repoId}\0${fact.fileId}`))
      .map((fact) => fact.id)
  ])];
  const dependentRoots = await input.store.rootsDependingOnDeclarations<OwnedSchemaFact & { repoId?: string; ownerFileId?: string }>(
    changedDeclarationIds,
    input.generation
  );
  for (const root of dependentRoots) {
    if (root.repoId && root.ownerFileId) {
      replacementSources.set(`${root.repoId}\0${root.ownerFileId}`, { repoId: root.repoId, fileId: root.ownerFileId });
    }
  }

  const sources = [...replacementSources.values()].sort((left, right) =>
    left.repoId.localeCompare(right.repoId) || left.fileId.localeCompare(right.fileId));
  const sourceFactReplacements: SchemaSourceFactReplacement[] = [];
  for (const source of sources) {
    for (const [kind, facts] of Object.entries(collections) as [SchemaInternalFactKind, readonly OwnedSchemaFact[]][]) {
      sourceFactReplacements.push({
        kind,
        repoId: source.repoId,
        fileId: source.fileId,
        facts: facts.filter((fact) => (fact.repoId === undefined || fact.repoId === source.repoId)
          && (fact.sourceFileId === undefined || fact.sourceFileId === source.fileId))
      });
    }
  }

  const oldContextsForSources = await input.store.factsBySources<OwnedSchemaFact & {
    languageId?: string;
    repoId?: string;
    resolutionScopeId?: string;
  }>("resolutionContexts", sources, input.generation);
  const sourceKeys = new Set(sources.map((source) => `${source.repoId}\0${source.fileId}`));
  const behaviorOwners = new Map<string, Omit<SchemaBehaviorFingerprintReplacement, "facts">>();
  const registerBehaviorOwner = (owner: { languageId?: string; repoId?: string; resolutionScopeId?: string }): void => {
    if (!owner.languageId || !owner.repoId || !owner.resolutionScopeId) return;
    const key = `${owner.languageId}\0${owner.repoId}\0${owner.resolutionScopeId}`;
    behaviorOwners.set(key, {
      languageId: owner.languageId,
      repoId: owner.repoId,
      resolutionScopeId: owner.resolutionScopeId
    });
  };
  for (const context of oldContextsForSources) registerBehaviorOwner(context);
  for (const context of input.extraction.schemaInternalFacts.resolutionContexts) {
    if (sourceKeys.has(`${context.repoId}\0${context.fileId}`)) registerBehaviorOwner(context);
  }
  const behaviorFingerprintReplacements = [...behaviorOwners.entries()].map(([key, owner]) => ({
    ...owner,
    facts: input.extraction.schemaInternalFacts.fingerprints.filter((fingerprint) =>
      `${fingerprint.languageId}\0${fingerprint.repoId}\0${fingerprint.resolutionScopeId}` === key)
  })).sort((left, right) =>
    left.repoId.localeCompare(right.repoId)
    || left.languageId.localeCompare(right.languageId)
    || left.resolutionScopeId.localeCompare(right.resolutionScopeId));

  const oldRoots = await input.store.factsBySources<OwnedSchemaFact & { ownerFileId?: string }>("roots", sources, input.generation);
  const oldSourceDeclarations = await input.store.factsBySources<OwnedSchemaFact & { fileId?: string }>("declarations", sources, input.generation);
  const currentRootIds = new Set(input.extraction.schemaInternalFacts.roots.map((root) => root.id));
  const contributionReplacements = new Map<string, import("./generationStore.js").SchemaContributionReplacement>();
  for (const root of oldRoots) {
    if (!currentRootIds.has(root.id)) contributionReplacements.set(root.id, { rootReferenceId: root.id, contributions: [] });
  }

  const currentSchemaSpecs = input.extraction.contractSpecs.filter((spec) => spec.specKind === "schema");
  const currentSchemaSpecIds = new Set(currentSchemaSpecs.map((spec) => spec.id));
  const candidateSchemaSpecIds = new Set(input.extraction.schemaInternalFacts.declarations.flatMap((fact) => fact.candidate
    ? [schemaSpecId({ declarationId: fact.id, canonicalTypeArguments: [] })]
    : []));
  for (const declaration of oldSourceDeclarations) {
    const specId = schemaSpecId({ declarationId: declaration.id, canonicalTypeArguments: [] });
    if (!currentSchemaSpecIds.has(specId)) {
      contributionReplacements.set(`declaration:${specId}`, { rootReferenceId: `declaration:${specId}`, contributions: [] });
    }
  }
  for (const spec of currentSchemaSpecs) {
    if (candidateSchemaSpecIds.has(spec.id)) {
      contributionReplacements.set(`declaration:${spec.id}`, {
        rootReferenceId: `declaration:${spec.id}`,
        contributions: []
      });
      continue;
    }
    const relations = collapseSemanticRelations(input.extraction.semanticRelations.filter((relation) => relation.fromSpecId === spec.id));
    contributionReplacements.set(`declaration:${spec.id}`, {
      rootReferenceId: `declaration:${spec.id}`,
      contributions: [
        { entityKind: "schema-spec", entityId: spec.id, payload: spec },
        ...relations.map((relation) => ({ entityKind: "logical-relation" as const, entityId: relationContributionId(relation), payload: relationContributionPayload(relation) })),
        ...input.lexicalDocuments.filter((document) => document.canonicalId === spec.id)
          .map((document) => ({ entityKind: "lexical-document" as const, entityId: document.id, payload: document }))
      ]
    });
  }

  const rootIds = [
    ...oldRoots.map((root) => root.id),
    ...input.extraction.schemaInternalFacts.roots.map((root) => root.id),
    ...currentSchemaSpecs.map((spec) => `declaration:${spec.id}`)
  ];
  const previousContributions = await input.store.contributionsByRoots(rootIds, input.generation);
  const previousLexicalDocuments = previousContributions.flatMap((contribution) => {
    if (contribution.entityKind !== "lexical-document" || !contribution.payload || typeof contribution.payload !== "object") return [];
    const document = contribution.payload as Partial<LexicalDocument>;
    return typeof document.id === "string" && typeof document.canonicalId === "string" ? [document as LexicalDocument] : [];
  });
  const lexicalDocuments = [...new Map([...previousLexicalDocuments, ...input.lexicalDocuments].map((document) => [document.id, document])).values()];
  for (const root of input.extraction.schemaInternalFacts.roots) {
    if (!replacementSources.has(`${root.repoId}\0${root.ownerFileId}`)) continue;
    const relations = reachableRelations(root.ownerSpecId, input.extraction.semanticRelations);
    const targetIds = new Set(relations.flatMap((relation) => [relation.fromSpecId, relation.toSpecId]));
    targetIds.delete(root.ownerSpecId);
    contributionReplacements.set(root.id, {
      rootReferenceId: root.id,
      contributions: [
        ...[...targetIds].map((entityId) => ({ entityKind: "schema-spec" as const, entityId })),
        ...relations.map((relation) => ({
          entityKind: "logical-relation" as const,
          entityId: relationContributionId(relation),
          payload: relationContributionPayload(
            relation,
            rootEvidenceId(root.id, relation, input.extraction.schemaInternalFacts.provenance)
          )
        })),
        ...lexicalDocuments.filter((document) => targetIds.has(document.canonicalId))
          .map((document) => ({ entityKind: "lexical-document" as const, entityId: document.id, payload: document }))
      ]
    });
  }

  const replacements = [...contributionReplacements.values()].sort((left, right) => left.rootReferenceId.localeCompare(right.rootReferenceId));
  return {
    sourceFactReplacements,
    behaviorFingerprintReplacements,
    contributionReplacements: replacements,
    visibilityChanges: [],
    upsertLexicalDocuments: [],
    deleteLexicalDocumentIds: []
  };
}

/**
 * Reconciles contribution visibility once for the complete workspace mutation.
 * Computing this per repository is incorrect when two changed roots share the
 * same derived schema/relation/document and both disappear in one revision.
 */
export async function buildCombinedIncrementalSchemaVisibility(input: {
  store: SchemaGenerationStore;
  generation: string;
  mutations: readonly IncrementalSchemaMutation[];
}): Promise<IncrementalSchemaMutation> {
  const replacementsByRoot = new Map<string, import("./generationStore.js").SchemaContributionReplacement>();
  for (const mutation of input.mutations) {
    for (const replacement of mutation.contributionReplacements) {
      const previous = replacementsByRoot.get(replacement.rootReferenceId);
      if (previous) {
        throw new Error(`Incremental mutation contains duplicate root replacement ${replacement.rootReferenceId}.`);
      }
      replacementsByRoot.set(replacement.rootReferenceId, replacement);
    }
  }
  const replacements = [...replacementsByRoot.values()]
    .sort((left, right) => left.rootReferenceId.localeCompare(right.rootReferenceId));
  const visibilityChanges = await input.store.contributionVisibilityForReplacements({
    generation: input.generation,
    replacements
  });
  const upsertLexicalDocuments = visibilityChanges.flatMap((change) => {
    if (change.entityKind !== "lexical-document" || change.nextCount === 0) return [];
    const document = change.contributions
      .map((contribution) => parseLexicalContribution(contribution.payload))
      .find((candidate): candidate is LexicalDocument => Boolean(candidate));
    if (!document) return [];
    const previous = change.previousContributions
      .map((contribution) => parseLexicalContribution(contribution.payload))
      .find((candidate): candidate is LexicalDocument => Boolean(candidate));
    // A contribution count change does not imply that the physical search
    // document changed. Keep the existing document when its semantic payload
    // is identical; batch ownership is journal metadata and must not turn a
    // one-root removal into an otherwise unnecessary lexical rewrite.
    if (previous && lexicalDocumentSemanticKey(previous) === lexicalDocumentSemanticKey(document)) return [];
    return [document];
  });
  return {
    sourceFactReplacements: [],
    behaviorFingerprintReplacements: [],
    contributionReplacements: [],
    visibilityChanges,
    upsertLexicalDocuments: [...new Map(upsertLexicalDocuments.map((document) => [document.id, document])).values()]
      .sort((left, right) => left.id.localeCompare(right.id)),
    deleteLexicalDocumentIds: visibilityChanges
      .filter((change) => change.entityKind === "lexical-document" && change.nextCount === 0)
      .map((change) => change.entityId)
      .sort((left, right) => left.localeCompare(right))
  };
}

/**
 * Projects contribution visibility into the public-graph delta used by the
 * incremental dependency planner. This is a read-only projection: the actual
 * contribution/public writes still happen during the guarded provider commit.
 */
export function incrementalSchemaPublicGraphDelta(
  mutation: IncrementalSchemaMutation
): IncrementalSchemaPublicGraphDelta {
  const relationIdentity = (relation: Pick<SemanticRelationEdge, "fromSpecId" | "toSpecId" | "kind">): string =>
    JSON.stringify([relation.fromSpecId, relation.toSpecId, relation.kind]);
  const upsertSpecs: ContractSpecNode[] = [];
  const deleteSpecIds: string[] = [];
  const upsertRelations: SemanticRelationEdge[] = [];
  const deleteRelations: IncrementalSchemaPublicGraphDelta["deleteRelations"] = [];
  for (const change of mutation.visibilityChanges) {
    if (change.entityKind === "schema-spec") {
      if (change.nextCount === 0) {
        deleteSpecIds.push(change.entityId);
        continue;
      }
      const spec = change.contributions
        .map((contribution) => parseSchemaSpecContribution(contribution.payload))
        .find((candidate): candidate is ContractSpecNode => Boolean(candidate));
      if (spec) upsertSpecs.push(spec);
      continue;
    }
    if (change.entityKind !== "logical-relation") continue;
    if (change.nextCount === 0) {
      const relation = change.previousContributions
        .flatMap((contribution) => parseRelationContribution(contribution.payload))[0];
      if (relation) deleteRelations.push({
        fromSpecId: relation.fromSpecId,
        toSpecId: relation.toSpecId,
        kind: relation.kind
      });
      continue;
    }
    const [selected] = collapseSemanticRelations(
      change.contributions.flatMap((contribution) => parseRelationContribution(contribution.payload))
    );
    if (selected) upsertRelations.push(selected);
  }
  return {
    upsertSpecs: [...new Map(upsertSpecs.map((spec) => [spec.id, spec])).values()]
      .sort((left, right) => left.id.localeCompare(right.id)),
    deleteSpecIds: [...new Set(deleteSpecIds)].sort(),
    upsertRelations: collapseSemanticRelations(upsertRelations),
    deleteRelations: [...new Map(deleteRelations.map((relation) => [relationIdentity(relation), relation])).values()]
      .sort((left, right) => relationIdentity(left).localeCompare(relationIdentity(right)))
  };
}

function lexicalDocumentSemanticKey(document: LexicalDocument): string {
  return stableFactId("lexical-document-payload", {
    id: document.id,
    canonicalId: document.canonicalId,
    workspaceId: document.workspaceId,
    repoId: document.repoId,
    kind: document.kind,
    title: document.title,
    qualifiedName: document.qualifiedName ?? null,
    path: document.path ?? null,
    searchableText: document.searchableText,
    tokens: [...document.tokens],
    active: document.active,
    sourceHash: document.sourceHash,
    renderRef: document.renderRef
  });
}

export async function applyIncrementalSchemaMutation(input: {
  db: GraphDB;
  store: SchemaGenerationStore;
  workspaceId: string;
  generation: string;
  revision: string;
  mutation: IncrementalSchemaMutation;
}): Promise<void> {
  await input.store.applyActiveReplacementBatch({
    generation: input.generation,
    revision: input.revision,
    sourceReplacements: input.mutation.sourceFactReplacements,
    behaviorFingerprintReplacements: input.mutation.behaviorFingerprintReplacements,
    contributionReplacements: input.mutation.contributionReplacements
  });
  for (const change of input.mutation.visibilityChanges) {
    if (change.entityKind === "schema-spec" && change.nextCount === 0) {
      const params = {
        workspaceId: input.workspaceId,
        generation: input.generation,
        storageId: publicNodeStorageId(input.generation, change.entityId)
      };
      await input.db.query(
        "MATCH (n:ContractSpec {storageId: $storageId}) WHERE n.workspaceId=$workspaceId AND n.generation=$generation DETACH DELETE n;",
        params
      );
      continue;
    }
    if (change.entityKind === "schema-spec") {
      const spec = change.contributions.flatMap((contribution) => {
        const parsed = parseSchemaSpecContribution(contribution.payload);
        return parsed ? [parsed] : [];
      })[0];
      if (spec) await input.db.upsertContractSpec({ ...spec, active: true }, {
        workspaceId: input.workspaceId,
        generation: input.generation
      });
      continue;
    }
    // Logical semantic relations have one public publisher: the incremental
    // dependency mutation prepared from contribution visibility. Applying
    // them here as well creates a second relation path and is not idempotent
    // on providers that allow parallel relationships.
  }
}

function parseLexicalContribution(payload: unknown): LexicalDocument | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const document = payload as Partial<LexicalDocument>;
  if (typeof document.id !== "string" || typeof document.canonicalId !== "string"
    || typeof document.workspaceId !== "string" || typeof document.repoId !== "string"
    || typeof document.kind !== "string" || typeof document.title !== "string"
    || typeof document.searchableText !== "string" || !Array.isArray(document.tokens)
    || !document.tokens.every((token) => typeof token === "string")
    || typeof document.active !== "boolean" || typeof document.sourceHash !== "string"
    || typeof document.batchId !== "string" || typeof document.renderRef !== "string") return undefined;
  return document as LexicalDocument;
}

function parseSchemaSpecContribution(payload: unknown): ContractSpecNode | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const spec = payload as Partial<ContractSpecNode>;
  if (typeof spec.id !== "string" || typeof spec.contractId !== "string"
    || spec.specKind !== "schema" || typeof spec.repoId !== "string"
    || typeof spec.fileId !== "string" || typeof spec.canonicalKey !== "string"
    || typeof spec.specJson !== "string" || typeof spec.confidence !== "number"
    || typeof spec.batchId !== "string" || typeof spec.indexedAt !== "string"
    || typeof spec.active !== "boolean") return undefined;
  return spec as ContractSpecNode;
}

function parseRelationContribution(payload: unknown): SemanticRelationEdge[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const relation = payload as Partial<SemanticRelationEdge>;
  if (typeof relation.fromSpecId !== "string" || typeof relation.toSpecId !== "string"
    || typeof relation.kind !== "string" || typeof relation.evidenceId !== "string"
    || typeof relation.reason !== "string" || typeof relation.confidence !== "number") return [];
  return [relation as SemanticRelationEdge];
}

function relationContributionPayload(
  relation: CrossRepoExtraction["semanticRelations"][number],
  evidenceId = relation.evidenceId
): CrossRepoExtraction["semanticRelations"][number] {
  return {
    fromSpecId: relation.fromSpecId,
    toSpecId: relation.toSpecId,
    kind: relation.kind,
    evidenceId,
    reason: relation.reason,
    confidence: relation.confidence
  };
}

function rootEvidenceId(
  rootReferenceId: string,
  relation: CrossRepoExtraction["semanticRelations"][number],
  provenance: CrossRepoExtraction["schemaInternalFacts"]["provenance"]
): string | undefined {
  const relationId = relationContributionId(relation);
  return provenance
    .filter((fact) => fact.rootReferenceId === rootReferenceId
      && fact.relationId === relationId
      && fact.evidenceId)
    .map((fact) => fact.evidenceId!)
    .sort((left, right) => left.localeCompare(right))[0];
}

function relationContributionId(relation: CrossRepoExtraction["semanticRelations"][number]): string {
  return stableFactId("schema-relation", {
    fromSpecId: relation.fromSpecId,
    toSpecId: relation.toSpecId,
    kind: relation.kind
  });
}

function reachableRelations(
  ownerSpecId: string,
  relations: readonly CrossRepoExtraction["semanticRelations"][number][]
): CrossRepoExtraction["semanticRelations"] {
  const reachable = new Set([ownerSpecId]);
  const selected = new Map<string, CrossRepoExtraction["semanticRelations"][number]>();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const relation of collapseSemanticRelations(relations)) {
      if (!reachable.has(relation.fromSpecId)) continue;
      if (relation.kind !== "USES_SCHEMA" && relation.fromSpecId !== ownerSpecId) continue;
      const key = semanticRelationDedupKey(relation);
      selected.set(key, relation);
      if (!reachable.has(relation.toSpecId)) {
        reachable.add(relation.toSpecId);
        expanded = true;
      }
    }
  }
  return [...selected.values()];
}

function ownedByRoot<T extends OwnedSchemaFact & { rootReferenceId: string }>(fact: T, roots: ReadonlyMap<string, { repoId: string; ownerFileId: string }>): T {
  const root = roots.get(fact.rootReferenceId);
  return root ? { ...fact, repoId: root.repoId, sourceFileId: root.ownerFileId } : fact;
}
