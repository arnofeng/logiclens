import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraphFactsBatch } from "../../src/core/graph-model/facts.js";
import type { LexicalDocument } from "../../src/core/retrieval/types.js";
import { tokenizeLexicalText } from "../../src/core/retrieval/tokenizer.js";
import { parseSourceFile } from "../../src/core/parsing/parserRegistry.js";
import { projectLexicalDocuments } from "../../src/core/retrieval/projection.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "workspace-unified-retrieval");
const FIXTURE_GENERATION = "schema-generation:workspace-spike:fixture";
const FIXTURE_SYSTEM_NAME = "workspace-lexical-spike-fixture";
const sources = [
  ["repo:api", "src/contracts/orders.ts", "typescript", "api"], ["repo:api", "src/routes/orders.go", "go", "api"],
  ["repo:catalog", "docs/zh-CN/inventory.md", "markdown", "catalog"], ["repo:catalog", "src/CatalogItemDTO.ts", "typescript", "catalog"], ["repo:worker", "src/handlers/orderCreated.ts", "typescript", "worker"]
] as const;

const latinStopWords = new Set(["a", "an", "and", "are", "consume", "consumes", "declared", "defined", "does", "find", "for", "http", "is", "of", "on", "or", "the", "to", "what", "where", "which", "who", "with", "worker"]);
const cjkStopTokens = new Set(["什么", "哪个", "哪里", "如何", "服务", "接口", "稳定", "标识", "契约", "事件", "消费", "创建", "订单"]);

/** Test-only symmetric normalization for Unicode prose, identifiers and paths. */
export function lexicalTokens(text: string): string[] {
  return tokenizeLexicalText(text);
}

/** Projects parsed fixture facts into deliberately small, test-only lexical documents. */
export async function workspaceSpikeDocuments(workspaceId: string): Promise<LexicalDocument[]> {
  const parsedFiles = await Promise.all(sources.map(([repoId, relativePath, language, repo]) => parseSourceFile({ repoId, relativePath, language, absolutePath: path.join(root, repo, relativePath) })));
  const repos = ["api", "catalog", "worker"].map((name) => ({ id: `repo:${name}`, name, path: path.join(root, name), remoteUrl: "", branch: "", commitSha: "", language: "", indexedAt: "" }));
  const facts = await buildGraphFactsBatch({
    batchId: "workspace-spike",
    workspaceId,
    generation: FIXTURE_GENERATION,
    systemName: FIXTURE_SYSTEM_NAME,
    indexedAt: "fixture",
    repos,
    parsedFiles,
    semantic: false
  });
  return projectLexicalDocuments(facts, workspaceId)
    .filter((document) => ["file", "code", "section", "contract"].includes(document.kind));
}

export function queryTerms(text: string): string {
  const rawTokens = lexicalTokens(text);
  const identifier = rawTokens.find((token) => !token.startsWith("ident_") && !token.startsWith("cjk_") && /[._/-]/.test(token) && token.length > 3);
  if (identifier) return `ident_${identifier.replace(/[^\p{L}\p{N}]+/gu, "_")}`;
  for (const run of text.normalize("NFKC").match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index++) {
      const token = run.slice(index, index + 2);
      if (!cjkStopTokens.has(token)) return `cjk_${token}`;
    }
  }
  const word = rawTokens.filter((token) => !token.startsWith("cjk_") && !latinStopWords.has(token)).sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
  return word ?? rawTokens[0] ?? text;
}
