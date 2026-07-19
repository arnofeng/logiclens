import { GraphDatabaseOperationalError, type GraphDB } from "../../../core/graph-model/db.js";
import { findContractSourceSymbols, sectionsDocumentingCode, type CodeSearchRow, type SectionSearchRow } from "../../../core/graph-model/queries.js";
import { callEdgesAround, type EdgeRow } from "../../../core/graph-model/subgraph.js";
import {
  candidatesFromGraphEdges,
  candidatesFromGraphCodeRows,
  candidatesFromSectionRows,
  createRetrievalCandidate,
  stableCandidateKey,
  strongestCandidateConfidence,
  type RetrievalCandidate
} from "../candidates.js";
import type { QueryPlan } from "../planner.js";
import { emptyRouteResult, RetrieverOperationalError, successfulRouteResult, type RetrieverRouteResult } from "./types.js";

export type GraphLegacyRow =
  | Readonly<{ kind: "implementation"; row: CodeSearchRow }>
  | Readonly<{ kind: "section"; row: SectionSearchRow }>
  | Readonly<{ kind: "edge"; row: EdgeRow }>;

export type GraphRetrieverDependencies = Readonly<{
  callEdgesAround?: typeof callEdgesAround;
  findContractSourceSymbols?: typeof findContractSourceSymbols;
  sectionsDocumentingCode?: typeof sectionsDocumentingCode;
}>;

const STRONG_LEXICAL_MATCH_REASONS = new Set(["exact-identifier", "exact-path", "exact-contract", "canonical-id"]);

function strongLexicalSeed(candidate: RetrievalCandidate): boolean {
  return candidate.routes.some((membership) => membership.route === "lexical") &&
    candidate.matchReasons.some((reason) => STRONG_LEXICAL_MATCH_REASONS.has(reason)) &&
    ((candidate.kind === "code" && candidate.canonicalId.startsWith("code:")) ||
      (candidate.kind === "contract" && candidate.canonicalId.startsWith("contract:")));
}

function eligible(candidate: RetrievalCandidate): boolean {
  return candidate.confidence === "exact" ||
    candidate.confidence === "resolved-contract" ||
    candidate.confidence === "corroborated" ||
    strongLexicalSeed(candidate);
}

const CONFIDENCE_STRENGTH: Record<RetrievalCandidate["confidence"], number> = {
  exact: 4,
  "resolved-contract": 3,
  corroborated: 2,
  discovery: 1
};

const ROUTE_STRENGTH = new Map([
  ["exact", 6], ["contract", 5], ["entity", 4], ["lexical", 3], ["graph", 2], ["semantic", 1]
]);

function strongestRoute(candidate: RetrievalCandidate): { strength: number; rank: number } {
  return candidate.routes.reduce((best, route) => {
    const current = { strength: ROUTE_STRENGTH.get(route.route) ?? 0, rank: route.rank };
    return current.strength > best.strength || (current.strength === best.strength && current.rank < best.rank)
      ? current
      : best;
  }, { strength: 0, rank: Number.MAX_SAFE_INTEGER });
}

function compareSeedStrength(left: RetrievalCandidate, right: RetrievalCandidate): number {
  const confidence = CONFIDENCE_STRENGTH[right.confidence] - CONFIDENCE_STRENGTH[left.confidence];
  if (confidence !== 0) return confidence;
  const leftRoute = strongestRoute(left);
  const rightRoute = strongestRoute(right);
  return rightRoute.strength - leftRoute.strength ||
    leftRoute.rank - rightRoute.rank ||
    stableCandidateKey(left).localeCompare(stableCandidateKey(right));
}

function edgeKey(edge: EdgeRow): string {
  return JSON.stringify([
    edge.fromCodeId ?? "", edge.toCodeId ?? "", edge.fromRepoId ?? "", edge.toRepoId ?? "",
    edge.fromPath ?? edge.fromFile, edge.toPath ?? edge.toFile, edge.resolution, edge.raw
  ]);
}

function mergeGraphCandidates(candidates: readonly RetrievalCandidate[], limit: number): RetrievalCandidate[] {
  const grouped = new Map<string, RetrievalCandidate[]>();
  for (const candidate of candidates) {
    const key = stableCandidateKey(candidate);
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }
  return [...grouped.entries()].map(([key, values]) => {
    const first = values[0]!;
    const candidate = createRetrievalCandidate({
      canonicalId: first.canonicalId,
      repoId: first.repoId,
      kind: first.kind,
      routes: values.flatMap((value) => value.routes),
      provenance: values.flatMap((value) => value.provenance),
      matchReasons: values.flatMap((value) => value.matchReasons),
      confidence: strongestCandidateConfidence(values.map((value) => value.confidence))
    });
    return { key, candidate, rank: candidate.routes.find((route) => route.route === "graph")?.rank ?? Number.MAX_SAFE_INTEGER };
  }).sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key))
    .map(({ candidate }) => candidate)
    .slice(0, limit);
}

