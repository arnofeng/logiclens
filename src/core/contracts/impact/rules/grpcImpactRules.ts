import type { ContractSpecNode, SemanticRelationKind } from "../../../parsing/types.js";
import { deserializeSpec, type GrpcMethodSpec } from "../../spec.js";
import type { ChangeIntent, ImpactItem } from "../types.js";
import type { ImpactAnalysisOptions } from "../types.js";

/**
 * Classifies the impact on the target gRPC method spec itself (the spec
 * being changed).
 */
export function classifyGrpcMethodTargetChange(
  change: ChangeIntent,
  spec: ContractSpecNode
): ImpactItem | null {
  const grpcSpec = deserializeSpec(spec.specJson) as GrpcMethodSpec;
  if (grpcSpec.kind !== "grpc-method") return null;

  const base = {
    repoId: spec.repoId,
    filePath: spec.fileId,
    specId: spec.id,
  };

  if (change.changeType === "rpc-removed") {
    return {
      ...base,
      severity: "breaking",
      symbol: `${grpcSpec.service}/${grpcSpec.method}`,
      relationKind: "IMPACTS",
      description: `gRPC method ${grpcSpec.service}/${grpcSpec.method} will be removed`,
      evidence: `rpc: ${grpcSpec.service}/${grpcSpec.method}`,
      confidence: spec.confidence,
    };
  }
  if (change.changeType === "rpc-renamed") {
    return {
      ...base,
      severity: "breaking",
      symbol: `${grpcSpec.service}/${grpcSpec.method}`,
      relationKind: "IMPACTS",
      description: `gRPC method renamed to ${change.detail ?? "unknown"}`,
      evidence: `rpc: ${grpcSpec.service}/${grpcSpec.method}`,
      confidence: spec.confidence,
    };
  }
  if (change.changeType === "rpc-signature-change") {
    return {
      ...base,
      severity: "risky",
      symbol: `${grpcSpec.service}/${grpcSpec.method}`,
      relationKind: "IMPACTS",
      description: `Signature changed for gRPC method ${grpcSpec.service}/${grpcSpec.method}`,
      evidence: `rpc: ${grpcSpec.service}/${grpcSpec.method}`,
      confidence: spec.confidence,
    };
  }

  return null;
}

/**
 * Assesses the impact of a contract change on a gRPC method consumer.
 */
export function assessGrpcMethodChange(
  change: ChangeIntent,
  dependentSpec: ContractSpecNode,
  relationKind: SemanticRelationKind,
  reason: string,
  confidence: number,
  _options?: ImpactAnalysisOptions
): ImpactItem[] {
  const grpcSpec = deserializeSpec(dependentSpec.specJson) as GrpcMethodSpec;
  if (grpcSpec.kind !== "grpc-method") return [];

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
        symbol: `${grpcSpec.service}/${grpcSpec.method}`,
        description: `Consumer calls removed gRPC method ${grpcSpec.service}/${grpcSpec.method}`,
        evidence: `${grpcSpec.service}/${grpcSpec.method} (via ${relationKind}: ${reason})`,
      }];

    case "rpc-renamed":
      return [{
        ...base,
        severity: "breaking",
        symbol: `${grpcSpec.service}/${grpcSpec.method}`,
        description: `Consumer references renamed gRPC method ${grpcSpec.service}/${grpcSpec.method} → ${change.detail ?? "unknown"}`,
        evidence: `${grpcSpec.service}/${grpcSpec.method} (via ${relationKind}: ${reason})`,
      }];

    case "rpc-signature-change":
      return [{
        ...base,
        severity: "risky",
        symbol: `${grpcSpec.service}/${grpcSpec.method}`,
        description: `Consumer may be affected by signature change on ${grpcSpec.service}/${grpcSpec.method}`,
        evidence: `${grpcSpec.service}/${grpcSpec.method} (via ${relationKind}: ${reason})`,
      }];

    // Cross-cutting: if a schema field changed and this gRPC method uses that schema
    case "field-removed":
      return [{
        ...base,
        severity: "risky",
        symbol: `${grpcSpec.service}/${grpcSpec.method}`,
        description: `Request/response schema field '${change.detail ?? "unknown"}' removed — affects gRPC method ${grpcSpec.service}/${grpcSpec.method}`,
        evidence: `${grpcSpec.service}/${grpcSpec.method} (via ${relationKind})`,
      }];

    case "field-type-changed":
      return [{
        ...base,
        severity: "risky",
        symbol: `${grpcSpec.service}/${grpcSpec.method}`,
        description: `Schema field type changed for '${change.detail ?? "unknown"}' — affects gRPC method ${grpcSpec.service}/${grpcSpec.method}`,
        evidence: `${grpcSpec.service}/${grpcSpec.method} (via ${relationKind})`,
      }];

    case "field-added":
      return [{
        ...base,
        severity: "compatible",
        symbol: `${grpcSpec.service}/${grpcSpec.method}`,
        description: `New schema field '${change.detail ?? "unknown"}' added — compatible with gRPC method ${grpcSpec.service}/${grpcSpec.method}`,
        evidence: `${grpcSpec.service}/${grpcSpec.method} (via ${relationKind})`,
      }];

    default:
      return [];
  }
}
