import { describe, expect, it } from "vitest";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import {
  MAX_EVIDENCE_RAW_LENGTH,
  MAX_SECTION_TEXT_LENGTH,
  projectCodeDocuments,
  projectContractDocuments,
  projectContractSpecDocuments,
  projectEvidenceDocuments,
  projectSectionDocuments
} from "../src/core/retrieval/projection.js";
import { parseRenderRef } from "../src/core/retrieval/renderRef.js";

function factsFixture(): GraphFactsBatch {
  const longSection = `searchable section prefix ${"x".repeat(MAX_SECTION_TEXT_LENGTH + 200)} LEAKED_SECTION_SUFFIX`;
  const longRaw = `evidence prefix ${"y".repeat(MAX_EVIDENCE_RAW_LENGTH + 200)} LEAKED_EVIDENCE_SUFFIX`;
  return {
    batchId: "batch:fallback",
    indexedAt: "2026-01-01",
    repos: [
      { id: "repo:a", name: "Alpha", path: "ignored", remoteUrl: "", branch: "main", commitSha: "a", language: "typescript", indexedAt: "old" },
      { id: "repo:b", name: "Beta", path: "ignored", remoteUrl: "", branch: "main", commitSha: "b", language: "typescript", indexedAt: "old" }
    ],
    files: [
      { id: "file:a", repoId: "repo:a", path: "src\\orders\\OrderService.ts", language: "typescript", hash: "file-a", loc: 30, batchId: "batch:file-a", active: true },
      { id: "file:b", repoId: "repo:b", path: "docs/contracts.md", language: "markdown", hash: "file-b", loc: 30, batchId: "batch:file-b", active: true }
    ],
    code: [
      { id: "code:valid", repoId: "repo:a", fileId: "file:a", kind: "method", name: "createOrder", qualifiedName: "OrderService.createOrder", startLine: 4, endLine: 9, signature: "createOrder(request: CreateOrderRequest)", source: "SECRET_SOURCE_ONLY_MARKER", hash: "code-hash", summary: "Creates customer orders", batchId: "batch:code", active: true },
      { id: "code:bad-lines", repoId: "repo:a", fileId: "file:a", kind: "function", name: "bad", qualifiedName: "bad", startLine: 0, endLine: 2, signature: "bad()", source: "", hash: "bad" },
      { id: "code:orphan", repoId: "repo:a", fileId: "file:missing", kind: "function", name: "orphan", qualifiedName: "orphan", startLine: 1, endLine: 2, signature: "orphan()", source: "", hash: "orphan" }
    ],
    sections: [
      { id: "section:valid", repoId: "repo:b", fileId: "file:b", heading: "Inventory Contract", level: 2, startLine: 2, endLine: 20, text: longSection, summary: "库存同步说明", hash: "section-hash", links: [], codeBlocks: [], batchId: "batch:section", active: false },
      { id: "section:bad-lines", repoId: "repo:b", fileId: "file:b", heading: "Bad", level: 2, startLine: 8, endLine: 7, text: "bad", hash: "bad-section", links: [], codeBlocks: [] }
    ],
    contracts: [
      { id: "contract:api:orders", kind: "api", key: "POST:/orders", name: "Create Orders API", description: "Creates an order" },
      { id: "contract:event:orders", kind: "event", key: "orders.created", name: "Order Created", description: "Order event" },
      { id: "contract:schema:order", kind: "schema", key: "OrderSchema", name: "Order Schema", description: "Order payload" }
    ],
    evidence: [
      { id: "evidence:a", repoId: "repo:a", fileId: "file:a", filePath: "src/orders/OrderService.ts", line: 4, raw: longRaw, rule: "http-producer", confidence: 0.95, batchId: "batch:evidence-a", active: false },
      { id: "evidence:b", repoId: "repo:b", fileId: "file:b", filePath: "docs/contracts.md", line: 7, raw: "POST /orders consumer", rule: "http-consumer", confidence: 0.8, batchId: "batch:evidence-b", active: true },
      { id: "evidence:event", repoId: "repo:a", fileId: "file:a", filePath: "src/orders/OrderService.ts", line: 12, raw: "orders.created", rule: "event-producer", confidence: 0.9 },
      { id: "evidence:schema", repoId: "repo:b", fileId: "file:b", filePath: "docs/contracts.md", line: 15, raw: "OrderSchema", rule: "schema-definition", confidence: 0.9 },
      { id: "evidence:mismatch", repoId: "repo:a", fileId: "file:a", filePath: "wrong.ts", line: 1, raw: "wrong", rule: "wrong", confidence: 1 }
    ],
    repoContracts: [
      { repoId: "repo:a", contractId: "contract:api:orders", role: "producer", evidenceId: "evidence:a", confidence: 0.95, batchId: "batch:edge", active: true },
      { repoId: "repo:a", contractId: "contract:api:orders", role: "producer", evidenceId: "evidence:a", confidence: 0.95, batchId: "batch:edge", active: true },
      { repoId: "repo:b", contractId: "contract:api:orders", role: "consumer", evidenceId: "evidence:b", confidence: 0.8 },
      { repoId: "repo:a", contractId: "contract:event:orders", role: "producer", evidenceId: "evidence:event", confidence: 0.9 },
      { repoId: "repo:b", contractId: "contract:schema:order", role: "shared", evidenceId: "evidence:schema", confidence: 0.9 }
    ],
    contractSpecs: [
      { id: "spec:http", contractId: "contract:api:orders", specKind: "http-endpoint", repoId: "repo:a", fileId: "file:a", evidenceId: "evidence:a", canonicalKey: "POST:/orders", httpMethod: "POST", pathTemplate: "/orders", framework: "express", version: "1", specJson: "{\"SECRET_SPEC_JSON\":true}", confidence: 0.95, batchId: "batch:spec" },
      { id: "spec:event", contractId: "contract:event:orders", specKind: "event", repoId: "repo:a", fileId: "file:a", evidenceId: "evidence:event", canonicalKey: "orders.created", eventTopic: "orders.created", framework: "kafka", specJson: "{}", confidence: 0.9 },
      { id: "spec:schema", contractId: "contract:schema:order", specKind: "schema", repoId: "repo:b", fileId: "file:b", evidenceId: "evidence:schema", canonicalKey: "OrderSchema", version: "2026-01", specJson: "{\"type\":\"object\"}", confidence: 0.9 },
      { id: "spec:orphan", contractId: "contract:api:orders", specKind: "http-endpoint", repoId: "repo:a", fileId: "file:a", evidenceId: "missing", canonicalKey: "GET:/missing", specJson: "{}", confidence: 1 }
    ],
    contractSpecEdges: [
      { contractId: "contract:api:orders", specId: "spec:http", evidenceId: "evidence:a", confidence: 0.95, active: true },
      { contractId: "contract:event:orders", specId: "spec:event", evidenceId: "evidence:event", confidence: 0.9 },
      { contractId: "contract:schema:order", specId: "spec:schema", evidenceId: "evidence:schema", confidence: 0.9 }
    ]
  } as unknown as GraphFactsBatch;
}

