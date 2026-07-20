import { parseRenderRef, RenderRefError } from "../../core/retrieval/renderRef.js";
import { stableCandidateKey, type CandidateConfidence } from "./candidates.js";
import type { FusedRetrievalCandidate } from "./fusion.js";

export type SelectionRejectionReason =
  | "total_quota"
  | "repo_quota"
  | "kind_quota"
  | "context_budget"
  | "low_reliability"
  | "unlocatable";

export type SelectionOptions = Readonly<{
  workspaceId: string;
  maxCandidates?: number;
  maxPerRepo?: number;
  maxPerKind?: number;
  maxContextChars?: number;
  maxContextTokens?: number;
  charsPerToken?: number;
  estimatedCharsPerCandidate?: number;
  reliability?: ReliabilityOptions;
}>;

export type ReliabilityOptions = Readonly<{
  minimumDiscoveryRouteSupport?: number;
  maximumSingleRouteLexicalRank?: number;
}>;

export type SelectionRejection = Readonly<{
  candidateKey: string;
  reason: SelectionRejectionReason;
}>;

export type SelectionResult = Readonly<{
  selectedCandidates: readonly FusedRetrievalCandidate[];
  rejections: readonly SelectionRejection[];
  estimatedChars: number;
  contextCharBudget: number;
}>;

const CONFIDENCE_PRIORITY: Record<CandidateConfidence, number> = {
  exact: 0,
  "resolved-contract": 1,
  corroborated: 2,
  discovery: 3
};

