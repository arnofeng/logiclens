import { describe, expect, it } from "vitest";
import { confidenceBand, confidenceFor, PROBABLE_CONFIDENCE_THRESHOLD, scoreCallResolution } from "../src/confidence.js";
import { auditRelationQuality } from "../src/graph/quality.js";

describe("confidence rules", () => {
  it("keeps confidence bands aligned with default query visibility", () => {
    expect(confidenceBand(confidenceFor("exact-parser-route"))).toBe("exact");
    expect(confidenceBand(confidenceFor("probable-http-client"))).toBe("probable");
    expect(confidenceBand(confidenceFor("fallback-framework-language"))).toBe("heuristic");
    expect(confidenceBand(PROBABLE_CONFIDENCE_THRESHOLD - 0.01)).toBe("heuristic");
  });

  it("keeps fallback detector confidence below probable evidence", () => {
    expect(confidenceFor("fallback-framework-language")).toBeLessThan(confidenceFor("probable-http-route"));
    expect(confidenceFor("fallback-framework-signature")).toBeLessThan(confidenceFor("probable-http-client"));
  });

  it("places spec confidence rules in correct bands", () => {
    expect(confidenceBand(confidenceFor("exact-parser-route-spec"))).toBe("exact");
    expect(confidenceBand(confidenceFor("probable-http-client-spec"))).toBe("probable");
    expect(confidenceBand(confidenceFor("probable-event-spec"))).toBe("probable");
    expect(confidenceBand(confidenceFor("exact-event-annotation"))).toBe("exact");
    expect(confidenceBand(confidenceFor("heuristic-schema-fields"))).toBe("heuristic");
    expect(confidenceBand(confidenceFor("heuristic-generic-type-param"))).toBe("heuristic");
    expect(confidenceBand(confidenceFor("heuristic-request-body-type"))).toBe("heuristic");
    expect(confidenceBand(confidenceFor("heuristic-response-body-type"))).toBe("heuristic");
    expect(confidenceBand(confidenceFor("method-unknown-fallback"))).toBe("heuristic");
  });

  it("ensures spec band hierarchy does not cross boundaries", () => {
    expect(confidenceFor("exact-parser-route-spec")).toBeGreaterThanOrEqual(0.9);
    expect(confidenceFor("probable-http-client-spec")).toBeGreaterThanOrEqual(0.8);
    expect(confidenceFor("probable-http-client-spec")).toBeLessThan(0.9);
    expect(confidenceFor("probable-event-spec")).toBeGreaterThanOrEqual(0.8);
    expect(confidenceFor("probable-event-spec")).toBeLessThan(0.9);
    expect(confidenceFor("exact-event-annotation")).toBeGreaterThanOrEqual(0.9);
    expect(confidenceFor("heuristic-schema-fields")).toBeLessThan(0.8);
    expect(confidenceFor("heuristic-generic-type-param")).toBeLessThan(0.8);
    expect(confidenceFor("heuristic-request-body-type")).toBeLessThan(0.8);
    expect(confidenceFor("heuristic-response-body-type")).toBeLessThan(0.8);
    expect(confidenceFor("method-unknown-fallback")).toBeLessThan(0.8);
    expect(confidenceFor("method-unknown-fallback")).toBeLessThan(confidenceFor("heuristic-schema-fields"));
  });

  it("scores call resolution from explainable static signals", () => {
    expect(scoreCallResolution({ sameFile: true, imported: false, sameRepo: true, nameExact: true })).toBe(0.9);
    expect(scoreCallResolution({ sameFile: false, imported: true, sameRepo: true, nameExact: true })).toBe(0.8);
    expect(scoreCallResolution({ sameFile: false, imported: false, sameRepo: false, nameExact: true })).toBe(0.4);
  });

  it("places resolver confidence rules in correct bands", () => {
    expect(confidenceBand(confidenceFor("exact-method-path-match"))).toBe("exact");
    expect(confidenceBand(confidenceFor("template-compatible-match"))).toBe("exact");
    expect(confidenceBand(confidenceFor("static-path-to-template-match"))).toBe("exact");
    expect(confidenceBand(confidenceFor("wildcard-path-match"))).toBe("probable");
    expect(confidenceBand(confidenceFor("path-only-match"))).toBe("heuristic");
  });

  it("ensures resolver band hierarchy does not cross boundaries", () => {
    // path-only is the weakest match → heuristic (< 0.8)
    expect(confidenceFor("path-only-match")).toBeLessThan(0.8);
    // wildcard → probable (≥ 0.8, < 0.9)
    expect(confidenceFor("wildcard-path-match")).toBeGreaterThanOrEqual(0.8);
    expect(confidenceFor("wildcard-path-match")).toBeLessThan(0.9);
    // template/static-to-template → exact (≥ 0.9)
    expect(confidenceFor("template-compatible-match")).toBeGreaterThanOrEqual(0.9);
    expect(confidenceFor("static-path-to-template-match")).toBeGreaterThanOrEqual(0.9);
    // exact-method-path is the strongest
    expect(confidenceFor("exact-method-path-match")).toBeGreaterThanOrEqual(0.9);
    // ordinal ordering
    expect(confidenceFor("path-only-match")).toBeLessThan(confidenceFor("wildcard-path-match"));
    expect(confidenceFor("wildcard-path-match")).toBeLessThan(confidenceFor("template-compatible-match"));
    expect(confidenceFor("template-compatible-match")).toBeLessThanOrEqual(confidenceFor("exact-method-path-match"));
  });

  it("uses the probable threshold as the default relation-quality audit cutoff", async () => {
    const seenMinConfidence: number[] = [];
    const db = {
      async query(_sql: string, params?: { minConfidence?: number }) {
        if (params?.minConfidence !== undefined) seenMinConfidence.push(params.minConfidence);
        return [];
      }
    };

    await auditRelationQuality(db as never);

    expect(seenMinConfidence).toEqual([
      PROBABLE_CONFIDENCE_THRESHOLD,
      PROBABLE_CONFIDENCE_THRESHOLD,
      PROBABLE_CONFIDENCE_THRESHOLD,
      PROBABLE_CONFIDENCE_THRESHOLD
    ]);
  });
});
