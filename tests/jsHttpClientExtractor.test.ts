import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { jsHttpClientExtractor } from "../src/core/contracts/extraction/builtin/jsHttpClientExtractor.js";
import { repoId } from "../src/shared/path.js";

async function extractFromSource(source: string, language: "typescript" | "javascript" = "typescript") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-jshttp-test-"));
  const ext = language === "typescript" ? "ts" : "js";
  const sourcePath = path.join(dir, `client.${ext}`);
  await fs.writeFile(sourcePath, source, "utf8");
  const repo = { id: repoId("jshttp-test"), name: "jshttp-test", path: dir, remoteUrl: "", branch: "", commitSha: "", language, indexedAt: "now" } as any;
  const parsed = await parseSourceFile({ repoId: repo.id, absolutePath: sourcePath, relativePath: `client.${ext}`, language });
  return await jsHttpClientExtractor.extract({
    repos: [repo], parsedFiles: [parsed], repoResolver: () => repo
  });
}

describe("JS HTTP Client Extractor method extraction", () => {
  it("extracts GET from axios.get()", async () => {
    const bundle = await extractFromSource(`
export async function fetchOrders() {
  return axios.get("/api/orders");
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("GET:/api/orders");
  });

  it("extracts POST from axios.post()", async () => {
    const bundle = await extractFromSource(`
export async function createOrder() {
  return axios.post("/api/orders", { sku: "abc" });
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("POST:/api/orders");
  });

  it("extracts PUT from axios.put()", async () => {
    const bundle = await extractFromSource(`
export async function updateOrder() {
  return axios.put("/api/orders/123", { sku: "abc" });
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("PUT:/api/orders/123");
  });

  it("extracts DELETE from axios.delete()", async () => {
    const bundle = await extractFromSource(`
export async function deleteOrder() {
  return axios.delete("/api/orders/123");
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("DELETE:/api/orders/123");
  });

  it("extracts PATCH from axios.patch()", async () => {
    const bundle = await extractFromSource(`
export async function patchOrder() {
  return axios.patch("/api/orders/123", { status: "paid" });
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("PATCH:/api/orders/123");
  });

  it("defaults fetch() to GET", async () => {
    const bundle = await extractFromSource(`
export async function fetchOrders() {
  return fetch("/api/orders");
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("GET:/api/orders");
  });

  it("extracts method from fetch() options", async () => {
    const bundle = await extractFromSource(`
export async function createOrder() {
  return fetch("/api/orders", { method: "POST" });
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("POST:/api/orders");
  });

  it("extracts method from object notation { method, url }", async () => {
    const bundle = await extractFromSource(`
export async function addItem() {
  return request({ url: "/api/items", method: "post" });
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("POST:/api/items");
  });

  it("produces method-unknown key when method cannot be inferred", async () => {
    const bundle = await extractFromSource(`
export async function fetchData() {
  return axios("/api/data");
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("/api/data");
    expect(keys.some((k) => k.includes(":"))).toBe(false);
  });

  it("degrades dynamic URL to unresolved evidence", async () => {
    const bundle = await extractFromSource(`
export async function fetchDynamic(url: string) {
  return axios.get(url);
}`);
    const dynamicEvidence = bundle.evidence.filter((e) => e.rule === "dynamic-unresolved");
    expect(dynamicEvidence.length).toBeGreaterThan(0);
  });

  it("extracts method from apiPost helper", async () => {
    const bundle = await extractFromSource(`
export async function createOrder() {
  return apiPost("/api/orders", { sku: "abc" });
}`);
    const keys = bundle.contracts.filter((c) => c.kind === "api").map((c) => c.key);
    expect(keys).toContain("POST:/api/orders");
  });
});

describe("JS HTTP Client Extractor HttpEndpointSpec production", () => {
  it("produces a consumer-side ContractSpec with method and path params", async () => {
    const bundle = await extractFromSource(`
export async function getOrder(id: string) {
  return axios.get("/api/orders/{id}");
}`);
    const spec = bundle.contractSpecs.find((s) => s.canonicalKey === "GET:/api/orders/{id}");
    expect(spec).toBeDefined();
    expect(spec!.specKind).toBe("http-endpoint");
    expect(spec!.httpMethod).toBe("GET");
    expect(spec!.framework).toBe("js-http-client");
    const parsed = JSON.parse(spec!.specJson);
    expect(parsed.pathParams).toEqual(["id"]);
    expect(bundle.contractSpecEdges.some((e) => e.specId === spec!.id)).toBe(true);
  });

  it("produces a method-unknown ContractSpec for un-inferable calls", async () => {
    const bundle = await extractFromSource(`
export async function fetchData() {
  return axios("/api/data");
}`);
    const spec = bundle.contractSpecs.find((s) => s.canonicalKey === "/api/data");
    expect(spec).toBeDefined();
    expect(spec!.httpMethod).toBeUndefined();
    expect(JSON.parse(spec!.specJson).method).toBeUndefined();
  });

  it("resolves template strings using camelCase baseUrl constants", async () => {
    const bundle = await extractFromSource(`
const baseUrl = "/mall/mgr/groupon/activity";
export async function getList() {
  return axios.get(\`\${baseUrl}/list\`);
}`);
    const spec = bundle.contractSpecs.find((s) => s.canonicalKey === "GET:/mall/mgr/groupon/activity/list");
    expect(spec).toBeDefined();
  });
});
