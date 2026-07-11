import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { csharpSchemaExtractor } from "../packages/plugin-csharp/src/schemaFacts.js";
import { ExtractionBuilder } from "../src/core/contracts/extraction/extractionBuilder.js";
import { resolveSchemaRelations } from "../src/core/contracts/matching/schemaResolver.js";
import { adaptFactExtractor } from "../src/core/plugins/adapter.js";

const fixture = path.resolve("packages/plugin-csharp/tests/fixtures/Schemas.cs");

describe("C# schema host integration", () => {
  it("normalizes plugin facts and resolves request/response relations for a cross-language consumer", async () => {
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

    const relations = resolveSchemaRelations([...builder.build().contractSpecs], new Map(), []);
    expect(relations.filter((relation) => relation.kind === "REQUEST_SCHEMA")).toHaveLength(2);
    expect(relations.filter((relation) => relation.kind === "RESPONSE_SCHEMA")).toHaveLength(2);
  });
});
