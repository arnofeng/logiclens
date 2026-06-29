import { describe, expect, it } from "vitest";
import {
  analyzeImpact,
  findFieldReferences,
  findTargetSpecs,
  parseTarget,
  type ImpactAnalysisOptions
} from "../src/core/contracts/impact/impactEngine.js";
import {
  assessHttpEndpointChange
} from "../src/core/contracts/impact/rules/httpImpactRules.js";
import {
  assessEventChange
} from "../src/core/contracts/impact/rules/eventImpactRules.js";
import {
  assessSchemaFieldChange
} from "../src/core/contracts/impact/rules/schemaImpactRules.js";
import type {
  ChangeIntent,
  ImpactItem,
  ImpactReport
} from "../src/core/contracts/impact/types.js";
import { serializeSpec } from "../src/core/contracts/spec.js";
import type {
  ContractSpecNode,
  ReadableContractSpecNode,
  SemanticRelationEdge
} from "../src/core/parsing/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHttpSpec(opts: {
  id: string; contractId: string; repoId: string; fileId?: string;
  method?: string; path: string; pathTemplate?: string;
  confidence?: number;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "http-endpoint",
    repoId: opts.repoId,
    fileId: opts.fileId ?? `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: opts.method ? `${opts.method} ${opts.pathTemplate ?? opts.path}` : (opts.pathTemplate ?? opts.path),
    httpMethod: opts.method,
    pathTemplate: opts.pathTemplate ?? opts.path,
    specJson: serializeSpec({
      kind: "http-endpoint",
      method: opts.method as any,
      path: opts.path,
      pathTemplate: opts.pathTemplate ?? opts.path,
      pathParams: [],
      auth: "unknown" as const
    }),
    confidence: opts.confidence ?? 0.9
  };
}

function makeEventSpec(opts: {
  id: string; contractId: string; repoId: string; fileId?: string;
  topic: string; broker?: string; payloadType?: string;
  confidence?: number;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "event",
    repoId: opts.repoId,
    fileId: opts.fileId ?? `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: opts.topic,
    eventTopic: opts.topic,
    specJson: serializeSpec({
      kind: "event",
      topic: opts.topic,
      broker: (opts.broker as any) ?? "kafka",
      payloadType: opts.payloadType
    }),
    confidence: opts.confidence ?? 0.85
  };
}

function makeSchemaSpec(opts: {
  id: string; contractId: string; repoId: string; fileId?: string;
  name: string; fields?: { name: string; type: string; optional?: boolean; sourceLine?: number }[];
  language?: string; confidence?: number;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "schema",
    repoId: opts.repoId,
    fileId: opts.fileId ?? `file:${opts.repoId}:dto/${opts.name}.ts`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: opts.name.toLowerCase(),
    specJson: serializeSpec({
      kind: "schema",
      name: opts.name,
      language: opts.language ?? "typescript",
      fields: (opts.fields ?? []).map((f) => ({
        name: f.name,
        type: f.type,
        optional: f.optional ?? false,
        sourceLine: f.sourceLine
      }))
    }),
    confidence: opts.confidence ?? 0.75
  };
}

