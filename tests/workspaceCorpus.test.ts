import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { WORKSPACE_CORPUS } from "./retrieval/workspaceCorpus.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workspace-unified-retrieval");
const sources = [
  ["repo:api", "src/contracts/orders.ts", "typescript", "api"], ["repo:api", "src/routes/orders.go", "go", "api"],
  ["repo:catalog", "docs/zh-CN/inventory.md", "markdown", "catalog"], ["repo:catalog", "src/CatalogItemDTO.ts", "typescript", "catalog"], ["repo:worker", "src/handlers/orderCreated.ts", "typescript", "worker"]
] as const;

describe("workspace retrieval corpus", () => {
  it("covers every category with unique cases", () => {
    expect(new Set(WORKSPACE_CORPUS.map((entry) => entry.id)).size).toBe(WORKSPACE_CORPUS.length);
    expect(new Set(WORKSPACE_CORPUS.map((entry) => entry.category))).toEqual(new Set(["english", "chinese", "mixed", "identifier", "path", "contract", "schema", "refusal"]));
    for (const entry of WORKSPACE_CORPUS) {
      expect(entry.answerable ? entry.expectedCanonicalIds.length > 0 : entry.expectedCanonicalIds).toEqual(entry.answerable ? true : []);
    }
  });

  it("derives every expected identity from parsed and normalized fixture facts", async () => {
    const parsedFiles = await Promise.all(sources.map(([repoId, relativePath, language, repo]) => parseSourceFile({ repoId, relativePath, language, absolutePath: path.join(root, repo, relativePath) })));
    const repos = ["api", "catalog", "worker"].map((name) => ({ id: `repo:${name}`, name, path: path.join(root, name), remoteUrl: "", branch: "", commitSha: "", language: "", indexedAt: "" }));
    const facts = await buildGraphFactsBatch({ batchId: "fixture", repos, parsedFiles, semantic: false });
    expect(facts.contracts).toContainEqual(expect.objectContaining({ kind: "schema" }));
    const evidence = new Map([...facts.files, ...facts.sections, ...facts.code, ...facts.contracts].map((fact) => [fact.id, JSON.stringify(fact)]));
    const missing = WORKSPACE_CORPUS.filter((entry) => entry.answerable).flatMap((entry) => entry.expectedCanonicalIds.filter((id) => !evidence.has(id)));
    expect(missing).toEqual([]);
    for (const entry of WORKSPACE_CORPUS.filter((entry) => entry.answerable)) {
      const targetText = entry.expectedCanonicalIds.map((id) => evidence.get(id)!).join("\n").toLowerCase();
      expect(entry.searchableTerms.every((term) => targetText.includes(term.toLowerCase()))).toBe(true);
    }
  });
});
