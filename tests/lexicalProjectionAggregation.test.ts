import { describe, expect, it } from "vitest";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import { LEXICAL_DOCUMENT_KINDS } from "../src/core/retrieval/types.js";
import {
  MAX_LEXICAL_SEARCHABLE_TEXT_LENGTH,
  projectEvidenceDocuments,
  projectLexicalDocuments,
  projectOperationDocuments,
  projectPackageDocuments,
  projectWorkflowDocuments
} from "../src/core/retrieval/projection.js";
import { parseRenderRef } from "../src/core/retrieval/renderRef.js";

function completeFacts(): GraphFactsBatch {
  const repo = { id: "repo:a", name: "Alpha", path: "private", remoteUrl: "", branch: "main", commitSha: "a", language: "typescript", indexedAt: "old" };
  const file = { id: "file:a", repoId: repo.id, path: "src/order.ts", language: "typescript", hash: "file", loc: 30, batchId: "batch:file", active: true };
  const evidence = { id: "evidence:a", repoId: repo.id, fileId: file.id, filePath: file.path, line: 3, raw: "orders.created package @scope/orders", rule: "fixture", confidence: 0.9, batchId: "batch:evidence", active: true };
  return {
    batchId: "batch:fallback",
    indexedAt: "2026",
    repos: [repo],
    parsedFiles: [],
    files: [file],
    code: [{ id: "code:a", repoId: repo.id, fileId: file.id, kind: "function", name: "createOrder", qualifiedName: "orders.createOrder", startLine: 2, endLine: 5, signature: "createOrder()", source: "WHOLE_SOURCE_MUST_NOT_LEAK", hash: "code", summary: "Creates orders" }],
    sections: [{ id: "section:a", repoId: repo.id, fileId: file.id, heading: "Order workflow", level: 1, startLine: 7, endLine: 9, text: "Create and publish an order", hash: "section", links: [], codeBlocks: [] }],
    entities: [{ id: "entity:order", name: "Order", kind: "domain", description: "Customer order" }],
    operations: [{ id: "operation:create-order", verb: "create", entityName: "Order", description: "Create an order" }],
    workflows: [{ id: "workflow:checkout", name: "Checkout", description: "Checkout workflow" }],
    contracts: [{ id: "contract:event:orders", kind: "event", key: "orders.created", name: "Order Created", description: "Order event" }],
    evidence: [evidence],
    contains: [], imports: [], calls: [],
    mentions: [{ fromId: "code:a", entityId: "entity:order", sourceKind: "code", confidence: 0.7 }],
    sectionDescribesRepos: [], sectionDocumentsCode: [], sectionReferencesFile: [],
    repoContracts: [{ repoId: repo.id, contractId: "contract:event:orders", role: "producer", evidenceId: evidence.id, confidence: 0.9 }],
    packageUsages: [{ repoId: repo.id, packageContractId: "contract:package:orders", packageName: "@scope/orders", evidenceId: evidence.id, raw: "@scope/orders", confidence: 0.9 }],
    contractEntities: [{ contractId: "contract:event:orders", entityId: "entity:order", evidenceId: evidence.id, confidence: 0.9 }],
    operationRepos: [{ operationId: "operation:create-order", repoId: repo.id, role: "producer", evidenceId: evidence.id, confidence: 0.9 }],
    workflowOperations: [{ workflowId: "workflow:checkout", operationId: "operation:create-order", step: 1, evidenceId: evidence.id, confidence: 0.9 }],
    repoDependencies: [],
    contractSpecs: [{ id: "spec:event", contractId: "contract:event:orders", specKind: "event", repoId: repo.id, fileId: file.id, evidenceId: evidence.id, canonicalKey: "orders.created", eventTopic: "orders.created", framework: "kafka", specJson: "{\"WHOLE_SPEC_MUST_NOT_LEAK\":true}", confidence: 0.9 }],
    contractSpecEdges: [{ contractId: "contract:event:orders", specId: "spec:event", evidenceId: evidence.id, confidence: 0.9 }],
    semanticRelations: [],
    crossRepo: {} as GraphFactsBatch["crossRepo"]
  };
}

function reverseFactArrays(facts: GraphFactsBatch): void {
  for (const value of Object.values(facts)) if (Array.isArray(value)) value.reverse();
}

