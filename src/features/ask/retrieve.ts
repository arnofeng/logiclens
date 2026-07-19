import path from "node:path";
import type { GraphDB } from "../../core/graph-model/db.js";
import { callEdgesAround } from "../../core/graph-model/subgraph.js";
import {
  listCode,
  listDependencies,
  entityTraceRowKey,
  searchCode,
  searchSections,
  traceEntity,
  type CodeSearchRow,
  type ContractTraceRow,
  type DependencyRow,
  type EntityTraceRow,
  type SectionSearchRow
} from "../../core/graph-model/queries.js";
import type { AppConfig } from "../../config/schema.js";
import type { SemanticSearchResult } from "../../core/semantic/semanticIndex.js";
import { deriveWorkspaceId } from "../../core/workspace/identity.js";
import { planQuestion } from "./planner.js";
import type { QueryPlanningContext } from "./planningContext.js";
import { retrieveExactTargets } from "./retrievers/exact.js";
import { retrieveOptionalSemantic } from "./retrievers/semantic.js";

const GENERIC_ENTITY_QUERY_TERMS = new Set([
  "a", "an", "and", "are", "can", "could", "describe", "do", "does", "explain", "for", "how", "in", "is", "it", "me", "of", "please", "show", "tell", "the", "this", "to", "what", "where", "which", "who", "why", "work", "works", "would",
  "workflow", "flow", "dependency", "impact", "operation", "entity", "contract", "repository", "repo",
  "工作流", "流程", "依赖", "影响", "解释", "仓库"
]);

const ENTITY_CONTEXT_TERMS = new Set(["workflow", "flow", "operation", "entity", "contract"]);
const MAX_COMPATIBILITY_ENTITY_TARGETS = 3;

export function compatibilityEntityTargets(plan: ReturnType<typeof planQuestion>): string[] {
  const candidates = [...plan.exactIdentifiers, ...plan.terms];
  const ranked = candidates.map((term, index) => {
    const lowered = term.toLowerCase();
    const next = plan.terms[index - plan.exactIdentifiers.length + 1]?.toLowerCase();
    const structured = index < plan.exactIdentifiers.length;
    const symbolLike = /[_\d]/u.test(term) || /[a-z][A-Z]/u.test(term);
    const pascalCase = /^[A-Z][A-Za-z\d]*$/u.test(term);
    const contextual = next !== undefined && ENTITY_CONTEXT_TERMS.has(next);
    const generic = GENERIC_ENTITY_QUERY_TERMS.has(lowered);
    const score = generic ? 0 : structured ? 1_000 : symbolLike ? 500 : pascalCase ? 400 : contextual ? 300 : 100;
    return { term, lowered, index, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index || left.term.localeCompare(right.term));
  return [...new Map(ranked.map((candidate) => [candidate.lowered, candidate.term])).values()]
    .slice(0, MAX_COMPATIBILITY_ENTITY_TARGETS);
}

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

export async function retrieveForQuestion(db: GraphDB, question: string, options: { cwd?: string; config?: AppConfig; planningContext?: QueryPlanningContext } = {}): Promise<RetrievalResult> {
  const cwd = options.cwd ?? process.cwd();
  const plan = planQuestion(question, options.planningContext);
  const workspaceId = deriveWorkspaceId(options.config?.systemName ?? "default-system");
  const repoRoots = options.config?.repos?.map((repo) => path.resolve(cwd, repo.path)) ?? [];
  const exact = await retrieveExactTargets(db, plan, { workspaceId, repoRoots });
  const rows: CodeSearchRow[] = exact.exact.legacyRows.flatMap((item) => item.kind === "code" ? [item.row] : []);
  const sectionRows: SectionSearchRow[] = exact.exact.legacyRows.flatMap((item) => item.kind === "section" ? [item.row] : []);
  const discoveryQuery = plan.normalizedLexicalQuery;
  if (discoveryQuery) {
    rows.push(...await searchCode(db, discoveryQuery, 10));
    sectionRows.push(...await searchSections(db, discoveryQuery, 10));
  }
  let unique = [...new Map(rows.map((row) => [row.codeId, row])).values()].slice(0, 20);
  const uniqueSections = [...new Map(sectionRows.map((row) => [row.sectionId, row])).values()].slice(0, 20);
  const entityRows = [...exact.entity.legacyRows];
  if (entityRows.length === 0 && plan.enabledRoutes.includes("entity") &&
      (plan.kind === "workflow" || plan.kind === "dependency" || plan.kind === "impact" || plan.kind === "general")) {
    for (const compatibilityTarget of compatibilityEntityTargets(plan)) {
      const rows = await traceEntity(db, compatibilityTarget, plan.budgets.entity.limit);
      if (rows.length === 0) continue;
      entityRows.push(...rows);
      break;
    }
  }
  const uniqueEntities = [...new Map(entityRows
    .sort((left, right) => entityTraceRowKey(left).localeCompare(entityTraceRowKey(right)))
    .map((row) => [entityTraceRowKey(row), row])).values()]
    .slice(0, plan.budgets.entity.limit);
  const dependencies = plan.kind === "workflow" || plan.kind === "dependency" || plan.kind === "impact" ? await listDependencies(db, 50) : [];
  const semanticRoute = await retrieveOptionalSemantic(plan, question, options.config, { cwd });
  const semantic = [...semanticRoute.legacyRows];
  if (unique.length === 0 && (plan.kind === "workflow" || plan.kind === "general")) {
    unique = await listCode(db, 30);
  }
  return {
    questionKind: plan.kind,
    code: unique,
    sections: uniqueSections,
    entities: uniqueEntities,
    contracts: [...exact.contract.legacyRows],
    dependencies,
    semantic,
    edges: await callEdgesAround(db, unique.map((row) => row.codeId), plan.budgets.graph.limit)
  };
}
