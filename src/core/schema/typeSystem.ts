import type {
  CanonicalTypeExpression,
  ResolutionContextFact,
  SchemaBehaviorFingerprint,
  ResolutionScopeDependencyFact,
  SchemaDiagnosticFact,
  SchemaFieldSpec,
  TypeDeclarationFact,
  TypeExpression,
  TypeInstanceIdentity
} from "./model.js";
import { stableFactId } from "./model.js";

export const DEFAULT_SCHEMA_MAX_DEPTH = 12;
export const DEFAULT_SCHEMA_MAX_TYPES_PER_ROOT = 256;

export type SchemaBehaviorImplementation = Pick<SchemaBehaviorFingerprint,
  "adapterVersion" | "ruleSetVersion" | "serializationVersion" | "maxDepth" | "maxTypesPerRoot">;

export type ResolutionResult =
  | { kind: "resolved"; instance: TypeInstanceIdentity; expression: CanonicalTypeExpression }
  | { kind: "scalar"; scalar: string; expression: CanonicalTypeExpression }
  | { kind: "unresolved"; diagnostic: SchemaDiagnosticFact }
  | { kind: "external"; languageId: string; canonicalName: string; diagnostic: SchemaDiagnosticFact }
  | { kind: "ambiguous"; diagnostic: SchemaDiagnosticFact }
  | { kind: "unsupported"; diagnostic: SchemaDiagnosticFact };

export type TypeProjection =
  | { kind: "transparent"; expressions: TypeExpression[]; ruleId: string }
  | { kind: "materialized"; expression: TypeExpression }
  | { kind: "stop"; reason: "scalar" | "external" | "unsupported" };

export type SchemaShape =
  | { kind: "object"; fields: SchemaFieldSpec[]; baseTypes?: TypeExpression[] }
  | { kind: "enum"; values: string[] }
  | { kind: "unsupported"; diagnostic: SchemaDiagnosticFact };

export interface ParsedSourceSet {
  generation: string;
  files: readonly unknown[];
}

export interface AffectedSchemaRootsQuery {
  changedSources: readonly { repoId: string; fileId: string }[];
  changedDeclarations: readonly string[];
  changedResolutionScopes: readonly string[];
  previousBehaviorFingerprintId?: string;
}

export interface SchemaReconciliationPlan {
  affectedRootReferenceIds: string[];
  replacedSourceIds: string[];
  requiresFullReconciliation: boolean;
  reason: "source-change" | "scope-change" | "declaration-change" | "behavior-change";
}

export interface TypeSystemAdapter {
  readonly languageId: string;
  readonly adapterVersion: string;
  readonly ruleSetVersion: string;
  readonly serializationVersion: string;
  readonly maxDepth: number;
  readonly maxTypesPerRoot: number;
  indexDeclarations(input: ParsedSourceSet): TypeDeclarationFact[];
  parseTypeExpression(raw: string, context: ResolutionContextFact): TypeExpression;
  resolveType(expression: TypeExpression, context: ResolutionContextFact): ResolutionResult;
  projectType(expression: TypeExpression, context: ResolutionContextFact): TypeProjection;
  inspectSchemaShape(instance: TypeInstanceIdentity): SchemaShape;
}

export function createSchemaBehaviorFingerprint(input: {
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
}): SchemaBehaviorFingerprint {
  const normalized = {
    languageId: normalizeFingerprintText(input.languageId),
    repoId: normalizeFingerprintText(input.repoId),
    resolutionScopeId: normalizeFingerprintText(input.resolutionScopeId),
    adapterVersion: normalizeFingerprintText(input.adapterVersion),
    ruleSetVersion: normalizeFingerprintText(input.ruleSetVersion),
    serializationVersion: normalizeFingerprintText(input.serializationVersion),
    maxDepth: input.maxDepth,
    maxTypesPerRoot: input.maxTypesPerRoot,
    buildInputsHash: normalizeFingerprintText(input.buildInputsHash),
    generation: normalizeFingerprintText(input.generation)
  };
  return { id: stableFactId("schema-behavior", { ...normalized, generation: undefined }), ...normalized };
}

function normalizeFingerprintText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function schemaBehaviorMatchesImplementation(
  fingerprint: SchemaBehaviorFingerprint,
  implementation: SchemaBehaviorImplementation
): boolean {
  return normalizeFingerprintText(fingerprint.adapterVersion) === normalizeFingerprintText(implementation.adapterVersion)
    && normalizeFingerprintText(fingerprint.ruleSetVersion) === normalizeFingerprintText(implementation.ruleSetVersion)
    && normalizeFingerprintText(fingerprint.serializationVersion) === normalizeFingerprintText(implementation.serializationVersion)
    && fingerprint.maxDepth === implementation.maxDepth
    && fingerprint.maxTypesPerRoot === implementation.maxTypesPerRoot;
}

export function schemaScopeDependencySetChanged(
  previous: readonly ResolutionScopeDependencyFact[],
  pending: readonly ResolutionScopeDependencyFact[]
): boolean {
  const key = (facts: readonly ResolutionScopeDependencyFact[]): string => canonicalDependencySet(facts);
  return key(previous) !== key(pending);
}

function canonicalDependencySet(facts: readonly ResolutionScopeDependencyFact[]): string {
  return JSON.stringify(facts.map(({ id, from, to, kind, order }) => ({ id, from, to, kind, order }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

export function assertTypeSystemAdapterContract(adapter: TypeSystemAdapter): void {
  if (!adapter.languageId.trim() || !adapter.adapterVersion.trim() || !adapter.ruleSetVersion.trim() || !adapter.serializationVersion.trim()) {
    throw new Error("Type system adapter identifiers and versions must be non-empty.");
  }
  if (!Number.isSafeInteger(adapter.maxDepth) || adapter.maxDepth <= 0) {
    throw new Error("Type system adapter maxDepth must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(adapter.maxTypesPerRoot) || adapter.maxTypesPerRoot <= 0) {
    throw new Error("Type system adapter maxTypesPerRoot must be a positive safe integer.");
  }
}
