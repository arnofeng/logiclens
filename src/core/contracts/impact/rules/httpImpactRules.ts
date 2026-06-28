// ---------------------------------------------------------------------------
// Phase 5: HTTP Endpoint Impact Rules
//
// Determines impact severity for HTTP endpoint consumers when an endpoint
// is renamed, removed, or has its request/response schema changed.
// ---------------------------------------------------------------------------

import type { ContractSpecNode, SemanticRelationKind } from "../../../parsing/types.js";
import { deserializeSpec, type HttpEndpointSpec } from "../../spec.js";
import type { ChangeIntent, ImpactItem } from "../types.js";
import type { ImpactAnalysisOptions } from "../types.js";

/**
 * Classifies the impact on the target HTTP endpoint spec itself (the spec
 * being changed). Extracted from `impactEngine.classifyTargetChange` for
 * the registry pattern.
 */
export function classifyHttpEndpointTargetChange(
  change: ChangeIntent,
  spec: ContractSpecNode
): ImpactItem | null {
  const httpSpec = deserializeSpec(spec.specJson) as HttpEndpointSpec;
  if (httpSpec.kind !== "http-endpoint") return null;

  const base = {
    repoId: spec.repoId,
    filePath: spec.fileId,
    specId: spec.id,
  };

  if (change.changeType === "endpoint-removed") {
    return {
      ...base,
      severity: "breaking",
      symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
      relationKind: "IMPACTS",
      description: `HTTP endpoint ${httpSpec.method ?? "ANY"} ${httpSpec.path} will be removed`,
      evidence: `endpoint: ${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate}`,
      confidence: spec.confidence,
    };
  }
  if (change.changeType === "endpoint-renamed" && change.detail) {
    return {
      ...base,
      severity: "breaking",
      symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
      relationKind: "IMPACTS",
      description: `HTTP endpoint renamed to ${change.detail}`,
      evidence: `endpoint: ${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate}`,
      confidence: spec.confidence,
    };
  }
  if (change.changeType === "endpoint-schema-change") {
    return {
      ...base,
      severity: "risky",
      symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
      relationKind: "IMPACTS",
      description: `Request/response schema changed for ${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
      evidence: `endpoint: ${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate}`,
      confidence: spec.confidence,
    };
  }

  return null;
}

/**
 * Assesses the impact of a contract change on an HTTP endpoint consumer.
 */
export function assessHttpEndpointChange(
  change: ChangeIntent,
  dependentSpec: ContractSpecNode,
  relationKind: SemanticRelationKind,
  reason: string,
  confidence: number,
  _options?: ImpactAnalysisOptions
): ImpactItem[] {
  const httpSpec = deserializeSpec(dependentSpec.specJson) as HttpEndpointSpec;
  if (httpSpec.kind !== "http-endpoint") return [];

  const base = {
    repoId: dependentSpec.repoId,
    specId: dependentSpec.id,
    filePath: dependentSpec.fileId,
    relationKind,
    confidence,
  };

  switch (change.changeType) {
    case "endpoint-removed":
      return [{
        ...base,
        severity: "breaking",
        symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        description: `Consumer calls removed endpoint ${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        evidence: `${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate} (via ${relationKind}: ${reason})`,
      }];

    case "endpoint-renamed":
      return [{
        ...base,
        severity: "breaking",
        symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        description: `Consumer references renamed endpoint ${httpSpec.method ?? "ANY"} ${httpSpec.path} → ${change.detail ?? "unknown"}`,
        evidence: `${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate} (via ${relationKind}: ${reason})`,
      }];

    case "endpoint-schema-change":
      return [{
        ...base,
        severity: "risky",
        symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        description: `Consumer may be affected by schema change on ${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        evidence: `${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate} (via ${relationKind}: ${reason})`,
      }];

    // Cross-cutting: if a schema field changed and this HTTP endpoint uses that schema
    case "field-removed":
      return [{
        ...base,
        severity: "risky",
        symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        description: `Request/response schema field '${change.detail ?? "unknown"}' removed — affects ${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        evidence: `${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate} (via ${relationKind})`,
      }];

    case "field-type-changed":
      return [{
        ...base,
        severity: "risky",
        symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        description: `Schema field type changed for '${change.detail ?? "unknown"}' — affects ${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        evidence: `${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate} (via ${relationKind})`,
      }];

    case "field-added":
      return [{
        ...base,
        severity: "compatible",
        symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        description: `New schema field '${change.detail ?? "unknown"}' added — compatible with ${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        evidence: `${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate} (via ${relationKind})`,
      }];

    default:
      return [];
  }
}
