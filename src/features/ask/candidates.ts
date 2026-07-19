import type {
  CodeSearchRow,
  ContractTraceRow,
  EntityTraceRow,
  SectionSearchRow
} from "../../core/graph-model/queries.js";
import type { SemanticSearchResult, SemanticNodeKind } from "../../core/semantic/semanticIndex.js";
import type { EdgeRow } from "../../core/graph-model/subgraph.js";
import type { LexicalHit, LexicalDocumentKind } from "../../core/retrieval/types.js";
import { createRenderRef, parseRenderRef } from "../../core/retrieval/renderRef.js";
import { fileId, repoId } from "../../shared/path.js";
import type { RetrievalRoute } from "./planner.js";

export type CandidateSourceKind = LexicalDocumentKind | "system";
export type CandidateConfidence = "exact" | "resolved-contract" | "corroborated" | "discovery";

export type CandidateLocation = Readonly<{
  fileId?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
}>;

export type CandidateRouteMembership = Readonly<{
  route: RetrievalRoute;
  rank: number;
  documentIds: readonly string[];
}>;

export type CandidateProvenance = Readonly<{
  route: RetrievalRoute;
  rank: number;
  confidence: CandidateConfidence;
  documentId?: string;
  renderRef?: string;
  location?: CandidateLocation;
}>;

export type RetrievalCandidate = Readonly<{
  canonicalId: string;
  repoId: string;
  kind: CandidateSourceKind;
  renderRef?: string;
  location?: CandidateLocation;
  provenance: readonly CandidateProvenance[];
  routes: readonly CandidateRouteMembership[];
  matchReasons: readonly string[];
  confidence: CandidateConfidence;
}>;

export type RetrievalCandidateInput = Omit<RetrievalCandidate, "provenance"> & Readonly<{
  provenance?: readonly CandidateProvenance[];
}>;

const CONFIDENCE_ORDER: readonly CandidateConfidence[] = ["exact", "resolved-contract", "corroborated", "discovery"];
const ROUTE_ORDER: readonly RetrievalRoute[] = ["exact", "contract", "entity", "lexical", "graph", "semantic"];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableCandidateKey(candidate: Pick<RetrievalCandidate, "repoId" | "kind" | "canonicalId">): string {
  return JSON.stringify([candidate.repoId, candidate.kind, candidate.canonicalId]);
}

export function strongestCandidateConfidence(values: readonly CandidateConfidence[]): CandidateConfidence {
  return [...values].sort((left, right) => CONFIDENCE_ORDER.indexOf(left) - CONFIDENCE_ORDER.indexOf(right))[0] ?? "discovery";
}

export function stableCandidateStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(compareText));
}

export function normalizeCandidateRoutes(routes: readonly CandidateRouteMembership[]): readonly CandidateRouteMembership[] {
  const grouped = new Map<RetrievalRoute, { rank: number; documentIds: string[] }>();
  for (const membership of routes) {
    if (!Number.isSafeInteger(membership.rank) || membership.rank < 1) {
      throw new Error(`Candidate route rank must be a positive one-based integer: ${membership.rank}`);
    }
    const current = grouped.get(membership.route);
    if (current) {
      current.rank = Math.min(current.rank, membership.rank);
      current.documentIds.push(...membership.documentIds);
    } else {
      grouped.set(membership.route, { rank: membership.rank, documentIds: [...membership.documentIds] });
    }
  }
  return Object.freeze([...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([route, membership]) => Object.freeze({
      route,
      rank: membership.rank,
      documentIds: stableCandidateStrings(membership.documentIds)
    })));
}

function provenanceTieKey(provenance: CandidateProvenance): string {
  return JSON.stringify([
    provenance.documentId ?? "",
    provenance.renderRef ?? "",
    provenance.location ?? null
  ]);
}

