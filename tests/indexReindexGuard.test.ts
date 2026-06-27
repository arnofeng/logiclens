import { describe, expect, it } from "vitest";
import { findBlockedReindexTargets } from "../src/core/indexing/run.js";

describe("findBlockedReindexTargets", () => {
  it("allows a full index of a repo that has not been indexed yet", () => {
    const blocked = findBlockedReindexTargets({
      repo: "service-a",
      configuredRepoNames: ["service-a"],
      indexedRepoNames: []
    });
    expect(blocked).toEqual([]);
  });

  it("blocks a full re-index of an already-indexed repo", () => {
    const blocked = findBlockedReindexTargets({
      repo: "service-a",
      configuredRepoNames: ["service-a"],
      indexedRepoNames: ["service-a"]
    });
    expect(blocked).toEqual(["service-a"]);
  });

  it("blocks a full all-repos index when any configured repo is already indexed", () => {
    const blocked = findBlockedReindexTargets({
      configuredRepoNames: ["service-a", "service-b"],
      indexedRepoNames: ["service-a"]
    });
    expect(blocked).toEqual(["service-a"]);
  });

  it("allows --changed-only even when the target repo is already indexed", () => {
    const blocked = findBlockedReindexTargets({
      changedOnly: true,
      repo: "service-a",
      configuredRepoNames: ["service-a"],
      indexedRepoNames: ["service-a"]
    });
    expect(blocked).toEqual([]);
  });

  it("allows a first index of a new repo while a different repo is already indexed", () => {
    const blocked = findBlockedReindexTargets({
      repo: "service-b",
      configuredRepoNames: ["service-a", "service-b"],
      indexedRepoNames: ["service-a"]
    });
    expect(blocked).toEqual([]);
  });
});