describe("code and section lexical projection", () => {
  it("indexes controlled symbol and section fields without leaking source or unbounded text", () => {
    const facts = factsFixture();
    const [code] = projectCodeDocuments(facts, "workspace:test");
    const [section] = projectSectionDocuments(facts, "workspace:test");
    expect(code).toMatchObject({ canonicalId: "code:valid", qualifiedName: "OrderService.createOrder", path: "src/orders/OrderService.ts", batchId: "batch:code", active: true });
    for (const token of ["createorder", "orderservice.createorder", "createorder(request", "creates", "src/orders/orderservice.ts"]) {
      expect(code!.searchableText.toLowerCase()).toContain(token);
    }
    expect(JSON.stringify(code)).not.toContain("SECRET_SOURCE_ONLY_MARKER");
    expect(section).toMatchObject({ canonicalId: "section:valid", batchId: "batch:section", active: false });
    expect(section!.searchableText).toContain("Inventory Contract");
    expect(section!.searchableText).toContain("searchable section prefix");
    expect(section!.searchableText).not.toContain("LEAKED_SECTION_SUFFIX");
    expect(section!.searchableText.length).toBeLessThanOrEqual(MAX_SECTION_TEXT_LENGTH + 100);
    expect(parseRenderRef(code!.renderRef, "workspace:test")).toMatchObject({ fileId: "file:a", path: "src/orders/OrderService.ts", startLine: 4, endLine: 9 });
    expect(parseRenderRef(section!.renderRef, "workspace:test")).toMatchObject({ fileId: "file:b", path: "docs/contracts.md", startLine: 2, endLine: 20 });
  });

  it("skips missing files and invalid line ranges deterministically and hashes only effective fields", () => {
    const facts = factsFixture();
    expect(projectCodeDocuments(facts, "workspace:test").map((document) => document.canonicalId)).toEqual(["code:valid"]);
    expect(projectSectionDocuments(facts, "workspace:test").map((document) => document.canonicalId)).toEqual(["section:valid"]);
    const before = projectCodeDocuments(facts, "workspace:test")[0]!.sourceHash;
    facts.indexedAt = "2099";
    facts.code[0]!.indexedAt = "2099";
    expect(projectCodeDocuments(facts, "workspace:test")[0]!.sourceHash).toBe(before);
    facts.code[0]!.signature = "createOrder(input: ChangedRequest)";
    expect(projectCodeDocuments(facts, "workspace:test")[0]!.sourceHash).not.toBe(before);
  });

  it("never truncates a Unicode surrogate pair in section text or code titles", () => {
    const facts = factsFixture();
    facts.code[0]!.name = `${"n".repeat(1_023)}😀`;
    facts.sections[0]!.text = `${"s".repeat(MAX_SECTION_TEXT_LENGTH - 1)}😀`;
    const code = projectCodeDocuments(facts, "workspace:test")[0]!;
    const section = projectSectionDocuments(facts, "workspace:test")[0]!;
    expect(code.title).not.toContain("😀");
    expect(section.searchableText).not.toContain("😀");
    for (const value of [code.title, section.searchableText]) {
      expect(Buffer.from(value, "utf8").toString("utf8")).toBe(value);
    }
  });
});

