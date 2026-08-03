import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { csharpSchemaExtractor } from "../packages/plugin-csharp/src/schemaFacts.js";
import { ExtractionBuilder } from "../src/core/contracts/extraction/extractionBuilder.js";
import { adaptFactExtractor, adaptLanguageParser } from "../src/core/plugins/adapter.js";
import { reconcileNonJavaSchemaFacts } from "../src/core/contracts/extraction/nonJavaSchemaReconciler.js";
import type { SchemaSpec } from "../src/core/contracts/spec.js";
import { fileId } from "../src/shared/path.js";
import { typeDeclarationIdentityId } from "../src/core/schema/model.js";
import { parseCSharp } from "../packages/plugin-csharp/src/parser.js";
import type { ParsedGraphFile } from "../src/core/parsing/types.js";

const fixture = path.resolve("packages/plugin-csharp/tests/fixtures/Schemas.cs");

describe("C# schema host integration", () => {
  it("preserves C# using semantics and lets an imported user List shadow the builtin wrapper", async () => {
    const repo = { id: "repo:csharp-using", name: "csharp-using", path: ".", remoteUrl: "", branch: "", commitSha: "", language: "csharp", indexedAt: "now" };
    const sources = new Map([
      ["Api.cs", `
        using Models;
        using AliasPayload = Models.AliasPayload;
        using static Models.Types;
        namespace Api;
        public record Imported(string Local);
        public record Payload(List<Item> Items);
        public static class Signatures { public static void Use(Models.FullyQualified value) { } }
      `],
      ["Models.cs", `
        namespace Models;
        public record Imported(string Wrong);
        public record UsingPayload(string Id);
        public record FullyQualified(string Id);
        public record AliasPayload(string Id);
        public static class Types { public record StaticPayload(string Id); }
        public class List<T> { public T Value { get; set; } }
        public record Item(string Id);
      `]
    ]);
    const languageParser = adaptLanguageParser({ id: "csharp", extensions: [".cs"], parse: parseCSharp })!;
    const parsedFiles: ParsedGraphFile[] = [];
    for (const [relativePath, source] of sources) {
      parsedFiles.push(await languageParser.parse({
        repoId: repo.id,
        absolutePath: path.resolve(relativePath),
        relativePath,
        language: "csharp",
        source,
        fileId: fileId(repo.id, relativePath),
        hash: `hash:${relativePath}`
      }));
    }
    const parsedApi = parsedFiles.find((file) => file.path === "Api.cs");
    expect(parsedApi && "imports" in parsedApi ? parsedApi.imports : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: "Models", importKind: "namespace" }),
      expect.objectContaining({ module: "Models.AliasPayload", importKind: "alias", alias: "AliasPayload" }),
      expect.objectContaining({ module: "Models.Types", importKind: "static" })
    ]));
    const builder = new ExtractionBuilder();
    const endpoints = [
      ["/local", "Imported"],
      ["/using", "UsingPayload"],
      ["/qualified", "Models.FullyQualified"],
      ["/alias", "AliasPayload"],
      ["/static", "StaticPayload"],
      ["/wrapper", "Payload"]
    ] as const;
    const httpExtractor = adaptFactExtractor({
      name: "fixture:csharp-using-http",
      extract(context) {
        for (const [endpointPath, requestBodyType] of endpoints) {
          context.emit.httpEndpoint({
            repoId: repo.id,
            filePath: "Api.cs",
            method: "POST",
            path: endpointPath,
            role: "producer",
            requestBodyType,
            evidence: { filePath: "Api.cs", line: 1, raw: requestBodyType, rule: "fixture", confidence: "exact" }
          });
        }
      }
    });
    await httpExtractor.extract({ repos: [repo], parsedFiles }, builder);
    await adaptFactExtractor(csharpSchemaExtractor).postExtract?.({ mergedFacts: builder.build(), repos: [repo], parsedFiles }, builder);
    const facts = builder.build();
    const reconciled = reconcileNonJavaSchemaFacts(facts.contractSpecs, facts.semanticRelations, facts.schemaDeclarations, { sourceFiles: parsedFiles });
    const schemas = reconciled.contractSpecs.filter((node) => node.specKind === "schema")
      .map((node) => JSON.parse(node.specJson) as SchemaSpec);
    const schemaByName = new Map(schemas.map((schema) => [schema.declaration.canonicalName, schema]));
    expect(schemaByName.has("Api.Imported")).toBe(true);
    expect(schemaByName.has("Models.Imported")).toBe(false);
    for (const canonicalName of ["Models.UsingPayload", "Models.FullyQualified", "Models.AliasPayload", "Models.Types.StaticPayload"]) {
      expect(schemaByName.has(canonicalName)).toBe(true);
    }
    const expectedByType = new Map([
      ["Imported", "Api.Imported"],
      ["UsingPayload", "Models.UsingPayload"],
      ["Models.FullyQualified", "Models.FullyQualified"],
      ["AliasPayload", "Models.AliasPayload"],
      ["StaticPayload", "Models.Types.StaticPayload"],
      ["Payload", "Api.Payload"]
    ]);
    for (const node of reconciled.contractSpecs.filter((candidate) => candidate.specKind === "http-endpoint")) {
      const requestType = (JSON.parse(node.specJson) as { requestBodyType?: string }).requestBodyType;
      const canonicalName = requestType ? expectedByType.get(requestType) : undefined;
      if (!canonicalName) continue;
      expect(reconciled.semanticRelations).toContainEqual(expect.objectContaining({
        fromSpecId: node.id,
        toSpecId: schemaByName.get(canonicalName)?.id,
        kind: "REQUEST_SCHEMA"
      }));
    }
    const payload = schemaByName.get("Api.Payload");
    if (!payload || payload.shape.kind !== "object") throw new Error("Api.Payload schema missing");
    const items = payload.shape.fields.find((field) => field.sourceName === "Items")?.type;
    expect(items?.kind).toBe("resolved");
    if (items?.kind !== "resolved") throw new Error("Payload.Items was not resolved");
    expect(items.expression).toMatchObject({
      kind: "type-instance",
      declarationId: typeDeclarationIdentityId({ languageId: "csharp", repoId: repo.id, resolutionScopeId: "namespace:Models", canonicalName: "Models.List" })
    });
    expect(items.expression.kind === "type-instance" ? items.expression.arguments : []).toEqual([
      expect.objectContaining({
        kind: "type-instance",
        declarationId: typeDeclarationIdentityId({ languageId: "csharp", repoId: repo.id, resolutionScopeId: "namespace:Models", canonicalName: "Models.Item" })
      })
    ]);
    const apiContext = reconciled.internal.resolutionContexts.find((context) => context.fileId === fileId(repo.id, "Api.cs"));
    expect(apiContext?.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({ localName: "UsingPayload", canonicalName: "Models.UsingPayload" }),
      expect.objectContaining({ localName: "AliasPayload", canonicalName: "Models.AliasPayload" }),
      expect.objectContaining({ localName: "StaticPayload", canonicalName: "Models.Types.StaticPayload" })
    ]));
  });

  it("resolves an HTTP body declaration in another file of the same namespace", async () => {
    const repo = { id: "repo:csharp", name: "csharp", path: ".", remoteUrl: "", branch: "", commitSha: "", language: "csharp", indexedAt: "now" };
    const sources = new Map([
      ["Api.cs", "namespace Acme.Contracts; public static class Api { }"],
      ["Models.cs", "namespace Acme.Contracts; public record Payload(string Id);"],
      ["Other.cs", "namespace Other.Contracts; public record Payload(string Wrong);"]
    ]);
    const parsedFiles = [...sources].map(([relativePath, source]) => ({
      repoId: repo.id,
      fileId: fileId(repo.id, relativePath),
      path: relativePath,
      language: "csharp",
      hash: `hash:${relativePath}`,
      loc: 1,
      source,
      symbols: [],
      imports: [],
      calls: []
    }));
    const builder = new ExtractionBuilder();
    const httpExtractor = adaptFactExtractor({
      name: "fixture:csharp-http-body",
      extract(context) {
        context.emit.httpEndpoint({
          repoId: repo.id,
          filePath: "Api.cs",
          method: "POST",
          path: "/payload",
          role: "producer",
          requestBodyType: "Payload",
          evidence: { filePath: "Api.cs", line: 1, raw: "MapPost<Payload>", rule: "fixture", confidence: "exact" }
        });
      }
    });
    await httpExtractor.extract({ repos: [repo], parsedFiles }, builder);
    await adaptFactExtractor(csharpSchemaExtractor).postExtract?.({ mergedFacts: builder.build(), repos: [repo], parsedFiles }, builder);
    const facts = builder.build();
    const reconciled = reconcileNonJavaSchemaFacts(facts.contractSpecs, facts.semanticRelations, facts.schemaDeclarations, { sourceFiles: parsedFiles });
    const http = reconciled.contractSpecs.find((node) => node.specKind === "http-endpoint")!;
    const schemas = reconciled.contractSpecs.filter((node) => node.specKind === "schema")
      .map((node) => JSON.parse(node.specJson) as SchemaSpec);
    const payload = schemas.find((schema) => schema.declaration.canonicalName === "Acme.Contracts.Payload");
    expect(payload?.declaration.resolutionScopeId).toBe("namespace:Acme.Contracts");
    expect(schemas.some((schema) => schema.declaration.canonicalName === "Other.Contracts.Payload")).toBe(false);
    expect(reconciled.semanticRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromSpecId: http.id, toSpecId: payload?.id, kind: "REQUEST_SCHEMA" })
    ]));
    expect(reconciled.internal.diagnostics.filter((diagnostic) => diagnostic.ownerSpecId === http.id)).toHaveLength(0);
  });

  it("round-trips stable SDK schema identities without global simple-name relation guessing", async () => {
    const schemaExtractor = adaptFactExtractor(csharpSchemaExtractor);
    const source = await fs.readFile(fixture, "utf8");
    const parsedFiles = [{
      repoId: "repo:csharp",
      fileId: "file:schema",
      path: "Schemas.cs",
      language: "csharp",
      hash: "h",
      loc: source.split(/\r?\n/).length,
      source,
      symbols: [],
      imports: [],
      calls: []
    }];
    const builder = new ExtractionBuilder();
    const httpExtractor = adaptFactExtractor({
      name: "fixture:cross-language-http",
      extract(context) {
        context.emit.httpEndpoint({
          repoId: "repo:csharp",
          filePath: "Api.cs",
          method: "POST",
          path: "/orders",
          role: "producer",
          requestBodyType: "CreateOrderRequest",
          responseBodyType: "OrderResponse",
          evidence: { filePath: "Api.cs", line: 1, raw: "MapPost", rule: "fixture", confidence: "exact" }
        });
        context.emit.httpEndpoint({
          repoId: "repo:typescript",
          filePath: "client.ts",
          method: "POST",
          path: "/orders",
          role: "consumer",
          requestBodyType: "CreateOrderRequest",
          responseBodyType: "OrderResponse",
          evidence: { filePath: "client.ts", line: 1, raw: "fetch('/orders')", rule: "typescript-fetch", confidence: "exact" }
        });
      }
    });

    await httpExtractor.extract({ repos: [], parsedFiles: [] }, builder);
    await schemaExtractor.postExtract?.({ mergedFacts: builder.build(), repos: [], parsedFiles }, builder);

    const roundTrippedDeclarations: unknown[] = [];
    const roundTrip = adaptFactExtractor({
      name: "fixture:round-trip",
      extract() {},
      postExtract(context) {
        for (const schema of context.facts.schemas()) {
          roundTrippedDeclarations.push(schema.declaration);
          context.emit.schema({ ...schema });
        }
      }
    });
    await roundTrip.postExtract?.({ mergedFacts: builder.build(), repos: [], parsedFiles }, builder);

    const facts = builder.build();
    const schemaSpecs = facts.contractSpecs.filter((spec) => spec.specKind === "schema");
    expect(schemaSpecs.length).toBeGreaterThan(0);
    expect(schemaSpecs.every((spec) => {
      const parsed = JSON.parse(spec.specJson) as { languageId?: string; identity?: { declarationId?: string }; shape?: { kind?: string } };
      return parsed.languageId === "csharp" && parsed.identity?.declarationId?.startsWith("declaration:") && parsed.shape?.kind === "object";
    })).toBe(true);
    const mapField = schemaSpecs.flatMap((spec) => {
      const parsed = JSON.parse(spec.specJson) as { shape?: { kind?: string; fields?: Array<{ sourceName?: string; type?: unknown }> } };
      return parsed.shape?.kind === "object" ? parsed.shape.fields ?? [] : [];
    }).find((field) => field.sourceName === "Counts");
    expect(mapField?.type).toEqual({
      kind: "resolved",
      expression: {
        kind: "map",
        key: { kind: "scalar", name: "string" },
        value: { kind: "nullable", inner: { kind: "scalar", name: "integer" } }
      }
    });
    expect(new Set(roundTrippedDeclarations.map((identity) => JSON.stringify(identity)))).toEqual(new Set(schemaSpecs.map((spec) => {
      const parsed = JSON.parse(spec.specJson) as { declaration: unknown };
      return JSON.stringify(parsed.declaration);
    })));
    expect(facts.semanticRelations.filter((relation) => relation.kind === "REQUEST_SCHEMA" || relation.kind === "RESPONSE_SCHEMA")).toHaveLength(0);
  });
});
