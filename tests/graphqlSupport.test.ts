import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { graphqlSdlExtractor } from "../src/core/contracts/extraction/builtin/graphqlSdlExtractor.js";
import { graphqlClientExtractor } from "../src/core/contracts/extraction/builtin/graphqlClientExtractor.js";
import { resolveGraphqlRelations } from "../src/core/contracts/matching/graphqlResolver.js";
import { analyzeImpact } from "../src/core/contracts/impact/impactEngine.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";
import type { SchemaSpec, GraphQLOperationSpec } from "../src/core/contracts/spec.js";
import type { ContractSpecNode } from "../src/core/parsing/types.js";
import type { SpecRoleMap } from "../src/core/contracts/matching/types.js";

async function extract(source: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-graphql-sdl-"));
  const rel = "schema.graphql";
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("graphql-sdl"), name: "graphql-sdl", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "graphql", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: rel, language: "graphql" });
  const bundle = await graphqlSdlExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

async function extractClient(source: string, filename: string, language: string): Promise<ExtractorFactBundle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-graphql-client-"));
  const abs = path.join(dir, filename);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, source, "utf8");
  const repo = { id: repoId("graphql-client"), name: "graphql-client", path: dir, remoteUrl: "", branch: "", commitSha: "", language, indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: abs, relativePath: filename, language });
  const bundle = await graphqlClientExtractor.extract({ repos: [repo], parsedFiles: [parsed], repoResolver: () => repo });
  await fs.rm(dir, { recursive: true, force: true });
  return bundle;
}

