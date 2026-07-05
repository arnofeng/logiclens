import { describe, expect, it } from "vitest";
import { resolveGrpcRelations } from "../../../src/core/contracts/matching/grpcResolver.js";
import type { ContractSpecNode } from "../../../src/core/parsing/types.js";
import type { SpecRoleMap } from "../../../src/core/contracts/matching/types.js";
import { serializeSpec } from "../../../src/core/contracts/spec.js";

function makeGrpcSpec(opts: {
  id: string;
  contractId: string;
  repoId: string;
  service: string;
  method: string;
  package?: string;
  evidenceId?: string;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "grpc-method",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:some/path`,
    evidenceId: opts.evidenceId ?? `ev:${opts.id}`,
    canonicalKey: opts.package ? `${opts.package}.${opts.service}/${opts.method}` : `${opts.service}/${opts.method}`,
    specJson: serializeSpec({
      kind: "grpc-method",
      fullName: opts.package ? `${opts.package}.${opts.service}/${opts.method}` : `${opts.service}/${opts.method}`,
      service: opts.service,
      method: opts.method,
      package: opts.package,
      requestType: "SomeRequest",
      responseType: "SomeResponse",
      streaming: "unary"
    }),
    confidence: 0.9
  };
}

function makeRoleMap(specs: ContractSpecNode[], roles: Record<string, string>): SpecRoleMap {
  const map: SpecRoleMap = new Map();
  for (const spec of specs) {
    const role = roles[spec.id] ?? "shared";
    map.set(`${spec.contractId}:${spec.repoId}`, role as any);
  }
  return map;
}

describe("gRPC Resolver", () => {
  it("matches client (consumer) and server (producer) by service and method", () => {
    const producer = makeGrpcSpec({
      id: "spec-producer",
      contractId: "contract-producer",
      repoId: "repo-server",
      service: "OrderService",
      method: "CreateOrder",
      package: "acme.order.v1"
    });

    const consumer = makeGrpcSpec({
      id: "spec-consumer",
      contractId: "contract-consumer",
      repoId: "repo-client",
      service: "OrderService",
      method: "CreateOrder"
    });

    const specs = [producer, consumer];
    const roles = makeRoleMap(specs, {
      "spec-producer": "producer",
      "spec-consumer": "consumer"
    });

    const edges = resolveGrpcRelations(specs, roles);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromSpecId).toBe("spec-consumer");
    expect(edges[0]!.toSpecId).toBe("spec-producer");
    expect(edges[0]!.kind).toBe("CALLS_ENDPOINT");
    expect(edges[0]!.confidence).toBe(0.9); // client package unspecified -> 0.9
  });

  it("treats owner specs as producers", () => {
    const owner = makeGrpcSpec({
      id: "spec-owner",
      contractId: "contract-owner",
      repoId: "repo-server",
      service: "OrderService",
      method: "CreateOrder"
    });
    const consumer = makeGrpcSpec({
      id: "spec-consumer",
      contractId: "contract-consumer",
      repoId: "repo-client",
      service: "OrderService",
      method: "CreateOrder"
    });

    const edges = resolveGrpcRelations([owner, consumer], makeRoleMap([owner, consumer], {
      "spec-owner": "owner",
      "spec-consumer": "consumer"
    }));

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ fromSpecId: consumer.id, toSpecId: owner.id });
  });

  it("matches identical packages with exact-grpc-match confidence", () => {
    const producer = makeGrpcSpec({
      id: "spec-producer",
      contractId: "contract-producer",
      repoId: "repo-server",
      service: "OrderService",
      method: "CreateOrder",
      package: "acme.order.v1"
    });

    const consumer = makeGrpcSpec({
      id: "spec-consumer",
      contractId: "contract-consumer",
      repoId: "repo-client",
      service: "OrderService",
      method: "CreateOrder",
      package: "acme.order.v1"
    });

    const specs = [producer, consumer];
    const roles = makeRoleMap(specs, {
      "spec-producer": "producer",
      "spec-consumer": "consumer"
    });

    const edges = resolveGrpcRelations(specs, roles);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.confidence).toBe(0.95); // exact match -> 0.95
  });

  it("handles package mismatch with downgraded confidence", () => {
    const producer = makeGrpcSpec({
      id: "spec-producer",
      contractId: "contract-producer",
      repoId: "repo-server",
      service: "OrderService",
      method: "CreateOrder",
      package: "acme.order.v1"
    });

    const consumer = makeGrpcSpec({
      id: "spec-consumer",
      contractId: "contract-consumer",
      repoId: "repo-client",
      service: "OrderService",
      method: "CreateOrder",
      package: "acme.orderpb" // mismatch!
    });

    const specs = [producer, consumer];
    const roles = makeRoleMap(specs, {
      "spec-producer": "producer",
      "spec-consumer": "consumer"
    });

    const edges = resolveGrpcRelations(specs, roles);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.confidence).toBe(0.8); // mismatched package -> 0.8
  });

  it("skips matching if client and server are in the same repo", () => {
    const producer = makeGrpcSpec({
      id: "spec-producer",
      contractId: "contract-producer",
      repoId: "repo-server",
      service: "OrderService",
      method: "CreateOrder"
    });

    const consumer = makeGrpcSpec({
      id: "spec-consumer",
      contractId: "contract-consumer",
      repoId: "repo-server", // same repo!
      service: "OrderService",
      method: "CreateOrder"
    });

    const specs = [producer, consumer];
    const roles = makeRoleMap(specs, {
      "spec-producer": "producer",
      "spec-consumer": "consumer"
    });

    const edges = resolveGrpcRelations(specs, roles);
    expect(edges).toHaveLength(0);
  });

  it("matches shared specs (such as proto-extracted contracts) acting as both consumer and producer across repos", () => {
    const specA = makeGrpcSpec({
      id: "spec-a",
      contractId: "contract-a",
      repoId: "repo-a",
      service: "OrderService",
      method: "CreateOrder",
      package: "acme.order.v1"
    });

    const specB = makeGrpcSpec({
      id: "spec-b",
      contractId: "contract-b",
      repoId: "repo-b",
      service: "OrderService",
      method: "CreateOrder",
      package: "acme.order.v1"
    });

    const specs = [specA, specB];
    const roles = makeRoleMap(specs, {
      "spec-a": "shared",
      "spec-b": "shared"
    });

    const edges = resolveGrpcRelations(specs, roles);
    // Since both act as shared (producer & consumer), they match twice (A -> B and B -> A)
    expect(edges).toHaveLength(2);
    
    const edge1 = edges.find(e => e.fromSpecId === "spec-a" && e.toSpecId === "spec-b");
    const edge2 = edges.find(e => e.fromSpecId === "spec-b" && e.toSpecId === "spec-a");
    expect(edge1).toBeDefined();
    expect(edge2).toBeDefined();
  });
});
