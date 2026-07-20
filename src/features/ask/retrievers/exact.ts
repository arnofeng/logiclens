import path from "node:path";
import { GraphDatabaseOperationalError, type GraphDB } from "../../../core/graph-model/db.js";
import {
  findExactCode,
  findSectionsAtExactPaths,
  CountedGraphQueryError,
  entityTraceRowKey,
  traceContractWithQueryCount,
  traceEntitiesExactWithQueryCount,
  type CodeSearchRow,
  type ContractTraceRow,
  type EntityTraceRow,
  type SectionSearchRow
} from "../../../core/graph-model/queries.js";
import {
  candidatesFromCodeRows,
  candidatesFromContractRows,
  candidatesFromEntityRows,
  candidatesFromSectionRows
} from "../candidates.js";
import type { QueryPlan } from "../planner.js";
import { emptyRouteResult, failedRouteResult, RetrieverOperationalError, successfulRouteResult, type RetrieverRouteResult } from "./types.js";

export type ExactLegacyRow =
  | Readonly<{ kind: "code"; row: CodeSearchRow }>
  | Readonly<{ kind: "section"; row: SectionSearchRow }>;

export type ExactRetrievalResult = Readonly<{
  exact: RetrieverRouteResult<ExactLegacyRow>;
  contract: RetrieverRouteResult<ContractTraceRow>;
  entity: RetrieverRouteResult<EntityTraceRow>;
}>;

export type ExactRetrieverDependencies = Readonly<{
  findExactCode?: typeof findExactCode;
  findSectionsAtExactPaths?: typeof findSectionsAtExactPaths;
  traceContract?: typeof traceContractWithQueryCount;
  traceEntitiesExact?: typeof traceEntitiesExactWithQueryCount;
}>;

const GENERIC_ENTITY_TERMS = new Set([
  "a", "an", "and", "are", "describe", "do", "does", "explain", "for", "how", "is", "of", "please", "show", "the", "to", "what", "where", "which", "who", "why", "work", "works",
  "workflow", "flow", "dependency", "impact", "operation", "entity", "contract", "repository", "repo",
  "工作流", "流程", "依赖", "影响", "解释", "仓库"
]);

export function compatibilityEntityTargets(plan: QueryPlan): string[] {
  const candidates = [...plan.exactIdentifiers, ...plan.terms];
  return [...new Map(candidates.map((term, index) => {
    const lowered = term.toLowerCase();
    const structured = index < plan.exactIdentifiers.length;
    const symbolLike = /[_\d]/u.test(term) || /[a-z][A-Z]/u.test(term) || /^[A-Z][A-Za-z\d]*$/u.test(term);
    const score = GENERIC_ENTITY_TERMS.has(lowered) ? 0 : structured ? 3 : symbolLike ? 2 : 1;
    return { term, lowered, index, score };
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index || left.term.localeCompare(right.term))
    .map((candidate) => [candidate.lowered, candidate.term] as const)).values()].slice(0, 3);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize("NFC").trim()).filter(Boolean))].sort();
}

function normalizedRelativePath(value: string): string | undefined {
  const segments = value.replace(/\\/gu, "/").split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return undefined;
  return segments.join("/");
}

