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

  it("scores call resolution from explainable static signals", () => {
    expect(scoreCallResolution({ sameFile: true, imported: false, sameRepo: true, nameExact: true })).toBe(0.9);
    expect(scoreCallResolution({ sameFile: false, imported: true, sameRepo: true, nameExact: true })).toBe(0.8);
    expect(scoreCallResolution({ sameFile: false, imported: false, sameRepo: false, nameExact: true })).toBe(0.4);
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
