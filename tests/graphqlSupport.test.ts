import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { graphqlSdlExtractor } from "../src/core/contracts/extraction/builtin/graphqlSdlExtractor.js";
import { repoId } from "../src/shared/path.js";
import type { ExtractorFactBundle } from "../src/core/contracts/extraction/crossRepoContracts.js";
import type { SchemaSpec, GraphQLOperationSpec } from "../src/core/contracts/spec.js";

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
