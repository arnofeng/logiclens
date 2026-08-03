import type { ContractEntityEdge, ContractNode, ContractSpecEdge, ContractSpecNode, EntityNode, EvidenceNode, RepoContractEdge, SemanticRelationEdge } from "../../parsing/types.js";
import type { ParsedGraphFile } from "../../parsing/types.js";
import type { SchemaSpec } from "../spec.js";
import type {
  ResolutionContextFact,
  ResolutionScopeDependencyFact,
  SchemaDependencyFact,
  SchemaDiagnosticFact,
  SchemaRelationProvenance,
  SchemaRootReference,
  TypeDeclarationFact,
  TypeExpression,
  TypeInstanceIdentity,
  CanonicalTypeExpression
} from "../../schema/model.js";
import type { SchemaDeclarationCandidate } from "../../schema/model.js";
import { canonicalSerialize, createSchemaSpec, schemaSpecId, stableFactId, typeDeclarationIdentityId } from "../../schema/model.js";
import type { SchemaBehaviorFingerprint } from "../../schema/model.js";
import { createSchemaBehaviorFingerprint } from "../../schema/typeSystem.js";
import type { ResolutionResult } from "../../schema/typeSystem.js";
import { IndexedTypeSystemAdapter, type IndexedSchemaDeclaration, type IndexedTypeSystemRules } from "../../schema/indexedTypeSystemAdapter.js";
import { materializeSchemaRoot } from "../../schema/materializer.js";
import { contract, evidence } from "./builtin/shared.js";
import { entityId } from "../../../shared/path.js";
import { buildSchemaSourceContexts, type SchemaSourceResolutionContext } from "../../schema/sourceScopes.js";
import { preferredSemanticRelation, semanticRelationDedupKey } from "./dedup.js";

export interface SchemaInternalFacts {
  declarations: TypeDeclarationFact[];
  resolutionContexts: ResolutionContextFact[];
  resolutionScopeDependencies: ResolutionScopeDependencyFact[];
  roots: SchemaRootReference[];
  dependencies: SchemaDependencyFact[];
  provenance: SchemaRelationProvenance[];
  diagnostics: SchemaDiagnosticFact[];
  fingerprints: SchemaBehaviorFingerprint[];
}

export interface ReconciledSchemaFacts {
  contractSpecs: ContractSpecNode[];
  semanticRelations: SemanticRelationEdge[];
  materialized: {
    contracts: ContractNode[];
    evidence: EvidenceNode[];
    repoContracts: RepoContractEdge[];
    contractSpecEdges: ContractSpecEdge[];
    entities: EntityNode[];
    contractEntities: ContractEntityEdge[];
  };
  internal: SchemaInternalFacts;
}

const RULE_SET_VERSION = "non-java-schema-rules-v1";
const COMMON_SCALARS: Readonly<Record<string, string>> = Object.freeze({
  any: "any", unknown: "unknown", object: "object", string: "string", str: "string", char: "string",
  boolean: "boolean", bool: "boolean", number: "number", integer: "integer", int: "integer", int32: "integer", int64: "integer",
  float: "number", double: "number", bytes: "bytes", byte: "integer", bigint: "bigint", void: "void", null: "null",
  uuid: "uuid", date: "date", datetime: "date"
});

