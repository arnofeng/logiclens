import type { ContractSpecNode, SemanticRelationEdge } from "../../parsing/types.js";
import { confidenceFor } from "../../../shared/confidence.js";
import { deserializeSpec, type DubboMethodSpec } from "../spec.js";
import type { SpecRoleMap } from "./types.js";

type ParsedDubboSpec = {
  specNode: ContractSpecNode;
  dubboSpec: DubboMethodSpec;
};

export function resolveDubboRelations(
  contractSpecs: ContractSpecNode[],
  specRoles: SpecRoleMap
): SemanticRelationEdge[] {
  const producersRaw: ContractSpecNode[] = [];
  const consumers: ContractSpecNode[] = [];

  for (const spec of contractSpecs) {
    if (spec.specKind !== "dubbo-method") continue;
    const role = specRoles.get(`${spec.contractId}:${spec.repoId}`) ?? "shared";
    if (role === "producer" || role === "owner") producersRaw.push(spec);
    if (role === "consumer") consumers.push(spec);
    if (role === "shared") {
      producersRaw.push(spec);
      consumers.push(spec);
    }
  }

  if (producersRaw.length === 0 || consumers.length === 0) return [];

  const producerBuckets = new Map<string, ParsedDubboSpec[]>();
  for (const producerSpec of producersRaw) {
    const dubboSpec = deserializeSpec(producerSpec.specJson) as DubboMethodSpec;
    const key = interfaceKey(dubboSpec.interfaceName);
    const list = producerBuckets.get(key);
    const item = { specNode: producerSpec, dubboSpec };
    if (list) list.push(item);
    else producerBuckets.set(key, [item]);
  }

  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();
  for (const consumerSpec of consumers) {
    const consumer = deserializeSpec(consumerSpec.specJson) as DubboMethodSpec;
    const candidates = producerBuckets.get(interfaceKey(consumer.interfaceName)) ?? [];
    for (const producer of candidates) {
      if (consumerSpec.id === producer.specNode.id) continue;
      if (consumerSpec.repoId === producer.specNode.repoId) continue;
      if (!methodsCompatible(consumer.method, producer.dubboSpec.method)) continue;

      const dedupKey = `${consumerSpec.id}:${producer.specNode.id}:CALLS_ENDPOINT`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const classified = classifyDubboMatch(consumer, producer.dubboSpec);
      edges.push({
        fromSpecId: consumerSpec.id,
        toSpecId: producer.specNode.id,
        kind: "CALLS_ENDPOINT",
        evidenceId: consumerSpec.evidenceId,
        reason: classified.reason,
        confidence: classified.confidence
      });
    }
  }

  return edges;
}

function interfaceKey(interfaceName: string): string {
  return interfaceName.replace(/\s+/g, "").toLowerCase();
}

function methodsCompatible(left: string | undefined, right: string | undefined): boolean {
  if (!left || left === "*" || !right || right === "*") return true;
  return left === right;
}

function classifyDubboMatch(
  consumer: DubboMethodSpec,
  producer: DubboMethodSpec
): { reason: string; confidence: number } {
  const consumerName = `${consumer.interfaceName}#${consumer.method || "*"}`;
  const producerName = `${producer.interfaceName}#${producer.method || "*"}`;
  const interfaceLevel = consumer.method === "*" || producer.method === "*" || !consumer.method || !producer.method;

  if (interfaceLevel) {
    return {
      reason: `Dubbo interface-level match: ${consumerName} -> ${producerName}`,
      confidence: confidenceFor("method-unknown-fallback")
    };
  }

  const groupVersion = classifyGroupVersion(consumer, producer);
  if (groupVersion === "mismatch") {
    return {
      reason: `Dubbo method match with group/version mismatch: ${consumerName} -> ${producerName}`,
      confidence: confidenceFor("probable-dubbo-group-version-mismatch")
    };
  }
  if (groupVersion === "partial") {
    return {
      reason: `Dubbo method match with group/version unspecified: ${consumerName} -> ${producerName}`,
      confidence: confidenceFor("probable-dubbo-group-version-unspecified")
    };
  }

  return {
    reason: `Dubbo exact match: ${consumerName}`,
    confidence: confidenceFor("exact-dubbo-match")
  };
}

function classifyGroupVersion(consumer: DubboMethodSpec, producer: DubboMethodSpec): "exact" | "partial" | "mismatch" {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [consumer.group, producer.group],
    [consumer.version, producer.version]
  ];
  let partial = false;
  for (const [left, right] of pairs) {
    if (left && right && left !== right) return "mismatch";
    if (!left || !right) partial = true;
  }
  return partial ? "partial" : "exact";
}