function compareProvenance(left: CandidateProvenance, right: CandidateProvenance): number {
  return CONFIDENCE_ORDER.indexOf(left.confidence) - CONFIDENCE_ORDER.indexOf(right.confidence) ||
    ROUTE_ORDER.indexOf(left.route) - ROUTE_ORDER.indexOf(right.route) ||
    left.rank - right.rank ||
    compareText(provenanceTieKey(left), provenanceTieKey(right));
}

function normalizeCandidateProvenance(values: readonly CandidateProvenance[]): readonly CandidateProvenance[] {
  const normalized = values.map((value) => {
    if (!Number.isSafeInteger(value.rank) || value.rank < 1) {
      throw new Error(`Candidate provenance rank must be a positive one-based integer: ${value.rank}`);
    }
    const location = value.location ? Object.freeze({ ...value.location }) : undefined;
    return Object.freeze({
      route: value.route,
      rank: value.rank,
      confidence: value.confidence,
      ...(value.documentId ? { documentId: value.documentId } : {}),
      ...(value.renderRef ? { renderRef: value.renderRef } : {}),
      ...(location ? { location } : {})
    });
  }).sort(compareProvenance);
  return Object.freeze([...new Map(normalized.map((value) => [JSON.stringify(value), value])).values()]);
}

export function selectCandidateProvenance(values: readonly CandidateProvenance[]): CandidateProvenance | undefined {
  return [...values].sort(compareProvenance)[0];
}

export function createRetrievalCandidate(input: RetrievalCandidateInput): RetrievalCandidate {
  const routes = normalizeCandidateRoutes(input.routes);
  const derivedProvenance = input.provenance ?? routes.slice(0, 1).map((route) => ({
    route: route.route,
    rank: route.rank,
    confidence: input.confidence,
    ...(route.documentIds[0] ? { documentId: route.documentIds[0] } : {}),
    ...(input.renderRef ? { renderRef: input.renderRef } : {}),
    ...(input.location ? { location: input.location } : {})
  }));
  const provenance = normalizeCandidateProvenance(derivedProvenance);
  const selected = selectCandidateProvenance(provenance);
  return Object.freeze({
    canonicalId: input.canonicalId,
    repoId: input.repoId,
    kind: input.kind,
    ...(selected?.renderRef ? { renderRef: selected.renderRef } : {}),
    ...(selected?.location ? { location: selected.location } : {}),
    provenance,
    routes,
    matchReasons: stableCandidateStrings(input.matchReasons),
    confidence: input.confidence
  });
}

function candidateLocation(repoIdValue: string, path: string, startLine?: number, endLine?: number): CandidateLocation {
  return {
    fileId: fileId(repoIdValue, path),
    path,
    ...(startLine && startLine >= 1 ? { startLine } : {}),
    ...(endLine && endLine >= 1 ? { endLine } : {})
  };
}

export function candidatesFromLexicalHits(hits: readonly LexicalHit[], workspaceId?: string): RetrievalCandidate[] {
  const grouped = new Map<string, LexicalHit[]>();
  for (const hit of hits) {
    const key = stableCandidateKey(hit);
    const values = grouped.get(key) ?? [];
    values.push(hit);
    grouped.set(key, values);
  }
  return [...grouped.entries()].map(([key, values]) => ({
    key,
    values,
    bestRank: Math.min(...values.map((hit) => hit.rank))
  })).sort((left, right) => left.bestRank - right.bestRank || compareText(left.key, right.key)).map(({ values }) => {
    const ordered = [...values].sort((left, right) => left.rank - right.rank || compareText(left.documentId, right.documentId));
    const first = ordered[0]!;
    const parsed = workspaceId ? parseRenderRef(first.renderRef, workspaceId) : undefined;
    if (parsed && (parsed.repoId !== first.repoId || parsed.kind !== first.kind || parsed.canonicalId !== first.canonicalId)) {
      throw new Error(`Lexical hit renderRef identity does not match document ${first.documentId}`);
    }
    const location = parsed?.fileId && parsed.path ? {
      fileId: parsed.fileId,
      path: parsed.path,
      ...(parsed.startLine ? { startLine: parsed.startLine } : {}),
      ...(parsed.endLine ? { endLine: parsed.endLine } : {})
    } : undefined;
    return createRetrievalCandidate({
      canonicalId: first.canonicalId,
      repoId: first.repoId,
      kind: first.kind,
      routes: [{ route: "lexical", rank: first.rank, documentIds: ordered.map((hit) => hit.documentId) }],
      provenance: ordered.map((hit) => ({
        route: "lexical",
        rank: hit.rank,
        confidence: "discovery",
        documentId: hit.documentId,
        renderRef: hit.renderRef,
        ...(hit === first && location ? { location } : {})
      })),
      matchReasons: ordered.flatMap((hit) => hit.matchReasons),
      confidence: "discovery"
    });
  });
}