export function reconcileNonJavaSchemaFacts(
  contractSpecs: readonly ContractSpecNode[],
  existingRelations: readonly SemanticRelationEdge[],
  declarationCandidates: readonly SchemaDeclarationCandidate[] = [],
  options: {
    sourceFiles?: readonly ParsedGraphFile[];
    resolutionContexts?: readonly ResolutionContextFact[];
  } = {}
): ReconciledSchemaFacts {
  const explicitSchemaIds = new Set(contractSpecs.filter(isExplicitSchemaNode).map((node) => node.id));
  const candidateMaterializations = declarationCandidates.map(materializationForCandidate);
  const allContractSpecs = [...new Map([...contractSpecs, ...candidateMaterializations.map((item) => item.node)].map((node) => [node.id, node])).values()];
  const candidateByDeclarationId = new Map(candidateMaterializations.map((item) => [item.spec.identity.declarationId, item.candidate]));
  const parsedSchemas = allContractSpecs.flatMap((node) => {
    const spec = parseSchema(node.specJson);
    return spec && spec.languageId !== "java" ? [{ node, spec }] : [];
  });
  const declarations: TypeDeclarationFact[] = parsedSchemas.map(({ node, spec }) => {
    const candidate = candidateByDeclarationId.get(spec.identity.declarationId);
    return {
      id: typeDeclarationIdentityId(spec.declaration),
      identity: spec.declaration,
      fileId: node.fileId,
      declarationKind: spec.shape.kind,
      typeParameters: candidate?.typeParameters ?? [],
      candidate,
      generation: ""
    };
  });
  const declarationsById = new Map(declarations.map((fact) => [fact.id, fact]));
  const contexts = new Map<string, ResolutionContextFact>();
  const sourceContexts = buildSchemaSourceContexts(options.sourceFiles ?? [], declarations, declarationCandidates);
  const sourceContextsByFile = new Map(sourceContexts.map((context) => [`${context.repoId}\0${context.fileId}`, context]));
  for (const context of options.resolutionContexts ?? []) {
    if (!sourceContextsByFile.has(`${context.repoId}\0${context.fileId}`)) {
      sourceContextsByFile.set(`${context.repoId}\0${context.fileId}`, {
        languageId: context.languageId,
        repoId: context.repoId,
        fileId: context.fileId,
        resolutionScopeId: context.resolutionScopeId,
        namespaceId: context.namespaceId ?? context.resolutionScopeId,
        imports: context.imports
      });
    }
  }
  const adapters = new Map<string, IndexedTypeSystemAdapter>();

  for (const { spec } of parsedSchemas) {
    const key = adapterKey(spec.declaration.languageId, spec.declaration.repoId);
    if (adapters.has(key)) continue;
    const indexed: IndexedSchemaDeclaration[] = parsedSchemas
      .filter((item) => adapterKey(item.spec.declaration.languageId, item.spec.declaration.repoId) === key)
      .map((item) => ({ fact: declarationsById.get(item.spec.identity.declarationId)!, shape: item.spec.shape }));
    adapters.set(key, new IndexedTypeSystemAdapter(rulesFor(spec.declaration.languageId), indexed));
  }

  const diagnostics = new Map<string, SchemaDiagnosticFact>();
  const dependencies = new Map<string, SchemaDependencyFact>();
  const provenance = new Map<string, SchemaRelationProvenance>();
  const relations = new Map<string, SemanticRelationEdge>();
  const roots: SchemaRootReference[] = [];
  const updatedNodes: ContractSpecNode[] = [];
  const contextsByDeclarationId = new Map<string, ResolutionContextFact>();
  const materializedIdentities = new Map<string, TypeInstanceIdentity>();
  for (const { node, spec } of parsedSchemas) {
    contextsByDeclarationId.set(
      spec.identity.declarationId,
      contextFor(spec, node.fileId, contexts, sourceContextsByFile.get(`${node.repoId}\0${node.fileId}`))
    );
  }
  const mergeMaterialized = (materialized: ReturnType<typeof materializeSchemaRoot>): void => {
    for (const type of materialized.types) materializedIdentities.set(schemaSpecId(type.identity), type.identity);
    for (const relation of materialized.relations) recordRelation(relations, relation);
    for (const dependency of materialized.dependencies) dependencies.set(dependency.id, dependency);
    for (const fact of materialized.provenance) provenance.set(fact.id, fact);
    for (const diagnostic of materialized.diagnostics) diagnostics.set(diagnostic.id, diagnostic);
  };
  const recordExplicitReference = (
    node: ContractSpecNode,
    expression: TypeExpression,
    context: ResolutionContextFact,
    adapter: IndexedTypeSystemAdapter,
    fieldPath: string[],
    ownerInstance: TypeInstanceIdentity
  ): void => {
    if (!explicitSchemaIds.has(node.id)) return;
    const rawTypeExpression = typeExpressionDisplay(expression);
    const root: SchemaRootReference = {
      id: stableFactId("schema-root", {
        repoId: node.repoId,
        ownerSpecId: node.id,
        relationKind: "USES_SCHEMA",
        fieldPath,
        expression
      }),
      repoId: node.repoId,
      ownerSpecId: node.id,
      ownerFileId: node.fileId,
      relationKind: "USES_SCHEMA",
      languageId: context.languageId,
      frameworkId: node.framework ?? "explicit-schema",
      rawTypeExpression,
      resolutionContextId: context.id,
      slot: { kind: "field", name: fieldPath.join(".") },
      evidenceId: node.evidenceId,
      generation: ""
    };
    roots.push(root);
    mergeMaterialized(materializeSchemaRoot({
      adapter,
      root,
      context,
      contextForDeclaration: (declarationId) => contextsByDeclarationId.get(declarationId),
      initialExpression: expression,
      ownerInstance
    }));
  };

  for (const node of allContractSpecs) {
    const schema = parseSchema(node.specJson);
    if (!schema || schema.languageId === "java" || schema.shape.kind !== "object") {
      updatedNodes.push(node);
      continue;
    }
    const context = contextFor(schema, node.fileId, contexts, sourceContextsByFile.get(`${node.repoId}\0${node.fileId}`));
    contextsByDeclarationId.set(schema.identity.declarationId, context);
    const adapter = adapters.get(adapterKey(context.languageId, context.repoId))!;
    const fields = schema.shape.fields.map((field) => {
      if (field.type.kind === "resolved") {
        if (typeInstances(field.type.expression).length > 0) {
          recordExplicitReference(node, typeExpressionForCanonical(field.type.expression), context, adapter, [field.serializedName], schema.identity);
        }
        return field;
      }
      const resolved = adapter.resolveFieldType(field.type.normalizedExpression, context);
      if (resolved.kind !== "resolved") {
        if (explicitSchemaIds.has(node.id)) {
          recordExplicitReference(node, field.type.normalizedExpression, context, adapter, [field.serializedName], schema.identity);
        } else {
          const diagnostic = diagnosticFor(resolved.kind, resolved.diagnosticId, field.type.normalizedExpression, context, node.id, field.serializedName);
          diagnostics.set(diagnostic.id, diagnostic);
        }
        return { ...field, type: resolved };
      }
      if (typeInstances(resolved.expression).length > 0) {
        recordExplicitReference(node, typeExpressionForCanonical(resolved.expression), context, adapter, [field.serializedName], schema.identity);
      }
      return { ...field, type: resolved };
    });
    for (const [index, expression] of (schema.shape.baseTypes ?? []).entries()) {
      const resolved = adapter.resolveFieldType(expression, context);
      const fieldPath = ["$base", String(index)];
      if (resolved.kind !== "resolved") {
        if (explicitSchemaIds.has(node.id)) {
          recordExplicitReference(node, expression, context, adapter, fieldPath, schema.identity);
        } else {
          const diagnostic = diagnosticFor(resolved.kind, resolved.diagnosticId, expression, context, node.id, fieldPath.join("."));
          diagnostics.set(diagnostic.id, diagnostic);
        }
        continue;
      }
      if (typeInstances(resolved.expression).length > 0) {
        recordExplicitReference(node, typeExpressionForCanonical(resolved.expression), context, adapter, fieldPath, schema.identity);
      }
    }
    updatedNodes.push({ ...node, specJson: JSON.stringify({ ...schema, shape: { kind: "object", fields, baseTypes: schema.shape.baseTypes } }) });
  }

  const reconciledSchemas = updatedNodes.flatMap((node) => {
    const spec = parseSchema(node.specJson);
    return spec && spec.languageId !== "java" ? [{ node, spec }] : [];
  });
  adapters.clear();
  for (const { spec } of reconciledSchemas) {
    const key = adapterKey(spec.declaration.languageId, spec.declaration.repoId);
    if (adapters.has(key)) continue;
    const indexed: IndexedSchemaDeclaration[] = reconciledSchemas
      .filter((item) => adapterKey(item.spec.declaration.languageId, item.spec.declaration.repoId) === key)
      .map((item) => ({ fact: declarationsById.get(item.spec.identity.declarationId)!, shape: item.spec.shape }));
    adapters.set(key, new IndexedTypeSystemAdapter(rulesFor(spec.declaration.languageId), indexed));
  }
  for (const sourceContext of sourceContexts) {
    const key = adapterKey(sourceContext.languageId, sourceContext.repoId);
    if (!adapters.has(key)) adapters.set(key, new IndexedTypeSystemAdapter(rulesFor(sourceContext.languageId), []));
  }

  for (const node of updatedNodes) {
    const typedSlots = typedSlotsFor(node);
    if (typedSlots.length === 0) continue;
    const sourceContext = sourceContextsByFile.get(`${node.repoId}\0${node.fileId}`);
    const repoAdapters = [...adapters.entries()].filter(([key]) => key.split("\0")[1] === node.repoId
      && (!sourceContext || key.split("\0")[0] === sourceContext.languageId))
      .sort(([left], [right]) => left.localeCompare(right));
    for (const slot of typedSlots) {
      const attempts = repoAdapters.flatMap(([, adapter]) => {
        const declarationsForAdapter = adapter.indexDeclarations({ generation: "", files: [] });
        const declaration = declarationsForAdapter.find((fact) => fact.fileId === node.fileId) ?? declarationsForAdapter[0];
        if (!sourceContext && !declaration) return [];
        const context = sourceContext
          ? contextForSource(sourceContext, contexts)
          : contextForDeclaration(declaration!, node.fileId, contexts);
        const expression = adapter.parseTypeExpression(slot.rawType, context);
        return [{ adapter, context, expression, resolution: resolveRootType(adapter, expression, context) }];
      });
      const resolvedAttempts = attempts.filter((attempt): attempt is typeof attempt & { resolution: Extract<ResolutionResult, { kind: "resolved" }> } => attempt.resolution.kind === "resolved");
      const selected = resolvedAttempts.length === 1
        ? resolvedAttempts[0]
        : resolvedAttempts.length === 0 && attempts.length === 1 ? attempts[0] : undefined;
      if (!selected) {
        const fallbackDeclaration = repoAdapters.flatMap(([, adapter]) => adapter.indexDeclarations({ generation: "", files: [] }))[0];
        const context = attempts[0]?.context ?? (sourceContext
          ? contextForSource(sourceContext, contexts)
          : fallbackDeclaration ? contextForDeclaration(fallbackDeclaration, node.fileId, contexts) : undefined);
        const code = resolvedAttempts.length > 1 ? "ambiguous" : failureCode(attempts.map((attempt) => attempt.resolution));
        if (!code) continue;
        const id = stableFactId("schema-diagnostic", { code, repoId: node.repoId, ownerSpecId: node.id, rawType: slot.rawType });
        diagnostics.set(id, {
          id, generation: "", repoId: node.repoId, sourceFileId: node.fileId, ownerSpecId: node.id,
          code, symbol: slot.rawType,
          scope: context ? { languageId: context.languageId, repoId: context.repoId, resolutionScopeId: context.resolutionScopeId } : undefined
        });
        continue;
      }
      const root: SchemaRootReference = {
        id: stableFactId("schema-root", { repoId: node.repoId, ownerSpecId: node.id, relationKind: slot.kind, slot: slot.slot, rawType: slot.rawType }),
        repoId: node.repoId,
        ownerSpecId: node.id,
        ownerFileId: node.fileId,
        relationKind: slot.kind,
        languageId: selected.adapter.languageId,
        frameworkId: node.framework ?? node.specKind,
        rawTypeExpression: slot.rawType,
        resolutionContextId: selected.context.id,
        slot: slot.slot,
        evidenceId: node.evidenceId,
        generation: ""
      };
      roots.push(root);
      const materialized = materializeSchemaRoot({
        adapter: selected.adapter,
        root,
        context: selected.context,
        contextForDeclaration: (declarationId) => contextsByDeclarationId.get(declarationId)
      });
      mergeMaterialized(materialized);
    }
  }

  const reconciledSchemaByDeclarationId = new Map(reconciledSchemas.map((item) => [item.spec.identity.declarationId, item]));
  const existingNodeIds = new Set(updatedNodes.map((node) => node.id));
  for (const [id, identity] of materializedIdentities) {
    if (existingNodeIds.has(id)) continue;
    const declaration = reconciledSchemaByDeclarationId.get(identity.declarationId);
    if (!declaration) continue;
    const instanceSpec: SchemaSpec = { ...declaration.spec, id, identity };
    updatedNodes.push({ ...declaration.node, id, specJson: canonicalSerialize(instanceSpec) });
    existingNodeIds.add(id);
  }

  for (const relation of existingRelations) recordRelation(relations, relation);

  const reachableSchemaIds = new Set<string>(explicitSchemaIds);
  for (const relation of relations.values()) {
    if (relation.kind === "REQUEST_SCHEMA" || relation.kind === "RESPONSE_SCHEMA" || relation.kind === "EVENT_PAYLOAD") reachableSchemaIds.add(relation.toSpecId);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const relation of relations.values()) {
      if (relation.kind !== "USES_SCHEMA" || !reachableSchemaIds.has(relation.fromSpecId) || reachableSchemaIds.has(relation.toSpecId)) continue;
      reachableSchemaIds.add(relation.toSpecId);
      expanded = true;
    }
  }
  const materializedNodes = updatedNodes.filter((node) => node.specKind !== "schema" || reachableSchemaIds.has(node.id));
  const specIds = new Set(materializedNodes.map((node) => node.id));
  const materializedDeclarationIds = new Set(materializedNodes.flatMap((node) => {
    const spec = parseSchema(node.specJson);
    return spec ? [spec.identity.declarationId] : [];
  }));
  const materializedCandidates = candidateMaterializations.filter((item) => materializedDeclarationIds.has(item.spec.identity.declarationId));
  const scopeDependencies = new Map<string, ResolutionScopeDependencyFact>();
  for (const context of contexts.values()) {
    const targetScopes = [...new Set(context.imports.map((binding) => binding.resolutionScopeId))].sort();
    for (const [order, targetScopeId] of targetScopes.entries()) {
      if (targetScopeId === context.resolutionScopeId) continue;
      const fact: ResolutionScopeDependencyFact = {
        id: stableFactId("scope-dependency", {
          from: { languageId: context.languageId, repoId: context.repoId, resolutionScopeId: context.resolutionScopeId },
          to: { languageId: context.languageId, repoId: context.repoId, resolutionScopeId: targetScopeId },
          kind: "module",
          order
        }),
        from: { languageId: context.languageId, repoId: context.repoId, resolutionScopeId: context.resolutionScopeId },
        to: { languageId: context.languageId, repoId: context.repoId, resolutionScopeId: targetScopeId },
        kind: "module",
        order,
        generation: ""
      };
      scopeDependencies.set(fact.id, fact);
    }
  }

  return {
    contractSpecs: materializedNodes,
    semanticRelations: [...relations.values()].filter((relation) => specIds.has(relation.fromSpecId) && specIds.has(relation.toSpecId)).sort((a, b) => relationKey(a).localeCompare(relationKey(b))),
    materialized: {
      contracts: materializedCandidates.map((item) => item.contractNode),
      evidence: materializedCandidates.map((item) => item.evidenceNode),
      repoContracts: materializedCandidates.map((item) => item.repoContract),
      contractSpecEdges: materializedCandidates.flatMap((item) => materializedNodes.flatMap((node) => {
        const spec = parseSchema(node.specJson);
        return spec?.identity.declarationId === item.spec.identity.declarationId ? [{ ...item.edge, specId: node.id }] : [];
      })),
      entities: materializedCandidates.map((item) => item.entity),
      contractEntities: materializedCandidates.map((item) => item.contractEntity)
    },
    internal: {
      declarations: declarations.sort(byId),
      resolutionContexts: [...contexts.values()].sort(byId),
      resolutionScopeDependencies: [...scopeDependencies.values()].sort(byId),
      roots: roots.sort(byId),
      dependencies: [...dependencies.values()].sort(byId),
      provenance: [...provenance.values()].sort(byId),
      diagnostics: [...diagnostics.values()].sort(byId),
      fingerprints: buildBehaviorFingerprints({
        adapters,
        declarations,
        contexts: [...contexts.values()],
        scopeDependencies: [...scopeDependencies.values()],
        roots,
        sourceFiles: options.sourceFiles ?? []
      })
    }
  };
}

