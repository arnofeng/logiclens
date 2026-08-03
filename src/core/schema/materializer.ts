import type { SemanticRelationEdge } from "../parsing/types.js";
import type {
  CanonicalTypeExpression,
  ResolutionContextFact,
  SchemaDependencyFact,
  SchemaDiagnosticFact,
  SchemaRelationProvenance,
  SchemaRootReference,
  TypeExpression,
  TypeInstanceIdentity
} from "./model.js";
import { canonicalSerialize, schemaSpecId, stableFactId, typeInstanceIdentityId } from "./model.js";
import type { ResolutionResult, SchemaShape, TypeProjection, TypeSystemAdapter } from "./typeSystem.js";

export interface MaterializedSchemaType {
  identity: TypeInstanceIdentity;
  shape: Exclude<SchemaShape, { kind: "unsupported" }>;
  depth: number;
}

export interface SchemaMaterializationResult {
  types: MaterializedSchemaType[];
  dependencies: SchemaDependencyFact[];
  provenance: SchemaRelationProvenance[];
  diagnostics: SchemaDiagnosticFact[];
  relations: SemanticRelationEdge[];
  truncated: boolean;
}

type QueueItem = {
  expression: TypeExpression;
  context: ResolutionContextFact;
  depth: number;
  fieldPath: string[];
  typePath: CanonicalTypeExpression[];
  projectionRuleIds: string[];
};

