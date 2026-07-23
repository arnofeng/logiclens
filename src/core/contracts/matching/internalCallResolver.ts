import type { ContractSpecNode, SemanticRelationEdge } from "../../parsing/types.js";
import type { SpecRoleMap } from "./types.js";

const CALLABLE_CONSUMER_KINDS = new Set([
  "http-endpoint",
  "dubbo-method",
  "grpc-method",
  "graphql-operation"
]);

/** Materializes exact handler-to-outbound-call flow from a shared Code id. */
export function resolveInternalCallRelations(
  specs: ContractSpecNode[],
  specRoles: SpecRoleMap
): SemanticRelationEdge[] {
  const bySourceSymbol = new Map<string, ContractSpecNode[]>();
  for (const spec of specs) {
    if (!spec.sourceSymbolId) continue;
    const key = `${spec.repoId}:${spec.sourceSymbolId}`;
    const list = bySourceSymbol.get(key);
    if (list) list.push(spec);
    else bySourceSymbol.set(key, [spec]);
  }

  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();
  for (const colocated of bySourceSymbol.values()) {
    const entries = colocated.filter((spec) => {
      const role = specRoles.get(`${spec.contractId}:${spec.repoId}`);
      return role === "producer" || role === "owner";
    });
    const outbound = colocated.filter((spec) => {
      if (!CALLABLE_CONSUMER_KINDS.has(spec.specKind)) return false;
      const role = specRoles.get(`${spec.contractId}:${spec.repoId}`);
      return role === "consumer";
    });

    for (const entry of entries) {
      for (const consumer of outbound) {
        if (entry.id === consumer.id || entry.contractId === consumer.contractId) continue;
        const key = `${entry.id}:${consumer.id}:INTERNAL_CALL`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          fromSpecId: entry.id,
          toSpecId: consumer.id,
          kind: "INTERNAL_CALL",
          evidenceId: consumer.evidenceId,
          reason: "Direct contract invocation in parsed source symbol",
          confidence: Math.min(entry.confidence, consumer.confidence)
        });
      }
    }
  }
  return edges;
}