function buildBehaviorFingerprints(input: {
  adapters: ReadonlyMap<string, IndexedTypeSystemAdapter>;
  declarations: readonly TypeDeclarationFact[];
  contexts: readonly ResolutionContextFact[];
  scopeDependencies: readonly ResolutionScopeDependencyFact[];
  roots: readonly SchemaRootReference[];
  sourceFiles: readonly ParsedGraphFile[];
}): SchemaBehaviorFingerprint[] {
  const contextById = new Map(input.contexts.map((context) => [context.id, context]));
  const scopes = new Map<string, { languageId: string; repoId: string; resolutionScopeId: string }>();
  for (const declaration of input.declarations) {
    const scope = declaration.identity;
    scopes.set(`${scope.languageId}\0${scope.repoId}\0${scope.resolutionScopeId}`, scope);
  }
  for (const context of input.contexts) {
    scopes.set(`${context.languageId}\0${context.repoId}\0${context.resolutionScopeId}`, {
      languageId: context.languageId,
      repoId: context.repoId,
      resolutionScopeId: context.resolutionScopeId
    });
  }
  return [...scopes.values()].flatMap((scope) => {
    const adapter = input.adapters.get(adapterKey(scope.languageId, scope.repoId));
    if (!adapter) return [];
    const scopedDeclarations = input.declarations
      .filter((fact) => fact.identity.languageId === scope.languageId
        && fact.identity.repoId === scope.repoId
        && fact.identity.resolutionScopeId === scope.resolutionScopeId)
      .map((fact) => ({
        identity: fact.identity,
        fileId: fact.fileId,
        declarationKind: fact.declarationKind,
        typeParameters: fact.typeParameters,
        shape: fact.candidate?.shape.kind === "object"
          ? {
            kind: "object",
            fields: fact.candidate.shape.fields.map((field) => ({
              sourceName: field.sourceName,
              serializedName: field.serializedName,
              type: field.type,
              optional: field.optional,
              nullable: field.nullable,
              sourceFileId: field.sourceLocation.fileId
            })),
            baseTypes: fact.candidate.shape.baseTypes ?? []
          }
          : fact.candidate?.shape
      }))
      .sort((left, right) => typeDeclarationIdentityId(left.identity).localeCompare(typeDeclarationIdentityId(right.identity)));
    const scopedContexts = input.contexts
      .filter((context) => context.languageId === scope.languageId
        && context.repoId === scope.repoId
        && context.resolutionScopeId === scope.resolutionScopeId)
      .map((context) => ({
        fileId: context.fileId,
        namespaceId: context.namespaceId ?? "",
        imports: [...context.imports].sort((left, right) => stableFactId("binding", left).localeCompare(stableFactId("binding", right)))
      }))
      .sort((left, right) => left.fileId.localeCompare(right.fileId));
    const contextIds = new Set(input.contexts
      .filter((context) => context.languageId === scope.languageId
        && context.repoId === scope.repoId
        && context.resolutionScopeId === scope.resolutionScopeId)
      .map((context) => context.id));
    const scopedRoots = input.roots
      .filter((root) => contextIds.has(root.resolutionContextId))
      .map((root) => ({
        id: root.id,
        ownerFileId: root.ownerFileId,
        ownerSpecId: root.ownerSpecId,
        relationKind: root.relationKind,
        rawTypeExpression: root.rawTypeExpression
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const scopedDependencies = input.scopeDependencies
      .filter((fact) => fact.from.languageId === scope.languageId
        && fact.from.repoId === scope.repoId
        && fact.from.resolutionScopeId === scope.resolutionScopeId)
      .map((fact) => ({ from: fact.from, to: fact.to, kind: fact.kind, order: fact.order }))
      .sort((left, right) => stableFactId("scope-dependency-input", left).localeCompare(stableFactId("scope-dependency-input", right)));
    return [createSchemaBehaviorFingerprint({
      ...scope,
      adapterVersion: adapter.adapterVersion,
      ruleSetVersion: adapter.ruleSetVersion,
      serializationVersion: adapter.serializationVersion,
      maxDepth: adapter.maxDepth,
      maxTypesPerRoot: adapter.maxTypesPerRoot,
      buildInputsHash: stableFactId("schema-build-inputs", {
        declarations: scopedDeclarations,
        contexts: scopedContexts,
        roots: scopedRoots,
        scopeDependencies: scopedDependencies
      }),
      generation: ""
    })];
  }).sort(byId);
}

function materializationForCandidate(candidate: SchemaDeclarationCandidate): {
  candidate: SchemaDeclarationCandidate;
  spec: SchemaSpec;
  contractNode: ContractNode;
  evidenceNode: EvidenceNode;
  repoContract: RepoContractEdge;
  node: ContractSpecNode;
  edge: ContractSpecEdge;
  entity: EntityNode;
  contractEntity: ContractEntityEdge;
} {
  const spec = createSchemaSpec({
    declaration: candidate.declaration,
    displayName: candidate.displayName,
    shape: candidate.shape
  });
  const contractNode = contract("schema", candidate.declaration.canonicalName, `Schema ${candidate.displayName}`);
  const evidenceNode = evidence({
    repoId: candidate.declaration.repoId,
    fileId: candidate.fileId,
    filePath: candidate.filePath,
    line: candidate.evidence.line,
    raw: candidate.evidence.raw,
    rule: candidate.evidence.rule,
    confidence: candidate.evidence.confidence
  });
  const node: ContractSpecNode = {
    id: spec.id,
    contractId: contractNode.id,
    specKind: "schema",
    repoId: candidate.declaration.repoId,
    fileId: candidate.fileId,
    evidenceId: evidenceNode.id,
    sourceSymbolId: candidate.sourceSymbolId,
    canonicalKey: contractNode.key,
    framework: candidate.framework,
    specJson: canonicalSerialize(spec),
    confidence: candidate.evidence.confidence
  };
  const entityName = schemaEntityName(candidate.displayName);
  const entity: EntityNode = {
    id: entityId(entityName),
    name: entityName,
    kind: "domain",
    description: "Domain entity inferred from a contract-reachable schema"
  };
  return {
    candidate,
    spec,
    contractNode,
    evidenceNode,
    repoContract: {
      repoId: candidate.declaration.repoId,
      contractId: contractNode.id,
      role: "shared",
      evidenceId: evidenceNode.id,
      confidence: candidate.evidence.confidence
    },
    node,
    edge: {
      contractId: contractNode.id,
      specId: spec.id,
      evidenceId: evidenceNode.id,
      confidence: candidate.evidence.confidence
    },
    entity,
    contractEntity: {
      contractId: contractNode.id,
      entityId: entity.id,
      evidenceId: evidenceNode.id,
      confidence: candidate.evidence.confidence
    }
  };
}

function schemaEntityName(displayName: string): string {
  const terminal = displayName.split(/[.$/]/u).filter(Boolean).at(-1) ?? displayName;
  const stripped = terminal.replace(/(?:Request|Response|DTO|Dto|Payload|Schema|Config)$/u, "");
  return stripped.length >= 3 ? stripped : terminal;
}

function parseSchema(raw: string): SchemaSpec | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<SchemaSpec>;
    return parsed.kind === "schema" && parsed.declaration && parsed.identity && parsed.shape ? parsed as SchemaSpec : undefined;
  } catch {
    return undefined;
  }
}

function isExplicitSchemaNode(node: ContractSpecNode): boolean {
  if (node.specKind !== "schema") return false;
  // TypeScript interfaces and Go structs are declaration-index inputs. They
  // can re-enter the active catalog on changed-only runs, but must never turn
  // into explicit public roots merely because a previous generation reached
  // and materialized them.
  return node.framework !== "ts-schema" && node.framework !== "go-struct";
}

function rulesFor(languageId: string): IndexedTypeSystemRules {
  return {
    languageId,
    adapterVersion: "1",
    ruleSetVersion: RULE_SET_VERSION,
    serializationVersion: "schema-wire-v2",
    maxDepth: 12,
    maxTypesPerRoot: 256,
    scalars: COMMON_SCALARS,
    externalSymbols: ["System", "google.protobuf", "GraphQL", "typing", "time", "net/url"],
    wrappers: wrappersFor(languageId)
  };
}

function wrappersFor(languageId: string): IndexedTypeSystemRules["wrappers"] {
  if (languageId === "typescript") return [
    { canonicalSymbol: "typescript.Promise", sourceSymbols: ["Promise"], behavior: "transparent", argumentIndexes: [0] },
    { canonicalSymbol: "typescript.Array", sourceSymbols: ["Array"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "typescript.ReadonlyArray", sourceSymbols: ["ReadonlyArray"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "typescript.Map", sourceSymbols: ["Map"], behavior: "map-value", argumentIndexes: [1] },
    { canonicalSymbol: "typescript.Record", sourceSymbols: ["Record"], behavior: "map-value", argumentIndexes: [1] }
  ];
  if (languageId === "python") return [
    { canonicalSymbol: "typing.Optional", sourceSymbols: ["Optional"], behavior: "transparent", argumentIndexes: [0] },
    { canonicalSymbol: "builtins.list", sourceSymbols: ["list", "List"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "typing.Sequence", sourceSymbols: ["Sequence"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "builtins.dict", sourceSymbols: ["dict", "Dict"], behavior: "map-value", argumentIndexes: [1] }
  ];
  if (languageId === "csharp") return [
    { canonicalSymbol: "System.Threading.Tasks.Task", sourceSymbols: ["Task"], behavior: "transparent", argumentIndexes: [0] },
    { canonicalSymbol: "System.Threading.Tasks.ValueTask", sourceSymbols: ["ValueTask"], behavior: "transparent", argumentIndexes: [0] },
    { canonicalSymbol: "Microsoft.AspNetCore.Mvc.ActionResult", sourceSymbols: ["ActionResult"], behavior: "transparent", argumentIndexes: [0] },
    { canonicalSymbol: "System.Collections.Generic.List", sourceSymbols: ["List"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "System.Collections.Generic.IEnumerable", sourceSymbols: ["IEnumerable"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "System.Collections.Generic.ICollection", sourceSymbols: ["ICollection"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "System.Collections.Generic.IList", sourceSymbols: ["IList"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "System.Collections.Generic.IReadOnlyCollection", sourceSymbols: ["IReadOnlyCollection"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "System.Collections.Generic.IReadOnlyList", sourceSymbols: ["IReadOnlyList"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "System.Collections.Generic.Collection", sourceSymbols: ["Collection"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "System.Collections.Generic.HashSet", sourceSymbols: ["HashSet"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "System.Collections.Generic.ISet", sourceSymbols: ["ISet"], behavior: "collection", argumentIndexes: [0] },
    { canonicalSymbol: "System.Collections.Generic.Dictionary", sourceSymbols: ["Dictionary"], behavior: "map-value", argumentIndexes: [1] },
    { canonicalSymbol: "System.Collections.Generic.IDictionary", sourceSymbols: ["IDictionary"], behavior: "map-value", argumentIndexes: [1] },
    { canonicalSymbol: "System.Collections.Generic.IReadOnlyDictionary", sourceSymbols: ["IReadOnlyDictionary"], behavior: "map-value", argumentIndexes: [1] },
    { canonicalSymbol: "System.Collections.Generic.SortedDictionary", sourceSymbols: ["SortedDictionary"], behavior: "map-value", argumentIndexes: [1] }
  ];
  return [];
}

function contextFor(
  schema: SchemaSpec,
  fileId: string,
  contexts: Map<string, ResolutionContextFact>,
  source?: SchemaSourceResolutionContext
): ResolutionContextFact {
  if (source) return contextForSource(source, contexts);
  return contextForDeclaration({
    id: schema.identity.declarationId,
    identity: schema.declaration,
    fileId,
    declarationKind: schema.shape.kind,
    typeParameters: [],
    generation: ""
  }, fileId, contexts);
}

function contextForDeclaration(declaration: TypeDeclarationFact, fileId: string, contexts: Map<string, ResolutionContextFact>): ResolutionContextFact {
  const key = `${scopeKey(declaration.identity.languageId, declaration.identity.repoId, declaration.identity.resolutionScopeId)}\0${fileId}`;
  const existing = contexts.get(key);
  if (existing) return existing;
  const context: ResolutionContextFact = {
    id: stableFactId("resolution-context", { scope: declaration.identity, fileId }),
    languageId: declaration.identity.languageId,
    repoId: declaration.identity.repoId,
    resolutionScopeId: declaration.identity.resolutionScopeId,
    fileId,
    namespaceId: declaration.identity.resolutionScopeId,
    imports: [],
    enclosingDeclarationIds: [],
    genericBindings: [],
    generation: ""
  };
  contexts.set(key, context);
  return context;
}

function contextForSource(source: SchemaSourceResolutionContext, contexts: Map<string, ResolutionContextFact>): ResolutionContextFact {
  const key = `${scopeKey(source.languageId, source.repoId, source.resolutionScopeId)}\0${source.fileId}`;
  const existing = contexts.get(key);
  if (existing) return existing;
  const context: ResolutionContextFact = {
    id: stableFactId("resolution-context", {
      languageId: source.languageId,
      repoId: source.repoId,
      resolutionScopeId: source.resolutionScopeId,
      fileId: source.fileId,
      namespaceId: source.namespaceId,
      imports: source.imports
    }),
    languageId: source.languageId,
    repoId: source.repoId,
    resolutionScopeId: source.resolutionScopeId,
    fileId: source.fileId,
    namespaceId: source.namespaceId,
    imports: [...source.imports],
    enclosingDeclarationIds: [],
    genericBindings: [],
    generation: ""
  };
  contexts.set(key, context);
  return context;
}

function typedSlotsFor(node: ContractSpecNode): { rawType: string; kind: SchemaRootReference["relationKind"]; slot: SchemaRootReference["slot"] }[] {
  try {
    const spec = JSON.parse(node.specJson) as Record<string, unknown>;
    if (spec.kind === "http-endpoint") return [
      ...(typeof spec.requestBodyType === "string" ? [{ rawType: spec.requestBodyType, kind: "REQUEST_SCHEMA" as const, slot: { kind: "parameter" as const, index: 0, name: "body" } }] : []),
      ...(typeof spec.responseBodyType === "string" ? [{ rawType: spec.responseBodyType, kind: "RESPONSE_SCHEMA" as const, slot: { kind: "return" as const } }] : [])
    ];
    if (spec.kind === "grpc-method") return [
      ...(typeof spec.requestType === "string" ? [{ rawType: spec.requestType, kind: "REQUEST_SCHEMA" as const, slot: { kind: "parameter" as const, index: 0, name: "request" } }] : []),
      ...(typeof spec.responseType === "string" ? [{ rawType: spec.responseType, kind: "RESPONSE_SCHEMA" as const, slot: { kind: "return" as const } }] : [])
    ];
    if (spec.kind === "graphql-operation") return [
      ...(Array.isArray(spec.requestTypes) ? spec.requestTypes.flatMap((rawType, index) => typeof rawType === "string"
        ? [{ rawType, kind: "REQUEST_SCHEMA" as const, slot: { kind: "parameter" as const, index } }]
        : []) : []),
      ...(typeof spec.requestType === "string" ? [{ rawType: spec.requestType, kind: "REQUEST_SCHEMA" as const, slot: { kind: "parameter" as const, index: 0, name: "input" } }] : []),
      ...(typeof spec.responseType === "string" ? [{ rawType: spec.responseType, kind: "RESPONSE_SCHEMA" as const, slot: { kind: "return" as const } }] : [])
    ];
    if (spec.kind === "event" && typeof spec.payloadType === "string") return [{ rawType: spec.payloadType, kind: "EVENT_PAYLOAD", slot: { kind: "payload" } }];
  } catch {}
  return [];
}

function diagnosticFor(kind: "external-symbol" | "unresolved" | "ambiguous" | "unsupported", id: string, expression: TypeExpression, context: ResolutionContextFact, ownerSpecId: string, field: string): SchemaDiagnosticFact {
  const diagnosticId = stableFactId("schema-diagnostic", {
    diagnosticId: id,
    ownerSpecId,
    sourceFileId: context.fileId,
    fieldPath: [field]
  });
  return {
    id: diagnosticId, generation: "", repoId: context.repoId, sourceFileId: context.fileId, ownerSpecId,
    scope: { languageId: context.languageId, repoId: context.repoId, resolutionScopeId: context.resolutionScopeId },
    code: kind === "external-symbol" ? "external" : kind,
    symbol: expression.kind === "reference" ? expression.name : JSON.stringify(expression),
    fieldPath: [field]
  };
}

function failureCode(results: readonly ResolutionResult[]): SchemaDiagnosticFact["code"] | undefined {
  if (results.length === 0) return "unresolved";
  if (results.some((result) => result.kind === "ambiguous")) return "ambiguous";
  if (results.some((result) => result.kind === "unsupported")) return "unsupported";
  if (results.some((result) => result.kind === "external")) return "external";
  if (results.every((result) => result.kind === "scalar")) return undefined;
  return "unresolved";
}

function typeInstances(expression: CanonicalTypeExpression): { declarationId: string; arguments: CanonicalTypeExpression[] }[] {
  switch (expression.kind) {
    case "type-instance": return [{ declarationId: expression.declarationId, arguments: expression.arguments }, ...expression.arguments.flatMap(typeInstances)];
    case "array": return typeInstances(expression.element);
    case "map": return [...typeInstances(expression.key), ...typeInstances(expression.value)];
    case "union":
    case "intersection": return expression.members.flatMap(typeInstances);
    case "nullable": return typeInstances(expression.inner);
    case "wildcard": return expression.type ? typeInstances(expression.type) : [];
    default: return [];
  }
}

function typeExpressionForCanonical(expression: CanonicalTypeExpression): TypeExpression {
  switch (expression.kind) {
    case "type-instance": return expression.arguments.length === 0
      ? { kind: "reference", name: expression.declarationId }
      : {
        kind: "application",
        target: { kind: "reference", name: expression.declarationId },
        arguments: expression.arguments.map(typeExpressionForCanonical)
      };
    case "scalar": return { kind: "reference", name: expression.name };
    case "array": return { kind: "array", element: typeExpressionForCanonical(expression.element) };
    case "map": return { kind: "map", key: typeExpressionForCanonical(expression.key), value: typeExpressionForCanonical(expression.value) };
    case "union": return { kind: "union", members: expression.members.map(typeExpressionForCanonical) };
    case "intersection": return { kind: "intersection", members: expression.members.map(typeExpressionForCanonical) };
    case "wildcard": return { kind: "wildcard", bound: expression.bound, type: expression.type ? typeExpressionForCanonical(expression.type) : undefined };
    case "nullable": return { kind: "nullable", inner: typeExpressionForCanonical(expression.inner) };
    case "literal": return expression;
  }
}

function typeExpressionDisplay(expression: TypeExpression): string {
  switch (expression.kind) {
    case "reference": return expression.name;
    case "application": return `${typeExpressionDisplay(expression.target)}<${expression.arguments.map(typeExpressionDisplay).join(",")}>`;
    case "array": return `array<${typeExpressionDisplay(expression.element)}>`;
    case "map": return `map<${typeExpressionDisplay(expression.key)},${typeExpressionDisplay(expression.value)}>`;
    case "union": return expression.members.map(typeExpressionDisplay).join(" | ");
    case "intersection": return expression.members.map(typeExpressionDisplay).join(" & ");
    case "variable": return expression.name;
    case "wildcard": return expression.type
      ? `? ${expression.bound ?? ""} ${typeExpressionDisplay(expression.type)}`.replace(/\s+/gu, " ").trim()
      : "?";
    case "nullable": return `${typeExpressionDisplay(expression.inner)}?`;
    case "literal": return expression.value;
    case "opaque": return expression.canonicalText;
  }
}

function resolveRootType(adapter: IndexedTypeSystemAdapter, expression: TypeExpression, context: ResolutionContextFact): ResolutionResult {
  const pending = [expression];
  let lastFailure: ResolutionResult | undefined;
  while (pending.length > 0) {
    const current = pending.shift()!;
    const projection = adapter.projectType(current, context);
    if (projection.kind === "transparent") {
      pending.unshift(...projection.expressions);
      continue;
    }
    const resolved = adapter.resolveType(projection.kind === "materialized" ? projection.expression : current, context);
    if (resolved.kind === "resolved") return resolved;
    lastFailure = resolved;
  }
  return lastFailure ?? { kind: "unsupported", diagnostic: {
    id: stableFactId("schema-diagnostic", { code: "unsupported", expression }), generation: "", code: "unsupported"
  } };
}

function relationKey(relation: SemanticRelationEdge): string {
  return semanticRelationDedupKey(relation);
}

function recordRelation(
  relations: Map<string, SemanticRelationEdge>,
  relation: SemanticRelationEdge
): void {
  const key = relationKey(relation);
  const current = relations.get(key);
  relations.set(key, current ? preferredSemanticRelation(current, relation) : relation);
}

function scopeKey(languageId: string, repoId: string, resolutionScopeId: string): string {
  return `${languageId}\0${repoId}\0${resolutionScopeId}`;
}

function adapterKey(languageId: string, repoId: string): string {
  return `${languageId}\0${repoId}`;
}

function byId<T extends { id: string }>(a: T, b: T): number { return a.id.localeCompare(b.id); }
