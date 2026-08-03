import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { objectSchemaFields } from "./helpers/schemaModel.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { protoExtractor } from "../src/core/contracts/extraction/builtin/protoExtractor.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";
import { reconcileNonJavaSchemaFacts } from "../src/core/contracts/extraction/nonJavaSchemaReconciler.js";
import type { GrpcMethodSpec, SchemaSpec } from "../src/core/contracts/spec.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-proto-extractor-"));
  const rel = "protos/order.proto";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  
  const repo = {
    id: repoId("order-repo"),
    name: "order-repo",
    path: dir,
    remoteUrl: "",
    branch: "",
    commitSha: "",
    language: "proto",
    indexedAt: "now"
  } as any;

  const parsed = await parseSourceFile({
    repoId: repo.id,
    absolutePath: abs,
    relativePath: rel,
    language: "proto"
  });

  const extracted = await protoExtractor.extract({
    repos: [repo],
    parsedFiles: [parsed],
    repoResolver: () => repo
  });
  const reconciled = reconcileNonJavaSchemaFacts(extracted.contractSpecs, extracted.semanticRelations, [], { sourceFiles: [parsed] });
  const bundle = { ...extracted, contractSpecs: reconciled.contractSpecs, semanticRelations: reconciled.semanticRelations };

  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

