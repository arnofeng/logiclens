import { describe, expect, it } from "vitest";
import { analyzeSemanticImpact, getImpactedSpecId } from "../src/core/contracts/impact/semanticImpact.js";
import { canonicalDubboContractKey, canonicalHttpContractKey } from "../src/core/contracts/apiPath.js";
import { serializeSpec } from "../src/core/contracts/spec.js";
import type { ContractSpecNode, SemanticRelationEdge } from "../src/core/parsing/types.js";

function schemaSpec(id: string, repo: string, name: string): ContractSpecNode {
  return {
    id,
    contractId: `contract:schema:${name}`,
    specKind: "schema",
    repoId: `repo:${repo}`,
    fileId: `file:${repo}:src/${name}.ts`,
    evidenceId: `ev:${id}`,
    canonicalKey: name,
    specJson: serializeSpec({
      kind: "schema",
      name,
      language: "typescript",
      fields: [{ name: "id", type: "string", optional: false }]
    }),
    confidence: 0.95
  };
}

function httpSpec(id: string, repo: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD", path: string): ContractSpecNode {
  const key = canonicalHttpContractKey({ method, path });
  return {
    id,
    contractId: `contract:api:${key}`,
    specKind: "http-endpoint",
    repoId: `repo:${repo}`,
    fileId: `file:${repo}:src/orders.ts`,
    evidenceId: `ev:${id}`,
    canonicalKey: key,
    httpMethod: method,
    pathTemplate: path,
    specJson: serializeSpec({
      kind: "http-endpoint",
      method,
      path,
      pathTemplate: path,
      pathParams: [],
      requestBodyType: "CreateOrderRequest",
      auth: "unknown"
    }),
    confidence: 0.9
  };
}

function eventSpec(id: string, repo: string, topic: string): ContractSpecNode {
  return {
    id,
    contractId: `contract:event:${topic}`,
    specKind: "event",
    repoId: `repo:${repo}`,
    fileId: `file:${repo}:src/events.ts`,
    evidenceId: `ev:${id}`,
    canonicalKey: topic,
    eventTopic: topic,
    specJson: serializeSpec({
      kind: "event",
      topic,
      payloadType: "OrderCreated",
      broker: "unknown"
    }),
    confidence: 0.9
  };
}

function dubboSpec(id: string, repo: string, file: string, method: string): ContractSpecNode {
  const key = canonicalDubboContractKey("com.acme.OrderService", method);
  const fullName = `com.acme.OrderService#${method}`;
  return {
    id,
    contractId: `contract:api:${key}`,
    specKind: "dubbo-method",
    repoId: `repo:${repo}`,
    fileId: `file:${repo}:${file}`,
    evidenceId: `ev:${id}`,
    canonicalKey: key,
    specJson: serializeSpec({
      kind: "dubbo-method",
      interfaceName: "com.acme.OrderService",
      method,
      fullName,
      requestTypes: ["CreateOrderRequest"],
      responseType: "OrderResponse",
      config: "annotation"
    }),
    confidence: 0.9
  };
}

