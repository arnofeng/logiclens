import { hashText } from "../../shared/hash.js";

export const SCHEMA_INDEX_VERSION = "7";

export interface ResolutionScopeIdentity {
  languageId: string;
  repoId: string;
  resolutionScopeId: string;
}

export interface TypeDeclarationIdentity extends ResolutionScopeIdentity {
  canonicalName: string;
}

export type TypeExpression =
  | { kind: "reference"; name: string }
  | { kind: "application"; target: TypeExpression; arguments: TypeExpression[] }
  | { kind: "array"; element: TypeExpression }
  | { kind: "map"; key: TypeExpression; value: TypeExpression }
  | { kind: "union"; members: TypeExpression[] }
  | { kind: "intersection"; members: TypeExpression[] }
  | { kind: "variable"; name: string }
  | { kind: "wildcard"; bound?: "extends" | "super"; type?: TypeExpression }
  | { kind: "nullable"; inner: TypeExpression }
  | { kind: "literal"; value: string }
  | { kind: "opaque"; languageId: string; canonicalText: string };

export type CanonicalTypeExpression =
  | { kind: "type-instance"; declarationId: string; arguments: CanonicalTypeExpression[] }
  | { kind: "scalar"; name: string }
  | { kind: "array"; element: CanonicalTypeExpression }
  | { kind: "map"; key: CanonicalTypeExpression; value: CanonicalTypeExpression }
  | { kind: "union"; members: CanonicalTypeExpression[] }
  | { kind: "intersection"; members: CanonicalTypeExpression[] }
  | { kind: "wildcard"; bound?: "extends" | "super"; type?: CanonicalTypeExpression }
  | { kind: "nullable"; inner: CanonicalTypeExpression }
  | { kind: "literal"; value: string };

export interface TypeInstanceIdentity {
  declarationId: string;
  canonicalTypeArguments: CanonicalTypeExpression[];
}

export interface ExternalTypeSymbolIdentity {
  languageId: string;
  canonicalName: string;
}

export type SchemaFieldType =
  | { kind: "resolved"; expression: CanonicalTypeExpression }
  | { kind: "external-symbol"; symbol: ExternalTypeSymbolIdentity; normalizedExpression: TypeExpression; diagnosticId: string }
  | { kind: "unresolved"; normalizedExpression: TypeExpression; diagnosticId: string }
  | { kind: "ambiguous"; normalizedExpression: TypeExpression; diagnosticId: string }
  | { kind: "unsupported"; normalizedExpression: TypeExpression; diagnosticId: string };

export interface SourceLocation {
  fileId: string;
  line?: number;
  column?: number;
}

export interface SchemaFieldSpec {
  sourceName: string;
  serializedName: string;
  type: SchemaFieldType;
  optional: boolean;
  nullable: boolean;
  sourceLocation: SourceLocation;
}

export interface SchemaDeclarationCandidate {
  declaration: TypeDeclarationIdentity;
  displayName: string;
  typeParameters: string[];
  typeParameterBounds?: Record<string, TypeExpression[]>;
  declarationKind?: "class" | "interface" | "record" | "enum";
  modifiers?: string[];
  enclosingDeclarationId?: string;
  shape: { kind: "object"; fields: SchemaFieldSpec[]; baseTypes?: TypeExpression[] } | { kind: "enum"; values: string[] };
  fileId: string;
  filePath: string;
  sourceSymbolId?: string;
  framework: string;
  evidence: { line: number; raw: string; rule: string; confidence: number };
}

export interface SchemaRootReference {
  id: string;
  repoId: string;
  ownerSpecId: string;
  ownerFileId: string;
  relationKind: "REQUEST_SCHEMA" | "RESPONSE_SCHEMA" | "EVENT_PAYLOAD" | "USES_SCHEMA";
  languageId: string;
  frameworkId: string;
  rawTypeExpression: string;
  resolutionContextId: string;
  slot: { kind: "parameter" | "return" | "payload" | "field"; index?: number; name?: string };
  evidenceId: string;
  generation: string;
}

