import { describe, expect, it } from "vitest";
import { resolveSchemaRelations } from "../../../src/core/contracts/matching/schemaResolver.js";
import { analyzeImpact } from "../../../src/core/contracts/impact/impactEngine.js";
import type { ContractSpecNode, SemanticRelationEdge } from "../../../src/core/parsing/types.js";
import { serializeSpec } from "../../../src/core/contracts/spec.js";

function makeHttpSpec(opts: {
  id: string; contractId: string; repoId: string;
  requestBodyType?: string; responseBodyType?: string;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "http-endpoint",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: "POST:/api/test",
    httpMethod: "POST",
    pathTemplate: "/api/test",
    specJson: serializeSpec({
      kind: "http-endpoint",
      method: "POST",
      path: "/api/test",
      pathTemplate: "/api/test",
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
  payloadType?: string;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "event",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: "order.created",
    eventTopic: "order.created",
    specJson: serializeSpec({
      kind: "event",
      topic: "order.created",
      payloadType: opts.payloadType,
      broker: "kafka"
    }),
    confidence: 0.85
  };
}

function makeGraphqlSpec(opts: {
  id: string; contractId: string; repoId: string;
  requestType?: string; responseType?: string;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "graphql-operation",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: "query.user",
    specJson: serializeSpec({
      kind: "graphql-operation",
      operationType: "query",
      field: "user",
      fullName: "Query.user",
      source: "sdl",
      requestType: opts.requestType,
      responseType: opts.responseType
    } as any),
    confidence: 0.9
  };
}

function makeSchemaSpec(opts: {
  id: string; contractId: string; name: string; repoId?: string;
  fields?: { name: string; type: string; optional?: boolean }[];
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "schema",
    repoId: opts.repoId ?? "repo-schemas",
    fileId: `file:${opts.repoId ?? "repo-schemas"}:test`,
    evidenceId: `ev:${opts.id}`,
    canonicalKey: opts.name.toLowerCase(),
    specJson: serializeSpec({
      kind: "schema",
      name: opts.name,
      language: "java",
      fields: (opts.fields ?? []).map((f) => ({
        name: f.name,
        type: f.type,
        optional: f.optional ?? false
      }))
    }),
    confidence: 0.85
  };
}

describe("Schema Resolver", () => {
  it("creates REQUEST_SCHEMA from http-endpoint requestBodyType", () => {
    const httpSpec = makeHttpSpec({
      id: "spec:h1", contractId: "c:h1", repoId: "repo-a",
      requestBodyType: "CreateOrderDTO"
    });
    const schemaSpec = makeSchemaSpec({
      id: "spec:s1", contractId: "c:s1", name: "CreateOrderDTO"
    });

    const edges = resolveSchemaRelations([httpSpec, schemaSpec], new Map(), []);
    const reqEdges = edges.filter((e) => e.kind === "REQUEST_SCHEMA");
    expect(reqEdges).toHaveLength(1);
    expect(reqEdges[0]!.fromSpecId).toBe(httpSpec.id);
    expect(reqEdges[0]!.toSpecId).toBe(schemaSpec.id);
  });

  it("creates RESPONSE_SCHEMA from http-endpoint responseBodyType", () => {
    const httpSpec = makeHttpSpec({
      id: "spec:h1", contractId: "c:h1", repoId: "repo-a",
      responseBodyType: "OrderResponse"
    });
    const schemaSpec = makeSchemaSpec({
      id: "spec:s1", contractId: "c:s1", name: "OrderResponse"
    });

    const edges = resolveSchemaRelations([httpSpec, schemaSpec], new Map(), []);
    const respEdges = edges.filter((e) => e.kind === "RESPONSE_SCHEMA");
    expect(respEdges).toHaveLength(1);
    expect(respEdges[0]!.fromSpecId).toBe(httpSpec.id);
    expect(respEdges[0]!.toSpecId).toBe(schemaSpec.id);
  });

  it("creates EVENT_PAYLOAD from event payloadType", () => {
    const eventSpec = makeEventSpec({
      id: "spec:e1", contractId: "c:e1", repoId: "repo-a",
      payloadType: "OrderCreatedEvent"
    });
    const schemaSpec = makeSchemaSpec({
      id: "spec:s1", contractId: "c:s1", name: "OrderCreatedEvent"
    });

    const edges = resolveSchemaRelations([eventSpec, schemaSpec], new Map(), []);
    const payloadEdges = edges.filter((e) => e.kind === "EVENT_PAYLOAD");
    expect(payloadEdges).toHaveLength(1);
    expect(payloadEdges[0]!.fromSpecId).toBe(eventSpec.id);
    expect(payloadEdges[0]!.toSpecId).toBe(schemaSpec.id);
  });

  it("resolves pending USES_SCHEMA (schema-ref: placeholder)", () => {
    const baseSchemaSpec = makeSchemaSpec({
      id: "spec:base", contractId: "c:base", name: "BaseDTO"
    });
    // The pending edge references contract "c:derived" as the source.
    // We need a ContractSpec for that contract so the resolver can map
    // contractId → specId. In this test the derived contract's spec is
    // the same as the base (simplified — in reality they'd be different).
    const derivedSpec = makeSchemaSpec({
      id: "spec:derived", contractId: "c:derived", name: "DerivedDTO"
    });
    const pendingRel: SemanticRelationEdge = {
      fromSpecId: "spec:c:derived:pending",
      toSpecId: "schema-ref:BaseDTO",
      kind: "USES_SCHEMA",
      evidenceId: "ev:pending",
      reason: "TS utility type references base schema BaseDTO",
      confidence: 0.7
    };

    const edges = resolveSchemaRelations(
      [baseSchemaSpec, derivedSpec], new Map(), [pendingRel]
    );
    const usesEdges = edges.filter((e) => e.kind === "USES_SCHEMA");
    expect(usesEdges).toHaveLength(1);
    expect(usesEdges[0]!.fromSpecId).toBe(derivedSpec.id);
    expect(usesEdges[0]!.toSpecId).toBe(baseSchemaSpec.id);
    expect(usesEdges[0]!.confidence).toBe(0.7);
  });

  it("matches schema names case-insensitively", () => {
    const httpSpec = makeHttpSpec({
      id: "spec:h1", contractId: "c:h1", repoId: "repo-a",
      requestBodyType: "createorderdto"
    });
    const schemaSpec = makeSchemaSpec({
      id: "spec:s1", contractId: "c:s1", name: "CreateOrderDTO"
    });

    const edges = resolveSchemaRelations([httpSpec, schemaSpec], new Map(), []);
    const reqEdges = edges.filter((e) => e.kind === "REQUEST_SCHEMA");
    expect(reqEdges).toHaveLength(1);
  });

  it("does NOT create edges when schema not found", () => {
    const httpSpec = makeHttpSpec({
      id: "spec:h1", contractId: "c:h1", repoId: "repo-a",
      requestBodyType: "NonExistentDTO"
    });

    const edges = resolveSchemaRelations([httpSpec], new Map(), []);
    expect(edges).toHaveLength(0);
  });

  it("handles empty input gracefully", () => {
    const edges = resolveSchemaRelations([], new Map(), []);
    expect(edges).toHaveLength(0);
  });

  it("creates both REQUEST_SCHEMA and RESPONSE_SCHEMA when both types present", () => {
    const httpSpec = makeHttpSpec({
      id: "spec:h1", contractId: "c:h1", repoId: "repo-a",
      requestBodyType: "CreateOrderDTO",
      responseBodyType: "OrderResponse"
    });
    const reqSchema = makeSchemaSpec({
      id: "spec:s1", contractId: "c:s1", name: "CreateOrderDTO"
    });
    const respSchema = makeSchemaSpec({
      id: "spec:s2", contractId: "c:s2", name: "OrderResponse"
    });

    const edges = resolveSchemaRelations(
      [httpSpec, reqSchema, respSchema], new Map(), []
    );
    expect(edges.filter((e) => e.kind === "REQUEST_SCHEMA")).toHaveLength(1);
    expect(edges.filter((e) => e.kind === "RESPONSE_SCHEMA")).toHaveLength(1);
  });

  it("integrates with analyzeImpact using edges returned by resolveSchemaRelations", () => {
    const httpSpec = makeHttpSpec({
      id: "spec:h1", contractId: "c:h1", repoId: "repo-a",
      requestBodyType: "CreateOrderDTO"
    });
    const schemaSpec = makeSchemaSpec({
      id: "spec:s1", contractId: "contract:schema:createorderdto", repoId: "repo-a", name: "CreateOrderDTO",
      fields: [{ name: "userId", type: "string" }]
    });

    const edges = resolveSchemaRelations([httpSpec, schemaSpec], new Map(), []);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe("REQUEST_SCHEMA");

    // Feed these resolved edges directly into analyzeImpact to verify regression
    const report = analyzeImpact(
      { target: "schema:CreateOrderDTO", changeType: "field-removed", detail: "userId" },
      [schemaSpec, httpSpec],
      edges
    );

    // The impact should propagate successfully to the http-endpoint using the resolved edge
    expect(report.overallSeverity).toBe("breaking");
    expect(report.impacts).toHaveLength(2); // target schema + dependent endpoint
    const endpointImpact = report.impacts.find(i => i.specId === "spec:h1");
    expect(endpointImpact).toBeDefined();
  });

  it("resolves REQUEST_SCHEMA and RESPONSE_SCHEMA for graphql-operation", () => {
    const gqlSpec = makeGraphqlSpec({
      id: "spec:g1", contractId: "c:g1", repoId: "repo-a",
      requestType: "CreateUserInput", responseType: "User"
    });
    const reqSchema = makeSchemaSpec({
      id: "spec:s1", contractId: "c:s1", name: "CreateUserInput"
    });
    const respSchema = makeSchemaSpec({
      id: "spec:s2", contractId: "c:s2", name: "User"
    });

    const edges = resolveSchemaRelations(
      [gqlSpec, reqSchema, respSchema], new Map(), []
    );
    expect(edges.filter((e) => e.kind === "REQUEST_SCHEMA")).toHaveLength(1);
    expect(edges.filter((e) => e.kind === "RESPONSE_SCHEMA")).toHaveLength(1);
  });

  it("resolves graphql schema-ref placeholders for additional operation arguments", () => {
    const gqlSpec = makeGraphqlSpec({
      id: "spec:g1", contractId: "c:g1", repoId: "repo-a",
      requestType: "ID", responseType: "User"
    });
    const inputSchema = makeSchemaSpec({
      id: "spec:s1", contractId: "c:s1", name: "UpdateUserInput"
    });
    const userSchema = makeSchemaSpec({
      id: "spec:s2", contractId: "c:s2", name: "User"
    });
    const existingRelations: SemanticRelationEdge[] = [{
      fromSpecId: gqlSpec.id,
      toSpecId: "schema-ref:UpdateUserInput",
      kind: "REQUEST_SCHEMA",
      evidenceId: gqlSpec.evidenceId,
      reason: "GraphQL operation request schema for arg input: UpdateUserInput",
      confidence: 1.0
    }];

    const edges = resolveSchemaRelations(
      [gqlSpec, inputSchema, userSchema], new Map(), existingRelations
    );

    expect(edges).toContainEqual(expect.objectContaining({
      fromSpecId: gqlSpec.id,
      toSpecId: inputSchema.id,
      kind: "REQUEST_SCHEMA"
    }));
    expect(edges).toContainEqual(expect.objectContaining({
      fromSpecId: gqlSpec.id,
      toSpecId: userSchema.id,
      kind: "RESPONSE_SCHEMA"
    }));
  });
});
