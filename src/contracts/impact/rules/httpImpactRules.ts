// ---------------------------------------------------------------------------
// Phase 5: HTTP Endpoint Impact Rules
//
// Determines impact severity for HTTP endpoint consumers when an endpoint
// is renamed, removed, or has its request/response schema changed.
// ---------------------------------------------------------------------------

import type { ContractSpecNode, SemanticRelationKind } from "../../../parsers/types.js";
import { deserializeSpec, type HttpEndpointSpec } from "../../spec.js";
import type { ChangeIntent, ImpactItem } from "../types.js";

/**
 * Assesses the impact of a contract change on an HTTP endpoint consumer.
 */
export function assessHttpEndpointChange(
  change: ChangeIntent,
  dependentSpec: ContractSpecNode,
  relationKind: SemanticRelationKind,
  reason: string,
  confidence: number
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
