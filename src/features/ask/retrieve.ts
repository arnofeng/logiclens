import path from "node:path";
import type { AppConfig } from "../../config/schema.js";
import { GraphDatabaseOperationalError, type GraphDB } from "../../core/graph-model/db.js";
import { listDependencies, type CodeSearchRow, type ContractTraceRow, type DependencyRow, type EntityTraceRow, type SectionSearchRow } from "../../core/graph-model/queries.js";
import type { EdgeRow } from "../../core/graph-model/subgraph.js";
import { WorkspaceLexicalStoreError, type WorkspaceLexicalStore } from "../../core/retrieval/provider.js";
import type { LexicalIndexHealth, LexicalHit } from "../../core/retrieval/types.js";
import type { SemanticSearchResult } from "../../core/semantic/semanticIndex.js";
import { deriveWorkspaceId } from "../../core/workspace/identity.js";
import { reciprocalRankFusion, type FusedRetrievalCandidate } from "./fusion.js";
import { determineRetrievalOutcome, safeLexicalProviderDiagnostic, type RetrievalDiagnostics, type RetrievalOutcome, type RetrievalRouteDiagnostic, type RetrievalStageDiagnostic } from "./diagnostics.js";
import { planQuestion, type QueryPlan, type RetrievalRoute } from "./planner.js";
import type { QueryPlanningContext } from "./planningContext.js";
import { compatibilityEntityTargets, retrieveExactTargets } from "./retrievers/exact.js";
import { retrieveBoundedGraph, type GraphLegacyRow } from "./retrievers/graph.js";
import { retrieveWorkspaceLexical } from "./retrievers/lexical.js";
import { retrieveOptionalSemantic } from "./retrievers/semantic.js";
import { emptyRouteResult, RetrieverOperationalError, type RetrieverRouteResult } from "./retrievers/types.js";

const DEFAULT_SELECTION_LIMIT = 20;
const ROUTES: readonly RetrievalRoute[] = ["exact", "contract", "entity", "lexical", "graph", "semantic"];
export { compatibilityEntityTargets };

export type RetrievalDependencies = Readonly<{
  plan?: typeof planQuestion;
  exact?: typeof retrieveExactTargets;
  lexical?: typeof retrieveWorkspaceLexical;
  graph?: typeof retrieveBoundedGraph;
  semantic?: typeof retrieveOptionalSemantic;
  fusion?: typeof reciprocalRankFusion;
  dependencies?: typeof listDependencies;
  now?: () => number;
}>;

export type RetrieveOptions = Readonly<{
  cwd?: string;
  config?: AppConfig;
  planningContext?: QueryPlanningContext;
  lexicalStore?: WorkspaceLexicalStore;
  lexicalStoreUnavailable?: boolean;
  dependencies?: RetrievalDependencies;
}>;

export type RetrievalResult = Readonly<{
  questionKind: string;
  code: readonly CodeSearchRow[];
  sections: readonly SectionSearchRow[];
  entities: readonly EntityTraceRow[];
  contracts: readonly ContractTraceRow[];
  dependencies: readonly DependencyRow[];
  semantic: readonly SemanticSearchResult[];
  edges: readonly EdgeRow[];
  fusedCandidates: readonly FusedRetrievalCandidate[];
  selectedCandidates: readonly FusedRetrievalCandidate[];
  diagnostics: RetrievalDiagnostics;
  outcome: RetrievalOutcome;
}>;

function duration(start: number, end: number): number {
  return Math.max(0, end - start);
}

function completed(durationMs: number): RetrievalStageDiagnostic {
  return Object.freeze({ status: "completed", durationMs: Math.max(0, durationMs) });
}

async function isolateOperational<T>(operation: () => Promise<T>, fallback: (error: RetrieverOperationalError) => T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof RetrieverOperationalError)) throw error;
    return fallback(error);
  }
}

function stageForRoute(result: RetrieverRouteResult<unknown>, durationMs: number): RetrievalStageDiagnostic {
  const status = result.status === "succeeded"
    ? result.executed ? "completed" : "skipped"
    : result.status === "disabled" ? "skipped" : result.status;
  return Object.freeze({ status, durationMs: Math.max(0, durationMs) });
}