describe("Protobuf Extractor", () => {
  it("extracts gRPC service methods and message schemas from .proto files", async () => {
    const source = `
      syntax = "proto3";
      package acme.order.v1;

      service OrderService {
        rpc CreateOrder (CreateOrderRequest) returns (Order);
        rpc GetOrder (GetOrderRequest) returns (stream Order);
      }

      message CreateOrderRequest {
        string user_id = 1;
        repeated string items = 2;
        map<string, string> metadata = 3;
      }

      message Order {
        string id = 1;
      }

      message GetOrderRequest {
        string id = 1;
      }

      message Outer {
        message Inner {
          string value = 1;
        }
      }
    `;

    const bundle = await extract(source);

    // Assert GRPC contract node extraction
    const createOrderContract = bundle.contracts.find((c) => c.key === "acme.order.v1.OrderService/CreateOrder");
    expect(createOrderContract).toBeDefined();
    expect(createOrderContract!.description).toBe("gRPC acme.order.v1.OrderService/CreateOrder");

    const getOrderContract = bundle.contracts.find((c) => c.key === "acme.order.v1.OrderService/GetOrder");
    expect(getOrderContract).toBeDefined();

    // Assert GrpcMethodSpec definitions
    const createOrderSpecRow = bundle.contractSpecs.find((s) => s.contractId === createOrderContract!.id);
    expect(createOrderSpecRow).toBeDefined();
    const createOrderSpec = JSON.parse(createOrderSpecRow!.specJson) as GrpcMethodSpec;
    expect(createOrderSpec.kind).toBe("grpc-method");
    expect(createOrderSpec.service).toBe("OrderService");
    expect(createOrderSpec.method).toBe("CreateOrder");
    expect(createOrderSpec.package).toBe("acme.order.v1");
    expect(createOrderSpec.requestType).toBe("CreateOrderRequest");
    expect(createOrderSpec.responseType).toBe("Order");
    expect(createOrderSpec.streaming).toBe("unary");

    const getOrderSpecRow = bundle.contractSpecs.find((s) => s.contractId === getOrderContract!.id);
    expect(getOrderSpecRow).toBeDefined();
    const getOrderSpec = JSON.parse(getOrderSpecRow!.specJson) as GrpcMethodSpec;
    expect(getOrderSpec.streaming).toBe("server-stream");

    // Assert SchemaSpec definitions
    const reqSchemaContract = bundle.contracts.find((c) => c.key === "acme.order.v1.createorderrequest");
    expect(reqSchemaContract).toBeDefined();
    const reqSchemaSpecRow = bundle.contractSpecs.find((s) => s.contractId === reqSchemaContract!.id);
    expect(reqSchemaSpecRow).toBeDefined();
    const reqSchemaSpec = JSON.parse(reqSchemaSpecRow!.specJson) as SchemaSpec;
    expect(reqSchemaSpec.kind).toBe("schema");
    expect(reqSchemaSpec.displayName).toBe("acme.order.v1.CreateOrderRequest");
    expect(reqSchemaSpec.languageId).toBe("proto");
    expect(objectSchemaFields(reqSchemaSpec)).toHaveLength(3);

    // Fields check
    const userIdField = objectSchemaFields(reqSchemaSpec).find((f) => f.name === "user_id");
    expect(userIdField).toBeDefined();
    expect(userIdField!.type).toBe("string");

    const itemsField = objectSchemaFields(reqSchemaSpec).find((f) => f.name === "items");
    expect(itemsField).toBeDefined();
    expect(itemsField!.type).toBe("array<string>");

    const metadataField = objectSchemaFields(reqSchemaSpec).find((f) => f.name === "metadata");
    expect(metadataField).toBeDefined();
    expect(metadataField!.type).toBe("map<string,string>");

    // Nested messages check
    const innerSchemaContract = bundle.contracts.find((c) => c.key === "acme.order.v1.outer.inner");
    expect(innerSchemaContract).toBeDefined();
    const innerSchemaSpecRow = bundle.contractSpecs.find((s) => s.contractId === innerSchemaContract!.id);
    expect(innerSchemaSpecRow).toBeDefined();
    const innerSchemaSpec = JSON.parse(innerSchemaSpecRow!.specJson) as SchemaSpec;
    expect(objectSchemaFields(innerSchemaSpec)[0]!.name).toBe("value");

    // --- Relation Resolution ---
    // Match the extracted specs into semantic relations
    const mockDbSpecs = bundle.contractSpecs.map((s) => ({
      id: s.id,
      contractId: s.contractId,
      specKind: s.specKind,
      repoId: s.repoId,
      fileId: s.fileId,
      evidenceId: s.evidenceId,
      canonicalKey: s.canonicalKey,
      specJson: s.specJson,
      confidence: s.confidence
    })) as any;

    const resolvedRelations = bundle.semanticRelations;
    
    // Check REQUEST_SCHEMA edge from CreateOrder to CreateOrderRequest
    const reqEdge = resolvedRelations.find(
      (r) => r.fromSpecId === createOrderSpecRow!.id && r.kind === "REQUEST_SCHEMA"
    );
    expect(reqEdge).toBeDefined();
    expect(reqEdge!.toSpecId).toBe(reqSchemaSpecRow!.id);

    // Check RESPONSE_SCHEMA edge from CreateOrder to Order
    const orderSchemaContract = bundle.contracts.find((c) => c.key === "acme.order.v1.order");
    const orderSchemaSpecRow = bundle.contractSpecs.find((s) => s.contractId === orderSchemaContract!.id);
    const respEdge = resolvedRelations.find(
      (r) => r.fromSpecId === createOrderSpecRow!.id && r.kind === "RESPONSE_SCHEMA"
    );
    expect(respEdge).toBeDefined();
    expect(respEdge!.toSpecId).toBe(orderSchemaSpecRow!.id);
  });

  it("resolves RPC request and response messages declared in another file of the same package", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "test-proto-cross-file-"));
    try {
      const id = repoId("proto-cross-file");
      const sources = new Map([
        ["protos/service.proto", `
          syntax = "proto3";
          package acme.orders.v1;
          import "models.proto";
          service Orders { rpc Create (CreateRequest) returns (CreateResponse); }
        `],
        ["protos/models.proto", `
          syntax = "proto3";
          package acme.orders.v1;
          message CreateRequest { string id = 1; }
          message CreateResponse { string id = 1; }
        `]
      ]);
      const parsed = [];
      for (const [relativePath, source] of sources) {
        const absolutePath = path.join(directory, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, source, "utf8");
        parsed.push(await parseSourceFile({ repoId: id, absolutePath, relativePath, language: "proto" }));
      }
      const repo = { id, name: "proto-cross-file", path: directory, remoteUrl: "", branch: "", commitSha: "", language: "proto", indexedAt: "now" };
      const extracted = await protoExtractor.extract({ repos: [repo], parsedFiles: parsed, repoResolver: () => repo });
      const serviceFile = parsed.find((file) => file.path === "protos/service.proto");
      expect(serviceFile && "imports" in serviceFile ? serviceFile.imports : []).toEqual([
        expect.objectContaining({ module: "models.proto", importKind: "module" })
      ]);
      const reconciled = reconcileNonJavaSchemaFacts(extracted.contractSpecs, extracted.semanticRelations, [], { sourceFiles: parsed });
      const grpcNode = reconciled.contractSpecs.find((node) => {
        const spec = JSON.parse(node.specJson) as { kind?: string };
        return spec.kind === "grpc-method";
      });
      const schemas = reconciled.contractSpecs.filter((node) => node.specKind === "schema")
        .map((node) => JSON.parse(node.specJson) as SchemaSpec);
      const request = schemas.find((schema) => schema.displayName === "acme.orders.v1.CreateRequest");
      const response = schemas.find((schema) => schema.displayName === "acme.orders.v1.CreateResponse");
      expect(request?.declaration.resolutionScopeId).toBe("package:acme.orders.v1");
      expect(response?.declaration.resolutionScopeId).toBe("package:acme.orders.v1");
      expect(reconciled.semanticRelations).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromSpecId: grpcNode?.id, toSpecId: request?.id, kind: "REQUEST_SCHEMA" }),
        expect.objectContaining({ fromSpecId: grpcNode?.id, toSpecId: response?.id, kind: "RESPONSE_SCHEMA" })
      ]));
      expect(reconciled.internal.diagnostics.filter((diagnostic) => diagnostic.ownerSpecId === grpcNode?.id)).toHaveLength(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves source-root imports plus relative and absolute protobuf type names in another package", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "test-proto-import-package-"));
    try {
      const id = repoId("proto-import-package");
      const sources = new Map([
        ["api/service.proto", `
          syntax = "proto3";
          package acme.api;
          import "models/types.proto";
          service Api { rpc Create (models.CreateRequest) returns (.acme.models.CreateResponse); }
        `],
        ["models/types.proto", `
          syntax = "proto3";
          package acme.models;
          message CreateRequest { string id = 1; }
          message CreateResponse { string id = 1; }
        `]
      ]);
      const parsed = [];
      for (const [relativePath, source] of sources) {
        const absolutePath = path.join(directory, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, source, "utf8");
        parsed.push(await parseSourceFile({ repoId: id, absolutePath, relativePath, language: "proto" }));
      }
      const repo = { id, name: "proto-import-package", path: directory, remoteUrl: "", branch: "", commitSha: "", language: "proto", indexedAt: "now" };
      const extracted = await protoExtractor.extract({ repos: [repo], parsedFiles: parsed, repoResolver: () => repo });
      const reconciled = reconcileNonJavaSchemaFacts(extracted.contractSpecs, extracted.semanticRelations, [], { sourceFiles: parsed });
      const grpcNode = reconciled.contractSpecs.find((node) => node.specKind === "grpc-method")!;
      const grpc = JSON.parse(grpcNode.specJson) as GrpcMethodSpec;
      expect(grpc.requestType).toBe("models.CreateRequest");
      expect(grpc.responseType).toBe("acme.models.CreateResponse");
      const schemas = reconciled.contractSpecs.filter((node) => node.specKind === "schema")
        .map((node) => JSON.parse(node.specJson) as SchemaSpec);
      const request = schemas.find((schema) => schema.declaration.canonicalName === "acme.models.CreateRequest");
      const response = schemas.find((schema) => schema.declaration.canonicalName === "acme.models.CreateResponse");
      expect(reconciled.semanticRelations).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromSpecId: grpcNode.id, toSpecId: request?.id, kind: "REQUEST_SCHEMA" }),
        expect.objectContaining({ fromSpecId: grpcNode.id, toSpecId: response?.id, kind: "RESPONSE_SCHEMA" })
      ]));
      expect(reconciled.internal.diagnostics.filter((diagnostic) => diagnostic.ownerSpecId === grpcNode.id)).toHaveLength(0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
