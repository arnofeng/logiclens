import { describe, expect, it } from "vitest";
import { resolveSemanticRelations } from "../../src/core/contracts/resolver.js";
import type { ContractSpecNode, RepoContractEdge, SemanticRelationEdge } from "../../src/core/parsing/types.js";
import { serializeSpec } from "../../src/core/contracts/spec.js";

function makeHttpSpec(opts: {
  id: string; contractId: string; repoId: string;
  method?: string; path: string; pathTemplate?: string;
  requestBodyType?: string; responseBodyType?: string;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "http-endpoint",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: opts.method ? `${opts.method}:${opts.pathTemplate ?? opts.path}` : (opts.pathTemplate ?? opts.path),
    httpMethod: opts.method,
    pathTemplate: opts.pathTemplate ?? opts.path,
    specJson: serializeSpec({
      kind: "http-endpoint",
      method: opts.method as any,
      path: opts.path,
      pathTemplate: opts.pathTemplate ?? opts.path,
      pathParams: [],
      auth: "unknown",
      requestBodyType: opts.requestBodyType,
      responseBodyType: opts.responseBodyType
    }),
    confidence: 0.9
  };
}

function makeEventSpec(opts: {
  id: string; contractId: string; repoId: string;
  topic: string; payloadType?: string;
}): ContractSpecNode {
  const topic = opts.topic.toLowerCase();
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "event",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: topic,
    eventTopic: topic,
    specJson: serializeSpec({
      kind: "event",
      topic,
      payloadType: opts.payloadType,
      broker: "kafka"
    }),
    confidence: 0.85
  };
}

function makeSchemaSpec(opts: {
  id: string; contractId: string; repoId: string;
  name: string;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "schema",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: opts.name.toLowerCase(),
    specJson: serializeSpec({
      kind: "schema",
      name: opts.name,
      language: "java",
      fields: []
    }),
    confidence: 0.85
  };
}

function makeRepoContract(opts: {
  contractId: string; repoId: string; role: string;
}): RepoContractEdge {
  return {
    contractId: opts.contractId,
    repoId: opts.repoId,
    role: opts.role as any,
    evidenceId: `ev:${opts.contractId}`,
    confidence: 0.9
  };
}

