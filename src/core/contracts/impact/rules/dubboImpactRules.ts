import type { ContractSpecNode, SemanticRelationKind } from "../../../parsing/types.js";
import { deserializeSpec, type DubboMethodSpec } from "../../spec.js";
import type { ChangeIntent, ImpactAnalysisOptions, ImpactItem } from "../types.js";

function dubboSymbol(spec: DubboMethodSpec): string {
  return `${spec.interfaceName}#${spec.method || "*"}`;
}

export function classifyDubboMethodTargetChange(
  change: ChangeIntent,
  spec: ContractSpecNode
): ImpactItem | null {
  const dubboSpec = deserializeSpec(spec.specJson) as DubboMethodSpec;
  if (dubboSpec.kind !== "dubbo-method") return null;

  const symbol = dubboSymbol(dubboSpec);
  const base = {
    repoId: spec.repoId,
    filePath: spec.fileId,
    specId: spec.id,
    relationKind: "IMPACTS" as const,
    confidence: spec.confidence
  };

  if (change.changeType === "rpc-removed") {
    return {
      ...base,
      severity: "breaking",
      symbol,
      description: `Dubbo method ${symbol} will be removed`,
      evidence: `rpc: ${symbol}`
    };
  }
  if (change.changeType === "rpc-renamed") {
    return {
      ...base,
      severity: "breaking",
      symbol,
      description: `Dubbo method renamed to ${change.detail ?? "unknown"}`,
      evidence: `rpc: ${symbol}`
    };
  }
  if (change.changeType === "rpc-signature-change") {
    return {
      ...base,
      severity: "risky",
      symbol,
      description: `Signature changed for Dubbo method ${symbol}`,
      evidence: `rpc: ${symbol}`
    };
  }

  return null;
}

export function assessDubboMethodChange(
  change: ChangeIntent,
  dependentSpec: ContractSpecNode,
  relationKind: SemanticRelationKind,
  reason: string,
  confidence: number,
  _options?: ImpactAnalysisOptions
): ImpactItem[] {
  const dubboSpec = deserializeSpec(dependentSpec.specJson) as DubboMethodSpec;
  if (dubboSpec.kind !== "dubbo-method") return [];

  const symbol = dubboSymbol(dubboSpec);
  const base = {
    repoId: dependentSpec.repoId,
    specId: dependentSpec.id,
    filePath: dependentSpec.fileId,
    relationKind,
    confidence
  };

  switch (change.changeType) {
    case "rpc-removed":
      return [{
        ...base,
        severity: "breaking",
        symbol,
        description: `Consumer calls removed Dubbo method ${symbol}`,
        evidence: `${symbol} (via ${relationKind}: ${reason})`
      }];

    case "rpc-renamed":
      return [{
        ...base,
        severity: "breaking",
        symbol,
        description: `Consumer references renamed Dubbo method ${symbol} -> ${change.detail ?? "unknown"}`,
        evidence: `${symbol} (via ${relationKind}: ${reason})`
      }];

    case "rpc-signature-change":
      return [{
        ...base,
        severity: "risky",
        symbol,
        description: `Consumer may be affected by signature change on ${symbol}`,
        evidence: `${symbol} (via ${relationKind}: ${reason})`
      }];

    case "field-removed":
      return [{
        ...base,
        severity: "risky",
        symbol,
        description: `Request/response schema field '${change.detail ?? "unknown"}' removed - affects Dubbo method ${symbol}`,
        evidence: `${symbol} (via ${relationKind})`
      }];

    case "field-type-changed":
      return [{
        ...base,
        severity: "risky",
        symbol,
        description: `Schema field type changed for '${change.detail ?? "unknown"}' - affects Dubbo method ${symbol}`,
        evidence: `${symbol} (via ${relationKind})`
      }];

    case "field-added":
      return [{
        ...base,
        severity: "compatible",
        symbol,
        description: `New schema field '${change.detail ?? "unknown"}' added - compatible with Dubbo method ${symbol}`,
        evidence: `${symbol} (via ${relationKind})`
      }];

    default:
      return [];
  }
}
