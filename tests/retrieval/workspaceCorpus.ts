export type WorkspaceCorpusLanguage = "en" | "zh" | "mixed";
export type WorkspaceCorpusCategory = "english" | "chinese" | "mixed" | "identifier" | "path" | "contract" | "schema" | "refusal";

export interface WorkspaceCorpusCase {
  id: string;
  question: string;
  language: WorkspaceCorpusLanguage;
  expectedCanonicalIds: string[];
  answerable: boolean;
  category: WorkspaceCorpusCategory;
  searchableTerms: string[];
}

export const WORKSPACE_CORPUS: WorkspaceCorpusCase[] = [
  { id: "english-order-api", question: "Which HTTP endpoint serves /orders?", language: "en", expectedCanonicalIds: ["contract:api:orders"], answerable: true, category: "english", searchableTerms: ["orders"] },
  { id: "chinese-inventory", question: "库存契约中的稳定标识是什么？", language: "zh", expectedCanonicalIds: ["section:repo:catalog:docs/zh-CN/inventory.md::1"], answerable: true, category: "chinese", searchableTerms: ["库存", "catalog_item_id"] },
  { id: "chinese-inventory-document", question: "哪个文档说明目录服务的稳定标识？", language: "zh", expectedCanonicalIds: ["section:repo:catalog:docs/zh-CN/inventory.md::1"], answerable: true, category: "chinese", searchableTerms: ["目录服务", "catalog_item_id"] },
  { id: "mixed-event", question: "哪个 worker 消费 orders.created 事件？", language: "mixed", expectedCanonicalIds: ["contract:event:orders.created"], answerable: true, category: "mixed", searchableTerms: ["orders.created"] },
  { id: "mixed-schema", question: "CatalogItemSchema 的稳定字段是什么？", language: "mixed", expectedCanonicalIds: ["contract:schema:catalogitemschema"], answerable: true, category: "mixed", searchableTerms: ["CatalogItemSchema"] },
  { id: "identifier", question: "Where is CreateOrderRequest declared?", language: "en", expectedCanonicalIds: ["code:repo:api:src/contracts/orders.ts:interface:CreateOrderRequest:2"], answerable: true, category: "identifier", searchableTerms: ["CreateOrderRequest"] },
  { id: "path", question: "Find api/src/contracts/orders.ts", language: "en", expectedCanonicalIds: ["file:repo:api:src/contracts/orders.ts"], answerable: true, category: "path", searchableTerms: ["src/contracts/orders.ts"] },
  { id: "contract", question: "What event does the worker consume?", language: "en", expectedCanonicalIds: ["contract:event:orders.created"], answerable: true, category: "contract", searchableTerms: ["orders.created"] },
  { id: "schema", question: "Where is CatalogItemSchema defined?", language: "en", expectedCanonicalIds: ["contract:schema:catalogitemschema"], answerable: true, category: "schema", searchableTerms: ["CatalogItemSchema"] },
  { id: "refusal", question: "Which service owns the payment ledger?", language: "en", expectedCanonicalIds: [], answerable: false, category: "refusal", searchableTerms: [] }
];

export const QUALITY_GATE_CORPUS_IDS = Object.freeze([
  "english-order-api",
  "chinese-inventory",
  "chinese-inventory-document",
  "mixed-event",
  "mixed-schema",
  "identifier",
  "path",
  "contract",
  "schema",
  "refusal",
] as const);

const corpusById = new Map(WORKSPACE_CORPUS.map((entry) => [entry.id, entry]));
export const QUALITY_GATE_CORPUS = Object.freeze(QUALITY_GATE_CORPUS_IDS.map((id) => {
  const entry = corpusById.get(id);
  if (!entry) throw new Error(`Missing quality-gate corpus query: ${id}`);
  return entry;
}));