export function materializeSchemaRoot(input: {
  adapter: TypeSystemAdapter;
  root: SchemaRootReference;
  context: ResolutionContextFact;
  contextForDeclaration?: (declarationId: string) => ResolutionContextFact | undefined;
  initialExpression?: TypeExpression;
  ownerInstance?: TypeInstanceIdentity;
}): SchemaMaterializationResult {
  const { adapter, root, context } = input;
  const queue: QueueItem[] = [{
    expression: input.initialExpression ?? adapter.parseTypeExpression(root.rawTypeExpression, context),
    context,
    depth: 0,
    fieldPath: [],
    typePath: input.ownerInstance ? [{
      kind: "type-instance",
      declarationId: input.ownerInstance.declarationId,
      arguments: input.ownerInstance.canonicalTypeArguments
    }] : [],
    projectionRuleIds: []
  }];
  const types = new Map<string, MaterializedSchemaType>();
  const dependencies = new Map<string, SchemaDependencyFact>();
  const provenance = new Map<string, SchemaRelationProvenance>();
  const diagnostics = new Map<string, SchemaDiagnosticFact>();
  const relations = new Map<string, SemanticRelationEdge>();
  let truncated = false;

  const recordDiagnostic = (diagnostic: SchemaDiagnosticFact, fieldPath: string[]): void => {
    const id = stableFactId("schema-diagnostic", {
      diagnosticId: diagnostic.id,
      rootReferenceId: root.id,
      fieldPath
    });
    diagnostics.set(id, { ...diagnostic, id, rootReferenceId: root.id, ownerSpecId: root.ownerSpecId, fieldPath });
  };

  while (queue.length > 0) {
    queue.sort((left, right) => left.depth - right.depth
      || queueItemSortKey(adapter, left).localeCompare(queueItemSortKey(adapter, right))
      || canonicalSerialize(left.fieldPath).localeCompare(canonicalSerialize(right.fieldPath)));
    const item = queue.shift()!;
    if (item.depth > adapter.maxDepth) {
      truncated = true;
      const diagnostic: SchemaDiagnosticFact = {
        id: stableFactId("schema-diagnostic", {
          code: "truncated", rootReferenceId: root.id, fieldPath: item.fieldPath,
          limit: { kind: "depth", value: adapter.maxDepth }
        }),
        generation: root.generation,
        repoId: root.repoId,
        sourceFileId: root.ownerFileId,
        ownerSpecId: root.ownerSpecId,
        rootReferenceId: root.id,
        code: "truncated",
        fieldPath: item.fieldPath,
        limit: { kind: "depth", value: adapter.maxDepth }
      };
      recordDiagnostic(diagnostic, item.fieldPath);
      continue;
    }

    const projection = adapter.projectType(item.expression, item.context);
    if (projection.kind === "transparent") {
      for (const expression of projection.expressions) {
        queue.push({
          ...item,
          expression,
          projectionRuleIds: [...item.projectionRuleIds, projection.ruleId]
        });
      }
      continue;
    }
    if (projection.kind === "stop") {
      const resolution = adapter.resolveType(item.expression, item.context);
      if (resolution.kind === "unresolved" || resolution.kind === "ambiguous" || resolution.kind === "unsupported") {
        recordDiagnostic(resolution.diagnostic, item.fieldPath);
      } else if (resolution.kind === "external") {
        recordDiagnostic(resolution.diagnostic, item.fieldPath);
      }
      continue;
    }

    const resolution = adapter.resolveType(projection.expression, item.context);
    if (resolution.kind === "unresolved" || resolution.kind === "ambiguous" || resolution.kind === "unsupported") {
      recordDiagnostic(resolution.diagnostic, item.fieldPath);
      continue;
    }
    if (resolution.kind === "external") {
      recordDiagnostic(resolution.diagnostic, item.fieldPath);
      continue;
    }
    if (resolution.kind === "scalar") continue;

    const instanceId = typeInstanceIdentityId(resolution.instance);
    const previouslyVisited = types.has(instanceId);
    if (!previouslyVisited && types.size >= adapter.maxTypesPerRoot) {
      truncated = true;
      recordDiagnostic({
        id: stableFactId("schema-diagnostic", {
          code: "truncated", rootReferenceId: root.id, fieldPath: item.fieldPath,
          candidate: resolution.instance, limit: { kind: "types", value: adapter.maxTypesPerRoot }
        }),
        generation: root.generation,
        repoId: root.repoId,
        sourceFileId: root.ownerFileId,
        ownerSpecId: root.ownerSpecId,
        rootReferenceId: root.id,
        code: "truncated",
        fieldPath: item.fieldPath,
        limit: { kind: "types", value: adapter.maxTypesPerRoot }
      }, item.fieldPath);
      continue;
    }
    const shape = adapter.inspectSchemaShape(resolution.instance);
    if (shape.kind === "unsupported") {
      recordDiagnostic(shape.diagnostic, item.fieldPath);
      continue;
    }
    if (!previouslyVisited) types.set(instanceId, { identity: resolution.instance, shape, depth: item.depth });

    const parentExpression = item.typePath.at(-1);
    const parentInstance = parentExpression?.kind === "type-instance" ? {
      declarationId: parentExpression.declarationId,
      canonicalTypeArguments: parentExpression.arguments
    } : undefined;
    const fromInstanceId = parentInstance ? typeInstanceIdentityId(parentInstance) : undefined;
    const dependency: SchemaDependencyFact = {
      id: stableFactId("schema-dependency", {
        rootReferenceId: root.id, fromInstanceId, declarationId: resolution.instance.declarationId, fieldPath: item.fieldPath
      }),
      rootReferenceId: root.id,
      fromInstanceId,
      declarationId: resolution.instance.declarationId,
      fieldPath: item.fieldPath,
      generation: root.generation
    };
    dependencies.set(dependency.id, dependency);

    const targetSpecId = schemaSpecId(resolution.instance);
    const fromSpecId = parentInstance ? schemaSpecId(parentInstance) : root.ownerSpecId;
    const relationKind = parentInstance ? "USES_SCHEMA" : root.relationKind;
    const relationId = stableFactId("schema-relation", {
      fromSpecId,
      toSpecId: targetSpecId,
      kind: relationKind
    });
    relations.set(relationId, {
      fromSpecId,
      toSpecId: targetSpecId,
      kind: relationKind,
      evidenceId: root.evidenceId,
      reason: `Resolved ${root.rawTypeExpression} through ${adapter.languageId} rules ${adapter.ruleSetVersion}`,
      confidence: 0.95
    });
    const provenanceFact: SchemaRelationProvenance = {
      id: stableFactId("schema-provenance", { relationId, rootReferenceId: root.id, fieldPath: item.fieldPath, declarationId: resolution.instance.declarationId }),
      relationId,
      rootReferenceId: root.id,
      sourceFileId: root.ownerFileId,
      rawTypeExpression: root.rawTypeExpression,
      typePath: [...item.typePath, resolution.expression],
      fieldPath: item.fieldPath,
      declarationIds: [...new Set([...item.typePath.flatMap(declarationIds), resolution.instance.declarationId])],
      projectionRuleId: item.projectionRuleIds.length > 0
        ? item.projectionRuleIds.join(" > ")
        : `${adapter.ruleSetVersion}:materialized`,
      projectionRuleVersion: adapter.ruleSetVersion,
      resolution: "resolved",
      evidenceId: root.evidenceId,
      generation: root.generation
    };
    provenance.set(provenanceFact.id, provenanceFact);

    // visited controls expansion only. The relation/provenance above must be
    // retained for self references, cycles, and repeated fields.
    if (previouslyVisited) continue;

    if (shape.kind === "object") {
      const declarationContext = input.contextForDeclaration?.(resolution.instance.declarationId) ?? item.context;
      for (const field of shape.fields) {
        const expression = field.type.kind === "resolved"
          ? canonicalToTypeExpression(field.type.expression)
          : field.type.normalizedExpression;
        queue.push({
          expression,
          context: declarationContext,
          depth: item.depth + 1,
          fieldPath: [...item.fieldPath, field.serializedName],
          typePath: [...item.typePath, resolution.expression],
          projectionRuleIds: item.projectionRuleIds
        });
      }
      for (const [index, expression] of (shape.baseTypes ?? []).entries()) {
        queue.push({
          expression,
          context: declarationContext,
          depth: item.depth + 1,
          fieldPath: [...item.fieldPath, "$base", String(index)],
          typePath: [...item.typePath, resolution.expression],
          projectionRuleIds: item.projectionRuleIds
        });
      }
    }
  }

  return {
    types: [...types.values()].sort((a, b) => canonicalSerialize(a.identity).localeCompare(canonicalSerialize(b.identity))),
    dependencies: [...dependencies.values()].sort(byId),
    provenance: [...provenance.values()].sort(byId),
    diagnostics: [...diagnostics.values()].sort(byId),
    relations: [...relations.values()].sort((a, b) => `${a.fromSpecId}:${a.toSpecId}:${a.kind}`.localeCompare(`${b.fromSpecId}:${b.toSpecId}:${b.kind}`)),
    truncated
  };
}