const DEFAULT_MAX_CANDIDATES = 20;
const DEFAULT_MAX_PER_KIND = 8;
const DEFAULT_CONTEXT_CHARS = 16_000;
const DEFAULT_ESTIMATED_CHARS = 1_200;
const DEFAULT_MAX_SINGLE_ROUTE_LEXICAL_RANK = 5;
const RELIABLE_LEXICAL_MATCH_REASONS = new Set(["full-text"]);

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number.`);
  return value;
}

function isLocatable(candidate: FusedRetrievalCandidate, workspaceId: string): boolean {
  return candidate.provenance.some((provenance) => {
    if (!provenance.documentId || !provenance.renderRef) return false;
    try {
      const parsed = parseRenderRef(provenance.renderRef, workspaceId);
      return parsed.repoId === candidate.repoId &&
        parsed.kind === candidate.kind &&
        parsed.canonicalId === candidate.canonicalId &&
        typeof parsed.path === "string";
    } catch (error) {
      if (error instanceof RenderRefError) return false;
      throw error;
    }
  });
}

export function isReliableCandidate(
  candidate: Pick<FusedRetrievalCandidate, "confidence" | "routes" | "matchReasons">,
  options: ReliabilityOptions = {}
): boolean {
  const minimumDiscoveryRouteSupport = options.minimumDiscoveryRouteSupport ?? 2;
  if (!Number.isSafeInteger(minimumDiscoveryRouteSupport) || minimumDiscoveryRouteSupport < 1) {
    throw new Error("minimumDiscoveryRouteSupport must be a positive integer.");
  }
  const maximumSingleRouteLexicalRank = options.maximumSingleRouteLexicalRank ?? DEFAULT_MAX_SINGLE_ROUTE_LEXICAL_RANK;
  if (!Number.isSafeInteger(maximumSingleRouteLexicalRank) || maximumSingleRouteLexicalRank < 1) {
    throw new Error("maximumSingleRouteLexicalRank must be a positive integer.");
  }
  if (candidate.confidence !== "discovery" || candidate.routes.length >= minimumDiscoveryRouteSupport) return true;
  if (candidate.routes.length !== 1 || candidate.routes[0]?.route !== "lexical") return false;
  return candidate.routes[0].rank <= maximumSingleRouteLexicalRank &&
    candidate.matchReasons.some((reason) => RELIABLE_LEXICAL_MATCH_REASONS.has(reason));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function directQueryMatchPriority(candidate: FusedRetrievalCandidate): number {
  if (candidate.kind === "file" && candidate.matchReasons.includes("exact-path")) return 0;
  if (candidate.matchReasons.includes("exact-path") || candidate.matchReasons.includes("canonical-id")) return 1;
  return 2;
}

function priorityOrder(
  left: { candidate: FusedRetrievalCandidate; inputIndex: number },
  right: { candidate: FusedRetrievalCandidate; inputIndex: number }
): number {
  return directQueryMatchPriority(left.candidate) - directQueryMatchPriority(right.candidate) ||
    right.candidate.routes.length - left.candidate.routes.length ||
    CONFIDENCE_PRIORITY[left.candidate.confidence] - CONFIDENCE_PRIORITY[right.candidate.confidence] ||
    right.candidate.fusionScore - left.candidate.fusionScore ||
    compareText(stableCandidateKey(left.candidate), stableCandidateKey(right.candidate)) ||
    left.inputIndex - right.inputIndex;
}

function rejection(candidate: FusedRetrievalCandidate, reason: SelectionRejectionReason): SelectionRejection {
  return Object.freeze({ candidateKey: stableCandidateKey(candidate), reason });
}

export function selectCandidates(
  candidates: readonly FusedRetrievalCandidate[],
  options: SelectionOptions
): SelectionResult {
  const maxCandidates = nonNegativeInteger(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES, "Selection maxCandidates");
  const maxPerKind = nonNegativeInteger(options.maxPerKind ?? DEFAULT_MAX_PER_KIND, "Selection maxPerKind");
  const estimatedCharsPerCandidate = nonNegativeInteger(
    options.estimatedCharsPerCandidate ?? DEFAULT_ESTIMATED_CHARS,
    "Selection estimatedCharsPerCandidate"
  );
  const charsPerToken = positiveNumber(options.charsPerToken ?? 4, "Selection charsPerToken");
  const charBudget = nonNegativeInteger(options.maxContextChars ?? DEFAULT_CONTEXT_CHARS, "Selection maxContextChars");
  const tokenBudget = options.maxContextTokens === undefined
    ? Number.POSITIVE_INFINITY
    : nonNegativeInteger(options.maxContextTokens, "Selection maxContextTokens") * charsPerToken;
  const contextCharBudget = Math.floor(Math.min(charBudget, tokenBudget));

  const located: Array<{ candidate: FusedRetrievalCandidate; inputIndex: number }> = [];
  const rejections: SelectionRejection[] = [];
  candidates.forEach((candidate, inputIndex) => {
    if (!isLocatable(candidate, options.workspaceId)) rejections.push(rejection(candidate, "unlocatable"));
    else if (!isReliableCandidate(candidate, options.reliability)) rejections.push(rejection(candidate, "low_reliability"));
    else located.push({ candidate, inputIndex });
  });
  located.sort(priorityOrder);

  const repoIds = [...new Set(located.map(({ candidate }) => candidate.repoId))].sort(compareText);
  const defaultRepoQuota = repoIds.length <= 1 ? maxCandidates : Math.max(1, Math.ceil(maxCandidates / repoIds.length));
  const maxPerRepo = nonNegativeInteger(options.maxPerRepo ?? defaultRepoQuota, "Selection maxPerRepo");
  const repoCounts = new Map<string, number>();
  const kindCounts = new Map<string, number>();
  const selected: FusedRetrievalCandidate[] = [];
  const decided = new Set<string>();
  let estimatedChars = 0;

  const consider = (candidate: FusedRetrievalCandidate): void => {
    const key = stableCandidateKey(candidate);
    if (decided.has(key)) return;
    decided.add(key);
    if (selected.length >= maxCandidates) {
      rejections.push(rejection(candidate, "total_quota"));
      return;
    }
    if ((repoCounts.get(candidate.repoId) ?? 0) >= maxPerRepo) {
      rejections.push(rejection(candidate, "repo_quota"));
      return;
    }
    if ((kindCounts.get(candidate.kind) ?? 0) >= maxPerKind) {
      rejections.push(rejection(candidate, "kind_quota"));
      return;
    }
    if (estimatedChars + estimatedCharsPerCandidate > contextCharBudget) {
      rejections.push(rejection(candidate, "context_budget"));
      return;
    }
    selected.push(candidate);
    estimatedChars += estimatedCharsPerCandidate;
    repoCounts.set(candidate.repoId, (repoCounts.get(candidate.repoId) ?? 0) + 1);
    kindCounts.set(candidate.kind, (kindCounts.get(candidate.kind) ?? 0) + 1);
  };

  // Give every represented repository its best opportunity before consuming
  // remaining capacity in global priority order.
  for (const repoId of repoIds) {
    const best = located.find(({ candidate }) => candidate.repoId === repoId);
    if (best) consider(best.candidate);
  }
  for (const entry of located) consider(entry.candidate);

  return Object.freeze({
    selectedCandidates: Object.freeze(selected),
    rejections: Object.freeze(rejections),
    estimatedChars,
    contextCharBudget
  });
}
