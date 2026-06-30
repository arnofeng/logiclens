import type { ContractSpecNode, SemanticRelationKind } from "../../../parsing/types.js";
import { deserializeSpec, type GraphQLOperationSpec } from "../../spec.js";
import type { ChangeIntent, ImpactItem, ImpactAnalysisOptions } from "../types.js";

/**
 * Classifies the impact on the target GraphQL operation spec itself (the spec
 * being changed).
 */
export function classifyGraphqlOperationTargetChange(
  change: ChangeIntent,
  spec: ContractSpecNode
): ImpactItem | null {
  const gqlSpec = deserializeSpec(spec.specJson) as GraphQLOperationSpec;
  if (gqlSpec.kind !== "graphql-operation") return null;

  const base = {
    repoId: spec.repoId,
    filePath: spec.fileId,
    specId: spec.id,
  };

  if (change.changeType === "rpc-removed") {
    return {
      ...base,
      severity: "breaking",
      symbol: gqlSpec.fullName,
      relationKind: "IMPACTS",
      description: `GraphQL operation ${gqlSpec.fullName} will be removed`,
      evidence: `operation: ${gqlSpec.fullName}`,
      confidence: spec.confidence,
    };
  }
  if (change.changeType === "rpc-renamed") {
    return {
      ...base,
      severity: "breaking",
      symbol: gqlSpec.fullName,
      relationKind: "IMPACTS",
      description: `GraphQL operation renamed to ${change.detail ?? "unknown"}`,
      evidence: `operation: ${gqlSpec.fullName}`,
      confidence: spec.confidence,
    };
  }
  if (change.changeType === "rpc-signature-change") {
    return {
      ...base,
      severity: "risky",
      symbol: gqlSpec.fullName,
      relationKind: "IMPACTS",
      description: `Signature changed for GraphQL operation ${gqlSpec.fullName}`,
      evidence: `operation: ${gqlSpec.fullName}`,
      confidence: spec.confidence,
    };
  }

  return null;
}

/**
 * Assesses the impact of a contract change on a GraphQL operation consumer.
 */
export function assessGraphqlOperationChange(
  change: ChangeIntent,
  dependentSpec: ContractSpecNode,
  relationKind: SemanticRelationKind,
  reason: string,
  confidence: number,
  _options?: ImpactAnalysisOptions
): ImpactItem[] {
  const gqlSpec = deserializeSpec(dependentSpec.specJson) as GraphQLOperationSpec;
  if (gqlSpec.kind !== "graphql-operation") return [];

  const base = {
    repoId: dependentSpec.repoId,
    specId: dependentSpec.id,
    filePath: dependentSpec.fileId,
    relationKind,
    confidence,
  };

  switch (change.changeType) {
    case "rpc-removed":
      return [{
        ...base,
        severity: "breaking",
        symbol: gqlSpec.fullName,
        description: `Consumer calls removed GraphQL operation ${gqlSpec.fullName}`,
        evidence: `${gqlSpec.fullName} (via ${relationKind}: ${reason})`,
      }];

    case "rpc-renamed":
      return [{
        ...base,
        severity: "breaking",
        symbol: gqlSpec.fullName,
        description: `Consumer references renamed GraphQL operation ${gqlSpec.fullName} → ${change.detail ?? "unknown"}`,
        evidence: `${gqlSpec.fullName} (via ${relationKind}: ${reason})`,
      }];

    case "rpc-signature-change":
      return [{
        ...base,
        severity: "risky",
        symbol: gqlSpec.fullName,
        description: `Consumer may be affected by signature change on ${gqlSpec.fullName}`,
        evidence: `${gqlSpec.fullName} (via ${relationKind}: ${reason})`,
      }];

    // Cross-cutting schema changes (propagating via REQUEST_SCHEMA / RESPONSE_SCHEMA)
    case "field-removed":
      return [{
        ...base,
        severity: "risky",
        symbol: gqlSpec.fullName,
        description: `Request/response schema field '${change.detail ?? "unknown"}' removed — affects GraphQL operation ${gqlSpec.fullName}`,
        evidence: `${gqlSpec.fullName} (via ${relationKind})`,
      }];

    case "field-type-changed":
      return [{
        ...base,
        severity: "risky",
        symbol: gqlSpec.fullName,
        description: `Schema field type changed for '${change.detail ?? "unknown"}' — affects GraphQL operation ${gqlSpec.fullName}`,
        evidence: `${gqlSpec.fullName} (via ${relationKind})`,
      }];

    case "field-added":
      return [{
        ...base,
        severity: "compatible",
        symbol: gqlSpec.fullName,
        description: `New schema field '${change.detail ?? "unknown"}' added — compatible with GraphQL operation ${gqlSpec.fullName}`,
        evidence: `${gqlSpec.fullName} (via ${relationKind})`,
      }];

    default:
      return [];
  }
}
