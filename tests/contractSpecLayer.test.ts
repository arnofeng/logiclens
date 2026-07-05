import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalContractKey, buildRepoDependenciesFromParticipants, type ContractParticipant } from "../src/core/contracts/extraction/crossRepoContracts.js";
import { canonicalHttpContractKey, canonicalGrpcContractKey } from "../src/core/contracts/apiPath.js";
import { createCrossRepoExtraction, toFactBundle, contract, evidence, pushGrpcContract, grpcContract } from "../src/core/contracts/extraction/builtin/shared.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { writeGraphFactsWithMerge } from "../src/core/graph-model/upsert.js";
import type { ContractNode, EvidenceNode, ParsedFile, RepoNode } from "../src/core/parsing/types.js";
import { contractId, evidenceId, fileId, repoId } from "../src/shared/path.js";

// --- Helpers ---

function makeRepo(name: string): RepoNode {
  return { id: repoId(name), name, path: `/tmp/${name}`, remoteUrl: "", branch: "main", commitSha: "abc", language: "typescript", indexedAt: "now" };
}

function makeParsedFile(repo: RepoNode, relativePath: string): ParsedFile {
  return { repoId: repo.id, fileId: fileId(repo.id, relativePath), path: relativePath, language: "typescript", hash: `${repo.id}:${relativePath}:hash`, loc: 1, imports: [], symbols: [], calls: [] };
}

function makeParticipant(repo: RepoNode, contractNode: ContractNode, role: "producer" | "consumer", rule: string): ContractParticipant {
  const ev: EvidenceNode = {
    id: evidenceId([repo.id, "file.ts", "1", rule, contractNode.key]),
    repoId: repo.id, fileId: fileId(repo.id, "src/file.ts"), filePath: "src/file.ts",
    line: 1, raw: contractNode.key, rule, confidence: 0.9
  };
  return { repoId: repo.id, contractId: contractNode.id, role, evidenceId: ev.id, confidence: ev.confidence, contract: contractNode, evidence: ev };
}

// --- 0-D: canonicalContractKey method-level ---

describe("canonicalContractKey method-level", () => {
  it("generates method-level key when method is provided", () => {
    expect(canonicalContractKey("api", "/api/orders", "GET")).toBe("GET:/api/orders");
    expect(canonicalContractKey("api", "/api/orders", "POST")).toBe("POST:/api/orders");
    expect(canonicalContractKey("api", "/api/orders/{id}", "DELETE")).toBe("DELETE:/api/orders/{id}");
  });

  it("generates path-only key when method is omitted", () => {
    expect(canonicalContractKey("api", "/api/orders")).toBe("/api/orders");
    expect(canonicalContractKey("api", "/api/orders/")).toBe("/api/orders");
  });

  it("normalizes method to uppercase", () => {
    expect(canonicalContractKey("api", "/api/orders", "get")).toBe("GET:/api/orders");
    expect(canonicalContractKey("api", "/api/orders", "Post")).toBe("POST:/api/orders");
  });

  it("trims whitespace from method", () => {
    expect(canonicalContractKey("api", "/api/orders", " GET ")).toBe("GET:/api/orders");
  });

  it("normalizes path parameters", () => {
    expect(canonicalContractKey("api", "/api/orders/:id", "GET")).toBe("GET:/api/orders/{id}");
    expect(canonicalContractKey("api", "/api/orders/${orderId}", "GET")).toBe("GET:/api/orders/{orderid}");
  });

  it("strips query strings", () => {
    expect(canonicalContractKey("api", "/api/orders?page=1", "GET")).toBe("GET:/api/orders");
  });

  it("strips HTTP origins", () => {
    expect(canonicalContractKey("api", "https://example.com/api/orders", "GET")).toBe("GET:/api/orders");
  });

  it("does not affect non-api kinds", () => {
    expect(canonicalContractKey("event", "order.created")).toBe("order.created");
    expect(canonicalContractKey("package", "@scope/pkg")).toBe("@scope/pkg");
    expect(canonicalContractKey("config", "dbUrl")).toBe("DBURL");
  });

  it("handles API paths containing colons (gRPC style)", () => {
    expect(canonicalContractKey("api", "grpc:user.UserService")).toBe("grpc:user.userservice");
  });
});

describe("canonicalHttpContractKey", () => {
  it("generates method-level key", () => {
    expect(canonicalHttpContractKey({ method: "POST", path: "/api/orders" })).toBe("POST:/api/orders");
  });

  it("generates path-only key when method is omitted", () => {
    expect(canonicalHttpContractKey({ path: "/api/orders" })).toBe("/api/orders");
  });

  it("trims and uppercases method", () => {
    expect(canonicalHttpContractKey({ method: " get ", path: "/api/orders" })).toBe("GET:/api/orders");
  });

  it("normalizes relative paths to the same key as absolute paths", () => {
    expect(canonicalHttpContractKey({ method: "GET", path: "api/orders" })).toBe("GET:/api/orders");
    expect(canonicalHttpContractKey({ method: "GET", path: "api/orders" })).toBe(canonicalHttpContractKey({ method: "GET", path: "/api/orders" }));
  });
});

