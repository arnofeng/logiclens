import { extractFacts } from "./helpers/extractFacts.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { springMvcExtractor } from "../src/core/contracts/extraction/builtin/springMvcExtractor.js";
import { extractCrossRepoContracts } from "../src/core/contracts/extraction/crossRepoContracts.js";
import { repoId } from "../src/shared/path.js";
async function extractFromSource(source: string) {
  return extractFromSources({ "TestController.java": source });
}

async function extractFromSources(sources: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-spring-test-"));
  const repo = { id: repoId("spring-test"), name: "spring-test", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" } as any;
  const parsedFiles = [];
  for (const [name, source] of Object.entries(sources)) {
    const relativePath = `src/main/java/com/example/${name}`;
    const absolutePath = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, source, "utf8");
    parsedFiles.push(await parseSourceFile({ repoId: repo.id, absolutePath, relativePath, language: "java" }));
  }
  const bundle = await extractFacts(springMvcExtractor, {
    repos: [repo], parsedFiles, repoResolver: () => repo
  });
  return { bundle, repo, parsed: parsedFiles[0]!, parsedFiles };
}

describe("Spring MVC Extractor HTTP method extraction", () => {
  it("extracts GET method from @GetMapping", async () => {
    const { bundle } = await extractFromSource(`
@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping("/list")
  public Object list() { return null; }
}`);
    const apiContracts = bundle.contracts.filter((c) => c.kind === "api");
    expect(apiContracts.map((c) => c.key)).toContain("GET:/api/orders/list");
  });

  it("extracts POST method from @PostMapping", async () => {
    const { bundle } = await extractFromSource(`
@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @PostMapping
  public Object create() { return null; }
}`);
    const apiContracts = bundle.contracts.filter((c) => c.kind === "api");
    expect(apiContracts.map((c) => c.key)).toContain("POST:/api/orders");
  });

  it("extracts PUT method from @PutMapping", async () => {
    const { bundle } = await extractFromSource(`
@RestController
public class OrderController {
  @PutMapping("/api/orders/{id}")
  public Object update() { return null; }
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("PUT:/api/orders/{id}");
  });

  it("extracts DELETE method from @DeleteMapping", async () => {
    const { bundle } = await extractFromSource(`
@RestController
public class OrderController {
  @DeleteMapping("/api/orders/{id}")
  public Object delete() { return null; }
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("DELETE:/api/orders/{id}");
  });

  it("extracts PATCH method from @PatchMapping", async () => {
    const { bundle } = await extractFromSource(`
@RestController
public class OrderController {
  @PatchMapping("/api/orders/{id}")
  public Object patch() { return null; }
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("PATCH:/api/orders/{id}");
  });

  it("extracts method from @RequestMapping with method attribute", async () => {
    const { bundle } = await extractFromSource(`
@RestController
public class OrderController {
  @RequestMapping(value = "/api/orders", method = RequestMethod.POST)
  public Object create() { return null; }
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("POST:/api/orders");
  });

  it("falls back to no method for @RequestMapping without method attribute", async () => {
    const { bundle } = await extractFromSource(`
@RestController
public class OrderController {
  @RequestMapping("/api/orders")
  public Object handle() { return null; }
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("/api/orders");
    expect(keys.some((k) => k.includes(":"))).toBe(false);
  });

  it("combines class-level @RequestMapping prefix with method-level @GetMapping", async () => {
    const { bundle } = await extractFromSource(`
@RestController
@RequestMapping("/api/v1")
public class UserController {
  @GetMapping("/users")
  public Object list() { return null; }
  @PostMapping("/users")
  public Object create() { return null; }
  @DeleteMapping("/users/{id}")
  public Object delete() { return null; }
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("GET:/api/v1/users");
    expect(keys).toContain("POST:/api/v1/users");
    expect(keys).toContain("DELETE:/api/v1/users/{id}");
  });
});

describe("Spring MVC Extractor HttpEndpointSpec production", () => {
  it("produces a ContractSpec + HAS_SPEC edge for each endpoint", async () => {
    const { bundle } = await extractFromSource(`
@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping("/{id}")
  public Object get() { return null; }
}`);
    const spec = bundle.contractSpecs.find((s) => s.canonicalKey === "GET:/api/orders/{id}");
    expect(spec).toBeDefined();
    expect(spec!.specKind).toBe("http-endpoint");
    expect(spec!.httpMethod).toBe("GET");
    expect(spec!.pathTemplate).toBe("/api/orders/{id}");
    expect(spec!.framework).toBe("spring-mvc");
    expect(spec!.repoId).toBe(repoId("spring-test"));

    const parsedSpec = JSON.parse(spec!.specJson);
    expect(parsedSpec.kind).toBe("http-endpoint");
    expect(parsedSpec.method).toBe("GET");
    expect(parsedSpec.pathTemplate).toBe("/api/orders/{id}");
    expect(parsedSpec.pathParams).toEqual(["id"]);

    const edge = bundle.contractSpecEdges.find((e) => e.specId === spec!.id);
    expect(edge).toBeDefined();
    expect(edge!.contractId).toBe(spec!.contractId);
  });

  it("leaves httpMethod undefined for method-unknown @RequestMapping", async () => {
    const { bundle } = await extractFromSource(`
@RestController
public class OrderController {
  @RequestMapping("/api/orders")
  public Object handle() { return null; }
}`);
    const spec = bundle.contractSpecs.find((s) => s.canonicalKey === "/api/orders");
    expect(spec).toBeDefined();
    expect(spec!.httpMethod).toBeUndefined();
    expect(JSON.parse(spec!.specJson).method).toBeUndefined();
  });

  it("preserves declared generic request/response types for adapter projection", async () => {
    const { bundle } = await extractFromSource(`
@RestController
public class ActivityController {
  @PostMapping("/plain")
  public Resp<String,String> plain(@RequestBody ActivityCreateDTO request) { return null; }
  @PostMapping("/wrapped")
  public ResponseEntity<Resp<String,String>> wrapped(@RequestBody ActivityCreateDTO request) { return null; }
}`);
    const specs = bundle.contractSpecs.map((row) => JSON.parse(row.specJson));

    expect(specs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "/plain",
        requestBodyType: "ActivityCreateDTO",
        responseBodyType: "Resp<String,String>",
        declaredResponseType: "Resp<String,String>"
      }),
      expect.objectContaining({
        path: "/wrapped",
        requestBodyType: "ActivityCreateDTO",
        responseBodyType: "ResponseEntity<Resp<String,String>>",
        declaredResponseType: "ResponseEntity<Resp<String,String>>"
      })
    ]));
  });

  it("assigns inherited generic endpoints to the concrete controller owner", async () => {
    const { bundle } = await extractFromSources({
      "BaseController.java": `
package com.example;
public abstract class BaseController<T> {
  @PostMapping("/items")
  public ResponseEntity<List<T>> create(@RequestBody T request) { return null; }
}`,
      "GoodsController.java": `
package com.example;
@RestController
@RequestMapping("/api")
public class GoodsController extends BaseController<GoodsPayload> {}`
    });
    const inherited = bundle.contractSpecs.map((row) => JSON.parse(row.specJson)).find((spec) => spec.path === "/api/items");
    expect(inherited).toMatchObject({
      ownerType: "com.example.GoodsController",
      requestBodyType: "T",
      declaredResponseType: "ResponseEntity<List<T>>",
      ownerGenericBindings: [{ name: "T", type: "GoodsPayload" }]
    });
  });

  it("keeps overloaded endpoint identities distinct by canonical method signature", async () => {
    const { bundle } = await extractFromSource(`
package com.example;
@RestController
public class OverloadedController {
  @PostMapping("/items") public Item first(@RequestBody FirstInput input) { return null; }
  @PostMapping("/items") public Item first(@RequestBody SecondInput input) { return null; }
}`);
    const specs = bundle.contractSpecs.filter((row) => row.canonicalKey === "POST:/items");
    expect(specs).toHaveLength(2);
    expect(new Set(specs.map((row) => row.id)).size).toBe(2);
    expect(new Set(specs.map((row) => JSON.parse(row.specJson).methodSignature))).toEqual(new Set([
      "first(FirstInput):Item",
      "first(SecondInput):Item"
    ]));
  });

  it("finalizes generic mappings inherited through a controller interface chain", async () => {
    const { bundle } = await extractFromSources({
      "BaseApi.java": `
package com.example;
public interface BaseApi<T> {
  @PostMapping("/items")
  ResponseEntity<List<T>> create(@RequestBody T request);
}`,
      "GoodsApi.java": `
package com.example;
public interface GoodsApi extends BaseApi<GoodsPayload> {}`,
      "GoodsController.java": `
package com.example;
@RestController
@RequestMapping("/api")
public class GoodsController implements GoodsApi {}`
    });
    const inherited = bundle.contractSpecs.map((row) => JSON.parse(row.specJson)).find((spec) => spec.path === "/api/items");
    expect(inherited).toMatchObject({
      ownerType: "com.example.GoodsController",
      requestBodyType: "T",
      declaredResponseType: "ResponseEntity<List<T>>",
      ownerGenericBindings: [{ name: "T", type: "GoodsPayload" }]
    });
  });

  it("materializes roots finalized from an inherited generic controller interface", async () => {
    const { repo, parsedFiles } = await extractFromSources({
      "BaseApi.java": `
package com.example;
public interface BaseApi<T> {
  @PostMapping("/items")
  ResponseEntity<List<T>> create(@RequestBody T request);
}`,
      "GoodsApi.java": `package com.example; public interface GoodsApi extends BaseApi<GoodsPayload> {}`,
      "GoodsController.java": `
package com.example;
@RestController
@RequestMapping("/api")
public class GoodsController implements GoodsApi {}`,
      "GoodsPayload.java": `package com.example; public record GoodsPayload(String sku) {}`
    });
    const facts = await extractCrossRepoContracts([repo], parsedFiles);
    const goods = facts.contractSpecs.find((node) => node.specKind === "schema"
      && (JSON.parse(node.specJson) as { displayName?: string }).displayName === "GoodsPayload");
    const endpoints = new Set(facts.contractSpecs.filter((node) => node.specKind === "http-endpoint").map((node) => node.id));
    expect(goods).toBeDefined();
    expect(facts.semanticRelations.some((relation) => endpoints.has(relation.fromSpecId)
      && relation.toSpecId === goods?.id && relation.kind === "REQUEST_SCHEMA")).toBe(true);
    expect(facts.semanticRelations.some((relation) => endpoints.has(relation.fromSpecId)
      && relation.toSpecId === goods?.id && relation.kind === "RESPONSE_SCHEMA")).toBe(true);
  });

  it("extracts a directly annotated controller interface", async () => {
    const { bundle } = await extractFromSource(`
package com.example;
@RestController
@RequestMapping("/interface")
public interface ControllerApi<T extends Payload> {
  @PostMapping("/create")
  T create(@RequestBody T request);
}`);
    const endpoint = bundle.contractSpecs.map((row) => JSON.parse(row.specJson)).find((spec) => spec.path === "/interface/create");
    expect(endpoint).toMatchObject({
      ownerType: "com.example.ControllerApi",
      requestBodyType: "T",
      declaredResponseType: "T"
    });
  });
});
