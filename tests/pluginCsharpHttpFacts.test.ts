import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginHttpEndpointFact, PluginSymbolView } from "@logiclens/plugin-sdk";
import { parseCSharp } from "../packages/plugin-csharp/src/parser.js";
import { csharpHttpExtractor } from "../packages/plugin-csharp/src/httpFacts.js";

const fixture = path.resolve("tests/fixtures/plugin-csharp/AspNetHttp.cs");

async function run(inputSources?: Array<{ path: string; source: string }>) {
  const sources = inputSources ?? [{ path: "AspNetHttp.cs", source: await fs.readFile(fixture, "utf8") }];
  const fileViews = await Promise.all(sources.map(async ({ path: filePath, source }) => {
    const parsed = await parseCSharp({ repoId: "repo:csharp", absolutePath: path.resolve(filePath), relativePath: filePath, language: "csharp", source });
    const symbols: PluginSymbolView[] = (parsed.symbols ?? []).map((symbol, index) => ({
      id: `symbol:${filePath}:${index}`, filePath, name: symbol.name, kind: symbol.kind,
      qualifiedName: symbol.qualifiedName ?? symbol.name, startLine: symbol.startLine, endLine: symbol.endLine,
      signature: symbol.signature ?? ""
    }));
    return { repoId: "repo:csharp", path: filePath, language: "csharp", source, symbols, imports: [], calls: [] };
  }));
  const symbols = fileViews.flatMap((file) => file.symbols);
  const files = Object.assign(fileViews, {
    all: () => fileViews, byLanguage: (language: string) => language === "csharp" ? fileViews : [],
    byRepo: (repoId: string) => repoId === "repo:csharp" ? fileViews : [],
    get: (repoId: string, filePath: string) => repoId === "repo:csharp" ? fileViews.find((file) => file.path === filePath) : undefined
  });
  const endpoints: PluginHttpEndpointFact[] = [];
  await csharpHttpExtractor.extract({ repos: [], files, symbols, imports: [], calls: [], emit: {
    fact: () => undefined, schema: () => undefined, event: () => undefined, grpcMethod: () => undefined,
    packageUsage: () => undefined, framework: () => undefined, semanticRelation: () => undefined,
    httpEndpoint: (fact) => endpoints.push({ kind: "httpEndpoint", ...fact })
  } });
  return endpoints;
}