describe("canonicalGrpcContractKey", () => {
  it("normalizes gRPC fullNames and lowercase package segment", () => {
    expect(canonicalGrpcContractKey("acme.order.v1.OrderService/CreateOrder")).toBe("acme.order.v1.OrderService/CreateOrder");
    expect(canonicalGrpcContractKey("Acme.Order.V1.OrderService/CreateOrder")).toBe("acme.order.v1.OrderService/CreateOrder");
    expect(canonicalGrpcContractKey("OrderService/CreateOrder")).toBe("OrderService/CreateOrder");
    expect(canonicalGrpcContractKey("  acme.order.v1.OrderService / CreateOrder  ")).toBe("acme.order.v1.OrderService/CreateOrder");
  });
});

describe("pushGrpcContract", () => {
  it("emits contract, evidence, spec and derives entity/operations", () => {
    const facts = {
      contracts: [] as any[],
      evidence: [] as any[],
      entities: [] as any[],
      contractEntities: [] as any[],
      operations: [] as any[],
      operationRepos: [] as any[],
      contractSpecs: [] as any[],
      contractSpecEdges: [] as any[],
      repoContracts: [] as any[]
    };

    const collector = {
      addContract(node: any) { facts.contracts.push(node); },
      addEvidence(node: any) { facts.evidence.push(node); },
      addEntity(node: any) { facts.entities.push(node); },
      addContractEntity(edge: any) { facts.contractEntities.push(edge); },
      addOperation(node: any) { facts.operations.push(node); },
      addOperationRepo(edge: any) { facts.operationRepos.push(edge); },
      addContractSpec(node: any) { facts.contractSpecs.push(node); },
      addContractSpecEdge(edge: any) { facts.contractSpecEdges.push(edge); },
      addRepoContract(edge: any) { facts.repoContracts.push(edge); }
    } as any;

    const repo = makeRepo("acme-order");
    const file = makeParsedFile(repo, "order.proto");
    const symbol = {
      id: "sym:1",
      name: "CreateOrder",
      kind: "rpc",
      source: "rpc CreateOrder(CreateOrderRequest) returns (Order);",
      startLine: 10,
      endLine: 10
    } as any;

    pushGrpcContract({
      collector,
      file,
      symbol,
      fullName: "acme.order.v1.OrderService/CreateOrder",
      role: "producer",
      offset: 4,
      raw: "rpc CreateOrder",
      rule: "proto-rpc",
      confidence: 1.0,
      service: "OrderService",
      method: "CreateOrder",
      package: "acme.order.v1",
      requestType: "CreateOrderRequest",
      responseType: "Order",
      streaming: "unary",
      framework: "proto"
    });

    // 1. Contract Node
    expect(facts.contracts.length).toBe(1);
    expect(facts.contracts[0]).toEqual({
      id: "contract:api:acme.order.v1.orderservice-createorder",
      kind: "api",
      key: "acme.order.v1.OrderService/CreateOrder",
      name: "acme.order.v1.OrderService/CreateOrder",
      description: "gRPC acme.order.v1.OrderService/CreateOrder"
    });

    // 2. Evidence Node
    expect(facts.evidence.length).toBe(1);
    expect(facts.evidence[0].raw).toBe("rpc CreateOrder");

    // 3. Contract Spec
    expect(facts.contractSpecs.length).toBe(1);
    expect(facts.contractSpecs[0].specKind).toBe("grpc-method");
    const parsedSpec = JSON.parse(facts.contractSpecs[0].specJson);
    expect(parsedSpec).toEqual({
      kind: "grpc-method",
      service: "OrderService",
      method: "CreateOrder",
      package: "acme.order.v1",
      fullName: "acme.order.v1.OrderService/CreateOrder",
      requestType: "CreateOrderRequest",
      responseType: "Order",
      streaming: "unary",
      framework: "proto"
    });

    // 4. Entity Derivation
    expect(facts.entities.length).toBe(1);
    expect(facts.entities[0].name).toBe("Order"); // "OrderService" -> "Order"

    // 5. Operations
    expect(facts.operations.length).toBe(1);
    expect(facts.operations[0].verb).toBe("serve-api"); // role: producer -> serve-api
    expect(facts.operations[0].entityName).toBe("Order");
  });
});

// --- 0-D: buildRepoDependenciesFromParticipants fuzzy matching ---