describe("semantic impact survey", () => {
  it("propagates schema changes to endpoint users and endpoint consumers", () => {
    const schema = schemaSpec("spec:schema", "order-service", "CreateOrderRequest");
    const endpoint = httpSpec("spec:endpoint", "order-service", "POST", "/orders");
    const consumer = httpSpec("spec:consumer", "web-frontend", "POST", "/orders");
    const relations: SemanticRelationEdge[] = [
      { fromSpecId: endpoint.id, toSpecId: schema.id, kind: "REQUEST_SCHEMA", evidenceId: "ev:req", reason: "request schema", confidence: 0.95 },
      { fromSpecId: consumer.id, toSpecId: endpoint.id, kind: "CALLS_ENDPOINT", evidenceId: "ev:call", reason: "method+path match", confidence: 0.9 }
    ];

    const report = analyzeSemanticImpact("schema CreateOrderRequest", [schema, endpoint, consumer], relations);

    expect(report).not.toBeNull();
    expect(report!.nodes.map((n) => [n.specId, n.hop])).toEqual([
      [schema.id, 0],
      [endpoint.id, 1],
      [consumer.id, 2]
    ]);
    expect(report!.affectedRepos).toEqual(["order-service", "web-frontend"]);
    expect(report!.edges.map((e) => e.kind)).toEqual(["REQUEST_SCHEMA", "CALLS_ENDPOINT"]);
  });

  it("uses relation-specific impact direction for event producer to consumer", () => {
    const producer = eventSpec("spec:producer", "order-service", "order.created");
    const consumer = eventSpec("spec:consumer", "payment-service", "order.created");
    const relations: SemanticRelationEdge[] = [
      { fromSpecId: producer.id, toSpecId: consumer.id, kind: "PUBLISHES_EVENT", evidenceId: "ev:pub", reason: "publishes", confidence: 0.95 },
      { fromSpecId: consumer.id, toSpecId: producer.id, kind: "SUBSCRIBES_EVENT", evidenceId: "ev:sub", reason: "subscribes", confidence: 0.95 }
    ];

    expect(getImpactedSpecId(relations[0]!, producer.id)).toBe(consumer.id);
    expect(getImpactedSpecId(relations[1]!, producer.id)).toBe(consumer.id);

    const report = analyzeSemanticImpact("event order.created", [producer, consumer], relations);

    expect(report).not.toBeNull();
    expect(report!.nodes.filter((n) => n.specId === consumer.id)).toHaveLength(1);
    expect(report!.nodes.find((n) => n.specId === consumer.id)?.hop).toBe(1);
    expect(report!.edges).toHaveLength(1);
  });

  it("ignores intra-spec semantic relations", () => {
    const schema = schemaSpec("spec:schema", "order-service", "CreateOrderRequest");
    const compatible = schemaSpec("spec:compatible", "order-service", "CreateOrderRequestV2");
    const relations: SemanticRelationEdge[] = [
      { fromSpecId: schema.id, toSpecId: compatible.id, kind: "COMPATIBLE_WITH", evidenceId: "ev:compat", reason: "compatible", confidence: 0.8 }
    ];

    const report = analyzeSemanticImpact("schema CreateOrderRequest", [schema, compatible], relations);

    expect(report).not.toBeNull();
    expect(report!.nodes.map((n) => n.specId)).toEqual([schema.id]);
    expect(report!.edges).toHaveLength(0);
  });

  it("surfaces same-file same-action downstream RPC providers in the semantic survey", () => {
    const http = httpSpec("spec:http", "front-service", "POST", "/orders/pageQueryPromotionList");
    const localDubboConsumer = dubboSpec("spec:dubbo-consumer", "front-service", "src/orders.ts", "pageQueryPromotionList");
    const centerDubboProducer = dubboSpec("spec:dubbo-producer", "center-service", "src/OrderService.ts", "pageQueryPromotionList");
    const sameFileHttp = { ...http, fileId: "file:front-service:src/orders.ts" };
    const relations: SemanticRelationEdge[] = [
      { fromSpecId: localDubboConsumer.id, toSpecId: centerDubboProducer.id, kind: "CALLS_ENDPOINT", evidenceId: "ev:dubbo", reason: "dubbo method match", confidence: 0.9 }
    ];

    const report = analyzeSemanticImpact(
      "http POST /orders/pageQueryPromotionList",
      [sameFileHttp, localDubboConsumer, centerDubboProducer],
      relations
    );

    expect(report).not.toBeNull();
    expect(report!.nodes.map((n) => [n.specId, n.hop])).toEqual([
      [sameFileHttp.id, 0],
      [centerDubboProducer.id, 1]
    ]);
    expect(report!.affectedRepos).toEqual(["center-service", "front-service"]);
  });

  it("bridges an impacted same-file RPC consumer upstream to the local HTTP endpoint", () => {
    const http = httpSpec("spec:http", "front-service", "POST", "/orders/pageQueryPromotionList");
    const localDubboConsumer = dubboSpec("spec:dubbo-consumer", "front-service", "src/orders.ts", "pageQueryPromotionList");
    const centerDubboProducer = dubboSpec("spec:dubbo-producer", "center-service", "src/OrderService.ts", "pageQueryPromotionList");
    const sameFileHttp = { ...http, fileId: "file:front-service:src/orders.ts" };
    const frontendConsumer = httpSpec("spec:http-consumer", "web-frontend", "POST", "/orders/pageQueryPromotionList");
    const relations: SemanticRelationEdge[] = [
      { fromSpecId: localDubboConsumer.id, toSpecId: centerDubboProducer.id, kind: "CALLS_ENDPOINT", evidenceId: "ev:dubbo", reason: "dubbo method match", confidence: 0.9 },
      { fromSpecId: frontendConsumer.id, toSpecId: sameFileHttp.id, kind: "CALLS_ENDPOINT", evidenceId: "ev:http", reason: "http method match", confidence: 0.95 }
    ];

    const report = analyzeSemanticImpact(
      "dubbo com.acme.OrderService#pageQueryPromotionList",
      [sameFileHttp, localDubboConsumer, centerDubboProducer, frontendConsumer],
      relations
    );

    expect(report).not.toBeNull();
    expect(report!.nodes.map((n) => [n.specId, n.hop])).toEqual([
      [centerDubboProducer.id, 0],
      [localDubboConsumer.id, 1],
      [sameFileHttp.id, 2],
      [frontendConsumer.id, 3]
    ]);
    expect(report!.affectedRepos).toEqual(["center-service", "front-service", "web-frontend"]);
  });
});