export function candidatesFromGraphCodeRows(rows: readonly CodeSearchRow[], workspaceId: string): RetrievalCandidate[] {
  return rows.map((row, index) => {
    const owner = repoId(row.repoName);
    const location = candidateLocation(owner, row.filePath);
    return createRetrievalCandidate({
      canonicalId: row.codeId,
      repoId: owner,
      kind: "code",
      renderRef: createRenderRef({ workspaceId, repoId: owner, kind: "code", canonicalId: row.codeId, fileId: location.fileId, path: row.filePath }),
      location,
      routes: [{ route: "graph", rank: index + 1, documentIds: [] }],
      matchReasons: ["contract-implementation"],
      confidence: "corroborated"
    });
  });
}

export function candidatesFromGraphEdges(rows: readonly EdgeRow[], workspaceId: string): RetrievalCandidate[] {
  const confidenceForResolution = (resolution: EdgeRow["resolution"]): CandidateConfidence =>
    resolution === "exact" ? "corroborated" : "discovery";
  const endpoints = rows.flatMap((row, index) => {
    if (!row.fromCodeId || !row.toCodeId || !row.fromRepoId || !row.toRepoId || !row.fromPath || !row.toPath) return [];
    const documentId = JSON.stringify(["call-edge", row.fromCodeId, row.toCodeId, row.resolution, row.raw]);
    return [
      { canonicalId: row.fromCodeId, repoId: row.fromRepoId, path: row.fromPath, rank: index + 1, direction: "from", resolution: row.resolution, confidence: confidenceForResolution(row.resolution), documentId },
      { canonicalId: row.toCodeId, repoId: row.toRepoId, path: row.toPath, rank: index + 1, direction: "to", resolution: row.resolution, confidence: confidenceForResolution(row.resolution), documentId }
    ];
  });
  const grouped = new Map<string, typeof endpoints>();
  for (const endpoint of endpoints) {
    const key = JSON.stringify([endpoint.repoId, "code", endpoint.canonicalId]);
    grouped.set(key, [...(grouped.get(key) ?? []), endpoint]);
  }
  return [...grouped.entries()].map(([key, values]) => ({
    key,
    values,
    rank: Math.min(...values.map((value) => value.rank))
  })).sort((left, right) => left.rank - right.rank || compareText(left.key, right.key)).map(({ values }) => {
    const first = [...values].sort((left, right) => left.rank - right.rank || compareText(left.path, right.path))[0]!;
    const location = candidateLocation(first.repoId, first.path);
    const renderRef = createRenderRef({ workspaceId, repoId: first.repoId, kind: "code", canonicalId: first.canonicalId, fileId: location.fileId, path: first.path });
    return createRetrievalCandidate({
      canonicalId: first.canonicalId,
      repoId: first.repoId,
      kind: "code",
      renderRef,
      location,
      routes: values.map((value) => ({ route: "graph", rank: value.rank, documentIds: [value.documentId] })),
      provenance: values.map((value) => ({ route: "graph", rank: value.rank, confidence: value.confidence, documentId: value.documentId, renderRef, location })),
      matchReasons: values.flatMap((value) => [`call-edge-${value.direction}`, `call-edge-resolution-${value.resolution}`]),
      confidence: strongestCandidateConfidence(values.map((value) => value.confidence))
    });
  });
}

