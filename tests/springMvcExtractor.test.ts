import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import { springMvcExtractor } from "../src/extractors/builtin/springMvcExtractor.js";
import { repoId } from "../src/utils/path.js";
import type { ExtractedRelation } from "../src/extractors/crossRepoContracts.js";

function isRepoContractRelation(r: ExtractedRelation): r is ExtractedRelation & { kind: "repo-contract" } {
  return r.kind === "repo-contract";
}

async function extractFromSource(source: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-spring-test-"));
  const relativePath = "src/main/java/com/example/TestController.java";
  const absolutePath = path.join(dir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, source, "utf8");
  const repo = { id: repoId("spring-test"), name: "spring-test", path: dir, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath, relativePath, language: "java" });
  const bundle = await springMvcExtractor.extract({
    repos: [repo], parsedFiles: [parsed], repoResolver: () => repo
  });
  return { bundle, repo, parsed };
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
});
