import { describe, expect, it } from "vitest";
import { createRetrievalCandidate, type RetrievalCandidate } from "../src/features/ask/candidates.js";
import { reciprocalRankFusion } from "../src/features/ask/fusion.js";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";

function candidate(input: {
  id: string;
  repo?: string;
  route: "exact" | "contract" | "entity" | "lexical" | "graph" | "semantic";
  rank: number;
  reason?: string;
  confidence?: RetrievalCandidate["confidence"];
  renderRef?: string;
  location?: RetrievalCandidate["location"];
}): RetrievalCandidate {
  return createRetrievalCandidate({
    canonicalId: input.id,
    repoId: input.repo ?? "repo:a",
    kind: "code",
    ...(input.renderRef ? { renderRef: input.renderRef } : {}),
    ...(input.location ? { location: input.location } : {}),
    routes: [{ route: input.route, rank: input.rank, documentIds: [] }],
    matchReasons: [input.reason ?? input.route],
    confidence: input.confidence ?? "discovery"
  });
}

describe("reciprocal-rank fusion", () => {
  it("handles empty and one-route input", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    const result = reciprocalRankFusion([candidate({ id: "one", route: "lexical", rank: 1 })], { rrfConstant: 60 });
    expect(result[0]?.fusionScore).toBe(0.016393442623);
    expect(result[0]?.diagnostics.totalScore).toBe(result[0]?.fusionScore);
  });

  it("deduplicates candidates and repeated routes without mutating input", () => {
    const inputs = [
      candidate({ id: "same", route: "lexical", rank: 4, reason: "title" }),
      candidate({ id: "same", route: "lexical", rank: 2, reason: "path" }),
      candidate({ id: "same", route: "semantic", rank: 1, reason: "meaning" })
    ];
    const before = JSON.stringify(inputs);
    const result = reciprocalRankFusion(inputs);
    expect(result).toHaveLength(1);
    expect(result[0]?.routes).toEqual([
      { route: "lexical", rank: 2, documentIds: [] },
      { route: "semantic", rank: 1, documentIds: [] }
    ]);
    expect(result[0]?.matchReasons).toEqual(["meaning", "path", "title"]);
    expect(JSON.stringify(inputs)).toBe(before);
  });

  it("applies route weights, exact confidence, and deterministic tie-breaking", () => {
    const inputs = [
      candidate({ id: "z", route: "lexical", rank: 1 }),
      candidate({ id: "a", route: "semantic", rank: 1 }),
      candidate({ id: "exact", route: "exact", rank: 20, confidence: "exact" })
    ];
    const first = reciprocalRankFusion(inputs, { routeWeights: { semantic: 2 } });
    const second = reciprocalRankFusion([...inputs].reverse(), { routeWeights: { semantic: 2 } });
    expect(first.map(({ canonicalId }) => canonicalId)).toEqual(["exact", "a", "z"]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("selects renderRef and location as one ranked provenance unit", () => {
    const exactLocation = { fileId: "file:repo:a:src/z.ts", path: "src/z.ts", startLine: 20 };
    const lexicalLocation = { fileId: "file:repo:a:src/a.ts", path: "src/a.ts", startLine: 1 };
    const exactRef = createRenderRef({ workspaceId: "workspace:test", repoId: "repo:a", kind: "code", canonicalId: "same", ...exactLocation });
    const lexicalRef = createRenderRef({ workspaceId: "workspace:test", repoId: "repo:a", kind: "code", canonicalId: "same", ...lexicalLocation });
    const result = reciprocalRankFusion([
      candidate({ id: "same", route: "lexical", rank: 1, renderRef: lexicalRef, location: lexicalLocation }),
      candidate({ id: "same", route: "exact", rank: 2, confidence: "exact", renderRef: exactRef, location: exactLocation })
    ])[0]!;
    expect(result.renderRef).toBe(exactRef);
    expect(result.location).toEqual(exactLocation);
    expect(result.diagnostics.selectedProvenance).toMatchObject({ route: "exact", rank: 2, renderRef: exactRef, location: exactLocation });
  });

  it("rejects invalid rank and weight boundaries", () => {
    expect(() => candidate({ id: "bad", route: "lexical", rank: 0 })).toThrow(/one-based/);
    expect(() => reciprocalRankFusion([candidate({ id: "ok", route: "lexical", rank: 1 })], { routeWeights: { lexical: -1 } })).toThrow(/non-negative/);
  });

  it("emits stable diagnostics without provider raw scores", () => {
    const result = reciprocalRankFusion([
      candidate({ id: "same", route: "contract", rank: 1, reason: "resolved", confidence: "resolved-contract" }),
      candidate({ id: "same", route: "lexical", rank: 3, reason: "path" })
    ], { rrfConstant: 60, routeWeights: { contract: 2, lexical: 1 } });
    expect(result[0]?.diagnostics).toMatchInlineSnapshot(`
      {
        "confidenceContribution": 0.5,
        "confidenceSignal": "resolved-contract",
        "matchReasons": [
          "path",
          "resolved",
        ],
        "routes": [
          {
            "contribution": 0.032786885246,
            "rank": 1,
            "route": "contract",
            "weight": 2,
          },
          {
            "contribution": 0.015873015873,
            "rank": 3,
            "route": "lexical",
            "weight": 1,
          },
        ],
        "selectedProvenance": {
          "confidence": "resolved-contract",
          "rank": 1,
          "route": "contract",
        },
        "totalScore": 0.548659901119,
      }
    `);
    expect(JSON.stringify(result)).not.toMatch(/rawScore|providerScore|distance/);
  });
});