export function candidatesFromCodeRows(rows: readonly CodeSearchRow[], workspaceId: string): RetrievalCandidate[] {
  return rows.map((row, index) => {
    const owner = repoId(row.repoName);
    const location = candidateLocation(owner, row.filePath);
    return createRetrievalCandidate({
      canonicalId: row.codeId,
      repoId: owner,
      kind: "code",
      renderRef: createRenderRef({ workspaceId, repoId: owner, kind: "code", canonicalId: row.codeId, fileId: location.fileId, path: row.filePath }),
      location,
      routes: [{ route: "exact", rank: index + 1, documentIds: [] }],
      matchReasons: ["exact-code"],
      confidence: "exact"
    });
  });
}

export function candidatesFromSectionRows(rows: readonly SectionSearchRow[], workspaceId: string): RetrievalCandidate[] {
  return rows.map((row, index) => {
    const owner = repoId(row.repoName);
    const location = candidateLocation(owner, row.filePath, row.startLine, row.endLine);
    return createRetrievalCandidate({
      canonicalId: row.sectionId,
      repoId: owner,
      kind: "section",
      renderRef: createRenderRef({ workspaceId, repoId: owner, kind: "section", canonicalId: row.sectionId, ...location }),
      location,
      routes: [{ route: "exact", rank: index + 1, documentIds: [] }],
      matchReasons: ["exact-section"],
      confidence: "exact"
    });
  });
}

export function candidatesFromContractRows(rows: readonly ContractTraceRow[], workspaceId: string): RetrievalCandidate[] {
  return rows.map((row, index) => {
    const owner = repoId(row.repoName);
    const location = candidateLocation(owner, row.filePath, row.line);
    return createRetrievalCandidate({
      canonicalId: row.contractId,
      repoId: owner,
      kind: "contract",
      renderRef: createRenderRef({ workspaceId, repoId: owner, kind: "contract", canonicalId: row.contractId, ...location }),
      location,
      routes: [{ route: "contract", rank: index + 1, documentIds: [] }],
      matchReasons: [`contract-${row.role}`, `resolution-${row.resolution}`],
      confidence: row.resolution === "exact" ? "resolved-contract" : "discovery"
    });
  });
}

export function candidatesFromEntityRows(rows: readonly EntityTraceRow[], workspaceId: string): RetrievalCandidate[] {
  return rows.map((row, index) => {
    const owner = repoId(row.repoName);
    const hasFileLocation = row.filePath.trim().length > 0 && Number.isSafeInteger(row.line) && row.line >= 1;
    const location = hasFileLocation ? candidateLocation(owner, row.filePath, row.line) : undefined;
    return createRetrievalCandidate({
      canonicalId: row.entityId,
      repoId: owner,
      kind: "entity",
      renderRef: createRenderRef({ workspaceId, repoId: owner, kind: "entity", canonicalId: row.entityId, ...(location ?? {}) }),
      ...(location ? { location } : {}),
      routes: [{ route: "entity", rank: index + 1, documentIds: [] }],
      matchReasons: [`entity-${row.role}`],
      confidence: "discovery"
    });
  });
}

function semanticKind(kind: SemanticNodeKind): CandidateSourceKind {
  return kind === "System" ? "system" : kind.toLowerCase() as CandidateSourceKind;
}

export function candidatesFromSemanticResults(rows: readonly SemanticSearchResult[]): RetrievalCandidate[] {
  return rows.flatMap((row, index) => row.repoId ? [createRetrievalCandidate({
    canonicalId: row.nodeId,
    repoId: row.repoId,
    kind: semanticKind(row.nodeKind),
    routes: [{ route: "semantic", rank: index + 1, documentIds: [] }],
    matchReasons: ["semantic-match"],
    confidence: "discovery"
  })] : []);
}