describe("complete lexical projection aggregation", () => {
  it("covers every document kind with globally unique, sorted, bounded documents", () => {
    const documents = projectLexicalDocuments(completeFacts(), "workspace:test");
    expect(new Set(documents.map((document) => document.kind))).toEqual(new Set(LEXICAL_DOCUMENT_KINDS));
    expect(new Set(documents.map((document) => document.id)).size).toBe(documents.length);
    expect(documents.map((document) => document.id)).toEqual(documents.map((document) => document.id).sort());
    expect(documents.every((document) => document.searchableText.length <= MAX_LEXICAL_SEARCHABLE_TEXT_LENGTH)).toBe(true);
    expect(JSON.stringify(documents)).not.toContain("WHOLE_SOURCE_MUST_NOT_LEAK");
    expect(JSON.stringify(documents)).not.toContain("WHOLE_SPEC_MUST_NOT_LEAK");
    for (const document of documents) {
      const parsed = parseRenderRef(document.renderRef, "workspace:test");
      expect(parsed.repoId).toBe(document.repoId);
      expect(parsed.canonicalId).toBe(document.canonicalId);
    }
  });

  it("is independent of fact-array order and indexedAt", () => {
    const facts = completeFacts();
    const before = JSON.stringify(projectLexicalDocuments(facts, "workspace:test"));
    reverseFactArrays(facts);
    facts.indexedAt = "2099";
    facts.repos[0]!.indexedAt = "2099";
    facts.files[0]!.indexedAt = "2099";
    facts.evidence[0]!.indexedAt = "2099";
    expect(JSON.stringify(projectLexicalDocuments(facts, "workspace:test"))).toBe(before);
  });

  it("changes source-backed fingerprints when the source file hash changes", () => {
    const facts = completeFacts();
    const before = projectLexicalDocuments(facts, "workspace:test")
      .find((document) => document.kind === "evidence")?.sourceHash;
    facts.files[0]!.hash = "changed-file-hash";
    const after = projectLexicalDocuments(facts, "workspace:test")
      .find((document) => document.kind === "evidence")?.sourceHash;
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("filters invalid duplicates and deduplicates identical source facts independently of order", () => {
    const facts = completeFacts();
    facts.evidence.unshift({ ...facts.evidence[0]!, filePath: "invalid/location.ts" });
    facts.evidence.push({ ...facts.evidence[0]! });
    facts.mentions.push({ ...facts.mentions[0]! });
    facts.operationRepos.push({ ...facts.operationRepos[0]! });
    facts.workflowOperations.push({ ...facts.workflowOperations[0]! });
    facts.packageUsages.push({ ...facts.packageUsages[0]! });
    const before = JSON.stringify(projectLexicalDocuments(facts, "workspace:test"));
    reverseFactArrays(facts);
    expect(JSON.stringify(projectLexicalDocuments(facts, "workspace:test"))).toBe(before);
  });

  it("rejects conflicting duplicate source facts instead of selecting by array order", () => {
    const evidenceFacts = completeFacts();
    evidenceFacts.evidence.push({ ...evidenceFacts.evidence[0]!, raw: "conflicting evidence" });
    expect(() => projectEvidenceDocuments(evidenceFacts, "workspace:test")).toThrow("Conflicting evidence facts");

    const mentionFacts = completeFacts();
    mentionFacts.mentions.push({ ...mentionFacts.mentions[0]!, confidence: 0.1 });
    expect(() => projectLexicalDocuments(mentionFacts, "workspace:test")).toThrow("Lexical document id collision");

    const operationFacts = completeFacts();
    operationFacts.operationRepos.push({ ...operationFacts.operationRepos[0]!, active: false });
    expect(() => projectOperationDocuments(operationFacts, "workspace:test")).toThrow("Lexical document id collision");

    const workflowFacts = completeFacts();
    workflowFacts.workflowOperations.push({ ...workflowFacts.workflowOperations[0]!, active: false });
    expect(() => projectWorkflowDocuments(workflowFacts, "workspace:test")).toThrow("Lexical document id collision");

    const packageFacts = completeFacts();
    packageFacts.packageUsages.push({ ...packageFacts.packageUsages[0]!, raw: "conflicting package source" });
    expect(() => projectPackageDocuments(packageFacts, "workspace:test")).toThrow("Lexical document id collision");
  });

  it("keeps source documents fusion-compatible and workspace identities isolated", () => {
    const facts = completeFacts();
    facts.files.push({ id: "file:b", repoId: "repo:b", path: "src/order.ts", language: "typescript", hash: "b", loc: 3 });
    facts.evidence.push({ ...facts.evidence[0]!, id: "evidence:b", repoId: "repo:b", fileId: "file:b" });
    facts.repoContracts.push({ repoId: "repo:b", contractId: "contract:event:orders", role: "consumer", evidenceId: "evidence:b", confidence: 0.8 });
    const first = projectLexicalDocuments(facts, "workspace:first");
    const contracts = first.filter((document) => document.canonicalId === "contract:event:orders");
    expect(contracts).toHaveLength(2);
    expect(new Set(contracts.map((document) => document.canonicalId))).toEqual(new Set(["contract:event:orders"]));
    expect(new Set(contracts.map((document) => document.id)).size).toBe(2);
    const secondIds = new Set(projectLexicalDocuments(facts, "workspace:second").map((document) => document.id));
    expect(first.every((document) => !secondIds.has(document.id))).toBe(true);
  });

  it("does not invent ownership for orphan semantic nodes", () => {
    const facts = completeFacts();
    facts.entities.push({ id: "entity:orphan", name: "Orphan", kind: "domain", description: "No source" });
    facts.operations.push({ id: "operation:orphan", verb: "lose", entityName: "Orphan", description: "No source" });
    facts.workflows.push({ id: "workflow:orphan", name: "Orphan", description: "No source" });
    const canonicalIds = projectLexicalDocuments(facts, "workspace:test").map((document) => document.canonicalId);
    expect(canonicalIds).not.toContain("entity:orphan");
    expect(canonicalIds).not.toContain("operation:orphan");
    expect(canonicalIds).not.toContain("workflow:orphan");
  });
});
