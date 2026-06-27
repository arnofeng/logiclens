import { describe, expect, it } from "vitest";
import {
  normalizeSemanticTarget,
  traceSemanticGraph,
  summarizeSpec
} from "../src/contracts/semanticTrace.js";
import { canonicalHttpContractKey } from "../src/contracts/apiPath.js";
import { serializeSpec } from "../src/contracts/spec.js";
import type { ContractSpecNode, SemanticRelationEdge } from "../src/parsers/types.js";

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
});
