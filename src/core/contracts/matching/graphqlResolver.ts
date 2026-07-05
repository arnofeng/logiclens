import type { ContractSpecNode, SemanticRelationEdge } from "../../parsing/types.js";
import type { SpecRoleMap } from "./types.js";
import { confidenceFor } from "../../../shared/confidence.js";

/**
 * Resolves CALLS_ENDPOINT relations between GraphQL consumers (clients) and producers (SDL schemas).
 */
export function resolveGraphqlRelations(
  contractSpecs: ContractSpecNode[],
  specRoles: SpecRoleMap
): SemanticRelationEdge[] {
  const producers: ContractSpecNode[] = [];
  const consumers: ContractSpecNode[] = [];

  for (const spec of contractSpecs) {
    if (spec.specKind !== "graphql-operation") continue;

    const role = specRoles.get(`${spec.contractId}:${spec.repoId}`) ?? "shared";
    if (role === "producer" || role === "owner") {
      producers.push(spec);
    }
    if (role === "consumer") {
      consumers.push(spec);
    }
    if (role === "shared") {
      producers.push(spec);
      consumers.push(spec);
    }
  }

  if (producers.length === 0 || consumers.length === 0) return [];

  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();

  for (const consumerSpec of consumers) {
    for (const producerSpec of producers) {
      if (consumerSpec.id === producerSpec.id) continue;
      if (consumerSpec.repoId === producerSpec.repoId) continue;

      if (consumerSpec.canonicalKey === producerSpec.canonicalKey) {
        const dedupKey = `${consumerSpec.id}:${producerSpec.id}:CALLS_ENDPOINT`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        edges.push({
          fromSpecId: consumerSpec.id,
          toSpecId: producerSpec.id,
          kind: "CALLS_ENDPOINT",
          evidenceId: consumerSpec.evidenceId,
          reason: `GraphQL operation match: ${consumerSpec.canonicalKey}`,
          confidence: confidenceFor("exact-graphql-match")
        });
      }
    }
  }

  return edges;
}
