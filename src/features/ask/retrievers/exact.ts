import path from "node:path";
import type { GraphDB } from "../../../core/graph-model/db.js";
import {
  findExactCode,
  findSectionsAtExactPaths,
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
import { emptyRouteResult, successfulRouteResult, type RetrieverRouteResult } from "./types.js";

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
  const paths = normalizeExactPaths(plan.paths, options.repoRoots);

  let exact: RetrieverRouteResult<ExactLegacyRow>;
  if (!plan.enabledRoutes.includes("exact")) {
    exact = emptyRouteResult("exact", "disabled", "route-disabled");
  } else if (identifiers.length === 0 && paths.length === 0) {
    exact = emptyRouteResult("exact", "disabled", "no-structured-targets");
  } else {
    const limit = Math.max(0, plan.budgets.exact.limit);
    const codeRows = limit > 0 ? await deps.findExactCode(db, { identifiers, paths, limit }) : [];
    const remaining = Math.max(0, limit - codeRows.length);
    const queriedSections = remaining > 0 && paths.length > 0;
    const sectionRows = queriedSections
      ? await deps.findSectionsAtExactPaths(db, paths, remaining)
      : [];
    const rows = uniqueRows<CodeSearchRow | SectionSearchRow>([...codeRows, ...sectionRows], rowKey, limit);
    const legacyRows: ExactLegacyRow[] = rows.map((row) => "codeId" in row
      ? { kind: "code", row }
      : { kind: "section", row });
    const candidates = [
      ...candidatesFromCodeRows(rows.filter((row): row is CodeSearchRow => "codeId" in row), options.workspaceId),
      ...candidatesFromSectionRows(rows.filter((row): row is SectionSearchRow => "sectionId" in row), options.workspaceId)
    ];
    exact = successfulRouteResult("exact", candidates, legacyRows, (limit > 0 ? 1 : 0) + (queriedSections ? 1 : 0));
  }

  let contract: RetrieverRouteResult<ContractTraceRow>;
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
      const result = await deps.traceContract(db, target.kind, target.value, target.method, limit - rows.length);
      queryCount += result.queryCount;
      rows.push(...result.rows);
    }
    const unique = uniqueRows(rows, (row) => `${row.contractId}:${row.repoName}:${row.role}:${row.filePath}:${row.line}`, limit);
    contract = successfulRouteResult("contract", candidatesFromContractRows(unique, options.workspaceId), unique, queryCount);
  }

  let entity: RetrieverRouteResult<EntityTraceRow>;
  if (!plan.enabledRoutes.includes("entity")) {
    entity = emptyRouteResult("entity", "disabled", "route-disabled");
  } else if (identifiers.length === 0) {
    entity = emptyRouteResult("entity", "disabled", "no-structured-targets");
  } else {
    const limit = Math.max(0, plan.budgets.entity.limit);
    const result = limit > 0 ? await deps.traceEntitiesExact(db, identifiers, limit) : { rows: [], queryCount: 0 };
    const rows = result.rows;
    const unique = uniqueRows(rows, entityTraceRowKey, limit);
    entity = successfulRouteResult("entity", candidatesFromEntityRows(unique, options.workspaceId), unique, result.queryCount);
  }

  return Object.freeze({ exact, contract, entity });
}