export interface GenericBindingFact {
  name: string;
  expression: TypeExpression;
}

export interface ResolutionImportBinding {
  localName: string;
  canonicalName: string;
  declarationId: string;
  resolutionScopeId: string;
  kind: "default" | "named" | "namespace";
}

export interface ResolutionContextFact extends ResolutionScopeIdentity {
  id: string;
  fileId: string;
  sourceSymbolId?: string;
  namespaceId?: string;
  imports: ResolutionImportBinding[];
  enclosingDeclarationIds: string[];
  genericBindings: GenericBindingFact[];
  generation: string;
}

export interface TypeDeclarationFact {
  id: string;
  identity: TypeDeclarationIdentity;
  fileId: string;
  declarationKind: string;
  typeParameters: string[];
  typeParameterBounds?: Record<string, TypeExpression[]>;
  modifiers?: string[];
  enclosingDeclarationId?: string;
  candidate?: SchemaDeclarationCandidate;
  generation: string;
}

export interface ResolutionScopeDependencyFact {
  id: string;
  from: ResolutionScopeIdentity;
  to: ResolutionScopeIdentity;
  kind: "module" | "source-set" | "repository";
  order: number;
  generation: string;
}

export interface SchemaDependencyFact {
  id: string;
  rootReferenceId: string;
  fromInstanceId?: string;
  declarationId: string;
  fieldPath: string[];
  generation: string;
}

export interface SchemaRelationProvenance {
  id: string;
  relationId: string;
  rootReferenceId: string;
  sourceFileId?: string;
  sourceSymbolId?: string;
  rawTypeExpression: string;
  typePath: CanonicalTypeExpression[];
  fieldPath: string[];
  declarationIds: string[];
  projectionRuleId?: string;
  projectionRuleVersion?: string;
  resolution: "resolved" | "unresolved" | "external" | "ambiguous" | "unsupported" | "truncated";
  evidenceId?: string;
  generation: string;
}

export interface SchemaDiagnosticFact {
  id: string;
  generation: string;
  repoId?: string;
  sourceFileId?: string;
  sourceSymbolId?: string;
  ownerSpecId?: string;
  rootReferenceId?: string;
  scope?: ResolutionScopeIdentity;
  code: "unresolved" | "ambiguous" | "external" | "unsupported" | "truncated";
  symbol?: string;
  fieldPath?: string[];
  candidates?: TypeDeclarationIdentity[];
  evidenceId?: string;
  limit?: { kind: "depth" | "types"; value: number };
}

