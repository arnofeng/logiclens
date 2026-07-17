import { describe, expect, it } from "vitest";
import { mrrAtK, recallAtK, refusalAccuracy } from "../src/core/retrieval/evaluation.js";

describe("retrieval evaluation", () => {
  it("calculates recall for multiple relevant identities without duplicate inflation", () => {
    expect(recallAtK(["a", "b"], ["a", "a", "b"], 3)).toBe(1);
    expect(recallAtK(["a", "b"], ["a", "a", "b"], 2)).toBe(0.5);
  });
  it("handles empty results and one-based reciprocal rank boundaries", () => {
    expect(recallAtK(["a"], [], 5)).toBe(0);
    expect(mrrAtK(["a"], ["x", "a"], 1)).toBe(0);
    expect(mrrAtK(["a"], ["x", "a"], 2)).toBe(0.5);
    expect(mrrAtK(["a"], ["a"], 0)).toBe(0);
  });
  it("scores refusal behavior for unanswerable questions", () => {
    expect(refusalAccuracy(false, [])).toBe(1);
    expect(refusalAccuracy(false, ["unsupported"])).toBe(0);
    expect(refusalAccuracy(true, ["evidence"])).toBe(1);
  });
});
