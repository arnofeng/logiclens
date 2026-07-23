import { lexQuery } from "./queryLexer.js";
import { classifyQueryTargets, type ContractTarget } from "./queryTargets.js";
import { DEFAULT_QUERY_PLANNING_CONTEXT, type QueryPlanningContext } from "./planningContext.js";

export type QuestionKind = "impact" | "workflow" | "symbol" | "dependency" | "debugging" | "general";
export type RetrievalRoute = "exact" | "contract" | "entity" | "lexical" | "graph" | "semantic";
export type RouteBudget = { limit: number };
export type { ContractTarget } from "./queryTargets.js";

export type QueryPlan = {
  kind: QuestionKind;
  terms: string[];
  exactIdentifiers: string[];
  paths: string[];
  scopedPaths?: RepoScopedPathTarget[];
  contractTargets: ContractTarget[];
  normalizedLexicalQuery: string;
  enabledRoutes: RetrievalRoute[];
  budgets: Record<RetrievalRoute, RouteBudget>;
};

export type RepoScopedPathTarget = Readonly<{ repoId: string; path: string; raw: string }>;

export const MAX_LEXICAL_QUERY_CODE_POINTS = 512;

const ROUTE_BUDGETS: Record<RetrievalRoute, RouteBudget> = {
  exact: { limit: 20 },
  contract: { limit: 20 },
  entity: { limit: 30 },
  lexical: { limit: 20 },
  graph: { limit: 40 },
  semantic: { limit: 10 }
};

function questionIntentText(question: string, targets: readonly ReturnType<typeof classifyQueryTargets>[number][]): string {
  const masked = question.split("");
  for (const target of targets) {
    if (target.type === "ignored") continue;
    for (let index = target.span.start; index < target.span.end; index += 1) masked[index] = " ";
  }
  return masked.join("");
}

function questionKind(question: string, targets: readonly ReturnType<typeof classifyQueryTargets>[number][]): QuestionKind {
  const lowered = questionIntentText(question, targets).toLowerCase();
  return /impact|influence|who[\s_]*uses|\bref\b|影响|引用/.test(lowered)
    ? "impact"
    : /\b(?:flow|workflow|chain|create|creates|created|creating|creation)\b|流程|工作流|调用链|创建/.test(lowered)
      ? "workflow"
      : /dependency|depend|import|依赖|导入/.test(lowered)
        ? "dependency"
        : /error|bug|debug|exception|错误|异常|调试/.test(lowered)
          ? "debugging"
          : /function|class|symbol|method|函数|类|符号|方法/.test(lowered)
            ? "symbol"
            : "general";
}

function stableUnique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function stableUniqueContracts(targets: readonly ContractTarget[]): ContractTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}:${target.method ?? ""}:${target.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scopedPaths(paths: readonly string[], context: QueryPlanningContext): RepoScopedPathTarget[] {
  return paths.flatMap((raw) => {
    const normalized = raw.replace(/\\/gu, "/");
    const separator = normalized.indexOf("/");
    if (separator <= 0) return [];
    const prefix = normalized.slice(0, separator);
    const relativePath = normalized.slice(separator + 1);
    const repo = (context.repos ?? []).find(({ id, name }) => prefix === name || prefix === id || `repo:${prefix}` === id);
    return repo && relativePath ? [{ repoId: repo.id, path: relativePath, raw }] : [];
  });
}

export function normalizeLexicalQuery(question: string): string {
  const normalized = question.normalize("NFC").replace(/\s+/gu, " ").trim();
  return [...normalized].slice(0, MAX_LEXICAL_QUERY_CODE_POINTS).join("");
}

export function contractTargetsFromQuestion(
  question: string,
  context: QueryPlanningContext = DEFAULT_QUERY_PLANNING_CONTEXT
): ContractTarget[] {
  return stableUniqueContracts(
    classifyQueryTargets(lexQuery(question), context)
      .filter((target) => target.type === "contract")
      .map(({ kind, value, method }) => ({ kind, value, ...(method ? { method } : {}) }))
  );
}

export function planQuestion(
  question: string,
  context: QueryPlanningContext = DEFAULT_QUERY_PLANNING_CONTEXT
): QueryPlan {
  const normalizedLexicalQuery = normalizeLexicalQuery(question);
  const targets = classifyQueryTargets(lexQuery(question), context);
  const exactIdentifiers = stableUnique(targets.filter((target) => target.type === "identifier").map((target) => target.value));
  const paths = stableUnique(targets.filter((target) => target.type === "path").map((target) => target.value));
  const contractTargets = stableUniqueContracts(
    targets.filter((target) => target.type === "contract").map(({ kind, value, method }) => ({ kind, value, ...(method ? { method } : {}) }))
  );
  const terms = normalizedLexicalQuery
    ? [...normalizedLexicalQuery.matchAll(/[A-Za-z_][A-Za-z0-9_]+|[\u4e00-\u9fa5]{2,}/g)].map((match) => match[0])
    : [];
  const strictApiTargets = contractTargets.length > 0 && contractTargets.every(({ kind }) => kind === "api");
  const enabledRoutes: RetrievalRoute[] = [];
  if (exactIdentifiers.length > 0 || paths.length > 0) enabledRoutes.push("exact");
  if (strictApiTargets) {
    enabledRoutes.push("contract", "graph");
  } else if (normalizedLexicalQuery) {
    if (contractTargets.length > 0) enabledRoutes.push("contract");
    enabledRoutes.push("entity", "lexical", "graph", "semantic");
  }

  return {
    kind: questionKind(question, targets),
    terms: terms.length > 0 ? terms : normalizedLexicalQuery ? [normalizedLexicalQuery] : [],
    exactIdentifiers,
    paths,
    scopedPaths: scopedPaths(paths, context),
    contractTargets,
    normalizedLexicalQuery,
    enabledRoutes,
    budgets: {
      exact: { ...ROUTE_BUDGETS.exact },
      contract: { ...ROUTE_BUDGETS.contract },
      entity: { ...ROUTE_BUDGETS.entity },
      lexical: { ...ROUTE_BUDGETS.lexical },
      graph: { ...ROUTE_BUDGETS.graph },
      semantic: { ...ROUTE_BUDGETS.semantic }
    }
  };
}
