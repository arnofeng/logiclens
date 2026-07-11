import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginContractFact, PluginHttpEndpointFact, PluginSchemaFact, PluginSymbolView } from "@logiclens/plugin-sdk";
import { parseCSharp } from "../src/parser.js";
import { csharpSchemaExtractor } from "../src/schemaFacts.js";

const fixture = path.resolve(import.meta.dirname, "fixtures/Schemas.cs");

async function fileView(filePath: string, source: string) {
  const parsed = await parseCSharp({ repoId: "repo:csharp", absolutePath: path.resolve(filePath), relativePath: filePath, language: "csharp", source });
  const symbols: PluginSymbolView[] = (parsed.symbols ?? []).map((symbol, index) => ({
    id: `symbol:${filePath}:${index}`, filePath, name: symbol.name, kind: symbol.kind,
    qualifiedName: symbol.qualifiedName ?? symbol.name, startLine: symbol.startLine, endLine: symbol.endLine,
    signature: symbol.signature ?? ""
  }));
  return { repoId: "repo:csharp", path: filePath, language: "csharp", source, symbols, imports: [], calls: [] };
}

async function run(httpFacts: PluginHttpEndpointFact[] = [], sources?: Array<{ path: string; source: string }>) {
  const input = sources ?? [{ path: "Schemas.cs", source: await fs.readFile(fixture, "utf8") }];
  const views = await Promise.all(input.map((item) => fileView(item.path, item.source)));
  const files = Object.assign(views, {
    all: () => views, byLanguage: (language: string) => language === "csharp" ? views : [],
    byRepo: (repoId: string) => repoId === "repo:csharp" ? views : [],
    get: (repoId: string, filePath: string) => repoId === "repo:csharp" ? views.find((file) => file.path === filePath) : undefined
  });
  const schemas: PluginSchemaFact[] = [];
  const allFacts: PluginContractFact[] = [...httpFacts];
  await csharpSchemaExtractor.postExtract?.({ repos: [], files, symbols: views.flatMap((file) => file.symbols), imports: [], calls: [], facts: {
    httpEndpoints: () => httpFacts, schemas: () => [], events: () => [], grpcMethods: () => [], packageUsages: () => [], frameworks: () => [], all: () => allFacts
  }, emit: {
    fact: () => undefined, httpEndpoint: () => undefined, event: () => undefined, grpcMethod: () => undefined,
    packageUsage: () => undefined, framework: () => undefined, semanticRelation: () => undefined,
    schema: (fact) => schemas.push({ kind: "schema", ...fact })
  } });
  return schemas;
}

function endpoint(requestBodyType?: string, responseBodyType?: string): PluginHttpEndpointFact {
  return { kind: "httpEndpoint", repoId: "repo:csharp", filePath: "Api.cs", method: "POST", path: "/orders", role: "producer",
    requestBodyType, responseBodyType, evidence: { filePath: "Api.cs", line: 1, raw: "MapPost", rule: "fixture", confidence: "exact" } };
}