function absolutePathRelativeToRoots(value: string, roots: readonly string[]): string[] {
  const pathApi = path.win32.isAbsolute(value) ? path.win32 : path.posix;
  const relativePaths: string[] = [];
  for (const root of roots) {
    if (!pathApi.isAbsolute(root)) continue;
    const relative = pathApi.relative(pathApi.normalize(root), pathApi.normalize(value));
    if (!relative || pathApi.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${pathApi.sep}`)) continue;
    const normalized = normalizedRelativePath(relative);
    if (normalized) relativePaths.push(normalized);
  }
  return [...new Set(relativePaths)].sort();
}

export function normalizeExactPaths(values: readonly string[], repoRoots: readonly string[] = []): string[] {
  const normalized = values.flatMap((value) => {
    const trimmed = value.normalize("NFC").trim();
    if (!trimmed) return [];
    if (path.win32.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed)) {
      return absolutePathRelativeToRoots(trimmed, repoRoots);
    }
    const relative = normalizedRelativePath(trimmed);
    return relative ? [relative] : [];
  });
  return [...new Set(normalized)].sort();
}

function rowKey(row: CodeSearchRow | SectionSearchRow): string {
  return "codeId" in row ? `code:${row.codeId}` : `section:${row.sectionId}`;
}

function uniqueRows<T>(rows: readonly T[], key: (row: T) => string, limit: number): T[] {
  return [...new Map([...rows].sort((left, right) => key(left).localeCompare(key(right))).map((row) => [key(row), row])).values()].slice(0, limit);
}

export async function retrieveExactTargets(
  db: GraphDB,
  plan: QueryPlan,
  options: { workspaceId: string; repoRoots?: readonly string[]; dependencies?: ExactRetrieverDependencies }
): Promise<ExactRetrievalResult> {
  const deps = {
    findExactCode: options.dependencies?.findExactCode ?? findExactCode,
    findSectionsAtExactPaths: options.dependencies?.findSectionsAtExactPaths ?? findSectionsAtExactPaths,
    traceContract: options.dependencies?.traceContract ?? traceContractWithQueryCount,
    traceEntitiesExact: options.dependencies?.traceEntitiesExact ?? traceEntitiesExactWithQueryCount
  };
  const identifiers = uniqueSorted(plan.exactIdentifiers);
  const scopedRawPaths = new Set((plan.scopedPaths ?? []).map(({ raw }) => raw));
  const paths = normalizeExactPaths(plan.paths.filter((value) => !scopedRawPaths.has(value)), options.repoRoots);
  const scopedPaths = (plan.scopedPaths ?? []).flatMap((target) =>
    normalizeExactPaths([target.path]).map((relativePath) => ({ repoId: target.repoId, path: relativePath }))
  );

  let exact: RetrieverRouteResult<ExactLegacyRow> | undefined;
  if (!plan.enabledRoutes.includes("exact")) {
    exact = emptyRouteResult("exact", "disabled", "route-disabled");
  } else if (identifiers.length === 0 && paths.length === 0 && scopedPaths.length === 0) {
    exact = emptyRouteResult("exact", "disabled", "no-structured-targets");
  } else {
    const limit = Math.max(0, plan.budgets.exact.limit);
    let queryCount = 0;
    let codeRows: CodeSearchRow[] = [];
    let sectionRows: SectionSearchRow[] = [];
    try {
      if (limit > 0) {
        queryCount += 1;
        codeRows = await deps.findExactCode(db, { identifiers, paths, ...(scopedPaths.length > 0 ? { scopedPaths } : {}), limit });
      }
      const remaining = Math.max(0, limit - codeRows.length);
      if (remaining > 0 && (paths.length > 0 || scopedPaths.length > 0)) {
        queryCount += 1;
        sectionRows = await deps.findSectionsAtExactPaths(db, paths, remaining, scopedPaths);
      }
    } catch (error) {
      if (error instanceof RetrieverOperationalError) {
        exact = failedRouteResult("exact", error.attemptedQueryCount, error.reason);
      } else if (error instanceof GraphDatabaseOperationalError) {
        exact = failedRouteResult("exact", queryCount, "query-failed");
      } else {
        throw error;
      }
    }
    if (!exact) {
      const rows = uniqueRows<CodeSearchRow | SectionSearchRow>([...codeRows, ...sectionRows], rowKey, limit);
      const legacyRows: ExactLegacyRow[] = rows.map((row) => "codeId" in row
        ? { kind: "code", row }
        : { kind: "section", row });
      const candidates = [
        ...candidatesFromCodeRows(rows.filter((row): row is CodeSearchRow => "codeId" in row), options.workspaceId),
        ...candidatesFromSectionRows(rows.filter((row): row is SectionSearchRow => "sectionId" in row), options.workspaceId)
      ];
      exact = successfulRouteResult("exact", candidates, legacyRows, queryCount);
    }
  }

  let contract: RetrieverRouteResult<ContractTraceRow> | undefined;
  const contractTargets = [...new Map(plan.contractTargets.map((target) => [
    `${target.kind}:${target.method ?? ""}:${target.value}`,
    target
  ])).values()];
  if (!plan.enabledRoutes.includes("contract")) {
    contract = emptyRouteResult("contract", "disabled", "route-disabled");
  } else if (contractTargets.length === 0) {
    contract = emptyRouteResult("contract", "disabled", "no-structured-targets");
  } else {
    const limit = Math.max(0, plan.budgets.contract.limit);
    const rows: ContractTraceRow[] = [];
    let queryCount = 0;
    for (const target of contractTargets) {
      if (rows.length >= limit) break;
      const previousQueryCount = queryCount;
      try {
        queryCount += 1;
        const result = await deps.traceContract(db, target.kind, target.value, target.method, limit - rows.length);
        queryCount += Math.max(0, result.queryCount - 1);
        rows.push(...result.rows);
      } catch (error) {
        if (error instanceof CountedGraphQueryError) {
          queryCount = previousQueryCount + error.attemptedQueryCount;
          contract = failedRouteResult("contract", queryCount, "query-failed");
        } else if (error instanceof RetrieverOperationalError) {
          queryCount = previousQueryCount + error.attemptedQueryCount;
          contract = failedRouteResult("contract", queryCount, error.reason);
        } else if (error instanceof GraphDatabaseOperationalError) {
          contract = failedRouteResult("contract", queryCount, "query-failed");
        } else {
          throw error;
        }
        break;
      }
    }
    if (!contract) {
      const unique = uniqueRows(rows, (row) => `${row.contractId}:${row.repoName}:${row.role}:${row.filePath}:${row.line}`, limit);
      contract = successfulRouteResult("contract", candidatesFromContractRows(unique, options.workspaceId), unique, queryCount);
    }
  }

  let entity: RetrieverRouteResult<EntityTraceRow> | undefined;
  const entityTargets = identifiers.length > 0
    ? identifiers
    : plan.contractTargets.length === 0 && (plan.kind === "workflow" || plan.kind === "dependency" || plan.kind === "impact" || plan.kind === "general")
      ? compatibilityEntityTargets(plan)
      : [];
  if (!plan.enabledRoutes.includes("entity")) {
    entity = emptyRouteResult("entity", "disabled", "route-disabled");
  } else if (entityTargets.length === 0) {
    entity = emptyRouteResult("entity", "disabled", "no-structured-targets");
  } else {
    const limit = Math.max(0, plan.budgets.entity.limit);
    let result: Awaited<ReturnType<typeof traceEntitiesExactWithQueryCount>> = { rows: [], queryCount: 0 };
    try {
      if (limit > 0) result = await deps.traceEntitiesExact(db, entityTargets, limit);
    } catch (error) {
      if (error instanceof CountedGraphQueryError) {
        entity = failedRouteResult("entity", error.attemptedQueryCount, "query-failed");
      } else if (error instanceof RetrieverOperationalError) {
        entity = failedRouteResult("entity", error.attemptedQueryCount, error.reason);
      } else if (error instanceof GraphDatabaseOperationalError) {
        entity = failedRouteResult("entity", limit > 0 ? 1 : 0, "query-failed");
      } else {
        throw error;
      }
    }
    if (!entity) {
      const unique = uniqueRows(result.rows, entityTraceRowKey, limit);
      entity = successfulRouteResult("entity", candidatesFromEntityRows(unique, options.workspaceId), unique, result.queryCount);
    }
  }

  return Object.freeze({ exact, contract, entity });
}
