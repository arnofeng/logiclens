import { describe, expect, it } from "vitest";
import {
  normalizeSemanticTarget,
  traceSemanticGraph,
  summarizeSpec
} from "../src/core/contracts/semanticTrace.js";
import { canonicalHttpContractKey } from "../src/core/contracts/apiPath.js";
import { serializeSpec } from "../src/core/contracts/spec.js";
import type { ContractSpecNode, ReadableContractSpecNode, SemanticRelationEdge } from "../src/core/parsing/types.js";

// ---------------------------------------------------------------------------
// Fixtures — mirror real extractor output (canonicalHttpContractKey = "METHOD:/path")
// ---------------------------------------------------------------------------

const ORDERS_KEY = canonicalHttpContractKey({ method: "POST", path: "/orders" }); // "POST:/orders"

function httpSpec(id: string, repo: string, file: string): ContractSpecNode {
  return {
    id, contractId: `contract:api:${ORDERS_KEY}`, specKind: "http-endpoint",
    repoId: `repo:${repo}`, fileId: `file:${repo}:${file}`, evidenceId: `ev:${id}`,
    canonicalKey: ORDERS_KEY, httpMethod: "POST", pathTemplate: "/orders",
    specJson: serializeSpec({
      kind: "http-endpoint", method: "POST", path: "/orders", pathTemplate: "/orders",
      pathParams: [], requestBodyType: "CreateOrderRequest", auth: "unknown"
    }),
    confidence: 0.9
  };
}

function schemaSpec(id: string, repo: string, name: string): ContractSpecNode {
  return {
    id, contractId: `contract:schema:${name}`, specKind: "schema",
    repoId: `repo:${repo}`, fileId: `file:${repo}:dto.ts`, evidenceId: `ev:${id}`,
    canonicalKey: name,
    specJson: serializeSpec({
      kind: "schema", name, language: "typescript",
      fields: [{ name: "sku", type: "string", optional: false }]
    }),
    confidence: 0.95
  };
}

function grpcSpec(id: string, repo: string): ContractSpecNode {
  return {
    id, contractId: "contract:api:orderservice/createorder", specKind: "grpc-method",
    repoId: `repo:${repo}`, fileId: `file:${repo}:order.proto`, evidenceId: `ev:${id}`,
    canonicalKey: "OrderService/CreateOrder",
    specJson: serializeSpec({
      kind: "grpc-method",
      service: "OrderService",
      method: "CreateOrder",
      fullName: "OrderService/CreateOrder",
      requestType: "CreateOrderRequest",
      responseType: "CreateOrderResponse",
      streaming: "unary",
      framework: "proto"
    }),
    confidence: 0.95
  };
}

function dubboSpec(id: string, repo: string): ContractSpecNode {
  return {
    id, contractId: "contract:api:com.acme.orderservice#createorder", specKind: "dubbo-method",
    repoId: `repo:${repo}`, fileId: `file:${repo}:OrderService.java`, evidenceId: `ev:${id}`,
    canonicalKey: "com.acme.orderservice#createOrder",
    specJson: serializeSpec({
      kind: "dubbo-method",
      interfaceName: "com.acme.OrderService",
      method: "createOrder",
      fullName: "com.acme.OrderService#createOrder",
      requestTypes: ["CreateOrderRequest"],
      responseType: "CreateOrderResponse",
      group: "orders",
      version: "v1",
      config: "annotation",
      framework: "dubbo-java"
    }),
    confidence: 0.9
  };
}

function graphqlSpec(id: string, repo: string, roleKey = "Query.user"): ContractSpecNode {
  const [rootType, field] = roleKey.split(".");
  const operationType = rootType === "Mutation" ? "mutation" : rootType === "Subscription" ? "subscription" : "query";
  return {
    id, contractId: `contract:api:${roleKey.toLowerCase()}`, specKind: "graphql-operation",
    repoId: `repo:${repo}`, fileId: `file:${repo}:schema.graphql`, evidenceId: `ev:${id}`,
    canonicalKey: roleKey.toLowerCase(),
    specJson: serializeSpec({
      kind: "graphql-operation",
      operationType,
      field: field!,
      fullName: roleKey,
      requestType: "UserInput",
      responseType: "User",
      source: "sdl"
    }),
    confidence: 0.92
  };
}