describe("C# schema extraction", () => {
  it("classifies records, structs, naming evidence, attributes, and endpoint wrappers conservatively", async () => {
    const schemas = await run([endpoint("Contracts.ExplicitlyReferenced", "Task<ActionResult<OrderResponse>>")]);
    expect(schemas.map((schema) => schema.name)).toEqual([
      "AddressContract", "Contracts.ExplicitlyReferenced", "CreateOrderRequest", "OrderResponse", "PayloadModel"
    ]);
    expect(schemas.some((schema) => schema.name === "OrdinaryDomainEntity")).toBe(false);
    expect(schemas.every((schema) => schema.sourceSymbolId && schema.evidence.confidence === "exact" && schema.evidence.raw)).toBe(true);
  });

  it("extracts deterministic fields with normalized types, names, optionality, nullability, and lines", async () => {
    const schemas = await run([endpoint("ExplicitlyReferenced", "OrderResponse")]);
    expect(schemas.find((schema) => schema.name === "CreateOrderRequest")?.fields).toEqual([
      expect.objectContaining({ name: "customer_id", type: "string", optional: false, nullable: false, sourceLine: 8 }),
      expect.objectContaining({ name: "Quantity", type: "integer", optional: true, nullable: true, sourceLine: 9 }),
      expect.objectContaining({ name: "Tags", type: "array<string>", optional: false, nullable: false, sourceLine: 10 })
    ]);
    expect(schemas.find((schema) => schema.name === "OrderResponse")?.fields).toEqual([
      expect.objectContaining({ name: "Id", type: "string", optional: false, nullable: false }),
      expect.objectContaining({ name: "Note", type: "string", optional: true, nullable: true }),
      expect.objectContaining({ name: "Total", type: "number", optional: true, nullable: false })
    ]);
    const address = schemas.find((schema) => schema.name === "AddressContract")!;
    expect(address.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "postal_code", type: "string", optional: false, nullable: false }),
      expect.objectContaining({ name: "Counts", type: "dictionary<string,integer?>", optional: false, nullable: false })
    ]));
    expect(address.fields.some((field) => field.name === "NotSerialized")).toBe(false);
  });

  it("is stable, deduplicated, and isolates malformed files", async () => {
    const valid = "public record GoodResponse(string Value);";
    const broken = "public record BrokenRequest(string Value";
    const first = await run([], [{ path: "Broken.cs", source: broken }, { path: "Good.cs", source: valid }]);
    expect(first.map((schema) => schema.name)).toEqual(["GoodResponse"]);
    expect(await run([], [{ path: "Broken.cs", source: broken }, { path: "Good.cs", source: valid }])).toEqual(first);
  });

  it("keeps qualified, nested, same-named, and partial declarations unambiguous", async () => {
    const source = `
namespace Alpha {
  public partial class Thing { public string First { get; set; } }
  public partial class Thing { public string Second { get; set; } }
  public class Outer { public record BodyModel(string?[] Values, System.Int32[,] Grid); }
}
namespace Beta { public class Thing { public int Wrong { get; set; } } }
`;
    const schemas = await run([endpoint("Alpha.Thing", "Alpha.Outer.BodyModel")], [{ path: "Names.cs", source }]);
    expect(schemas.map((schema) => schema.name)).toEqual(["Alpha.Outer.BodyModel", "Alpha.Thing"]);
    expect(schemas.find((schema) => schema.name === "Alpha.Thing")?.fields.map((field) => field.name)).toEqual(["First", "Second"]);
    expect(schemas.find((schema) => schema.name === "Alpha.Outer.BodyModel")?.fields).toEqual([
      expect.objectContaining({ name: "Values", type: "array<string?>", nullable: false, optional: false }),
      expect.objectContaining({ name: "Grid", type: "array<integer>", nullable: false, optional: false })
    ]);
    expect(schemas.some((schema) => schema.evidence.raw.includes("namespace Beta"))).toBe(false);
  });

  it("honors conditional JsonIgnore and required-over-default precedence", async () => {
    const source = `
public class AttributeModel {
  [JsonIgnore] public string Hidden { get; set; } = "x";
  [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string Included { get; set; } = "x";
  [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Conditional { get; set; }
  [JsonPropertyName("wire_name"), Required] public string Renamed { get; set; } = "x";
  public string Computed { get => "x"; set {} }
  public string PrivateRead { private get; set; }
}`;
    const schema = (await run([], [{ path: "Attributes.cs", source }]))[0]!;
    expect(schema.fields).toEqual([
      expect.objectContaining({ name: "Included", optional: true, nullable: false }),
      expect.objectContaining({ name: "Conditional", optional: true, nullable: true }),
      expect.objectContaining({ name: "wire_name", optional: false, nullable: false }),
      expect.objectContaining({ name: "Computed", optional: false, nullable: false })
    ]);
  });

  it("excludes static properties and explicitly attributed static fields", async () => {
    const source = `
public class StaticModel {
  public string Instance { get; set; }
  public static string Shared { get; set; }
  [JsonInclude] public static string IncludedShared;
  [DataMember] public static string ContractShared;
  [JsonInclude] public string IncludedInstance;
}`;
    const schema = (await run([], [{ path: "Static.cs", source }]))[0]!;
    expect(schema.fields.map((field) => field.name)).toEqual(["Instance", "IncludedInstance"]);
  });

});