function makeGraphqlSpec(opts: {
  id: string;
  contractId: string;
  repoId: string;
  operationType: "query" | "mutation" | "subscription";
  field: string;
  evidenceId?: string;
}): ContractSpecNode {
  return {
    id: opts.id,
    contractId: opts.contractId,
    specKind: "graphql-operation",
    repoId: opts.repoId,
    fileId: `file:${opts.repoId}:graphql/schema`,
    evidenceId: opts.evidenceId ?? `ev:${opts.id}`,
    canonicalKey: `${opts.operationType}.${opts.field}`.toLowerCase(),
    specJson: JSON.stringify({
      kind: "graphql-operation",
      operationType: opts.operationType,
      field: opts.field,
      fullName: `${opts.operationType === "query" ? "Query" : opts.operationType === "mutation" ? "Mutation" : "Subscription"}.${opts.field}`,
      source: "sdl"
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

function makeSemanticRel(opts: {
  fromSpecId: string;
  toSpecId: string;
  kind: any;
  reason?: string;
  confidence?: number;
}) {
  return {
    fromSpecId: opts.fromSpecId,
    toSpecId: opts.toSpecId,
    kind: opts.kind,
    evidenceId: "ev-rel",
    reason: opts.reason ?? "some relation",
    confidence: opts.confidence ?? 0.9
  };
}

describe("GraphQL SDL Extractor", () => {
  it("extracts schemas and operations from SDL", async () => {
    const sdl = `
      type User {
        id: ID!
        name: String!
        email: String
      }

      input CreateUserInput {
        name: String!
        email: String
      }

      type Query {
        user(id: ID!): User
      }

      type Mutation {
        createUser(input: CreateUserInput!): User!
      }
    `;

    const bundle = await extract(sdl);

    // 1. Verify schema contracts and specs
    const userSpec = bundle.contractSpecs.find(s => {
      const c = bundle.contracts.find(ct => ct.id === s.contractId);
      return c?.key === "user" && c?.kind === "schema";
    });
    expect(userSpec).toBeDefined();
    const userSpecData = JSON.parse(userSpec!.specJson) as SchemaSpec;
    expect(userSpecData.fields).toHaveLength(3);
    expect(userSpecData.fields[0]).toMatchObject({ name: "id", type: "ID!" });
    expect(userSpecData.fields[1]).toMatchObject({ name: "name", type: "String!" });
    expect(userSpecData.fields[2]).toMatchObject({ name: "email", type: "String" });

    // 2. Verify operations
    const userOp = bundle.contractSpecs.find(s => {
      const c = bundle.contracts.find(ct => ct.id === s.contractId);
      return c?.key === "query.user" && c?.kind === "api";
    });
    expect(userOp).toBeDefined();
    const userOpData = JSON.parse(userOp!.specJson) as GraphQLOperationSpec;
    expect(userOpData).toMatchObject({
      kind: "graphql-operation",
      operationType: "query",
      field: "user",
      fullName: "Query.user",
      source: "sdl"
    });

    const createUserOp = bundle.contractSpecs.find(s => {
      const c = bundle.contracts.find(ct => ct.id === s.contractId);
      return c?.key === "mutation.createuser" && c?.kind === "api";
    });
    expect(createUserOp).toBeDefined();
    const createUserOpData = JSON.parse(createUserOp!.specJson) as GraphQLOperationSpec;
    expect(createUserOpData).toMatchObject({
      kind: "graphql-operation",
      operationType: "mutation",
      field: "createUser",
      fullName: "Mutation.createUser",
      source: "sdl"
    });

    // 3. Verify semantic relations
    const relations = bundle.semanticRelations;
    expect(relations.length).toBeGreaterThan(0);

    // query.user returns User
    const userResponseRel = relations.find(r => r.fromSpecId === userOp!.id && r.kind === "RESPONSE_SCHEMA");
    expect(userResponseRel).toBeDefined();
    expect(userResponseRel!.toSpecId).toBe("schema-ref:User");

    // createUser takes CreateUserInput
    const createUserRequestRel = relations.find(r => r.fromSpecId === createUserOp!.id && r.kind === "REQUEST_SCHEMA");
    expect(createUserRequestRel).toBeDefined();
    expect(createUserRequestRel!.toSpecId).toBe("schema-ref:CreateUserInput");
  });
});

describe("GraphQL Client Extractor", () => {
  it("extracts consumer operations from .graphql query documents", async () => {
    const query = `
      query GetUserProfile($id: ID!) {
        user(id: $id) {
          id
          name
        }
      }
    `;
    const bundle = await extractClient(query, "getUser.graphql", "graphql");
    const userSpec = bundle.contractSpecs.find(s => {
      const c = bundle.contracts.find(ct => ct.id === s.contractId);
      return c?.key === "query.user" && c?.kind === "api";
    });
    expect(userSpec).toBeDefined();
    const userSpecData = JSON.parse(userSpec!.specJson) as GraphQLOperationSpec;
    expect(userSpecData).toMatchObject({
      kind: "graphql-operation",
      operationType: "query",
      field: "user",
      operationName: "GetUserProfile",
      source: "client-document"
    });
  });

  it("extracts consumer operations from JS/TS tagged templates", async () => {
    const tsCode = `
      import { gql } from '@apollo/client';
      const MUTATION_CREATE_USER = gql\`
        mutation CreateUser($input: CreateUserInput!) {
          createUser(input: $input) {
            id
          }
        }
      \`;
    `;
    const bundle = await extractClient(tsCode, "userMutations.ts", "typescript");
    const createUserSpec = bundle.contractSpecs.find(s => {
      const c = bundle.contracts.find(ct => ct.id === s.contractId);
      return c?.key === "mutation.createuser" && c?.kind === "api";
    });
    expect(createUserSpec).toBeDefined();
    const specData = JSON.parse(createUserSpec!.specJson) as GraphQLOperationSpec;
    expect(specData).toMatchObject({
      kind: "graphql-operation",
      operationType: "mutation",
      field: "createUser",
      operationName: "CreateUser",
      source: "client-document"
    });
  });
});

describe("GraphQL Resolver", () => {
  it("matches consumer and producer by operationtype.field", () => {
    const producer = makeGraphqlSpec({
      id: "spec-prod",
      contractId: "contract-prod",
      repoId: "repo-prod",
      operationType: "query",
      field: "user"
    });
    const consumer = makeGraphqlSpec({
      id: "spec-cons",
      contractId: "contract-cons",
      repoId: "repo-cons",
      operationType: "query",
      field: "user"
    });

    const specs = [producer, consumer];
    const roles = { "spec-prod": "producer", "spec-cons": "consumer" };
    const specRoles = makeRoleMap(specs, roles);

    const edges = resolveGraphqlRelations(specs, specRoles);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromSpecId: "spec-cons",
      toSpecId: "spec-prod",
      kind: "CALLS_ENDPOINT"
    });
  });

  it("does not match within the same repository", () => {
    const producer = makeGraphqlSpec({
      id: "spec-prod",
      contractId: "contract-prod",
      repoId: "repo-shared",
      operationType: "query",
      field: "user"
    });
    const consumer = makeGraphqlSpec({
      id: "spec-cons",
      contractId: "contract-cons",
      repoId: "repo-shared",
      operationType: "query",
      field: "user"
    });

    const specs = [producer, consumer];
    const roles = { "spec-prod": "producer", "spec-cons": "consumer" };
    const specRoles = makeRoleMap(specs, roles);

    const edges = resolveGraphqlRelations(specs, specRoles);
    expect(edges).toHaveLength(0);
  });
});

describe("GraphQL Impact Analysis", () => {
  it("classifies operation target removal correctly as breaking", () => {
    const spec = makeGraphqlSpec({
      id: "spec-op",
      contractId: "contract-op",
      repoId: "repo-prod",
      operationType: "query",
      field: "user"
    });

    const report = analyzeImpact(
      { target: "graphql:query.user", changeType: "rpc-removed" },
      [spec],
      []
    );

    expect(report.overallSeverity).toBe("breaking");
    expect(report.impacts).toHaveLength(1);
    expect(report.impacts[0]).toMatchObject({
      specId: "spec-op",
      severity: "breaking",
      description: "GraphQL operation Query.user will be removed"
    });
  });

  it("propagates operation removal to downstream consumers", () => {
    const producer = makeGraphqlSpec({
      id: "spec-prod",
      contractId: "contract-prod",
      repoId: "repo-prod",
      operationType: "query",
      field: "user"
    });
    const consumer = makeGraphqlSpec({
      id: "spec-cons",
      contractId: "contract-cons-client",
      repoId: "repo-cons",
      operationType: "query",
      field: "user"
    });
    // Set different canonicalKey so it is not matched directly by target query
    consumer.canonicalKey = "query.user.client";

    const relations = [
      makeSemanticRel({
        fromSpecId: "spec-cons",
        toSpecId: "spec-prod",
        kind: "CALLS_ENDPOINT"
      })
    ];

    const report = analyzeImpact(
      { target: "graphql:query.user", changeType: "rpc-removed" },
      [producer, consumer],
      relations
    );

    expect(report.overallSeverity).toBe("breaking");
    expect(report.impacts).toHaveLength(2);
    const consumerImpact = report.impacts.find(i => i.specId === "spec-cons");
    expect(consumerImpact).toBeDefined();
    expect(consumerImpact!.severity).toBe("breaking");
    expect(consumerImpact!.description).toContain("Consumer calls removed GraphQL operation Query.user");
  });

  it("propagates schema field removal to query using it", () => {
    const operation = makeGraphqlSpec({
      id: "spec-op",
      contractId: "contract-op",
      repoId: "repo-prod",
      operationType: "query",
      field: "user"
    });

    const schemaSpec: ContractSpecNode = {
      id: "spec-schema",
      contractId: "contract-schema",
      specKind: "schema",
      repoId: "repo-prod",
      fileId: "graphql/schema",
      evidenceId: "ev-schema",
      canonicalKey: "User",
      specJson: JSON.stringify({
        kind: "schema",
        name: "User",
        language: "graphql",
        fields: [{ name: "email", type: "String", optional: true }]
      }),
      confidence: 1.0
    };

    const relations = [
      makeSemanticRel({
        fromSpecId: "spec-op",
        toSpecId: "spec-schema",
        kind: "RESPONSE_SCHEMA"
      })
    ];

    const report = analyzeImpact(
      { target: "schema:User", changeType: "field-removed", detail: "email" },
      [operation, schemaSpec],
      relations
    );

    expect(report.overallSeverity).toBe("risky");
    const opImpact = report.impacts.find(i => i.specId === "spec-op");
    expect(opImpact).toBeDefined();
    expect(opImpact!.severity).toBe("risky");
    expect(opImpact!.description).toContain("Request/response schema field 'email' removed — affects GraphQL operation Query.user");
  });
});