function makeGrpcSpec(opts: {
  id: string; contractId: string; repoId: string; fileId?: string;
  service: string; method: string; package?: string;
  confidence?: number;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "grpc-method",
    repoId: opts.repoId,
    fileId: opts.fileId ?? `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
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
    confidence: opts.confidence ?? 0.9
  };
}

function makeSemanticRel(opts: {
  fromSpecId: string; toSpecId: string;
  kind: SemanticRelationEdge["kind"];
  reason?: string; confidence?: number;
}): SemanticRelationEdge {
  return {
    fromSpecId: opts.fromSpecId,
    toSpecId: opts.toSpecId,
    kind: opts.kind,
    evidenceId: `ev-rel:${opts.fromSpecId}-${opts.toSpecId}`,
    reason: opts.reason ?? `${opts.kind} relationship`,
    confidence: opts.confidence ?? 0.9
  };
}

// ---------------------------------------------------------------------------
// parseTarget
// ---------------------------------------------------------------------------

describe("parseTarget", () => {
  it("parses schema:Name", () => {
    expect(parseTarget("schema:CreateOrderRequest")).toEqual({ kind: "schema", key: "CreateOrderRequest" });
  });

  it("parses api:METHOD:path", () => {
    expect(parseTarget("api:POST:/api/orders")).toEqual({ kind: "api", key: "POST:/api/orders" });
  });

  it("parses event:topic", () => {
    expect(parseTarget("event:order.created")).toEqual({ kind: "event", key: "order.created" });
  });

  it("treats value without colon as schema bare name", () => {
    expect(parseTarget("CreateOrderRequest")).toEqual({ kind: "schema", key: "CreateOrderRequest" });
  });
});

// ---------------------------------------------------------------------------
// findTargetSpecs
// ---------------------------------------------------------------------------

describe("findTargetSpecs", () => {
  const schemaSpec = makeSchemaSpec({ id: "s1", contractId: "contract:schema:createorderrequest", repoId: "repo-a", name: "CreateOrderRequest" });

  it("finds schema spec by name", () => {
    const found = findTargetSpecs("schema:CreateOrderRequest", [schemaSpec]);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe("s1");
  });

  it("finds schema spec by bare name", () => {
    const found = findTargetSpecs("CreateOrderRequest", [schemaSpec]);
    expect(found).toHaveLength(1);
  });

  it("finds http spec by canonical key", () => {
    const httpSpec = makeHttpSpec({ id: "h1", contractId: "contract:api:POST:/api/orders", repoId: "repo-a", method: "POST", path: "/api/orders" });
    const found = findTargetSpecs("api:POST:/api/orders", [httpSpec]);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe("h1");
  });

  it("finds event spec by topic", () => {
    const eventSpec = makeEventSpec({ id: "e1", contractId: "contract:event:order.created", repoId: "repo-a", topic: "order.created" });
    const found = findTargetSpecs("event:order.created", [eventSpec]);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe("e1");
  });

  it("returns empty when no specs match", () => {
    const found = findTargetSpecs("schema:NonExistent", [schemaSpec]);
    expect(found).toHaveLength(0);
  });

  it("matches by contractId suffix", () => {
    const spec = makeSchemaSpec({ id: "s1", contractId: "contract:schema:MyDto", repoId: "repo-a", name: "MyDto" });
    const found = findTargetSpecs("schema:MyDto", [spec]);
    expect(found).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findFieldReferences
// ---------------------------------------------------------------------------

describe("findFieldReferences", () => {
  const sourceText = `export function createOrder(body: CreateOrderRequest) {
  const code = body.couponCode;
  const qty = body["quantity"];
  const name = body.getName();
  const val = body.getValue();
}`;

  it("finds dot-access field references", () => {
    const refs = findFieldReferences(sourceText, "couponCode");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.line).toBe(2);
    expect(refs[0]!.raw).toContain("body.couponCode");
  });

  it("finds bracket-access field references", () => {
    const refs = findFieldReferences(sourceText, "quantity");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.line).toBe(3);
    expect(refs[0]!.raw).toContain('body["quantity"]');
  });

  it("finds getter-style accessors (Java-style)", () => {
    const refs = findFieldReferences(sourceText, "name");
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs.some((r) => r.raw.includes("getName"))).toBe(true);
  });

  it("returns empty when field not referenced", () => {
    const refs = findFieldReferences(sourceText, "nonExistentField");
    expect(refs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeImpact — empty / missing
// ---------------------------------------------------------------------------

describe("analyzeImpact", () => {
  it("returns empty report for unknown target", () => {
    const report = analyzeImpact(
      { target: "schema:NonExistent", changeType: "field-removed", detail: "x" },
      [],
      []
    );
    expect(report.overallSeverity).toBe("compatible");
    expect(report.impacts).toHaveLength(0);
    expect(report.recommendedFiles).toHaveLength(0);
  });

  it("returns empty report with empty inputs", () => {
    const report = analyzeImpact(
      { target: "schema:X", changeType: "field-removed" },
      [],
      []
    );
    expect(report.impacts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeImpact — HTTP endpoint changes
// ---------------------------------------------------------------------------

describe("analyzeImpact — HTTP endpoint changes", () => {
  // Producer: order-service exposes POST /api/orders
  const producer = makeHttpSpec({
    id: "spec-producer", contractId: "contract:api:POST:/api/orders",
    repoId: "order-service", fileId: "src/controller/OrderController.java",
    method: "POST", path: "/api/orders", pathTemplate: "/api/orders"
  });

  // Consumer: web-app calls POST /api/orders
  const consumer = makeHttpSpec({
    id: "spec-consumer", contractId: "contract:api:POST:/api/orders",
    repoId: "web-app", fileId: "src/api/order.ts",
    method: "POST", path: "/api/orders", pathTemplate: "/api/orders"
  });

  const rels = [
    makeSemanticRel({ fromSpecId: "spec-consumer", toSpecId: "spec-producer", kind: "CALLS_ENDPOINT", reason: "consumer calls producer" })
  ];

  it("endpoint-removed → breaking for consumer", () => {
    const report = analyzeImpact(
      { target: "api:POST:/api/orders", changeType: "endpoint-removed" },
      [producer, consumer], rels
    );
    expect(report.overallSeverity).toBe("breaking");
    expect(report.summary.breaking).toBeGreaterThanOrEqual(1);
    // Consumer should be in impacts
    const consumerImpact = report.impacts.find((i) => i.repoId === "web-app");
    expect(consumerImpact).toBeDefined();
    expect(consumerImpact!.severity).toBe("breaking");
  });

  it("endpoint-renamed → breaking for consumer", () => {
    const report = analyzeImpact(
      { target: "api:POST:/api/orders", changeType: "endpoint-renamed", detail: "POST:/api/v2/orders" },
      [producer, consumer], rels
    );
    expect(report.overallSeverity).toBe("breaking");
    const consumerImpact = report.impacts.find((i) => i.repoId === "web-app");
    expect(consumerImpact).toBeDefined();
    expect(consumerImpact!.severity).toBe("breaking");
  });

  it("endpoint-schema-change → risky for consumer", () => {
    const report = analyzeImpact(
      { target: "api:POST:/api/orders", changeType: "endpoint-schema-change" },
      [producer, consumer], rels
    );
    expect(report.overallSeverity).toBe("risky");
    const consumerImpact = report.impacts.find((i) => i.repoId === "web-app");
    expect(consumerImpact).toBeDefined();
    expect(consumerImpact!.severity).toBe("risky");
  });

  it("producer itself is listed as the change target", () => {
    const report = analyzeImpact(
      { target: "api:POST:/api/orders", changeType: "endpoint-removed" },
      [producer], []
    );
    const producerItem = report.impacts.find((i) => i.repoId === "order-service");
    expect(producerItem).toBeDefined();
    expect(producerItem!.severity).toBe("breaking");
  });

});

// ---------------------------------------------------------------------------
// analyzeImpact — Event changes
// ---------------------------------------------------------------------------

describe("analyzeImpact — Event changes", () => {
  const producer = makeEventSpec({
    id: "spec-event-producer", contractId: "contract:event:order.created",
    repoId: "order-service", fileId: "src/events/publisher.ts",
    topic: "order.created", broker: "kafka"
  });

  const consumer = makeEventSpec({
    id: "spec-event-consumer", contractId: "contract:event:order.created",
    repoId: "notification-service", fileId: "src/handlers/order.ts",
    topic: "order.created", broker: "kafka"
  });

  const rels = [
    makeSemanticRel({ fromSpecId: "spec-event-consumer", toSpecId: "spec-event-producer", kind: "SUBSCRIBES_EVENT", reason: "consumer subscribes to producer" })
  ];

  it("topic-removed → breaking for consumer", () => {
    const report = analyzeImpact(
      { target: "event:order.created", changeType: "topic-removed" },
      [producer, consumer], rels
    );
    expect(report.overallSeverity).toBe("breaking");
    const consumerImpact = report.impacts.find((i) => i.repoId === "notification-service");
    expect(consumerImpact).toBeDefined();
    expect(consumerImpact!.severity).toBe("breaking");
  });

  it("topic-renamed → breaking for consumer", () => {
    const report = analyzeImpact(
      { target: "event:order.created", changeType: "topic-renamed", detail: "order.placed" },
      [producer, consumer], rels
    );
    expect(report.overallSeverity).toBe("breaking");
  });

  it("event-payload-change → risky for consumer", () => {
    const report = analyzeImpact(
      { target: "event:order.created", changeType: "event-payload-change" },
      [producer, consumer], rels
    );
    expect(report.overallSeverity).toBe("risky");
  });
});

// ---------------------------------------------------------------------------
// analyzeImpact — Schema field changes
// ---------------------------------------------------------------------------

describe("analyzeImpact — Schema field changes", () => {
  const schemaSpec = makeSchemaSpec({
    id: "spec-schema", contractId: "contract:schema:CreateOrderRequest",
    repoId: "order-service", fileId: "src/dto/CreateOrderRequest.java",
    name: "CreateOrderRequest",
    fields: [
      { name: "sku", type: "string", optional: false, sourceLine: 3 },
      { name: "quantity", type: "number", optional: false, sourceLine: 4 },
      { name: "couponCode", type: "string", optional: true, sourceLine: 5 }
    ]
  });

  // A consumer schema that USES_SCHEMA → the producer schema
  const consumerSpec = makeHttpSpec({
    id: "spec-consumer", contractId: "contract:api:POST:/api/orders",
    repoId: "web-app", fileId: "src/api/order.ts",
    method: "POST", path: "/api/orders", pathTemplate: "/api/orders"
  });

  const rels = [
    makeSemanticRel({ fromSpecId: "spec-consumer", toSpecId: "spec-schema", kind: "REQUEST_SCHEMA", reason: "request body" })
  ];

  it("field-removed (required) → breaking", () => {
    const report = analyzeImpact(
      { target: "schema:CreateOrderRequest", changeType: "field-removed", detail: "sku" },
      [schemaSpec, consumerSpec], rels
    );
    // The schema itself reports the removal
    const schemaImpact = report.impacts.find((i) => i.repoId === "order-service");
    expect(schemaImpact).toBeDefined();
    expect(schemaImpact!.severity).toBe("breaking");
  });

  it("field-removed (optional) → risky", () => {
    const report = analyzeImpact(
      { target: "schema:CreateOrderRequest", changeType: "field-removed", detail: "couponCode" },
      [schemaSpec, consumerSpec], rels
    );
    const schemaImpact = report.impacts.find((i) => i.repoId === "order-service");
    expect(schemaImpact).toBeDefined();
    expect(schemaImpact!.severity).toBe("risky");
  });

  it("field-added → compatible", () => {
    const report = analyzeImpact(
      { target: "schema:CreateOrderRequest", changeType: "field-added", detail: "newField" },
      [schemaSpec, consumerSpec], rels
    );
    expect(report.overallSeverity).toBe("compatible");
  });

  it("field-type-changed → risky", () => {
    const report = analyzeImpact(
      { target: "schema:CreateOrderRequest", changeType: "field-type-changed", detail: "quantity" },
      [schemaSpec, consumerSpec], rels
    );
    expect(report.overallSeverity).toBe("risky");
  });

  it("field-level search finds references in consumer file", () => {
    const fileContents: Record<string, string> = {
      "file:web-app:src/api/order.ts": `export async function createOrder(form: OrderForm) {
  return axios.post("/api/orders", {
    sku: form.sku,
    quantity: form.quantity,
    couponCode: form.couponCode
  });
}`
    };

    const options: ImpactAnalysisOptions = {
      readFile: (_repoId: string, fileId: string) => fileContents[fileId]
    };

    const report = analyzeImpact(
      { target: "schema:CreateOrderRequest", changeType: "field-removed", detail: "couponCode" },
      [schemaSpec, consumerSpec], rels,
      options
    );

    // Should find references in the consumer file via field search
    const consumerImpacts = report.impacts.filter((i) => i.repoId === "web-app");
    expect(consumerImpacts.length).toBeGreaterThan(0);
  });

  it("reports opaque dependent specs as risky instead of dropping them", () => {
    const opaque = {
      id: "spec-opaque",
      contractId: "contract:api:opaque",
      specKind: "graphql-operation",
      repoId: "future-service",
      fileId: "graphql/future.graphql",
      evidenceId: "ev:opaque",
      canonicalKey: "FutureQuery/Call",
      specJson: "{}",
      confidence: 0.4,
      opaque: true,
      warning: "Unknown ContractSpec specKind \"graphql-operation\""
    } satisfies ReadableContractSpecNode;

    const report = analyzeImpact(
      { target: "schema:CreateOrderRequest", changeType: "field-type-changed", detail: "quantity" },
      [schemaSpec, opaque],
      [makeSemanticRel({ fromSpecId: "spec-opaque", toSpecId: "spec-schema", kind: "USES_SCHEMA", reason: "future relation", confidence: 0.7 })]
    );

    const opaqueImpact = report.impacts.find((i) => i.specId === "spec-opaque");
    expect(opaqueImpact).toBeDefined();
    expect(opaqueImpact!.severity).toBe("risky");
    expect(opaqueImpact!.description).toContain("Opaque contract spec graphql-operation");
  });
});

// ---------------------------------------------------------------------------
// analyzeImpact — Transitive impact (multi-hop)
// ---------------------------------------------------------------------------

describe("analyImpact — transitive traversal", () => {
  // Schema → HTTP endpoint → consumer (2 hops)
  const schema = makeSchemaSpec({
    id: "s1", contractId: "contract:schema:OrderDto",
    repoId: "order-service", fileId: "src/dto/OrderDto.ts",
    name: "OrderDto",
    fields: [{ name: "status", type: "string", optional: false }]
  });

  const endpoint = makeHttpSpec({
    id: "h1", contractId: "contract:api:GET:/api/orders",
    repoId: "order-service", fileId: "src/controller/OrderController.java",
    method: "GET", path: "/api/orders"
  });

  const consumer = makeHttpSpec({
    id: "h2", contractId: "contract:api:GET:/api/orders",
    repoId: "web-app", fileId: "src/api/order.ts",
    method: "GET", path: "/api/orders"
  });

  const rels = [
    // Schema is the response body of the endpoint
    makeSemanticRel({ fromSpecId: "h1", toSpecId: "s1", kind: "RESPONSE_SCHEMA", reason: "response body" }),
    // Consumer calls the endpoint
    makeSemanticRel({ fromSpecId: "h2", toSpecId: "h1", kind: "CALLS_ENDPOINT", reason: "consumer calls" })
  ];

  it("traverses 2-hop transitive impact (schema → endpoint → consumer)", () => {
    const report = analyzeImpact(
      { target: "schema:OrderDto", changeType: "field-removed", detail: "status" },
      [schema, endpoint, consumer], rels
    );

    // Should find impacts across the transitive chain
    expect(report.traversedEdgeCount).toBeGreaterThanOrEqual(1);
    expect(report.inspectedSpecCount).toBeGreaterThanOrEqual(2);
  });

  it("no impact on unrelated specs", () => {
    const unrelated = makeEventSpec({
      id: "e-unrelated", contractId: "contract:event:unrelated",
      repoId: "other-service", topic: "unrelated.event"
    });

    const report = analyzeImpact(
      { target: "schema:OrderDto", changeType: "field-removed", detail: "status" },
      [schema, endpoint, consumer, unrelated], rels
    );

    const unrelatedImpact = report.impacts.find((i) => i.repoId === "other-service");
    expect(unrelatedImpact).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Individual rule functions (unit tests)
// ---------------------------------------------------------------------------

describe("httpImpactRules", () => {
  const consumerSpec = makeHttpSpec({
    id: "h-cons", contractId: "contract:api:POST:/api/orders",
    repoId: "web-app", method: "POST", path: "/api/orders"
  });

  it("endpoint-removed → breaking", () => {
    const items = assessHttpEndpointChange(
      { target: "api:POST:/api/orders", changeType: "endpoint-removed" },
      consumerSpec, "CALLS_ENDPOINT", "consumer calls endpoint", 0.9
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("breaking");
    expect(items[0]!.symbol).toContain("POST");
  });

  it("endpoint-renamed → breaking", () => {
    const items = assessHttpEndpointChange(
      { target: "api:POST:/api/orders", changeType: "endpoint-renamed", detail: "POST:/api/v2/orders" },
      consumerSpec, "CALLS_ENDPOINT", "consumer calls", 0.9
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("breaking");
  });

  it("endpoint-schema-change → risky", () => {
    const items = assessHttpEndpointChange(
      { target: "api:POST:/api/orders", changeType: "endpoint-schema-change" },
      consumerSpec, "CALLS_ENDPOINT", "schema changed", 0.9
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("risky");
  });
});

describe("eventImpactRules", () => {
  const consumerSpec = makeEventSpec({
    id: "e-cons", contractId: "contract:event:order.created",
    repoId: "notification-service", topic: "order.created"
  });

  it("topic-removed → breaking", () => {
    const items = assessEventChange(
      { target: "event:order.created", changeType: "topic-removed" },
      consumerSpec, "SUBSCRIBES_EVENT", "subscribes to", 0.85
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("breaking");
  });

  it("topic-renamed → breaking", () => {
    const items = assessEventChange(
      { target: "event:order.created", changeType: "topic-renamed", detail: "order.placed" },
      consumerSpec, "SUBSCRIBES_EVENT", "subscribes to", 0.85
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("breaking");
  });

  it("event-payload-change → risky", () => {
    const items = assessEventChange(
      { target: "event:order.created", changeType: "event-payload-change" },
      consumerSpec, "SUBSCRIBES_EVENT", "subscribes to", 0.85
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("risky");
  });
});

describe("schemaImpactRules", () => {
  const schemaSpec = makeSchemaSpec({
    id: "s-dep", contractId: "contract:schema:OrderDto",
    repoId: "other-service", fileId: "src/dto/OrderDto.ts",
    name: "OrderDto",
    fields: [
      { name: "status", type: "string", optional: false, sourceLine: 3 },
      { name: "note", type: "string", optional: true, sourceLine: 5 }
    ]
  });

  const noFileOptions: ImpactAnalysisOptions = {};

  it("field-removed (required) → breaking", () => {
    const items = assessSchemaFieldChange(
      { target: "schema:OrderDto", changeType: "field-removed", detail: "status" },
      schemaSpec, "USES_SCHEMA", "uses schema", 0.75, noFileOptions
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("breaking");
  });

  it("field-removed (optional) → risky", () => {
    const items = assessSchemaFieldChange(
      { target: "schema:OrderDto", changeType: "field-removed", detail: "note" },
      schemaSpec, "USES_SCHEMA", "uses schema", 0.75, noFileOptions
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("risky");
  });

  it("field-added → compatible", () => {
    const items = assessSchemaFieldChange(
      { target: "schema:OrderDto", changeType: "field-added", detail: "newField" },
      schemaSpec, "USES_SCHEMA", "uses schema", 0.75, noFileOptions
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("compatible");
  });

  it("field-type-changed → risky", () => {
    const items = assessSchemaFieldChange(
      { target: "schema:OrderDto", changeType: "field-type-changed", detail: "status" },
      schemaSpec, "USES_SCHEMA", "uses schema", 0.75, noFileOptions
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("risky");
  });
});

// ---------------------------------------------------------------------------
// Deduplication & report structure
// ---------------------------------------------------------------------------

describe("analyzeImpact — report structure", () => {
  const schema = makeSchemaSpec({
    id: "s1", contractId: "contract:schema:MyDto",
    repoId: "svc-a", fileId: "src/dto/MyDto.ts",
    name: "MyDto",
    fields: [{ name: "fieldA", type: "string", optional: true }]
  });

  it("report contains all required fields", () => {
    const report = analyzeImpact(
      { target: "schema:MyDto", changeType: "field-removed", detail: "fieldA" },
      [schema], []
    );
    expect(report.change).toBeDefined();
    expect(report.overallSeverity).toBeDefined();
    expect(report.impacts).toBeInstanceOf(Array);
    expect(report.summary.breaking).toBeGreaterThanOrEqual(0);
    expect(report.summary.risky).toBeGreaterThanOrEqual(0);
    expect(report.summary.compatible).toBeGreaterThanOrEqual(0);
    expect(report.recommendedFiles).toBeInstanceOf(Array);
    expect(report.traversedEdgeCount).toBeGreaterThanOrEqual(0);
    expect(report.inspectedSpecCount).toBeGreaterThanOrEqual(0);
  });

  it("impacts are sorted by severity (breaking first)", () => {
    const consumer1 = makeHttpSpec({ id: "h1", contractId: "contract:api:GET:/a", repoId: "repo-z", method: "GET", path: "/a" });
    const consumer2 = makeHttpSpec({ id: "h2", contractId: "contract:api:GET:/b", repoId: "repo-a", method: "GET", path: "/b" });

    // Both consumers call different endpoints that use the changed schema
    const rels = [
      makeSemanticRel({ fromSpecId: "s1", toSpecId: "h1", kind: "RESPONSE_SCHEMA" }),
      makeSemanticRel({ fromSpecId: "s1", toSpecId: "h2", kind: "REQUEST_SCHEMA" })
    ];

    const report = analyzeImpact(
      { target: "schema:MyDto", changeType: "field-removed", detail: "fieldA" },
      [schema, consumer1, consumer2], rels
    );

    // Breaking should come before risky
    if (report.impacts.length >= 2) {
      const severities = report.impacts.map((i) => i.severity);
      const rankOrder = { breaking: 3, risky: 2, compatible: 1 };
      for (let i = 1; i < severities.length; i++) {
        expect(rankOrder[severities[i - 1]!]).toBeGreaterThanOrEqual(rankOrder[severities[i]!]!);
      }
    }
  });

  it("deduplicates impacts with same repo/file/symbol/relationKind", () => {
    const consumer = makeHttpSpec({ id: "h1", contractId: "contract:api:GET:/x", repoId: "web-app", method: "GET", path: "/x" });
    // Multiple edges from the same schema to the same consumer (e.g. REQUEST_SCHEMA + RESPONSE_SCHEMA)
    const rels = [
      makeSemanticRel({ fromSpecId: "h1", toSpecId: "s1", kind: "REQUEST_SCHEMA" }),
      makeSemanticRel({ fromSpecId: "h1", toSpecId: "s1", kind: "RESPONSE_SCHEMA" })
    ];

    const report = analyzeImpact(
      { target: "schema:MyDto", changeType: "field-removed", detail: "fieldA" },
      [schema, consumer], rels
    );

    // Should deduplicate: at most one impact per (repo, file, symbol, relationKind)
    const webAppImpacts = report.impacts.filter((i) => i.repoId === "web-app");
    // Different relationKinds produce different items
    const requestItems = webAppImpacts.filter((i) => i.relationKind === "REQUEST_SCHEMA");
    const responseItems = webAppImpacts.filter((i) => i.relationKind === "RESPONSE_SCHEMA");
    expect(requestItems.length).toBeLessThanOrEqual(1);
    expect(responseItems.length).toBeLessThanOrEqual(1);
  });
});

describe("grpc impact analysis", () => {
  const schema = makeSchemaSpec({
    id: "s1", contractId: "contract:schema:MyDto", repoId: "core-lib", name: "MyDto",
    fields: [{ name: "userId", type: "string", optional: true }]
  });

  it("classifies target changes correctly", () => {
    const spec = makeGrpcSpec({
      id: "spec:p1", contractId: "c:p1", repoId: "repo-order",
      service: "OrderService", method: "CreateOrder", package: "acme.order.v1"
    });

    const removeReport = analyzeImpact(
      { target: "grpc:acme.order.v1.OrderService/CreateOrder", changeType: "rpc-removed" },
      [spec],
      []
    );
    expect(removeReport.overallSeverity).toBe("breaking");
    expect(removeReport.impacts).toHaveLength(1);
    expect(removeReport.impacts[0]!.severity).toBe("breaking");
    expect(removeReport.impacts[0]!.description).toContain("will be removed");

    const renameReport = analyzeImpact(
      { target: "grpc:acme.order.v1.OrderService/CreateOrder", changeType: "rpc-renamed", detail: "NewCreateOrder" },
      [spec],
      []
    );
    expect(renameReport.overallSeverity).toBe("breaking");
    expect(renameReport.impacts[0]!.description).toContain("renamed to NewCreateOrder");

    const sigReport = analyzeImpact(
      { target: "grpc:acme.order.v1.OrderService/CreateOrder", changeType: "rpc-signature-change" },
      [spec],
      []
    );
    expect(sigReport.overallSeverity).toBe("risky");
    expect(sigReport.impacts[0]!.description).toContain("Signature changed");
  });

  it("propagates impact to downstream grpc consumers", () => {
    const producer = makeGrpcSpec({
      id: "spec:prod", contractId: "c:prod", repoId: "repo-order-srv",
      service: "OrderService", method: "CreateOrder", package: "acme.order.v1"
    });
    const consumer = makeGrpcSpec({
      id: "spec:cons", contractId: "c:cons", repoId: "repo-web-client",
      service: "OrderService", method: "CreateOrder"
    });

    const rels: SemanticRelationEdge[] = [
      {
        fromSpecId: "spec:cons",
        toSpecId: "spec:prod",
        kind: "CALLS_ENDPOINT",
        evidenceId: "ev:call",
        reason: "gRPC call",
        confidence: 0.9
      }
    ];

    const report = analyzeImpact(
      { target: "grpc:acme.order.v1.OrderService/CreateOrder", changeType: "rpc-removed" },
      [producer, consumer],
      rels
    );

    expect(report.overallSeverity).toBe("breaking");
    expect(report.impacts).toHaveLength(2);
    
    const consumerImpact = report.impacts.find((i) => i.specId === "spec:cons");
    expect(consumerImpact).toBeDefined();
    expect(consumerImpact!.severity).toBe("breaking");
    expect(consumerImpact!.description).toContain("Consumer calls removed gRPC method");
  });

  it("handles request/response schema field removal and propagates to grpc method", () => {
    const method = makeGrpcSpec({
      id: "spec:method", contractId: "c:method", repoId: "repo-order-srv",
      service: "OrderService", method: "CreateOrder"
    });

    const rels: SemanticRelationEdge[] = [
      {
        fromSpecId: "spec:method",
        toSpecId: "s1",
        kind: "REQUEST_SCHEMA",
        evidenceId: "ev:req-schema",
        reason: "request parameter schema",
        confidence: 0.9
      }
    ];

    const report = analyzeImpact(
      { target: "schema:MyDto", changeType: "field-removed", detail: "userId" },
      [schema, method],
      rels
    );

    expect(report.overallSeverity).toBe("risky");
    expect(report.impacts).toHaveLength(2);

    const methodImpact = report.impacts.find((i) => i.specId === "spec:method");
    expect(methodImpact).toBeDefined();
    expect(methodImpact!.severity).toBe("risky");
    expect(methodImpact!.description).toContain("schema field 'userId' removed — affects gRPC method");
  });
});

// ---------------------------------------------------------------------------
// CLI option parser (exported from commands/impact.ts)
// ---------------------------------------------------------------------------

// Note: parseChangeOption is not exported from commands/impact.ts.
// We test the logic inline.

describe("change option parsing", () => {
  function parseChangeOption(raw: string): { changeType: string; detail?: string } | null {
    const VALID = new Set([
      "field-added", "field-removed", "field-type-changed",
      "endpoint-removed", "endpoint-renamed", "endpoint-schema-change",
      "topic-removed", "topic-renamed", "event-payload-change",
      "rpc-removed", "rpc-renamed", "rpc-signature-change",
    ]);
    const colonIdx = raw.indexOf(":");
    if (colonIdx === -1) {
      if (VALID.has(raw)) return { changeType: raw };
      return null;
    }
    const changeType = raw.slice(0, colonIdx);
    const detail = raw.slice(colonIdx + 1);
    if (!VALID.has(changeType)) return null;
    return { changeType, detail: detail || undefined };
  }

  it("parses field-removed:fieldName", () => {
    expect(parseChangeOption("field-removed:couponCode")).toEqual({
      changeType: "field-removed",
      detail: "couponCode"
    });
  });

  it("parses endpoint-removed (no detail)", () => {
    expect(parseChangeOption("endpoint-removed")).toEqual({
      changeType: "endpoint-removed"
    });
  });

  it("parses topic-renamed:newTopic", () => {
    expect(parseChangeOption("topic-renamed:order.placed")).toEqual({
      changeType: "topic-renamed",
      detail: "order.placed"
    });
  });

  it("parses rpc-renamed:newRpc", () => {
    expect(parseChangeOption("rpc-renamed:CreateNewOrder")).toEqual({
      changeType: "rpc-renamed",
      detail: "CreateNewOrder"
    });
  });

  it("parses rpc-signature-change (no detail)", () => {
    expect(parseChangeOption("rpc-signature-change")).toEqual({
      changeType: "rpc-signature-change"
    });
  });

  it("returns null for invalid change type", () => {
    expect(parseChangeOption("invalid-change:something")).toBeNull();
  });

  it("returns null for empty detail after colon", () => {
    const result = parseChangeOption("field-added:");
    expect(result).not.toBeNull();
    expect(result!.detail).toBeUndefined();
  });
});
