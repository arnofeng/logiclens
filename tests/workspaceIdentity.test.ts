import { describe, expect, it } from "vitest";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";

describe("deriveWorkspaceId", () => {
  it("is deterministic and normalizes whitespace, case, and Unicode", () => {
    expect(deriveWorkspaceId("  Cafe\u0301 API  ")).toBe(deriveWorkspaceId("caf\u00e9 api"));
  });

  it("distinguishes logical workspace names", () => {
    expect(deriveWorkspaceId("billing")).not.toBe(deriveWorkspaceId("catalog"));
  });

  it("does not depend on a filesystem path", () => {
    expect(deriveWorkspaceId("shared workspace")).toBe(deriveWorkspaceId("shared workspace"));
  });

  it("rejects empty names", () => {
    expect(() => deriveWorkspaceId("   ")).toThrow("must not be empty");
  });
});
