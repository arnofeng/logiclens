import type {
  CanonicalTypeExpression,
  ResolutionContextFact,
  SchemaBehaviorFingerprint,
  SchemaDiagnosticFact,
  SchemaFieldSpec,
  TypeDeclarationFact,
  TypeExpression,
  TypeInstanceIdentity
} from "./model.js";
import { stableFactId } from "./model.js";

export const DEFAULT_SCHEMA_MAX_DEPTH = 12;
export const DEFAULT_SCHEMA_MAX_TYPES_PER_ROOT = 256;

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
  return { id: stableFactId("schema-behavior", { ...input, generation: undefined }), ...input };
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
