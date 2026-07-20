import { describe, expect, it } from "vitest";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
import { createRetrievalCandidate, type CandidateConfidence } from "../src/features/ask/candidates.js";
import { reciprocalRankFusion, type FusedRetrievalCandidate } from "../src/features/ask/fusion.js";
import { selectCandidates } from "../src/features/ask/selection.js";
import type { RetrievalRoute } from "../src/features/ask/planner.js";

const WORKSPACE_ID = "workspace:test";

function candidate(input: {
  id: string;
  repo?: string;
  kind?: "code" | "section" | "file" | "contract" | "operation";
  routes?: RetrievalRoute[];
  confidence?: CandidateConfidence;
  locatable?: boolean;
  rank?: number;
  matchReasons?: string[];
  path?: string;
}): FusedRetrievalCandidate {
  const repoId = input.repo ?? "repo:a";
  const kind = input.kind ?? "code";
  const path = input.path ?? `${repoId.slice(5)}/${input.id}.ts`;
  const renderRef = createRenderRef({ workspaceId: WORKSPACE_ID, repoId, kind, canonicalId: input.id, fileId: kind === "file" ? input.id : `file:${input.id}`, path });
  const routes = input.routes ?? ["lexical"];
  const confidence = input.confidence ?? "corroborated";
  return reciprocalRankFusion([createRetrievalCandidate({
    canonicalId: input.id,
    repoId,
    kind,
    routes: routes.map((route, index) => ({ route, rank: (input.rank ?? 1) + index, documentIds: input.locatable === false ? [] : [`doc:${input.id}`] })),
    provenance: routes.map((route, index) => ({
      route,
      rank: (input.rank ?? 1) + index,
      confidence,
      ...(input.locatable === false ? {} : { documentId: `doc:${input.id}`, renderRef })
    })),
    matchReasons: input.matchReasons ?? routes,
    confidence
  })])[0]!;
}

