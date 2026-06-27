import type { GraphDB } from "../../core/graph-model/db.js";
import { callEdgesAround } from "../../core/graph-model/subgraph.js";
import {
  listCode,
  listDependencies,
  searchCode,
  searchSections,
  traceContract,
  traceEntity,
  type CodeSearchRow,
  type ContractTraceRow,
  type DependencyRow,
  type EntityTraceRow,
  type SectionSearchRow
} from "../../core/graph-model/queries.js";
import type { LogicLensConfig } from "../../config/schema.js";
import { defaultSemanticIndex, type SemanticSearchResult } from "../../core/semantic/semanticIndex.js";
import { resolveEmbeddingProvider } from "../../core/semantic/embeddings.js";
import { planQuestion } from "./planner.js";

/**
 * The structured retrieval result context representing matching information
 * extracted from the workspace graph and semantic databases to answer a query.
 */
export type RetrievalResult = {
  /** The classified intent/category of the question */
  questionKind: string;
  /** Relevant code symbols discovered via keyword search */
  code: CodeSearchRow[];
  /** Relevant markdown/document sections matching keyword query */
  sections: SectionSearchRow[];
  /** Entity trace mappings related to the target terms */
  entities: EntityTraceRow[];
  /** Exact contract traces detected directly from the question */
  contracts: ContractTraceRow[];
  /** Workspace-level dependency rows matching query terms */
  dependencies: DependencyRow[];
  /** Context matches retrieved via vector semantic search */
  semantic: SemanticSearchResult[];
  /** Subgraph function/method call edges around retrieved code symbols */
  edges: Awaited<ReturnType<typeof callEdgesAround>>;
};

function contractTargetsFromQuestion(question: string): { kind: "api"; value: string }[] {
  const targets: { kind: "api"; value: string }[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const normalized = value.replace(/[),.;\uFF0C\u3002\uFF1B\uFF09]+$/, "");
    if (!normalized.startsWith("/")) return;
    const key = `api:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ kind: "api", value: normalized });
  };

  for (const match of question.matchAll(/\bapi:(\/[^\s'"`\uFF0C\u3002\uFF1B,)\uFF09]+)/gi)) push(match[1] ?? "");
  for (const match of question.matchAll(/\/[A-Za-z0-9_{}:$.-]+(?:\/[A-Za-z0-9_{}:$.-]+)*/g)) push(match[0]);
  return targets;
}

export async function retrieveForQuestion(db: GraphDB, question: string, options: { cwd?: string; config?: LogicLensConfig } = {}): Promise<RetrievalResult> {
  const plan = planQuestion(question);
  const rows: CodeSearchRow[] = [];
  const sectionRows: SectionSearchRow[] = [];
  const entityRows: EntityTraceRow[] = [];
  const contractRows: ContractTraceRow[] = [];
  for (const target of contractTargetsFromQuestion(question)) {
    contractRows.push(...await traceContract(db, target.kind, target.value));
  }
  for (const term of plan.terms.slice(0, 5)) {
    if (plan.kind === "workflow" || plan.kind === "dependency" || plan.kind === "impact" || plan.kind === "general") {
      entityRows.push(...await traceEntity(db, term, 20));
    }
    rows.push(...await searchCode(db, term, 10));
    sectionRows.push(...await searchSections(db, term, 10));
  }
  let unique = [...new Map(rows.map((row) => [row.codeId, row])).values()].slice(0, 20);
  const uniqueSections = [...new Map(sectionRows.map((row) => [row.sectionId, row])).values()].slice(0, 20);
  const uniqueEntities = [...new Map(entityRows.map((row) => [`${row.repoName}:${row.sourceKind}:${row.name}:${row.role}`, row])).values()].slice(0, 30);
  const dependencies = plan.kind === "workflow" || plan.kind === "dependency" || plan.kind === "impact" ? await listDependencies(db, 50) : [];
  const providerName = options.config?.embedding.provider ?? "off";
  let embeddingProvider;
  try {
    embeddingProvider = providerName !== "off" ? resolveEmbeddingProvider(providerName) : undefined;
  } catch (error) {
    console.warn(`Semantic search disabled: ${error instanceof Error ? error.message : String(error)}`);
    embeddingProvider = undefined;
  }
  const semantic = await defaultSemanticIndex(options.cwd, options.config).search(question, {
    embeddingProvider,
    providerPolicy: options.config?.embedding ? {
      retry: options.config.embedding.retry,
      budget: options.config.embedding.budget,
      rateLimit: options.config.embedding.rateLimit
    } : undefined,
    limit: 10
  });
  if (unique.length === 0 && (plan.kind === "workflow" || plan.kind === "general")) {
    unique = await listCode(db, 30);
  }
  return { questionKind: plan.kind, code: unique, sections: uniqueSections, entities: uniqueEntities, contracts: contractRows, dependencies, semantic, edges: await callEdgesAround(db, unique.map((row) => row.codeId)) };
}