describe("buildRepoDependenciesFromParticipants fuzzy matching", () => {
  const repoA = makeRepo("service-a");
  const repoB = makeRepo("service-b");

  it("creates exact match dependency when contractId matches", () => {
    const c = contract("api", "/api/orders", "", "GET");
    const producer = makeParticipant(repoA, c, "producer", "exact-parser-route");
    const consumer = makeParticipant(repoB, c, "consumer", "probable-http-client");
    const deps = buildRepoDependenciesFromParticipants([producer, consumer]);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ fromRepoId: repoB.id, toRepoId: repoA.id, dependencyType: "api" });
  });

  it("fuzzy matches path-only consumer to method-level producer", () => {
    const methodContract = contract("api", "/api/orders", "", "POST");
    const pathContract = contract("api", "/api/orders");
    const producer = makeParticipant(repoA, methodContract, "producer", "exact-parser-route");
    const consumer = makeParticipant(repoB, pathContract, "consumer", "probable-http-client");
    const deps = buildRepoDependenciesFromParticipants([producer, consumer]);
    expect(deps.length).toBeGreaterThanOrEqual(1);
    const fuzzyDep = deps.find((d) => d.fromRepoId === repoB.id && d.toRepoId === repoA.id);
    expect(fuzzyDep).toBeDefined();
    expect(fuzzyDep!.confidence).toBeLessThanOrEqual(0.6);
  });

  it("fuzzy matches method-level consumer to path-only producer", () => {
    const pathContract = contract("api", "/api/orders");
    const methodContract = contract("api", "/api/orders", "", "GET");
    const producer = makeParticipant(repoA, pathContract, "producer", "exact-parser-route");
    const consumer = makeParticipant(repoB, methodContract, "consumer", "probable-http-client");
    const deps = buildRepoDependenciesFromParticipants([producer, consumer]);
    expect(deps.length).toBeGreaterThanOrEqual(1);
    const fuzzyDep = deps.find((d) => d.fromRepoId === repoB.id && d.toRepoId === repoA.id);
    expect(fuzzyDep).toBeDefined();
    expect(fuzzyDep!.confidence).toBeLessThanOrEqual(0.6);
  });

  it("does not create self-dependencies", () => {
    const c = contract("api", "/api/orders", "", "GET");
    const producer = makeParticipant(repoA, c, "producer", "exact-parser-route");
    const consumer = makeParticipant(repoA, c, "consumer", "probable-http-client");
    const deps = buildRepoDependenciesFromParticipants([producer, consumer]);
    expect(deps).toHaveLength(0);
  });

  it("handles API paths containing colons correctly in fuzzy match", () => {
    const methodContract = contract("api", "/api/v1/users:deactivate", "", "POST");
    const pathContract = contract("api", "/api/v1/users:deactivate");
    const producer = makeParticipant(repoA, methodContract, "producer", "exact-parser-route");
    const consumer = makeParticipant(repoB, pathContract, "consumer", "probable-http-client");
    const deps = buildRepoDependenciesFromParticipants([producer, consumer]);
    const fuzzyDep = deps.find((d) => d.fromRepoId === repoB.id && d.toRepoId === repoA.id);
    expect(fuzzyDep).toBeDefined();
  });
});

// --- 0-C: Extractor pipeline plumbing ---

describe("extractor pipeline plumbing", () => {
  it("createCrossRepoExtraction initializes new fields as empty arrays", () => {
    const result = createCrossRepoExtraction();
    expect(result.contractSpecs).toEqual([]);
    expect(result.contractSpecEdges).toEqual([]);
    expect(result.semanticRelations).toEqual([]);
  });

  it("toFactBundle passes through new fields", () => {
    const result = createCrossRepoExtraction();
    result.contractSpecs.push({
      id: "spec:test", contractId: "contract:api:test", specKind: "http-endpoint",
      repoId: "repo:test", fileId: "file:test", evidenceId: "ev:test",
      canonicalKey: "GET /api/test", specJson: "{}", confidence: 0.9
    });
    result.contractSpecEdges.push({
      contractId: "contract:api:test", specId: "spec:test",
      evidenceId: "ev:test", confidence: 0.9
    });
    result.semanticRelations.push({
      fromSpecId: "spec:a", toSpecId: "spec:b", kind: "CALLS_ENDPOINT",
      evidenceId: "ev:test", reason: "test", confidence: 0.9
    });
    const bundle = toFactBundle(result);
    expect(bundle.contractSpecs).toHaveLength(1);
    expect(bundle.contractSpecEdges).toHaveLength(1);
    expect(bundle.semanticRelations).toHaveLength(1);
  });

  it("buildGraphFactsBatch includes new fields from crossRepo extraction", async () => {
    const repo = makeRepo("pipeline-test");
    const parsed = makeParsedFile(repo, "src/index.ts");
    const facts = await buildGraphFactsBatch({
      batchId: "batch:pipeline", repos: [repo], parsedFiles: [parsed], semantic: false
    });
    expect(facts).toHaveProperty("contractSpecs");
    expect(facts).toHaveProperty("contractSpecEdges");
    expect(facts).toHaveProperty("semanticRelations");
    expect(Array.isArray(facts.contractSpecs)).toBe(true);
    expect(Array.isArray(facts.contractSpecEdges)).toBe(true);
    expect(Array.isArray(facts.semanticRelations)).toBe(true);
  });
});