export interface SchemaBehaviorFingerprint {
  id: string;
  languageId: string;
  repoId: string;
  resolutionScopeId: string;
  adapterVersion: string;
  ruleSetVersion: string;
  serializationVersion: string;
  maxDepth: number;
  maxTypesPerRoot: number;
  buildInputsHash: string;
  generation: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function stableFactId(prefix: string, value: unknown): string {
  return `${prefix}:${hashText(canonicalSerialize(value))}`;
}

export function resolutionScopeIdentityId(identity: ResolutionScopeIdentity): string {
  return stableFactId("scope", identity);
}

export function typeDeclarationIdentityId(identity: TypeDeclarationIdentity): string {
  return stableFactId("declaration", identity);
}

export function typeInstanceIdentityId(identity: TypeInstanceIdentity): string {
  return stableFactId("type-instance", identity);
}

export function createTypeInstanceIdentity(
  declarationId: string,
  canonicalTypeArguments: readonly (CanonicalTypeExpression | undefined)[]
): TypeInstanceIdentity | undefined {
  if (canonicalTypeArguments.some((argument) => argument === undefined)) return undefined;
  return { declarationId, canonicalTypeArguments: canonicalTypeArguments as CanonicalTypeExpression[] };
}

export function schemaSpecId(identity: TypeInstanceIdentity): string {
  return stableFactId("spec:schema", identity);
}

export function createSchemaIdentity(input: TypeDeclarationIdentity): TypeInstanceIdentity {
  return { declarationId: typeDeclarationIdentityId(input), canonicalTypeArguments: [] };
}

export function createSchemaSpec(input: {
  declaration: TypeDeclarationIdentity;
  displayName: string;
  shape: { kind: "object"; fields: SchemaFieldSpec[]; baseTypes?: TypeExpression[] } | { kind: "enum"; values: string[] };
}): { id: string; kind: "schema"; identity: TypeInstanceIdentity; declaration: TypeDeclarationIdentity; displayName: string; languageId: string; shape: typeof input.shape } {
  const identity = createSchemaIdentity(input.declaration);
  return {
    id: schemaSpecId(identity),
    kind: "schema",
    identity,
    declaration: input.declaration,
    displayName: input.displayName,
    languageId: input.declaration.languageId,
    shape: input.shape
  };
}

const CANONICAL_SCALARS = new Set([
  "any", "array", "bigint", "boolean", "date", "map", "null", "number", "string", "undefined", "unknown", "uuid", "void"
]);

export function schemaFieldFromNormalized(input: {
  languageId: string;
  repoId: string;
  fileId: string;
  sourceName: string;
  serializedName?: string;
  normalizedType: string;
  optional: boolean;
  nullable?: boolean;
  line?: number;
}): SchemaFieldSpec {
  const normalized = input.normalizedType.replace(/\?$/u, "");
  const normalizedExpression = typeExpressionFromNormalized(normalized, input.languageId);
  const canonicalExpression = canonicalPrimitiveExpression(normalizedExpression);
  let type: SchemaFieldType;
  if (canonicalExpression) {
    type = { kind: "resolved", expression: canonicalExpression };
  } else {
    type = {
      kind: "unresolved",
      normalizedExpression,
      diagnosticId: stableFactId("schema-diagnostic", {
        code: "unresolved",
        languageId: input.languageId,
        repoId: input.repoId,
        fileId: input.fileId,
        field: input.sourceName,
        expression: normalizedExpression
      })
    };
  }
  return {
    sourceName: input.sourceName,
    serializedName: input.serializedName ?? input.sourceName,
    type,
    optional: input.optional,
    nullable: input.nullable ?? input.normalizedType.endsWith("?"),
    sourceLocation: { fileId: input.fileId, line: input.line }
  };
}

export function typeExpressionFromNormalized(value: string, languageId = "unknown"): TypeExpression {
  const trimmed = value.trim();
  const nullable = trimmed.endsWith("?") && trimmed !== "?";
  const inner = nullable ? trimmed.slice(0, -1).trim() : trimmed;
  const union = splitNormalizedTopLevel(inner, "|");
  if (union.length > 1) {
    const expression: TypeExpression = {
      kind: "union",
      members: union.map((member) => typeExpressionFromNormalized(member, languageId))
    };
    return nullable ? { kind: "nullable", inner: expression } : expression;
  }
  const intersection = splitNormalizedTopLevel(inner, "&");
  if (intersection.length > 1) {
    const expression: TypeExpression = {
      kind: "intersection",
      members: intersection.map((member) => typeExpressionFromNormalized(member, languageId))
    };
    return nullable ? { kind: "nullable", inner: expression } : expression;
  }
  const wildcard = inner.match(/^\?\s*(?:(extends|super)\s+(.+))?$/u);
  if (wildcard) {
    const expression: TypeExpression = {
      kind: "wildcard",
      bound: wildcard[1] as "extends" | "super" | undefined,
      type: wildcard[2] ? typeExpressionFromNormalized(wildcard[2], languageId) : undefined
    };
    return nullable ? { kind: "nullable", inner: expression } : expression;
  }
  const application = normalizedApplication(inner);
  let expression: TypeExpression;
  if (application) {
    const target = application.target;
    const argumentsText = splitNormalizedTopLevel(application.argumentsText, ",");
    if (target === "array" && argumentsText.length === 1) {
      expression = { kind: "array", element: typeExpressionFromNormalized(argumentsText[0]!, languageId) };
    } else if (target === "map" && argumentsText.length === 2) {
      expression = {
        kind: "map",
        key: typeExpressionFromNormalized(argumentsText[0]!, languageId),
        value: typeExpressionFromNormalized(argumentsText[1]!, languageId)
      };
    } else {
      expression = {
        kind: "application",
        target: { kind: "reference", name: target },
        arguments: argumentsText.map((argument) => typeExpressionFromNormalized(argument, languageId))
      };
    }
  } else {
    expression = inner
      ? { kind: "reference", name: inner.replace(/^global::/u, "").replace(/^\./u, "") }
      : { kind: "opaque", languageId, canonicalText: inner };
  }
  return nullable ? { kind: "nullable", inner: expression } : expression;
}

function normalizedApplication(value: string): { target: string; argumentsText: string } | undefined {
  const angleIndex = value.indexOf("<");
  const squareIndex = value.indexOf("[");
  const openingIndex = angleIndex < 0 ? squareIndex : squareIndex < 0 ? angleIndex : Math.min(angleIndex, squareIndex);
  if (openingIndex <= 0) return undefined;
  const opening = value[openingIndex];
  const closing = opening === "<" ? ">" : "]";
  if (!value.endsWith(closing)) return undefined;
  return {
    target: value.slice(0, openingIndex).trim(),
    argumentsText: value.slice(openingIndex + 1, -1)
  };
}

function canonicalPrimitiveExpression(expression: TypeExpression): CanonicalTypeExpression | undefined {
  switch (expression.kind) {
    case "reference":
      return CANONICAL_SCALARS.has(expression.name) ? { kind: "scalar", name: expression.name } : undefined;
    case "array": {
      const element = canonicalPrimitiveExpression(expression.element);
      return element ? { kind: "array", element } : undefined;
    }
    case "map": {
      const key = canonicalPrimitiveExpression(expression.key);
      const value = canonicalPrimitiveExpression(expression.value);
      return key && value ? { kind: "map", key, value } : undefined;
    }
    case "nullable": {
      const inner = canonicalPrimitiveExpression(expression.inner);
      return inner ? { kind: "nullable", inner } : undefined;
    }
    default:
      return undefined;
  }
}

function splitNormalizedTopLevel(value: string, separator: string): string[] {
  const result: string[] = [];
  let angleDepth = 0;
  let squareDepth = 0;
  let parenDepth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "<") angleDepth++;
    else if (character === ">") angleDepth--;
    else if (character === "[") squareDepth++;
    else if (character === "]") squareDepth--;
    else if (character === "(") parenDepth++;
    else if (character === ")") parenDepth--;
    else if (character === separator && angleDepth === 0 && squareDepth === 0 && parenDepth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

export function resolvedSchemaField(input: {
  languageId: string;
  repoId: string;
  resolutionScopeId: string;
  canonicalName: string;
  fileId: string;
  sourceName: string;
  serializedName?: string;
  optional: boolean;
  nullable: boolean;
  line?: number;
}): SchemaFieldSpec {
  const declarationId = typeDeclarationIdentityId(input);
  return {
    sourceName: input.sourceName,
    serializedName: input.serializedName ?? input.sourceName,
    type: { kind: "resolved", expression: { kind: "type-instance", declarationId, arguments: [] } },
    optional: input.optional,
    nullable: input.nullable,
    sourceLocation: { fileId: input.fileId, line: input.line }
  };
}

export function externalSchemaField(input: {
  languageId: string;
  canonicalName: string;
  fileId: string;
  sourceName: string;
  serializedName?: string;
  optional: boolean;
  nullable: boolean;
  line?: number;
}): SchemaFieldSpec {
  const normalizedExpression: TypeExpression = { kind: "reference", name: input.canonicalName };
  const symbol = { languageId: input.languageId, canonicalName: input.canonicalName };
  return {
    sourceName: input.sourceName,
    serializedName: input.serializedName ?? input.sourceName,
    type: {
      kind: "external-symbol",
      symbol,
      normalizedExpression,
      diagnosticId: stableFactId("schema-diagnostic", { code: "external", symbol, field: input.sourceName })
    },
    optional: input.optional,
    nullable: input.nullable,
    sourceLocation: { fileId: input.fileId, line: input.line }
  };
}