describe("retrieval candidate selection", () => {
  it("enforces total, repo, kind, and character quotas", () => {
    const candidates = [
      candidate({ id: "a1" }), candidate({ id: "a2" }), candidate({ id: "a3", kind: "section" }),
      candidate({ id: "b1", repo: "repo:b" }), candidate({ id: "b2", repo: "repo:b", kind: "section" })
    ];
    const totalLimited = selectCandidates(candidates, { workspaceId: WORKSPACE_ID, maxCandidates: 2, maxPerRepo: 2, maxPerKind: 2, estimatedCharsPerCandidate: 10, maxContextChars: 100 });
    expect(totalLimited.selectedCandidates).toHaveLength(2);
    expect(totalLimited.rejections.some(({ reason }) => reason === "total_quota")).toBe(true);
    expect(selectCandidates(candidates, { workspaceId: WORKSPACE_ID, maxCandidates: 5, maxPerRepo: 1, maxPerKind: 5, estimatedCharsPerCandidate: 10, maxContextChars: 100 }).rejections.some(({ reason }) => reason === "repo_quota")).toBe(true);
    expect(selectCandidates(candidates, { workspaceId: WORKSPACE_ID, maxCandidates: 5, maxPerRepo: 5, maxPerKind: 1, estimatedCharsPerCandidate: 10, maxContextChars: 100 }).rejections.some(({ reason }) => reason === "kind_quota")).toBe(true);
    const budgeted = selectCandidates(candidates, { workspaceId: WORKSPACE_ID, maxCandidates: 5, maxPerRepo: 5, maxPerKind: 5, estimatedCharsPerCandidate: 40, maxContextChars: 81 });
    expect(budgeted.selectedCandidates).toHaveLength(2);
    expect(budgeted.estimatedChars).toBe(80);
    expect(budgeted.rejections.some(({ reason }) => reason === "context_budget")).toBe(true);
  });

  it("gives represented repositories a fair first opportunity but does not waste single-repo capacity", () => {
    const multi = [candidate({ id: "a1" }), candidate({ id: "a2" }), candidate({ id: "a3" }), candidate({ id: "b1", repo: "repo:b" })];
    const fair = selectCandidates(multi, { workspaceId: WORKSPACE_ID, maxCandidates: 2, maxPerKind: 5, estimatedCharsPerCandidate: 1, maxContextChars: 10 });
    expect(new Set(fair.selectedCandidates.map(({ repoId }) => repoId))).toEqual(new Set(["repo:a", "repo:b"]));

    const single = selectCandidates(multi.slice(0, 3), { workspaceId: WORKSPACE_ID, maxCandidates: 3, maxPerKind: 5, estimatedCharsPerCandidate: 1, maxContextChars: 10 });
    expect(single.selectedCandidates).toHaveLength(3);
  });

  it("prioritizes locatable, multi-route, and high-confidence candidates with stable ties", () => {
    const unlocatable = candidate({ id: "top-but-unlocatable", confidence: "exact", locatable: false });
    const corroborated = candidate({ id: "z", routes: ["lexical"] });
    const exact = candidate({ id: "y", confidence: "exact" });
    const multiRoute = candidate({ id: "x", routes: ["exact", "lexical"], confidence: "corroborated" });
    const tiedA = candidate({ id: "a" });
    const tiedB = candidate({ id: "b" });
    const lowReliability = candidate({ id: "low", confidence: "discovery" });
    const result = selectCandidates([unlocatable, corroborated, exact, multiRoute, tiedB, tiedA, lowReliability], {
      workspaceId: WORKSPACE_ID, maxCandidates: 5, maxPerRepo: 10, maxPerKind: 10, estimatedCharsPerCandidate: 1, maxContextChars: 10
    });
    expect(result.selectedCandidates.map(({ canonicalId }) => canonicalId)).toEqual(["x", "y", "a", "b", "z"]);
    expect(result.rejections).toContainEqual(expect.objectContaining({ reason: "unlocatable" }));
    expect(result.rejections).toContainEqual(expect.objectContaining({ reason: "low_reliability" }));
  });

  it("prioritizes a direct file-path match over contained code", () => {
    const containedCode = candidate({ id: "code", routes: ["exact", "lexical"], confidence: "exact", matchReasons: ["exact-path"] });
    const directFile = candidate({ id: "file:repo:a:a/direct.ts", kind: "file", path: "a/direct.ts", confidence: "exact", matchReasons: ["exact-path"] });
    const result = selectCandidates([containedCode, directFile], {
      workspaceId: WORKSPACE_ID,
      maxCandidates: 2,
      maxPerRepo: 2,
      maxPerKind: 2,
      estimatedCharsPerCandidate: 1,
      maxContextChars: 2,
    });
    expect(result.selectedCandidates.map(({ canonicalId }) => canonicalId)).toEqual(["file:repo:a:a/direct.ts", "code"]);
  });

  it("is repeatable and does not mutate inputs", () => {
    const candidates = Object.freeze([candidate({ id: "b" }), candidate({ id: "a" })]);
    const snapshot = JSON.stringify(candidates);
    const options = { workspaceId: WORKSPACE_ID, maxCandidates: 2, estimatedCharsPerCandidate: 1, maxContextChars: 2 };
    expect(selectCandidates(candidates, options)).toEqual(selectCandidates(candidates, options));
    expect(JSON.stringify(candidates)).toBe(snapshot);
  });

  it("uses a deterministic configurable discovery route threshold", () => {
    const discovery = candidate({ id: "discovery", confidence: "discovery" });
    expect(selectCandidates([discovery], { workspaceId: WORKSPACE_ID }).selectedCandidates).toEqual([]);
    expect(selectCandidates([discovery], {
      workspaceId: WORKSPACE_ID,
      reliability: { minimumDiscoveryRouteSupport: 1 }
    }).selectedCandidates).toEqual([discovery]);
    expect(() => selectCandidates([discovery], {
      workspaceId: WORKSPACE_ID,
      reliability: { minimumDiscoveryRouteSupport: 0 }
    })).toThrow("minimumDiscoveryRouteSupport must be a positive integer");
  });

  it("accepts strong ranked lexical discovery without accepting arbitrary single-route discovery", () => {
    const strongLexical = candidate({ id: "strong-lexical", confidence: "discovery", rank: 1, matchReasons: ["full-text"] });
    const weakLexical = candidate({ id: "weak-lexical", confidence: "discovery", rank: 6, matchReasons: ["full-text"] });
    const unsupportedLexical = candidate({ id: "unsupported-lexical", confidence: "discovery", rank: 1, matchReasons: ["provider-score"] });
    const result = selectCandidates([weakLexical, unsupportedLexical, strongLexical], { workspaceId: WORKSPACE_ID });
    expect(result.selectedCandidates).toEqual([strongLexical]);
    expect(result.rejections.filter(({ reason }) => reason === "low_reliability")).toHaveLength(2);
    expect(selectCandidates([weakLexical], {
      workspaceId: WORKSPACE_ID,
      reliability: { maximumSingleRouteLexicalRank: 6 }
    }).selectedCandidates).toEqual([weakLexical]);
    expect(() => selectCandidates([strongLexical], {
      workspaceId: WORKSPACE_ID,
      reliability: { maximumSingleRouteLexicalRank: 0 }
    })).toThrow("maximumSingleRouteLexicalRank must be a positive integer");
  });
});