// --- 0-B: Graph schema init + GC cascading ---

describe("graph schema and GC for ContractSpec", () => {
  it("initializes schema with ContractSpec, HAS_SPEC, SEMANTIC_REL tables", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-spec-schema-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("spec-test");
      await db.upsertContract({ id: "contract:api:test", kind: "api", key: "/api/test", name: "/api/test", description: "" });
      await db.upsertContractSpec({
        id: "spec:test", contractId: "contract:api:test", specKind: "http-endpoint",
        repoId: "repo:test", fileId: "file:test:src/a.ts", evidenceId: "ev:test",
        canonicalKey: "GET /api/test", specJson: "{}", confidence: 0.9,
        batchId: "batch:1", indexedAt: "now", active: true
      });
      await db.addHasSpec({
        contractId: "contract:api:test", specId: "spec:test",
        evidenceId: "ev:test", confidence: 0.9, batchId: "batch:1", active: true
      });
      const specs = await db.query<{ id: string }>("MATCH (s:ContractSpec) RETURN s.id AS id;");
      expect(specs).toHaveLength(1);
      expect(specs[0]!.id).toBe("spec:test");
    } finally {
      await db.close();
    }
  });

  it("cascades GC to deactivate ContractSpec and SEMANTIC_REL when file becomes stale", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-spec-gc-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("gc-test");
      const repoNode: RepoNode = { id: repoId("gc-repo"), name: "gc-repo", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      await db.upsertRepo(repoNode);

      const staleFileId = fileId(repoNode.id, "src/stale.ts");
      const activeFileId = fileId(repoNode.id, "src/active.ts");
      await db.upsertFile({ id: staleFileId, repoId: repoNode.id, path: "src/stale.ts", language: "typescript", hash: "h1", loc: 10, batchId: "batch:1", indexedAt: "now", active: true });
      await db.upsertFile({ id: activeFileId, repoId: repoNode.id, path: "src/active.ts", language: "typescript", hash: "h2", loc: 10, batchId: "batch:1", indexedAt: "now", active: true });
      await db.addContains(repoNode.id, staleFileId);
      await db.addContains(repoNode.id, activeFileId);

      await db.upsertContract({ id: "contract:api:gc", kind: "api", key: "/api/gc", name: "/api/gc", description: "" });
      await db.upsertContractSpec({
        id: "spec:stale", contractId: "contract:api:gc", specKind: "http-endpoint",
        repoId: repoNode.id, fileId: staleFileId, evidenceId: "ev:stale",
        canonicalKey: "GET /api/gc", specJson: "{}", confidence: 0.9,
        batchId: "batch:1", indexedAt: "now", active: true
      });
      await db.upsertContractSpec({
        id: "spec:active", contractId: "contract:api:gc", specKind: "http-endpoint",
        repoId: repoNode.id, fileId: activeFileId, evidenceId: "ev:active",
        canonicalKey: "POST /api/gc", specJson: "{}", confidence: 0.9,
        batchId: "batch:1", indexedAt: "now", active: true
      });
      await db.addSemanticRelation({
        fromSpecId: "spec:stale", toSpecId: "spec:active", kind: "CALLS_ENDPOINT",
        evidenceId: "ev:stale", reason: "test", confidence: 0.9,
        batchId: "batch:1", active: true
      });

      const staleCount = await db.markRepoArtifactsStale({
        repoId: repoNode.id, activeFileIds: [activeFileId], batchId: "batch:2", indexedAt: "now2"
      });
      expect(staleCount).toBe(1);

      const staleSpecs = await db.query<{ id: string; active: boolean }>(
        "MATCH (s:ContractSpec) WHERE s.id = 'spec:stale' RETURN s.id AS id, s.active AS active;"
      );
      expect(staleSpecs[0]!.active).toBe(false);

      const activeSpecs = await db.query<{ id: string; active: boolean }>(
        "MATCH (s:ContractSpec) WHERE s.id = 'spec:active' RETURN s.id AS id, s.active AS active;"
      );
      expect(activeSpecs[0]!.active).toBe(true);

      const semRels = await db.query<{ active: boolean }>(
        "MATCH ()-[r:SEMANTIC_REL]->() RETURN r.active AS active;"
      );
      expect(semRels).toHaveLength(1);
      expect(semRels[0]!.active).toBe(false);
    } finally {
      await db.close();
    }
  });
});
