import type { ContractSpecNode, SemanticRelationEdge } from "../../parsing/types.js";
import type { SpecRoleMap } from "./types.js";
import { deserializeSpec } from "../spec.js";
import type { GrpcMethodSpec } from "../spec.js";
import { confidenceFor } from "../../../shared/confidence.js";

interface ParsedGrpcSpec {
  specNode: ContractSpecNode;
  grpcSpec: GrpcMethodSpec;
}

/**
 * Resolves CALLS_ENDPOINT relations between gRPC consumers (clients) and producers (servers).
 *
 * Matching is package-agnostic to handle cases where Go import package names
 * and actual proto packages differ. Matching relies on Service and Method name equality,
 * with package mismatches causing a downgrade in confidence rather than blocking the match.
 *
 * Performance is optimized by pre-deserializing producer specs once and grouping them
 * into service-based buckets.
 */
export function resolveGrpcRelations(
  contractSpecs: ContractSpecNode[],
  specRoles: SpecRoleMap
): SemanticRelationEdge[] {
  const producersRaw: ContractSpecNode[] = [];
  const consumers: ContractSpecNode[] = [];

  for (const spec of contractSpecs) {
    if (spec.specKind !== "grpc-method") continue;

    const role = specRoles.get(`${spec.contractId}:${spec.repoId}`) ?? "shared";
    if (role === "producer" || role === "owner") {
      producersRaw.push(spec);
    }
    if (role === "consumer") {
      consumers.push(spec);
    }
    if (role === "shared") {
      producersRaw.push(spec);
      consumers.push(spec);
    }
  }

  if (producersRaw.length === 0 || consumers.length === 0) return [];

  // Pre-deserialize all producers and bucket them by service name to optimize matching performance
  const producerBuckets = new Map<string, ParsedGrpcSpec[]>();
  for (const producerSpec of producersRaw) {
    const grpcSpec = deserializeSpec(producerSpec.specJson) as GrpcMethodSpec;
    const item: ParsedGrpcSpec = { specNode: producerSpec, grpcSpec };
    const list = producerBuckets.get(grpcSpec.service);
    if (list) {
      list.push(item);
    } else {
      producerBuckets.set(grpcSpec.service, [item]);
    }
  }

  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();

  for (const consumerSpec of consumers) {
    const consumer = deserializeSpec(consumerSpec.specJson) as GrpcMethodSpec;
    
    // Query only producers registered in the matching service bucket
    const candidates = producerBuckets.get(consumer.service) ?? [];
    for (const producer of candidates) {
      if (consumerSpec.id === producer.specNode.id) continue;
      if (consumerSpec.repoId === producer.specNode.repoId) continue;

      if (consumer.method === producer.grpcSpec.method) {
        const dedupKey = `${consumerSpec.id}:${producer.specNode.id}:CALLS_ENDPOINT`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        let confidence = confidenceFor("exact-grpc-match");
        let reason = `gRPC match: ${consumer.service}/${consumer.method}`;

        if (consumer.package && producer.grpcSpec.package) {
          if (consumer.package !== producer.grpcSpec.package) {
            confidence = confidenceFor("probable-grpc-package-mismatch");
            reason = `gRPC match with package mismatch: ${consumer.package}.${consumer.service}/${consumer.method} ↔ ${producer.grpcSpec.package}.${producer.grpcSpec.service}/${producer.grpcSpec.method}`;
          } else {
            confidence = confidenceFor("exact-grpc-match");
            reason = `gRPC exact match: ${consumer.package}.${consumer.service}/${consumer.method}`;
          }
        } else if (producer.grpcSpec.package) {
          reason = `gRPC match (client package unspecified): ${consumer.service}/${consumer.method} ↔ ${producer.grpcSpec.package}.${producer.grpcSpec.service}/${producer.grpcSpec.method}`;
          confidence = confidenceFor("probable-grpc-package-unspecified");
        } else if (consumer.package) {
          reason = `gRPC match (server package unspecified): ${consumer.package}.${consumer.service}/${consumer.method} ↔ ${producer.grpcSpec.service}/${producer.grpcSpec.method}`;
          confidence = confidenceFor("probable-grpc-package-unspecified");
        }

        edges.push({
          fromSpecId: consumerSpec.id,
          toSpecId: producer.specNode.id,
          kind: "CALLS_ENDPOINT",
          evidenceId: consumerSpec.evidenceId,
          reason,
          confidence
        });
      }
    }
  }

  return edges;
}