async function graphProviderQuery<T>(attemptedQueryCount: number, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RetrieverOperationalError) throw error;
    if (!(error instanceof GraphDatabaseOperationalError)) throw error;
    throw new RetrieverOperationalError("graph", attemptedQueryCount, "query-failed", { cause: error });
  }
}

export async function retrieveBoundedGraph(
  db: GraphDB,
  plan: QueryPlan,
  seeds: readonly RetrievalCandidate[],
  options: { workspaceId: string; seedLimit?: number; dependencies?: GraphRetrieverDependencies }
): Promise<RetrieverRouteResult<GraphLegacyRow>> {
  if (!plan.enabledRoutes.includes("graph")) {
    return emptyRouteResult("graph", "disabled", "route-disabled");
  }
  const resultLimit = Math.max(0, plan.budgets.graph.limit);
  if (resultLimit === 0) return successfulRouteResult("graph", [], [], 0);
  const seedLimit = Math.max(0, Math.min(options.seedLimit ?? resultLimit, resultLimit));
  const groupedSeeds = new Map<string, RetrievalCandidate[]>();
  for (const candidate of seeds.filter(eligible)) {
    const key = stableCandidateKey(candidate);
    groupedSeeds.set(key, [...(groupedSeeds.get(key) ?? []), candidate]);
  }
  const uniqueSeeds = [...groupedSeeds.values()]
    .map((candidates) => [...candidates].sort(compareSeedStrength)[0]!)
    .sort(compareSeedStrength)
    .slice(0, seedLimit);
  if (uniqueSeeds.length === 0) {
    return emptyRouteResult("graph", "disabled", "no-eligible-seeds");
  }

  const deps = {
    callEdgesAround: options.dependencies?.callEdgesAround ?? callEdgesAround,
    findContractSourceSymbols: options.dependencies?.findContractSourceSymbols ?? findContractSourceSymbols,
    sectionsDocumentingCode: options.dependencies?.sectionsDocumentingCode ?? sectionsDocumentingCode
  };
  const contractIds = uniqueSeeds
    .filter((candidate) => candidate.kind === "contract")
    .map((candidate) => candidate.canonicalId);
  let queryCount = 0;
  let implementationRows: CodeSearchRow[] = [];
  if (contractIds.length > 0) {
    queryCount += 1;
    implementationRows = await graphProviderQuery(queryCount, () => deps.findContractSourceSymbols(db, contractIds, resultLimit));
    implementationRows = [...new Map(implementationRows
      .sort((left, right) => left.codeId.localeCompare(right.codeId))
      .map((row) => [row.codeId, row])).values()].slice(0, resultLimit);
  }

  const remainingForEdges = Math.max(0, resultLimit - implementationRows.length);
  const codeIds = [...new Set([
    ...uniqueSeeds
      .filter((candidate) => candidate.kind === "code" && candidate.canonicalId.startsWith("code:"))
      .map((candidate) => candidate.canonicalId),
    ...implementationRows.map((row) => row.codeId)
  ])].sort();
  let edges: EdgeRow[] = [];
  if (codeIds.length > 0 && remainingForEdges > 0) {
    queryCount += 1;
    edges = await graphProviderQuery(queryCount, () => deps.callEdgesAround(db, codeIds, remainingForEdges));
    edges = [...new Map(edges.sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))).map((edge) => [edgeKey(edge), edge])).values()]
      .slice(0, remainingForEdges);
  }
  if (queryCount === 0) return emptyRouteResult("graph", "disabled", "no-queryable-seeds");

  const remainingForSections = Math.max(0, resultLimit - implementationRows.length - edges.length);
  let sections: SectionSearchRow[] = [];
  if (codeIds.length > 0 && remainingForSections > 0 && typeof db.query === "function") {
    queryCount += 1;
    sections = await graphProviderQuery(queryCount, () => deps.sectionsDocumentingCode(db, codeIds, remainingForSections));
    sections = [...new Map(sections.sort((left, right) => left.sectionId.localeCompare(right.sectionId)).map((row) => [row.sectionId, row])).values()]
      .slice(0, remainingForSections);
  }

  const candidates = mergeGraphCandidates([
    ...candidatesFromGraphCodeRows(implementationRows, options.workspaceId),
    ...candidatesFromGraphEdges(edges, options.workspaceId),
    ...candidatesFromSectionRows(sections, options.workspaceId).map((candidate) => createRetrievalCandidate({
      ...candidate,
      routes: candidate.routes.map((route) => ({ ...route, route: "graph" as const })),
      provenance: candidate.provenance.map((provenance) => ({ ...provenance, route: "graph" as const, confidence: "corroborated" as const })),
      confidence: "corroborated"
    }))
  ], resultLimit);
  const legacyRows: GraphLegacyRow[] = [
    ...implementationRows.map((row): GraphLegacyRow => ({ kind: "implementation", row })),
    ...sections.map((row): GraphLegacyRow => ({ kind: "section", row })),
    ...edges.map((row): GraphLegacyRow => ({ kind: "edge", row }))
  ];
  return successfulRouteResult("graph", candidates, legacyRows, queryCount);
}
