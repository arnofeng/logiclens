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
import type { ResolutionResult, SchemaBehaviorImplementation } from "../../schema/typeSystem.js";
import { IndexedTypeSystemAdapter, type IndexedSchemaDeclaration, type IndexedTypeSystemRules } from "../../schema/indexedTypeSystemAdapter.js";
import { materializeSchemaRoot, type MaterializedSchemaType } from "../../schema/materializer.js";
import { contract, evidence } from "./builtin/shared.js";
import { entityId } from "../../../shared/path.js";
import { buildSchemaSourceContexts, type SchemaSourceResolutionContext } from "../../schema/sourceScopes.js";
import { preferredSemanticRelation, semanticRelationDedupKey } from "./dedup.js";
import { buildProtoJavaIdentityBridge } from "./protoJavaBridge.js";

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
    protoBridgeContractSpecs?: readonly ContractSpecNode[];
  } = {}
): ReconciledSchemaFacts {
  const explicitSchemaIds = new Set(contractSpecs.filter(isExplicitSchemaNode).map((node) => node.id));
  const candidateMaterializations = declarationCandidates.map(materializationForCandidate);
  const allContractSpecs = [...new Map([...contractSpecs, ...candidateMaterializations.map((item) => item.node)].map((node) => [node.id, node])).values()];
  const candidateByDeclarationId = new Map(candidateMaterializations.map((item) => [item.spec.identity.declarationId, item.candidate]));
  const parsedSchemas = allContractSpecs.flatMap((node) => {
    const spec = parseSchema(node.specJson);
    return spec ? [{ node, spec }] : [];
  });
  const declarationFacts: TypeDeclarationFact[] = parsedSchemas.map(({ node, spec }) => {
    const candidate = candidateByDeclarationId.get(spec.identity.declarationId);
    return {
      id: typeDeclarationIdentityId(spec.declaration),
      identity: spec.declaration,
      fileId: node.fileId,
      declarationKind: candidate?.declarationKind ?? spec.shape.kind,
      typeParameters: candidate?.typeParameters ?? [],
      typeParameterBounds: candidate?.typeParameterBounds,
      modifiers: candidate?.modifiers,
      enclosingDeclarationId: candidate?.enclosingDeclarationId,
      candidate,
      generation: ""
    };
  });
  const declarations = [...new Map(declarationFacts
    .sort((left, right) => canonicalSerialize(left).localeCompare(canonicalSerialize(right)))
    .map((fact) => [fact.id, fact])).values()]
    .sort(byId);
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
  for (const sourceContext of sourceContexts) contextForSource(sourceContext, contexts);
  const adapters = new Map<string, IndexedTypeSystemAdapter>();

  for (const { spec } of parsedSchemas) {
    const key = adapterKey(spec.declaration.languageId, spec.declaration.repoId);
    if (adapters.has(key)) continue;
    const indexed: IndexedSchemaDeclaration[] = parsedSchemas
      .filter((item) => adapterKey(item.spec.declaration.languageId, item.spec.declaration.repoId) === key)
      .map((item) => ({ fact: declarationsById.get(item.spec.identity.declarationId)!, shape: item.spec.shape }));
    adapters.set(key, new IndexedTypeSystemAdapter(rulesFor(spec.declaration.languageId), indexed, [...contexts.values()]));
  }

  const diagnostics = new Map<string, SchemaDiagnosticFact>();
  const dependencies = new Map<string, SchemaDependencyFact>();
  const provenance = new Map<string, SchemaRelationProvenance>();
  const relations = new Map<string, SemanticRelationEdge>();
  const roots: SchemaRootReference[] = [];
  const updatedNodes: ContractSpecNode[] = [];
  const contextsByDeclarationId = new Map<string, ResolutionContextFact>();
  const materializedTypes = new Map<string, MaterializedSchemaType>();
  for (const { node, spec } of parsedSchemas) {
    contextsByDeclarationId.set(
      spec.identity.declarationId,
      contextFor(spec, node.fileId, contexts, sourceContextsByFile.get(`${node.repoId}\0${node.fileId}`))
    );
  }
  const mergeMaterialized = (materialized: ReturnType<typeof materializeSchemaRoot>): void => {
    for (const type of materialized.types) materializedTypes.set(schemaSpecId(type.identity), type);
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
    if (!schema || schema.shape.kind !== "object") {
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
    return spec ? [{ node, spec }] : [];
  });
  adapters.clear();
  for (const { spec } of reconciledSchemas) {
    const key = adapterKey(spec.declaration.languageId, spec.declaration.repoId);
    if (adapters.has(key)) continue;
    const indexed: IndexedSchemaDeclaration[] = reconciledSchemas
      .filter((item) => adapterKey(item.spec.declaration.languageId, item.spec.declaration.repoId) === key)
      .map((item) => ({ fact: declarationsById.get(item.spec.identity.declarationId)!, shape: item.spec.shape }));
    adapters.set(key, new IndexedTypeSystemAdapter(rulesFor(spec.declaration.languageId), indexed, [...contexts.values()]));
  }
  for (const sourceContext of sourceContexts) {
    const key = adapterKey(sourceContext.languageId, sourceContext.repoId);
    if (!adapters.has(key)) adapters.set(key, new IndexedTypeSystemAdapter(rulesFor(sourceContext.languageId), [], [...contexts.values()]));
  }
  const protoJavaBridge = buildProtoJavaIdentityBridge(
    options.sourceFiles ?? [],
    [...updatedNodes, ...(options.protoBridgeContractSpecs ?? [])]
  );

  for (const [nodeIndex, originalNode] of updatedNodes.entries()) {
    let node = originalNode;
    if (node.specKind === "grpc-method" && node.framework === "grpc-java") {
      try {
        const spec = JSON.parse(node.specJson) as { kind?: string; service?: string; method?: string; streaming?: string; fullName?: string };
        const methodBridge = spec.kind === "grpc-method" && spec.service && spec.method
          ? protoJavaBridge.resolveMethod(node.fileId, spec.service, spec.method)
          : undefined;
        if (methodBridge) {
          node = { ...node, specJson: JSON.stringify({ ...spec, fullName: methodBridge.fullName, streaming: methodBridge.streaming }) };
          updatedNodes[nodeIndex] = node;
        }
      } catch {}
    }
    const typedSlots = typedSlotsFor(node);
    const sourceContext = sourceContextsByFile.get(`${node.repoId}\0${node.fileId}`);
    if (typedSlots.length === 0) {
      const inferenceDiagnostic = contractInferenceDiagnostic(node, sourceContext);
      if (inferenceDiagnostic) diagnostics.set(inferenceDiagnostic.id, inferenceDiagnostic);
      continue;
    }
    const repoAdapters = [...adapters.entries()].filter(([key]) => key.split("\0")[1] === node.repoId
      && (!sourceContext || key.split("\0")[0] === sourceContext.languageId))
      .sort(([left], [right]) => left.localeCompare(right));
    for (const slot of typedSlots) {
      if (node.specKind === "grpc-method" && node.framework === "grpc-java") {
        let grpcSpec: { requestProtoType?: string; responseProtoType?: string; requestGeneratedJavaType?: string; responseGeneratedJavaType?: string } = {};
        try { grpcSpec = JSON.parse(node.specJson) as typeof grpcSpec; } catch {}
        const persistedJavaType = slot.kind === "REQUEST_SCHEMA" ? grpcSpec.requestGeneratedJavaType : grpcSpec.responseGeneratedJavaType;
        const canonicalResolution = persistedJavaType ? protoJavaBridge.resolveCanonical(node.repoId, persistedJavaType) : undefined;
        const bridgeResolution = canonicalResolution?.kind === "resolved" ? canonicalResolution : protoJavaBridge.resolve(node.fileId, slot.rawType);
        if (bridgeResolution.kind !== "resolved") {
          const code = bridgeResolution.kind;
          const id = stableFactId("schema-diagnostic", { code, ownerSpecId: node.id, rawType: slot.rawType, bridge: "java-grpc-proto" });
          diagnostics.set(id, {
            id, generation: "", repoId: node.repoId, sourceFileId: node.fileId, sourceSymbolId: node.sourceSymbolId,
            ownerSpecId: node.id, code, symbol: slot.rawType, evidenceId: node.evidenceId,
            candidates: bridgeResolution.candidates?.map((canonicalName) => ({
              languageId: "proto", repoId: node.repoId, resolutionScopeId: "proto-bridge", canonicalName
            }))
          });
          continue;
        }
        const targetNode = bridgeResolution.schemaNode ?? reconciledSchemas.find(({ spec }) => (
          spec.languageId === "proto" && spec.declaration.canonicalName === bridgeResolution.protoCanonicalName
        ))?.node;
        const targetSpec = targetNode ? parseSchema(targetNode.specJson) : undefined;
        const targetContext = targetSpec ? contextsByDeclarationId.get(targetSpec.identity.declarationId) : undefined;
        const adapter = adapters.get(adapterKey("proto", node.repoId));
        if (!targetSpec || !targetContext || !adapter) {
          const id = stableFactId("schema-diagnostic", { code: "unsupported", ownerSpecId: node.id, bridgeTarget: bridgeResolution.protoCanonicalName });
          diagnostics.set(id, {
            id, generation: "", repoId: node.repoId, sourceFileId: node.fileId, sourceSymbolId: node.sourceSymbolId,
            ownerSpecId: node.id, code: "unsupported", symbol: bridgeResolution.protoCanonicalName,
            fieldPath: [!targetSpec ? "missing-proto-schema" : !targetContext ? "missing-proto-context" : "missing-proto-adapter"],
            evidenceId: node.evidenceId
          });
          continue;
        }
        try {
          const current = JSON.parse(node.specJson) as Record<string, unknown> & {
            service?: string;
            method?: string;
            requestProtoType?: string;
            responseProtoType?: string;
          };
          const withTypes = { ...current, ...(slot.kind === "REQUEST_SCHEMA"
            ? { requestProtoType: bridgeResolution.protoCanonicalName, requestGeneratedJavaType: bridgeResolution.javaCanonicalName }
            : { responseProtoType: bridgeResolution.protoCanonicalName, responseGeneratedJavaType: bridgeResolution.javaCanonicalName }) };
          const protoMethod = current.service && current.method
            ? protoJavaBridge.resolveMethodByProtoTypes(
              node.repoId,
              current.service,
              current.method,
              withTypes.requestProtoType,
              withTypes.responseProtoType
            )
            : undefined;
          node = { ...node, specJson: JSON.stringify(protoMethod ? { ...withTypes, ...protoMethod } : withTypes) };
          updatedNodes[nodeIndex] = node;
        } catch {}
        const root: SchemaRootReference = {
          id: stableFactId("schema-root", { repoId: node.repoId, ownerSpecId: node.id, relationKind: slot.kind, slot: slot.slot, proto: bridgeResolution.protoCanonicalName }),
          repoId: node.repoId, ownerSpecId: node.id, ownerFileId: node.fileId, relationKind: slot.kind,
          languageId: "proto", frameworkId: "grpc-java-proto-bridge", rawTypeExpression: slot.rawType,
          resolutionContextId: targetContext.id, slot: slot.slot, evidenceId: node.evidenceId, generation: ""
        };
        roots.push(root);
        mergeMaterialized(materializeSchemaRoot({
          adapter, root, context: targetContext,
          contextForDeclaration: (declarationId) => contextsByDeclarationId.get(declarationId),
          initialExpression: { kind: "reference", name: bridgeResolution.protoCanonicalName }
        }));
        continue;
      }
      const attempts = repoAdapters.flatMap(([, adapter]) => {
        const declarationsForAdapter = adapter.indexDeclarations({ generation: "", files: [] });
        const declaration = declarationsForAdapter.find((fact) => fact.fileId === node.fileId) ?? declarationsForAdapter[0];
        if (!sourceContext && !declaration) return [];
        const baseContext = sourceContext
          ? contextForSource(sourceContext, contexts)
          : contextForDeclaration(declaration!, node.fileId, contexts);
        const context = ownerResolutionContext(node, baseContext, declarations);
        if (context !== baseContext) contexts.set(context.id, context);
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
  const existingNodeIndexes = new Map(updatedNodes.map((node, index) => [node.id, index]));
  for (const [id, materializedType] of [...materializedTypes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const declaration = reconciledSchemaByDeclarationId.get(materializedType.identity.declarationId);
    if (!declaration) continue;
    const instanceSpec: SchemaSpec = {
      ...declaration.spec,
      id,
      identity: materializedType.identity,
      shape: materializedType.shape
    };
    const instanceNode = { ...declaration.node, id, specJson: canonicalSerialize(instanceSpec) };
    const existingIndex = existingNodeIndexes.get(id);
    if (existingIndex === undefined) {
      existingNodeIndexes.set(id, updatedNodes.length);
      updatedNodes.push(instanceNode);
    } else {
      updatedNodes[existingIndex] = { ...updatedNodes[existingIndex]!, specJson: instanceNode.specJson };
    }
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
      diagnostics: [...diagnostics.values()].filter((diagnostic) => !diagnostic.ownerSpecId || specIds.has(diagnostic.ownerSpecId)).sort(byId),
      fingerprints: buildBehaviorFingerprints({
        adapters,
        declarations,
        contexts: [...contexts.values()],
        scopeDependencies: [...scopeDependencies.values()]
      })
    }
  };
}

function buildBehaviorFingerprints(input: {
  adapters: ReadonlyMap<string, IndexedTypeSystemAdapter>;
  declarations: readonly TypeDeclarationFact[];
  contexts: readonly ResolutionContextFact[];
  scopeDependencies: readonly ResolutionScopeDependencyFact[];
}): SchemaBehaviorFingerprint[] {
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
        // Source declarations, roots, and resolution contexts are generation
        // facts, not adapter behavior. Including them here made a normal source
        // edit look like a rule-set change and broke full/incremental convergence.
        scope,
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
  return node.framework !== "ts-schema" && node.framework !== "go-struct" && node.framework !== "java-source";
}

function rulesFor(languageId: string): IndexedTypeSystemRules {
  if (languageId === "java") return javaRules();
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

function contractInferenceDiagnostic(
  node: ContractSpecNode,
  context: SchemaSourceResolutionContext | undefined
): SchemaDiagnosticFact | undefined {
  let spec: Record<string, unknown>;
  try { spec = JSON.parse(node.specJson) as Record<string, unknown>; } catch { return undefined; }
  if (spec.kind !== "event" || typeof spec.payloadInference !== "string" || spec.payloadInference === "resolved") return undefined;
  const code = spec.payloadInference === "ambiguous" ? "ambiguous"
    : spec.payloadInference === "unsupported" ? "unsupported" : "unresolved";
  const id = stableFactId("schema-diagnostic", { code, ownerSpecId: node.id, subject: "event-payload" });
  return {
    id, generation: "", repoId: node.repoId, sourceFileId: node.fileId, sourceSymbolId: node.sourceSymbolId,
    ownerSpecId: node.id, code, symbol: "event-payload", evidenceId: node.evidenceId,
    scope: context ? { languageId: context.languageId, repoId: context.repoId, resolutionScopeId: context.resolutionScopeId } : undefined
  };
}

export function currentSchemaBehaviorImplementation(languageId: string): SchemaBehaviorImplementation {
  const rules = rulesFor(languageId);
  return {
    adapterVersion: rules.adapterVersion,
    ruleSetVersion: rules.ruleSetVersion,
    serializationVersion: rules.serializationVersion,
    maxDepth: rules.maxDepth,
    maxTypesPerRoot: rules.maxTypesPerRoot
  };
}

function ownerResolutionContext(
  node: ContractSpecNode,
  base: ResolutionContextFact,
  declarations: readonly TypeDeclarationFact[]
): ResolutionContextFact {
  let spec: { ownerType?: unknown; methodSignature?: unknown; ownerGenericBindings?: unknown } = {};
  try { spec = JSON.parse(node.specJson) as typeof spec; } catch {}
  const ownerType = normalizedOptionalString(spec.ownerType);
  const methodSignature = normalizedOptionalString(spec.methodSignature);
  const declaredOwnerBindings = Array.isArray(spec.ownerGenericBindings)
    ? spec.ownerGenericBindings.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const binding = value as { name?: unknown; type?: unknown };
      const name = normalizedOptionalString(binding.name);
      const type = normalizedOptionalString(binding.type);
      return name && type ? [{ name, type }] : [];
    }).sort((left, right) => left.name.localeCompare(right.name) || left.type.localeCompare(right.type))
    : [];
  // Non-owner-aware contracts use file/scope resolution only. Reusing the
  // base context avoids manufacturing a second identity whose only difference
  // after persistence could be undefined versus an empty sourceSymbolId.
  if (!ownerType && !methodSignature && declaredOwnerBindings.length === 0) return base;
  const sourceSymbolId = normalizedOptionalString(node.sourceSymbolId);
  const owner = ownerType
    ? declarations.find((declaration) => declaration.identity.languageId === base.languageId
      && declaration.identity.repoId === base.repoId
      && declaration.identity.canonicalName === ownerType)
    : undefined;
  const bindings = new Map(base.genericBindings.map((binding) => [binding.name, binding]));
  for (const parameter of owner?.typeParameters ?? []) {
    const bound = owner?.typeParameterBounds?.[parameter]?.[0];
    if (bound) bindings.set(parameter, { name: parameter, expression: bound });
  }
  for (const binding of declaredOwnerBindings) {
    bindings.set(binding.name, { name: binding.name, expression: parseGenericBound(binding.type) });
  }
  if (methodSignature) {
    const typeParameters = /^<([^>]+)>/u.exec(methodSignature)?.[1];
    for (const declaration of typeParameters ? splitGenericParameters(typeParameters) : []) {
      const match = /^([A-Za-z_$][\w$]*)\s+extends\s+(.+)$/u.exec(declaration.trim());
      if (match) bindings.set(match[1]!, { name: match[1]!, expression: parseGenericBound(match[2]!) });
    }
  }
  const enclosingDeclarationIds = owner
    ? [...new Set([...base.enclosingDeclarationIds, owner.id, ...(owner.enclosingDeclarationId ? [owner.enclosingDeclarationId] : [])])]
    : base.enclosingDeclarationIds;
  const genericBindings = [...bindings.values()].sort((left, right) => left.name.localeCompare(right.name));
  return {
    ...base,
    id: stableFactId("resolution-context", {
      base: base.id,
      ownerDeclarationId: owner?.id,
      sourceSymbolId,
      genericBindings
    }),
    sourceSymbolId,
    enclosingDeclarationIds,
    genericBindings
  };
}

function normalizedOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function splitGenericParameters(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "<") depth++;
    else if (char === ">") depth--;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.filter(Boolean);
}

function parseGenericBound(value: string): TypeExpression {
  const members = value.split(/\s*&\s*/u).filter(Boolean).map((name) => ({ kind: "reference" as const, name }));
  return members.length === 1 ? members[0]! : { kind: "intersection", members };
}

function javaRules(): IndexedTypeSystemRules {
  return {
    languageId: "java",
    adapterVersion: "java-type-system-v1",
    ruleSetVersion: "java-projection-v1",
    serializationVersion: "java-source-visible-v1",
    maxDepth: 12,
    maxTypesPerRoot: 256,
    scalars: {
      byte: "integer", short: "integer", int: "integer", long: "integer",
      float: "number", double: "number", boolean: "boolean", char: "string", void: "void",
      Byte: "integer", Short: "integer", Integer: "integer", Long: "integer",
      Float: "number", Double: "number", Boolean: "boolean", Character: "string",
      String: "string", CharSequence: "string", BigInteger: "bigint", BigDecimal: "number",
      UUID: "uuid", Date: "date", Instant: "date", LocalDate: "date", LocalDateTime: "date",
      "java.lang.Byte": "integer", "java.lang.Short": "integer", "java.lang.Integer": "integer",
      "java.lang.Long": "integer", "java.lang.Float": "number", "java.lang.Double": "number",
      "java.lang.Boolean": "boolean", "java.lang.Character": "string", "java.lang.String": "string",
      "java.math.BigInteger": "bigint", "java.math.BigDecimal": "number", "java.util.UUID": "uuid",
      "java.util.Date": "date", "java.time.Instant": "date", "java.time.LocalDate": "date",
      "java.time.LocalDateTime": "date"
    },
    externalSymbols: [
      "java.io", "java.nio", "java.net", "jakarta.servlet", "javax.servlet",
      "org.springframework.core.io", "org.springframework.web.servlet", "org.springframework.web.context.request",
      "org.reactivestreams", "reactor.core.publisher"
    ],
    wrappers: [
      { canonicalSymbol: "org.springframework.http.ResponseEntity", sourceSymbols: ["ResponseEntity"], behavior: "transparent", argumentIndexes: [0] },
      { canonicalSymbol: "java.util.Optional", sourceSymbols: ["Optional"], behavior: "transparent", argumentIndexes: [0] },
      ...["Mono", "Flux", "Publisher", "ModelAndView", "View", "Resource", "InputStreamResource", "StreamingResponseBody", "ResponseBodyEmitter", "SseEmitter", "ServletRequest", "ServletResponse", "HttpServletRequest", "HttpServletResponse", "ServerHttpRequest", "ServerHttpResponse"].map((name) => ({
        canonicalSymbol: `java-boundary.${name}`, sourceSymbols: [name], behavior: "stop" as const
      })),
      ...["Collection", "List", "Set", "Iterable", "ArrayList", "LinkedList", "HashSet", "TreeSet"].map((name) => ({
        canonicalSymbol: `java.util.${name}`, sourceSymbols: [name], behavior: "collection" as const, argumentIndexes: [0]
      })),
      ...["Map", "HashMap", "LinkedHashMap", "TreeMap", "ConcurrentHashMap"].map((name) => ({
        canonicalSymbol: name === "ConcurrentHashMap" ? "java.util.concurrent.ConcurrentHashMap" : `java.util.${name}`,
        sourceSymbols: [name], behavior: "map-value" as const, argumentIndexes: [1]
      }))
    ]
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
    if (spec.kind === "http-endpoint") {
      const requestSlots = Array.isArray(spec.requestBodySlots)
        ? spec.requestBodySlots.flatMap((slot) => isTypedBodySlot(slot) && !isSpringBoundaryType(slot.type)
          ? [{ rawType: slot.type, kind: "REQUEST_SCHEMA" as const, slot: { kind: "parameter" as const, index: slot.index, name: slot.name } }]
          : [])
        : typeof spec.requestBodyType === "string" && !isSpringBoundaryType(spec.requestBodyType)
          ? [{ rawType: spec.requestBodyType, kind: "REQUEST_SCHEMA" as const, slot: { kind: "parameter" as const, index: 0, name: "body" } }]
          : [];
      const responseType = typeof spec.declaredResponseType === "string" ? spec.declaredResponseType
        : typeof spec.responseBodyType === "string" ? spec.responseBodyType : undefined;
      const responseAllowed = node.framework !== "spring-mvc" || spec.responseBody !== false;
      return [
        ...requestSlots,
        ...(responseAllowed && responseType && !isSpringBoundaryType(responseType)
          ? [{ rawType: responseType, kind: "RESPONSE_SCHEMA" as const, slot: { kind: "return" as const } }]
          : [])
      ];
    }
    if (spec.kind === "grpc-method") return [
      ...(typeof spec.requestType === "string" ? [{ rawType: spec.requestType, kind: "REQUEST_SCHEMA" as const, slot: { kind: "parameter" as const, index: 0, name: "request" } }] : []),
      ...(typeof spec.responseType === "string" ? [{ rawType: spec.responseType, kind: "RESPONSE_SCHEMA" as const, slot: { kind: "return" as const } }] : [])
    ];
    if (spec.kind === "dubbo-method") return [
      ...(Array.isArray(spec.requestSlots) ? spec.requestSlots.flatMap((slot) => isTypedBodySlot(slot)
        ? [{ rawType: slot.type, kind: "REQUEST_SCHEMA" as const, slot: { kind: "parameter" as const, index: slot.index, name: slot.name } }]
        : []) : []),
      ...(typeof spec.responseType === "string" && !/^(?:void|Void)$/u.test(spec.responseType.trim())
        ? [{ rawType: spec.responseType, kind: "RESPONSE_SCHEMA" as const, slot: { kind: "return" as const } }]
        : [])
    ];
    if (spec.kind === "graphql-operation") return [
      ...(Array.isArray(spec.requestTypes) ? spec.requestTypes.flatMap((rawType, index) => typeof rawType === "string"
        ? [{ rawType, kind: "REQUEST_SCHEMA" as const, slot: { kind: "parameter" as const, index } }]
        : []) : []),
      ...(typeof spec.requestType === "string" ? [{ rawType: spec.requestType, kind: "REQUEST_SCHEMA" as const, slot: { kind: "parameter" as const, index: 0, name: "input" } }] : []),
      ...(typeof spec.responseType === "string" ? [{ rawType: spec.responseType, kind: "RESPONSE_SCHEMA" as const, slot: { kind: "return" as const } }] : [])
    ];
    if (spec.kind === "event" && typeof spec.payloadType === "string") {
      const payloadSlot = spec.payloadSlot && typeof spec.payloadSlot === "object" ? spec.payloadSlot as { index?: unknown; name?: unknown } : {};
      return [{ rawType: spec.payloadType, kind: "EVENT_PAYLOAD", slot: {
        kind: "payload", index: Number.isSafeInteger(payloadSlot.index) ? payloadSlot.index as number : undefined,
        name: typeof payloadSlot.name === "string" ? payloadSlot.name : undefined
      } }];
    }
  } catch {}
  return [];
}

function isTypedBodySlot(value: unknown): value is { index: number; name?: string; type: string } {
  if (!value || typeof value !== "object") return false;
  const slot = value as { index?: unknown; name?: unknown; type?: unknown };
  return Number.isSafeInteger(slot.index) && typeof slot.type === "string"
    && (slot.name === undefined || typeof slot.name === "string");
}

function isSpringBoundaryType(raw: string): boolean {
  const normalized = raw.replace(/\s+/gu, "").replace(/^(?:[A-Za-z_$][\w$]*\.)+/u, "");
  if (/^(?:void|Void|boolean|byte|short|int|long|float|double|char|String|Character|Boolean|Byte|Short|Integer|Long|Float|Double)$/u.test(normalized)) return true;
  return /^(?:ModelAndView|View|Resource|InputStreamResource|StreamingResponseBody|ResponseBodyEmitter|SseEmitter|ServletRequest|ServletResponse|HttpServletRequest|HttpServletResponse|ServerHttpRequest|ServerHttpResponse|Publisher|Mono|Flux)(?:<.*>)?$/u.test(normalized);
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