describe("Resolver Integration", () => {
  it("produces CALLS_ENDPOINT between consumer and producer across repos", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      method: "GET", path: "/api/orders"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-web",
      method: "GET", path: "/api/orders"
    });
    const repoContracts = [
      makeRepoContract({ contractId: "c:p1", repoId: "repo-orders", role: "producer" }),
      makeRepoContract({ contractId: "c:c1", repoId: "repo-web", role: "consumer" })
    ];

    const edges = resolveSemanticRelations({
      contractSpecs: [producer, consumer],
      repoContracts,
      existingSemanticRelations: []
    });

    const callEdges = edges.filter((e) => e.kind === "CALLS_ENDPOINT");
    expect(callEdges).toHaveLength(1);
    expect(callEdges[0]!.fromSpecId).toBe(consumer.id);
    expect(callEdges[0]!.toSpecId).toBe(producer.id);
  });

  it("produces PUBLISHES_EVENT and SUBSCRIBES_EVENT", () => {
    const producer = makeEventSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-orders",
      topic: "order.created"
    });
    const consumer = makeEventSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-notify",
      topic: "order.created"
    });
    const repoContracts = [
      makeRepoContract({ contractId: "c:p1", repoId: "repo-orders", role: "producer" }),
      makeRepoContract({ contractId: "c:c1", repoId: "repo-notify", role: "consumer" })
    ];

    const edges = resolveSemanticRelations({
      contractSpecs: [producer, consumer],
      repoContracts,
      existingSemanticRelations: []
    });

    expect(edges.filter((e) => e.kind === "PUBLISHES_EVENT")).toHaveLength(1);
    expect(edges.filter((e) => e.kind === "SUBSCRIBES_EVENT")).toHaveLength(1);
  });

  it("produces REQUEST_SCHEMA from http spec body types", () => {
    const httpSpec = makeHttpSpec({
      id: "spec:h1", contractId: "c:h1", repoId: "repo-orders",
      method: "POST", path: "/api/orders", requestBodyType: "CreateOrderDTO"
    });
    const schemaSpec = makeSchemaSpec({
      id: "spec:s1", contractId: "c:s1", repoId: "repo-orders",
      name: "CreateOrderDTO"
    });
    const repoContracts = [
      makeRepoContract({ contractId: "c:h1", repoId: "repo-orders", role: "producer" }),
      makeRepoContract({ contractId: "c:s1", repoId: "repo-orders", role: "producer" })
    ];

    const edges = resolveSemanticRelations({
      contractSpecs: [httpSpec, schemaSpec],
      repoContracts,
      existingSemanticRelations: []
    });

    expect(edges.filter((e) => e.kind === "REQUEST_SCHEMA")).toHaveLength(1);
  });

  it("deduplicates edges", () => {
    // Two specs that would produce the same edge twice
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-a",
      method: "GET", path: "/api/test"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-b",
      method: "GET", path: "/api/test"
    });
    // Duplicate specs (same contractId, different repos — simulating a
    // scenario that should produce one edge, not multiple duplicates)
    const repoContracts = [
      makeRepoContract({ contractId: "c:p1", repoId: "repo-a", role: "producer" }),
      makeRepoContract({ contractId: "c:c1", repoId: "repo-b", role: "consumer" })
    ];

    const edges = resolveSemanticRelations({
      contractSpecs: [producer, consumer],
      repoContracts,
      existingSemanticRelations: []
    });

    // No duplicate CALLS_ENDPOINT edges
    const callEdges = edges.filter((e) => e.kind === "CALLS_ENDPOINT");
    expect(callEdges).toHaveLength(1);
  });

  it("deduplicates semantic edges by logical relation and keeps the highest confidence evidence", () => {
    const high: SemanticRelationEdge = {
      fromSpecId: "spec:a",
      toSpecId: "schema-ref:Target",
      kind: "REQUEST_SCHEMA",
      evidenceId: "ev:high",
      reason: "high",
      confidence: 0.9
    };
    const source = makeHttpSpec({ id: "spec:a", contractId: "c:a", repoId: "repo-a", method: "POST", path: "/source", requestBodyType: "Target" });
    const target = makeSchemaSpec({ id: "spec:b", contractId: "c:b", repoId: "repo-a", name: "Target" });

    const edges = resolveSemanticRelations({
      contractSpecs: [source, target],
      repoContracts: [],
      existingSemanticRelations: [high]
    });

    expect(edges.filter((edge) => edge.kind === "REQUEST_SCHEMA")).toEqual([{
      ...high,
      toSpecId: target.id
    }]);
  });

  it("handles empty specs gracefully", () => {
    const edges = resolveSemanticRelations({
      contractSpecs: [],
      repoContracts: [],
      existingSemanticRelations: []
    });
    expect(edges).toHaveLength(0);
  });

  it("resolves pending USES_SCHEMA from existing relations", () => {
    const derivedSpec = makeSchemaSpec({
      id: "spec:derived", contractId: "c:derived", repoId: "repo-a",
      name: "DerivedDTO"
    });
    const baseSpec = makeSchemaSpec({
      id: "spec:base", contractId: "c:base", repoId: "repo-a",
      name: "BaseDTO"
    });
    const pendingRel: SemanticRelationEdge = {
      fromSpecId: "spec:c:derived:pending",
      toSpecId: "schema-ref:BaseDTO",
      kind: "USES_SCHEMA",
      evidenceId: "ev:pending",
      reason: "TS utility type references base schema BaseDTO",
      confidence: 0.7
    };
    const repoContracts = [
      makeRepoContract({ contractId: "c:derived", repoId: "repo-a", role: "producer" }),
      makeRepoContract({ contractId: "c:base", repoId: "repo-a", role: "producer" })
    ];

    const edges = resolveSemanticRelations({
      contractSpecs: [derivedSpec, baseSpec],
      repoContracts,
      existingSemanticRelations: [pendingRel]
    });

    const usesEdges = edges.filter((e) => e.kind === "USES_SCHEMA");
    expect(usesEdges).toHaveLength(1);
    expect(usesEdges[0]!.fromSpecId).toBe(derivedSpec.id);
    expect(usesEdges[0]!.toSpecId).toBe(baseSpec.id);
  });

  it("skips same-repo consumer-producer pairs (no intra-repo edges)", () => {
    const producer = makeHttpSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-same",
      method: "GET", path: "/api/orders"
    });
    const consumer = makeHttpSpec({
      id: "spec:c1", contractId: "c:c1", repoId: "repo-same",
      method: "GET", path: "/api/orders"
    });
    const repoContracts = [
      makeRepoContract({ contractId: "c:p1", repoId: "repo-same", role: "producer" }),
      makeRepoContract({ contractId: "c:c1", repoId: "repo-same", role: "consumer" })
    ];

    const edges = resolveSemanticRelations({
      contractSpecs: [producer, consumer],
      repoContracts,
      existingSemanticRelations: []
    });

    // No CALLS_ENDPOINT, PUBLISHES_EVENT, or SUBSCRIBES_EVENT within same repo
    const crossEdges = edges.filter((e) =>
      e.kind === "CALLS_ENDPOINT" || e.kind === "PUBLISHES_EVENT" || e.kind === "SUBSCRIBES_EVENT"
    );
    expect(crossEdges).toHaveLength(0);
  });

  it("resolves gRPC CALLS_ENDPOINT relations across repos", () => {
    const producerSpec: ContractSpecNode = {
      id: "spec:g-p",
      contractId: "c:g-p",
      specKind: "grpc-method",
      repoId: "repo-server",
      fileId: "file:repo-server:server.proto",
      evidenceId: "ev:g-p",
      canonicalKey: "acme.order.v1.OrderService/CreateOrder",
      specJson: serializeSpec({
        kind: "grpc-method",
        fullName: "acme.order.v1.OrderService/CreateOrder",
        service: "OrderService",
        method: "CreateOrder",
        package: "acme.order.v1",
        requestType: "CreateOrderRequest",
        responseType: "Order",
        streaming: "unary"
      }),
      confidence: 0.9
    };

    const consumerSpec: ContractSpecNode = {
      id: "spec:g-c",
      contractId: "c:g-c",
      specKind: "grpc-method",
      repoId: "repo-client",
      fileId: "file:repo-client:client.go",
      evidenceId: "ev:g-c",
      canonicalKey: "OrderService/CreateOrder",
      specJson: serializeSpec({
        kind: "grpc-method",
        fullName: "OrderService/CreateOrder",
        service: "OrderService",
        method: "CreateOrder",
        requestType: "CreateOrderRequest",
        streaming: "unary"
      }),
      confidence: 0.9
    };

    const repoContracts = [
      makeRepoContract({ contractId: "c:g-p", repoId: "repo-server", role: "producer" }),
      makeRepoContract({ contractId: "c:g-c", repoId: "repo-client", role: "consumer" })
    ];

    const edges = resolveSemanticRelations({
      contractSpecs: [producerSpec, consumerSpec],
      repoContracts,
      existingSemanticRelations: []
    });

    const callsEdges = edges.filter((e) => e.kind === "CALLS_ENDPOINT");
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0]!.fromSpecId).toBe("spec:g-c");
    expect(callsEdges[0]!.toSpecId).toBe("spec:g-p");
    expect(callsEdges[0]!.confidence).toBe(0.9); // consumer package unspecified -> 0.9
  });

  it("resolves Dubbo CALLS_ENDPOINT relations across repos", () => {
    const producerSpec: ContractSpecNode = {
      id: "spec:d-p",
      contractId: "c:d-p",
      specKind: "dubbo-method",
      repoId: "repo-provider",
      fileId: "file:repo-provider:OrderServiceImpl.java",
      evidenceId: "ev:d-p",
      canonicalKey: "com.acme.api.orderservice#createOrder",
      specJson: serializeSpec({
        kind: "dubbo-method",
        interfaceName: "com.acme.api.OrderService",
        method: "createOrder",
        fullName: "com.acme.api.OrderService#createOrder",
        group: "orders",
        version: "1.0.0",
        config: "annotation",
        framework: "dubbo-java"
      }),
      confidence: 0.9
    };
    const consumerSpec: ContractSpecNode = {
      id: "spec:d-c",
      contractId: "c:d-c",
      specKind: "dubbo-method",
      repoId: "repo-web",
      fileId: "file:repo-web:OrderController.java",
      evidenceId: "ev:d-c",
      canonicalKey: "com.acme.api.orderservice#createOrder",
      specJson: serializeSpec({
        kind: "dubbo-method",
        interfaceName: "com.acme.api.OrderService",
        method: "createOrder",
        fullName: "com.acme.api.OrderService#createOrder",
        group: "orders",
        version: "1.0.0",
        config: "annotation",
        framework: "dubbo-java"
      }),
      confidence: 0.9
    };
    const repoContracts = [
      makeRepoContract({ contractId: "c:d-p", repoId: "repo-provider", role: "producer" }),
      makeRepoContract({ contractId: "c:d-c", repoId: "repo-web", role: "consumer" })
    ];

    const edges = resolveSemanticRelations({
      contractSpecs: [producerSpec, consumerSpec],
      repoContracts,
      existingSemanticRelations: []
    });

    const callsEdges = edges.filter((e) => e.kind === "CALLS_ENDPOINT");
    expect(callsEdges).toHaveLength(1);
    expect(callsEdges[0]!.fromSpecId).toBe("spec:d-c");
    expect(callsEdges[0]!.toSpecId).toBe("spec:d-p");
    expect(callsEdges[0]!.confidence).toBe(0.95);
  });
});