function queueItemSortKey(adapter: TypeSystemAdapter, item: QueueItem): string {
  const projection = adapter.projectType(item.expression, item.context);
  if (projection.kind === "transparent") {
    return `0:${projection.expressions.map((expression) => queueItemSortKey(adapter, { ...item, expression })).sort().join("|")}`;
  }
  const resolution = adapter.resolveType(projection.kind === "materialized" ? projection.expression : item.expression, item.context);
  if (resolution.kind === "resolved") return `1:${canonicalSerialize(resolution.instance)}`;
  if (resolution.kind === "scalar") return `2:${resolution.scalar}`;
  return `3:${resolution.kind}:${resolution.diagnostic.id}`;
}

function canonicalToTypeExpression(expression: CanonicalTypeExpression): TypeExpression {
  switch (expression.kind) {
    case "type-instance":
      return expression.arguments.length === 0
        ? { kind: "reference", name: expression.declarationId }
        : { kind: "application", target: { kind: "reference", name: expression.declarationId }, arguments: expression.arguments.map(canonicalToTypeExpression) };
    case "scalar": return { kind: "reference", name: expression.name };
    case "array": return { kind: "array", element: canonicalToTypeExpression(expression.element) };
    case "map": return { kind: "map", key: canonicalToTypeExpression(expression.key), value: canonicalToTypeExpression(expression.value) };
    case "union": return { kind: "union", members: expression.members.map(canonicalToTypeExpression) };
    case "intersection": return { kind: "intersection", members: expression.members.map(canonicalToTypeExpression) };
    case "wildcard": return { kind: "wildcard", bound: expression.bound, type: expression.type ? canonicalToTypeExpression(expression.type) : undefined };
    case "nullable": return { kind: "nullable", inner: canonicalToTypeExpression(expression.inner) };
    case "literal": return expression;
  }
}

function declarationIds(expression: CanonicalTypeExpression): string[] {
  switch (expression.kind) {
    case "type-instance": return [expression.declarationId, ...expression.arguments.flatMap(declarationIds)];
    case "array": return declarationIds(expression.element);
    case "map": return [...declarationIds(expression.key), ...declarationIds(expression.value)];
    case "union":
    case "intersection": return expression.members.flatMap(declarationIds);
    case "wildcard": return expression.type ? declarationIds(expression.type) : [];
    case "nullable": return declarationIds(expression.inner);
    default: return [];
  }
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}
