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
  { id: "mixed-event", question: "哪个 worker 消费 orders.created 事件？", language: "mixed", expectedCanonicalIds: ["contract:event:orders.created"], answerable: true, category: "mixed", searchableTerms: ["orders.created"] },
  { id: "identifier", question: "Where is CreateOrderRequest declared?", language: "en", expectedCanonicalIds: ["code:repo:api:src/contracts/orders.ts:interface:CreateOrderRequest:2"], answerable: true, category: "identifier", searchableTerms: ["CreateOrderRequest"] },
  { id: "path", question: "Find api/src/contracts/orders.ts", language: "en", expectedCanonicalIds: ["file:repo:api:src/contracts/orders.ts"], answerable: true, category: "path", searchableTerms: ["src/contracts/orders.ts"] },
  { id: "contract", question: "What event does the worker consume?", language: "en", expectedCanonicalIds: ["contract:event:orders.created"], answerable: true, category: "contract", searchableTerms: ["orders.created"] },
  { id: "schema", question: "Where is CatalogItemSchema defined?", language: "en", expectedCanonicalIds: ["contract:schema:catalogitemschema"], answerable: true, category: "schema", searchableTerms: ["CatalogItemSchema"] },
  { id: "refusal", question: "Which service owns the payment ledger?", language: "en", expectedCanonicalIds: [], answerable: false, category: "refusal", searchableTerms: [] }
];
