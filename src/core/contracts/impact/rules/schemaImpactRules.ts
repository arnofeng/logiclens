// ---------------------------------------------------------------------------
// Phase 5: Schema Field Impact Rules
//
// Determines impact severity when a schema field is added, removed, or has
// its type changed. Includes optional file-level field reference search
// to find exact occurrences in dependent files.
// ---------------------------------------------------------------------------

import type { ContractSpecNode, SemanticRelationKind } from "../../../parsing/types.js";
import { deserializeSpec, type SchemaSpec, type SchemaFieldSpec } from "../../spec.js";
import { findFieldReferences } from "../fieldSearch.js";
import type { ChangeIntent, ImpactItem, ImpactSeverity, ImpactAnalysisOptions } from "../types.js";

/**
 * Classifies the impact on the target schema spec itself (the spec being
 * changed). Extracted from `impactEngine.classifyTargetChange` for the
 * registry pattern.
 */
export function classifySchemaTargetChange(
  change: ChangeIntent,
  spec: ContractSpecNode
): ImpactItem | null {
  const schemaSpec = deserializeSpec(spec.specJson) as SchemaSpec;
  if (schemaSpec.kind !== "schema") return null;

  const fieldName = change.detail ?? "unknown field";
  // Check if the field is optional to adjust severity
  const field = schemaSpec.fields.find((f) => f.name === fieldName);
  const severity: ImpactSeverity = field?.optional && change.changeType === "field-removed"
    ? "risky" : schemaFieldChangeSeverity(change.changeType);

  return {
    repoId: spec.repoId,
    filePath: spec.fileId,
    specId: spec.id,
    severity,
    symbol: `${schemaSpec.name}.${fieldName}`,
    relationKind: "IMPACTS",
    description: `${change.changeType}: ${fieldName} in ${schemaSpec.name}`,
    evidence: `schema: ${schemaSpec.name}.${fieldName}${field ? ` (${field.type}${field.optional ? ", optional" : ""})` : ""}`,
    confidence: spec.confidence,
  };
}

/** Maps a schema change type to its default severity. */
function schemaFieldChangeSeverity(
  changeType: ChangeIntent["changeType"]
): ImpactSeverity {
  switch (changeType) {
    case "field-removed": return "breaking";
    case "field-type-changed": return "risky";
    case "field-added": return "compatible";
    default: return "risky";
  }
}

/**
 * Assesses the impact of a schema field change on dependent contracts.
 * When `options.readFile` is provided, performs file-level field reference
 * search to produce precise line-level evidence.
 */
export function assessSchemaFieldChange(
  change: ChangeIntent,
  dependentSpec: ContractSpecNode,
  relationKind: SemanticRelationKind,
  _reason: string,
  confidence: number,
  options: ImpactAnalysisOptions
): ImpactItem[] {
  const schemaSpec = deserializeSpec(dependentSpec.specJson) as SchemaSpec;
  if (schemaSpec.kind !== "schema") return [];

  const fieldName = change.detail;
  if (!fieldName) return [];

  // Find the specific field in the schema (for evidence)
  const field = schemaSpec.fields.find((f) => f.name === fieldName);
  const fieldEvidence = field
    ? `${field.name}: ${field.type}${field.optional ? " (optional)" : ""}`
    : `${fieldName} (not found in schema fields)`;

  const base = {
    repoId: dependentSpec.repoId,
    specId: dependentSpec.id,
    filePath: "", // will be set below
    relationKind,
    confidence,
  };

  const items: ImpactItem[] = [];

  // Determine severity based on change type and field characteristics
  let severity = schemaChangeSeverity(change.changeType, field);

  // If readFile is available, search for field references in dependent files
  if (options.readFile && dependentSpec.fileId) {
    const fileContent = options.readFile(dependentSpec.repoId, dependentSpec.fileId);
    if (fileContent) {
      const refs = findFieldReferences(fileContent, fieldName, dependentSpec.fileId);
      if (refs.length > 0) {
        // Produce per-reference impact items
        for (const ref of refs) {
          items.push({
            ...base,
            severity,
            filePath: dependentSpec.fileId,
            symbol: `${schemaSpec.name}.${fieldName}`,
            description: formatDescription(change.changeType, fieldName, schemaSpec.name, dependentSpec.repoId),
            evidence: ref.raw,
            line: ref.line,
          });
        }
        return items;
      }
    }
  }

  // No file search or no references found — produce a single spec-level impact
  items.push({
    ...base,
    severity,
    filePath: dependentSpec.fileId,
    symbol: `${schemaSpec.name}.${fieldName}`,
    description: formatDescription(change.changeType, fieldName, schemaSpec.name, dependentSpec.repoId),
    evidence: fieldEvidence,
  });

  return items;
}

function schemaChangeSeverity(
  changeType: ChangeIntent["changeType"],
  field?: SchemaFieldSpec
): ImpactItem["severity"] {
  switch (changeType) {
    case "field-removed":
      // If the field was optional, it's risky rather than breaking
      return field?.optional ? "risky" : "breaking";
    case "field-type-changed":
      return "risky";
    case "field-added":
      return "compatible";
    default:
      return "risky";
  }
}

function formatDescription(
  changeType: ChangeIntent["changeType"],
  fieldName: string,
  schemaName: string,
  repoId: string
): string {
  switch (changeType) {
    case "field-removed":
      return `Field '${fieldName}' removed from ${schemaName} — may break consumers in ${repoId}`;
    case "field-type-changed":
      return `Field '${fieldName}' type changed in ${schemaName} — may affect consumers in ${repoId}`;
    case "field-added":
      return `Field '${fieldName}' added to ${schemaName} — compatible change for ${repoId}`;
    default:
      return `Schema change in ${schemaName}.${fieldName} affects ${repoId}`;
  }
}