describe("contract, contract spec, and evidence lexical projection", () => {
  it("keeps cross-repository contract sources independent and deduplicates repeated edges", () => {
    const facts = factsFixture();
    const contracts = projectContractDocuments(facts, "workspace:test");
    const api = contracts.filter((document) => document.canonicalId === "contract:api:orders");
    expect(api).toHaveLength(2);
    expect(new Set(api.map((document) => document.repoId))).toEqual(new Set(["repo:a", "repo:b"]));
    expect(new Set(api.map((document) => document.id)).size).toBe(2);
    expect(api.find((document) => document.repoId === "repo:a")).toMatchObject({ active: false, batchId: "batch:evidence-a" });
    for (const document of contracts) expect(parseRenderRef(document.renderRef, "workspace:test").fileId).toBeTruthy();
  });

  it("projects stable HTTP, event, and schema fields but never specJson", () => {
    const specs = projectContractSpecDocuments(factsFixture(), "workspace:test");
    expect(specs.map((document) => document.canonicalId).sort()).toEqual(["spec:event", "spec:http", "spec:schema"]);
    expect(specs.find((document) => document.canonicalId === "spec:http")!.searchableText).toContain("POST /orders express 1");
    expect(specs.find((document) => document.canonicalId === "spec:event")!.searchableText).toContain("orders.created kafka");
    expect(JSON.stringify(specs)).not.toContain("SECRET_SPEC_JSON");
    expect(JSON.stringify(specs)).not.toContain("type\\\":\\\"object");
  });

  it("bounds evidence raw text and rejects inconsistent evidence locations", () => {
    const documents = projectEvidenceDocuments(factsFixture(), "workspace:test");
    expect(documents.some((document) => document.canonicalId === "evidence:mismatch")).toBe(false);
    const evidence = documents.find((document) => document.canonicalId === "evidence:a")!;
    expect(evidence.searchableText).toContain("evidence prefix");
    expect(evidence.searchableText).not.toContain("LEAKED_EVIDENCE_SUFFIX");
    expect(parseRenderRef(evidence.renderRef, "workspace:test")).toMatchObject({ repoId: "repo:a", fileId: "file:a", path: "src/orders/OrderService.ts", startLine: 4 });
  });

  it("never truncates a Unicode surrogate pair in evidence raw text", () => {
    const facts = factsFixture();
    facts.evidence[0]!.raw = `${"r".repeat(MAX_EVIDENCE_RAW_LENGTH - 1)}😀`;
    const evidence = projectEvidenceDocuments(facts, "workspace:test").find((document) => document.canonicalId === "evidence:a")!;
    expect(evidence.searchableText).not.toContain("😀");
    expect(Buffer.from(evidence.searchableText, "utf8").toString("utf8")).toBe(evidence.searchableText);
  });
});