describe("normalizeSemanticTarget", () => {
  it("normalizes space-separated http target to canonical key form", () => {
    expect(normalizeSemanticTarget("http POST /orders")).toBe(`http:${ORDERS_KEY}`);
  });
  it("normalizes bare method+path to http", () => {
    expect(normalizeSemanticTarget("POST /orders")).toBe(`http:${ORDERS_KEY}`);
  });
  it("normalizes api kind and path params", () => {
    expect(normalizeSemanticTarget("api GET /users/:id")).toBe("http:GET:/users/{id}");
  });
  it("lowercases event topics", () => {
    expect(normalizeSemanticTarget("event OrderCreated")).toBe("event:ordercreated");
  });
  it("preserves schema name case", () => {
    expect(normalizeSemanticTarget("schema CreateOrderRequest")).toBe("schema:CreateOrderRequest");
  });
  it("passes through existing kind:key forms", () => {
    expect(normalizeSemanticTarget("schema:CreateOrderRequest")).toBe("schema:CreateOrderRequest");
  });
  it("normalizes grpc, dubbo, and graphql targets to impact-compatible forms", () => {
    expect(normalizeSemanticTarget("grpc OrderService/CreateOrder")).toBe("grpc:OrderService/CreateOrder");
    expect(normalizeSemanticTarget("grpc acme.order.v1.OrderService/CreateOrder")).toBe("grpc:acme.order.v1.OrderService/CreateOrder");
    expect(normalizeSemanticTarget("dubbo com.acme.OrderService#createOrder")).toBe("dubbo:com.acme.orderservice#createOrder");
    expect(normalizeSemanticTarget("graphql Query.user")).toBe("graphql:query.user");
    expect(normalizeSemanticTarget("graphql Mutation.createOrder")).toBe("graphql:mutation.createOrder");
    expect(normalizeSemanticTarget("graphql Subscription.orderCreated")).toBe("graphql:subscription.orderCreated");
  });
});