describe("C# ASP.NET Core HTTP extraction", () => {
  it("combines controller routes, verbs, constraints, absolute routes, body types, and symbols", async () => {
    const endpoints = await run();
    const producers = endpoints.filter((item) => item.framework === "aspnet-core-controller");
    expect(producers.map((item) => [item.method, item.path])).toEqual(expect.arrayContaining([
      ["GET", "/api/Orders/{id}"], ["GET", "/v2/Orders/{id}"], ["GET", "/api/Orders/by-id/{id}"],
      ["HEAD", "/api/Orders/search"], ["GET", "/v2/Orders/search"], ["POST", "/absolute/Create"],
      ["PUT", "/api/Orders/first"], ["PUT", "/v2/Orders/second"], [undefined, "/api/Orders/unknown"],
      [undefined, "/api/Orders/custom"], ["DELETE", "/api/Orders/optional/{id}"],
      ["PATCH", "/api/Orders/catch/{slug}"], ["HEAD", "/api/Orders/default/{id}"],
      ["OPTIONS", "/api/Orders/options"], ["GET", "/stable"]
    ]));
    expect(producers.some((item) => item.path.includes("Dynamic") || item.path.includes("relative"))).toBe(false);
    expect(producers.filter((item) => item.method === "PUT" && item.path.includes("/Orders/")).map((item) => item.path)).toEqual([
      "/api/Orders/first", "/api/Orders/second", "/v2/Orders/first", "/v2/Orders/second"
    ]);
    const create = producers.find((item) => item.path === "/absolute/Create");
    expect(create).toMatchObject({ requestBodyType: "CreateOrder", responseBodyType: "OrderDto", sourceSymbolId: expect.any(String) });
    expect(producers.every((item) => item.evidence.filePath === "AspNetHttp.cs" && item.evidence.line > 0 && item.evidence.raw && item.evidence.rule === "aspnet-controller-route" && item.evidence.confidence === "exact")).toBe(true);
  });

  it("extracts route groups, MapMethods, constants, and rejects unresolved paths", async () => {
    const endpoints = (await run()).filter((item) => item.framework === "aspnet-core-minimal-api");
    expect(endpoints.map((item) => [item.method, item.path])).toEqual(expect.arrayContaining([
      ["GET", "/api/v1/{id}"], ["POST", "/api/v1"], ["HEAD", "/api/orders"], ["OPTIONS", "/api/orders"]
    ]));
    expect(endpoints.map((item) => [item.method, item.path])).toEqual(expect.arrayContaining([
      ["DELETE", "/direct/nested/{id}"], ["GET", "/multi"], ["PATCH", "/multi"], [undefined, "/multi"],
      ["GET", "/web-root"], ["POST", "/endpoint-root"]
    ]));
    expect(endpoints.some((item) => item.evidence.raw.includes("BuildPath"))).toBe(false);
    expect(endpoints.find((item) => item.method === "POST")?.requestBodyType).toBe("CreateOrder");
    expect(endpoints.find((item) => item.path === "/named")).toMatchObject({
      method: "PUT", requestBodyType: "CreateOrder", responseBodyType: "OrderDto", sourceSymbolId: expect.any(String)
    });
    expect(endpoints.filter((item) => item.path === "/multi")).toHaveLength(3);
    expect(endpoints.filter((item) => item.path === "/api/orders" && item.method === "HEAD")).toHaveLength(1);
  });

  it("extracts typed HttpClient calls with stable paths and prevents dynamic and similarly named false positives", async () => {
    const endpoints = (await run()).filter((item) => item.role === "consumer");
    expect(endpoints.map((item) => [item.method, item.path])).toEqual([
      ["GET", "/api/orders/1"], ["GET", "/api/orders/2"], ["GET", "/api/orders"],
      ["PATCH", "/api/orders/1"], ["POST", "/api/orders"]
    ]);
    expect(endpoints.every((item) => item.sourceSymbolId && item.evidence.rule === "dotnet-httpclient-consumer" && item.evidence.raw.includes("_httpClient"))).toBe(true);
  });

  it("is deterministic and deduplicated", async () => {
    const first = await run();
    expect(await run()).toEqual(first);
    expect(new Set(first.map((item) => JSON.stringify(item))).size).toBe(first.length);
  });

  it("keeps malformed partial C# isolated from valid files", async () => {
    const valid = `[ApiController]\n[Route("api/[controller]")]\npublic class HealthController : ControllerBase { [HttpGet("live")] public IActionResult Live() => Ok(); }`;
    const malformed = `[ApiController]\n[Route(BuildPath())]\npublic class BrokenController { [HttpGet("bad")] public IActionResult Bad(`;
    const endpoints = await run([{ path: "Broken.cs", source: malformed }, { path: "Health.cs", source: valid }]);
    expect(endpoints.map((item) => [item.filePath, item.method, item.path])).toEqual([["Health.cs", "GET", "/api/Health/live"]]);
  });

  it("does not treat an unrelated variable named app as an endpoint route builder", async () => {
    const fake = `var app = new FakeApplication();\napp.MapGet("/false", Handler);`;
    expect(await run([{ path: "Fake.cs", source: fake }])).toEqual([]);
  });

  it("keeps endpoint-root and HttpClient evidence inside its lexical scope", async () => {
    const shadowed = `
public class ScopedRoutes {
  public void Good(WebApplication app) { app.MapGet("/true", Handler); }
  public void Bad() { FakeApplication app = new(); app.MapGet("/false", Handler); }
}
public class ScopedClients {
  public void Good(HttpClient client) { client.GetAsync("/client-true"); }
  public void Bad() { FakeClient client = new(); client.GetAsync("/client-false"); }
}`;
    const endpoints = await run([{ path: "Shadowed.cs", source: shadowed }]);
    expect(endpoints.map((item) => [item.role, item.method, item.path])).toEqual([
      ["consumer", "GET", "/client-true"], ["producer", "GET", "/true"]
    ]);
  });

  it("resolves constant routes through the nearest visible lexical binding", async () => {
    const constants = `
public class ConstantRoutes {
  private const string Shared = "/outer";
  public void A(WebApplication web) {
    const string Root = "/a";
    const string Route = Root + "/one";
    web.MapGet(Route, Handler);
  }
  public void B(WebApplication web) {
    const string Root = "/b";
    const string Route = Root + "/two";
    web.MapGet(Route, Handler);
  }
  public void HiddenOwner() { const string Hidden = "/hidden"; }
  public void HiddenConsumer(WebApplication web) { web.MapGet(Hidden, Handler); }
  public void DynamicShadow(WebApplication web) {
    string Shared = BuildPath();
    web.MapGet(Shared, Handler);
  }
}`;
    const endpoints = await run([{ path: "Constants.cs", source: constants }]);
    expect(endpoints.map((item) => [item.method, item.path])).toEqual([["GET", "/a/one"], ["GET", "/b/two"]]);
  });

  it("aligns qualified and collection-wrapped body references with stable schema names", async () => {
    const source = `
[ApiController]
[Route("orders")]
public class OrdersController : ControllerBase {
  [HttpPost]
  public Task<ActionResult<List<Contracts.OrderResponse>>> Create(Contracts.CreateOrderRequest body) => Handle(body);
}`;
    const endpoints = await run([{ path: "Wrapped.cs", source }]);
    expect(endpoints[0]).toMatchObject({ requestBodyType: "Contracts.CreateOrderRequest", responseBodyType: "Contracts.OrderResponse" });
  });
});