function stageForRoutes(results: readonly RetrieverRouteResult<unknown>[], durationMs: number): RetrievalStageDiagnostic {
  if (results.some(({ status }) => status === "failed")) return Object.freeze({ status: "failed", durationMs: Math.max(0, durationMs) });
  if (results.some(({ status }) => status === "unhealthy")) return Object.freeze({ status: "unhealthy", durationMs: Math.max(0, durationMs) });
  if (results.some(({ status }) => status === "unavailable")) return Object.freeze({ status: "unavailable", durationMs: Math.max(0, durationMs) });
  if (results.some(({ executed }) => executed)) return completed(durationMs);
  return Object.freeze({ status: "skipped", durationMs: Math.max(0, durationMs) });
}

function uniqueLimited<T>(rows: readonly T[], key: (row: T) => string, limit: number): readonly T[] {
  return Object.freeze([...new Map(rows.map((row) => [key(row), row])).values()].slice(0, limit));
}

function routeDiagnostic(result: RetrieverRouteResult<unknown>) {
  return Object.freeze({
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    executed: result.executed,
    queryCount: result.queryCount
  });
}

export async function retrieveForQuestion(db: GraphDB, question: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
  const deps = options.dependencies ?? {};
  const now = deps.now ?? (() => performance.now());
  const totalStart = now();
  const cwd = options.cwd ?? process.cwd();
  const workspaceId = deriveWorkspaceId(options.config?.systemName ?? "default-system");
  const repoRoots = options.config?.repos?.map((repo) => path.resolve(cwd, repo.path)) ?? [];

  const planningStart = now();
  const plan: QueryPlan = (deps.plan ?? planQuestion)(question, options.planningContext);
  const planningTiming = completed(duration(planningStart, now()));

  const exactStart = now();
  const exact = await (deps.exact ?? retrieveExactTargets)(db, plan, { workspaceId, repoRoots });
  const exactDuration = duration(exactStart, now());

  let lexicalHealth: LexicalIndexHealth | undefined;
  let lexical: RetrieverRouteResult<LexicalHit>;
  const lexicalStart = now();
  if (!plan.enabledRoutes.includes("lexical")) {
    lexical = emptyRouteResult("lexical", "disabled", "route-disabled");
  } else if (!plan.normalizedLexicalQuery.trim()) {
    lexical = emptyRouteResult("lexical", "disabled", "query-empty");
  } else if (options.lexicalStoreUnavailable) {
    lexical = emptyRouteResult("lexical", "unavailable", "provider-unavailable");
  } else if (options.lexicalStore) {
    try {
      lexicalHealth = await options.lexicalStore.health(workspaceId);
      lexical = await (deps.lexical ?? retrieveWorkspaceLexical)(options.lexicalStore, plan, { workspaceId, repoRoots, health: lexicalHealth });
    } catch (error) {
      if (error instanceof WorkspaceLexicalStoreError) {
        lexical = emptyRouteResult("lexical", "failed", "health-check-failed");
      } else {
        throw error;
      }
    }
  } else {
    lexical = await (deps.lexical ?? retrieveWorkspaceLexical)(options.lexicalStore, plan, { workspaceId, repoRoots });
  }
  const lexicalDuration = duration(lexicalStart, now());

  const graphStart = now();
  const graph = await isolateOperational(
    () => (deps.graph ?? retrieveBoundedGraph)(db, plan, [
      ...exact.exact.candidates, ...exact.contract.candidates, ...exact.entity.candidates, ...lexical.candidates
    ], { workspaceId }),
    (error) => emptyRouteResult<GraphLegacyRow>("graph", "failed", error.reason, { executed: error.attemptedQueryCount > 0, queryCount: error.attemptedQueryCount })
  );
  const graphDuration = duration(graphStart, now());

  const semanticStart = now();
  const semantic = await isolateOperational(
    () => (deps.semantic ?? retrieveOptionalSemantic)(plan, question, options.config, { cwd }),
    (error) => emptyRouteResult<SemanticSearchResult>("semantic", "failed", error.reason, { executed: error.attemptedQueryCount > 0, queryCount: error.attemptedQueryCount })
  );
  const semanticDuration = duration(semanticStart, now());

  const fusionStart = now();
  const fusedCandidates = Object.freeze((deps.fusion ?? reciprocalRankFusion)([
    ...exact.exact.candidates, ...exact.contract.candidates, ...exact.entity.candidates,
    ...lexical.candidates, ...graph.candidates, ...semantic.candidates
  ]));
  const fusionTiming = completed(duration(fusionStart, now()));

  const selectionStart = now();
  const selectedCandidates = Object.freeze(fusedCandidates.slice(0, DEFAULT_SELECTION_LIMIT));
  const selectionTiming = completed(duration(selectionStart, now()));

  let compatibilityDependencies: readonly DependencyRow[] = [];
  let dependencyQueryCount = 0;
  let dependencyDiagnostic: RetrievalRouteDiagnostic = Object.freeze({ status: "disabled", reason: "not-required", executed: false, queryCount: 0 });
  if (plan.kind === "workflow" || plan.kind === "dependency" || plan.kind === "impact") {
    dependencyQueryCount = 1;
    try {
      compatibilityDependencies = await (deps.dependencies ?? listDependencies)(db, 50);
      dependencyDiagnostic = Object.freeze({ status: "succeeded" as const, executed: true, queryCount: dependencyQueryCount });
    } catch (error) {
      if (error instanceof RetrieverOperationalError) {
        dependencyQueryCount = error.attemptedQueryCount;
        dependencyDiagnostic = Object.freeze({ status: "failed" as const, reason: error.reason, executed: dependencyQueryCount > 0, queryCount: dependencyQueryCount });
      } else if (error instanceof GraphDatabaseOperationalError) {
        dependencyDiagnostic = Object.freeze({ status: "failed" as const, reason: "query-failed", executed: true, queryCount: dependencyQueryCount });
      } else {
        throw error;
      }
    }
  }

  const code = uniqueLimited([
    ...exact.exact.legacyRows.flatMap((item) => item.kind === "code" ? [item.row] : []),
    ...graph.legacyRows.flatMap((item) => item.kind === "implementation" ? [item.row] : [])
  ], (row) => row.codeId, 20);
  const sections = uniqueLimited([
    ...exact.exact.legacyRows.flatMap((item) => item.kind === "section" ? [item.row] : []),
    ...graph.legacyRows.flatMap((item) => item.kind === "section" ? [item.row] : [])
  ], (row) => row.sectionId, 20);
  const edges = Object.freeze(graph.legacyRows.flatMap((item) => item.kind === "edge" ? [item.row] : []));
  const routeResults: Readonly<Record<RetrievalRoute, RetrieverRouteResult<unknown>>> = {
    exact: exact.exact, contract: exact.contract, entity: exact.entity, lexical, graph, semantic
  };
  const byRoute = Object.freeze(Object.fromEntries(ROUTES.map((route) => [route, routeResults[route].queryCount])) as Record<RetrievalRoute, number>);
  const totalQueries = Object.values(byRoute).reduce((sum, count) => sum + count, 0) + dependencyQueryCount;
  const outcome = determineRetrievalOutcome(selectedCandidates.length, Object.values(routeResults), [dependencyDiagnostic.status]);
  const totalTiming = completed(duration(totalStart, now()));
  const semanticProvider = options.config?.embedding?.provider;
  const diagnostics: RetrievalDiagnostics = Object.freeze({
    routes: Object.freeze(Object.fromEntries(ROUTES.map((route) => [route, routeDiagnostic(routeResults[route])])) as Record<RetrievalRoute, ReturnType<typeof routeDiagnostic>>),
    timings: Object.freeze({
      planning: planningTiming,
      exactContractEntity: stageForRoutes([exact.exact, exact.contract, exact.entity], exactDuration),
      lexical: stageForRoute(lexical, lexicalDuration),
      graphExpansion: stageForRoute(graph, graphDuration),
      semantic: stageForRoute(semantic, semanticDuration),
      fusion: fusionTiming,
      selection: selectionTiming,
      sourceLoading: Object.freeze({ status: "not_run", durationMs: 0 }),
      total: totalTiming
    }),
    queries: Object.freeze({ total: totalQueries, byRoute, dependencies: dependencyQueryCount }),
    compatibility: Object.freeze({ dependencies: dependencyDiagnostic }),
    providers: Object.freeze({
      lexical: safeLexicalProviderDiagnostic(lexical, lexicalHealth),
      semantic: Object.freeze({
        status: semantic.status,
        ...(semanticProvider && semanticProvider !== "off" ? { provider: semanticProvider } : {}),
        ...(semantic.providerMetadata ?? {})
      })
    })
  });

  return Object.freeze({
    questionKind: plan.kind,
    code,
    sections,
    entities: Object.freeze([...exact.entity.legacyRows]),
    contracts: Object.freeze([...exact.contract.legacyRows]),
    dependencies: Object.freeze([...compatibilityDependencies]),
    semantic: Object.freeze([...semantic.legacyRows]),
    edges,
    fusedCandidates,
    selectedCandidates,
    diagnostics,
    outcome
  });
}