describe("traceSemanticGraph", () => {
  const producer = httpSpec("spec:prod", "order-service", "OrderController.ts");
  const consumer = httpSpec("spec:cons", "web-app", "api/order.ts");
  const reqSchema = schemaSpec("spec:schema", "order-service", "CreateOrderRequest");
  const specs = [producer, consumer, reqSchema];

  const relations: SemanticRelationEdge[] = [
    // consumer → producer (consumer calls the endpoint)
    { fromSpecId: consumer.id, toSpecId: producer.id, kind: "CALLS_ENDPOINT", evidenceId: "ev:1", reason: "method+path match", confidence: 0.95 },
    // producer → request schema
    { fromSpecId: producer.id, toSpecId: reqSchema.id, kind: "REQUEST_SCHEMA", evidenceId: "ev:2", reason: "@RequestBody", confidence: 0.9 }
  ];

  it("resolves a natural http target and walks both directions", () => {
    const graph = traceSemanticGraph("http POST /orders", specs, relations);
    // Both producer and consumer share the endpoint key → both are targets.
    const targetIds = graph.targets.map((t) => t.specId).sort();
    expect(targetIds).toContain("spec:prod");

    // The request schema is reachable downstream.
    const schemaNode = graph.nodes.find((n) => n.specId === "spec:schema");
    expect(schemaNode).toBeDefined();
    expect(schemaNode!.role).toBe("downstream");

    // Edges include both relation kinds.
    const kinds = new Set(graph.edges.map((e) => e.kind));
    expect(kinds.has("REQUEST_SCHEMA")).toBe(true);
    expect(kinds.has("CALLS_ENDPOINT")).toBe(true);
  });

  it("returns empty result for an unmatched target", () => {
    const graph = traceSemanticGraph("http DELETE /nonexistent", specs, relations);
    expect(graph.targets).toHaveLength(0);
    expect(graph.nodes).toHaveLength(0);
  });

  it("respects direction (schema has only an incoming REQUEST_SCHEMA edge)", () => {
    // The schema is only ever the target of REQUEST_SCHEMA (producer → schema),
    // so outgoing from it yields nothing, incoming yields the producer endpoint.
    const outgoing = traceSemanticGraph("schema CreateOrderRequest", specs, relations, { direction: "outgoing" });
    expect(outgoing.edges).toHaveLength(0);

    const incoming = traceSemanticGraph("schema CreateOrderRequest", specs, relations, { direction: "incoming" });
    const kinds = new Set(incoming.edges.map((e) => e.kind));
    expect(kinds.has("REQUEST_SCHEMA")).toBe(true);
    const producerNode = incoming.nodes.find((n) => n.specId === "spec:prod");
    expect(producerNode?.role).toBe("upstream");
  });

  it("keeps opaque downstream specs in semantic trace output", () => {
    const opaque = {
      id: "spec:grpc",
      contractId: "contract:api:grpc",
      specKind: "grpc-method",
      repoId: "repo:grpc-service",
      fileId: "file:grpc-service:service.proto",
      evidenceId: "ev:grpc",
      canonicalKey: "UserService/GetUser",
      specJson: "{}",
      confidence: 0.4,
      opaque: true,
      warning: "Unknown ContractSpec specKind \"grpc-method\""
    } satisfies ReadableContractSpecNode;

    const graph = traceSemanticGraph(
      "http POST /orders",
      [producer, consumer, opaque],
      [
        { fromSpecId: consumer.id, toSpecId: producer.id, kind: "CALLS_ENDPOINT", evidenceId: "ev:1", reason: "method+path match", confidence: 0.95 },
        { fromSpecId: producer.id, toSpecId: opaque.id, kind: "IMPACTS", evidenceId: "ev:opaque", reason: "future relation", confidence: 0.5 }
      ]
    );

    const opaqueNode = graph.nodes.find((n) => n.specId === "spec:grpc");
    expect(opaqueNode).toBeDefined();
    expect(opaqueNode!.specKind).toBe("grpc-method");
    expect(opaqueNode!.summary).toContain("Unknown ContractSpec specKind");
  });

  it("resolves natural grpc and graphql targets and traverses schema relations", () => {
    const grpcProducer = grpcSpec("spec:grpc-prod", "order-service");
    const grpcConsumer = grpcSpec("spec:grpc-cons", "web-app");
    const gqlOperation = graphqlSpec("spec:gql", "graphql-api");
    const responseSchema = schemaSpec("spec:user", "graphql-api", "User");
    const graph = traceSemanticGraph(
      "graphql Query.user",
      [grpcProducer, grpcConsumer, gqlOperation, responseSchema],
      [
        { fromSpecId: grpcConsumer.id, toSpecId: grpcProducer.id, kind: "CALLS_ENDPOINT", evidenceId: "ev:grpc", reason: "gRPC exact match: OrderService/CreateOrder", confidence: 0.95 },
        { fromSpecId: gqlOperation.id, toSpecId: responseSchema.id, kind: "RESPONSE_SCHEMA", evidenceId: "ev:gql", reason: "GraphQL response type User", confidence: 1 }
      ]
    );

    expect(graph.targets.map((t) => t.specId)).toContain(gqlOperation.id);
    expect(graph.edges.map((e) => e.kind)).toContain("RESPONSE_SCHEMA");

    const grpcGraph = traceSemanticGraph(
      "grpc OrderService/CreateOrder",
      [grpcProducer, grpcConsumer],
      [{ fromSpecId: grpcConsumer.id, toSpecId: grpcProducer.id, kind: "CALLS_ENDPOINT", evidenceId: "ev:grpc", reason: "gRPC exact match: OrderService/CreateOrder", confidence: 0.95 }]
    );
    expect(grpcGraph.targets.map((t) => t.specId).sort()).toEqual([grpcConsumer.id, grpcProducer.id].sort());
    expect(grpcGraph.edges.map((e) => e.kind)).toContain("CALLS_ENDPOINT");
  });
});

describe("summarizeSpec", () => {
  it("summarizes an http endpoint with request type", () => {
    const s = summarizeSpec(httpSpec("x", "r", "f.ts"));
    expect(s).toContain("POST /orders");
    expect(s).toContain("request=CreateOrderRequest");
  });
  it("summarizes a schema with field count", () => {
    const s = summarizeSpec(schemaSpec("x", "r", "CreateOrderRequest"));
    expect(s).toBe("CreateOrderRequest (1 field)");
  });
  it("summarizes grpc, dubbo, and graphql specs", () => {
    expect(summarizeSpec(grpcSpec("grpc", "r"))).toBe("OrderService/CreateOrder  request=CreateOrderRequest  response=CreateOrderResponse  streaming=unary");
    expect(summarizeSpec(dubboSpec("dubbo", "r"))).toBe("com.acme.OrderService#createOrder  request=CreateOrderRequest  response=CreateOrderResponse  group=orders  version=v1");
    expect(summarizeSpec(graphqlSpec("graphql", "r"))).toBe("Query.user  request=UserInput  response=User  source=sdl");
  });
});
