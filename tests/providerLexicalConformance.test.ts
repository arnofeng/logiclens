import { describe, expect, it } from "vitest";
import type { LexicalProviderHarness } from "./retrieval/providerConformance.js";
import { runWorkspaceLexicalConformance } from "./retrieval/providerConformance.js";
import type { WorkspaceCorpusCase } from "./retrieval/workspaceCorpus.js";

const cases: WorkspaceCorpusCase[] = [
  { id: "case-a", question: "find", language: "en", expectedCanonicalIds: ["code:a"], answerable: true, category: "english", searchableTerms: ["find"] },
  { id: "refusal", question: "unknown", language: "en", expectedCanonicalIds: [], answerable: false, category: "refusal", searchableTerms: [] }
];

function fake(options: { nativeCallsPerSearch?: number; prepareFails?: boolean; writeFails?: boolean; visibleBeforeWrite?: boolean; isolated?: boolean } = {}): { harness: LexicalProviderHarness; cleanupCalls: () => number } {
  let time = 0;
  let nativeSearches = 0;
  let cleanupCalls = 0;
  let visible = options.visibleBeforeWrite ?? false;
  return { cleanupCalls: () => cleanupCalls, harness: {
    provider: "memory", prepare: async () => { if (options.prepareFails) throw new Error("prepare failed"); }, write: async () => { if (options.writeFails) throw new Error("write failed"); visible = true; }, cleanup: async () => { cleanupCalls += 1; visible = false; }, now: () => time++,
    nativeSearchCount: () => nativeSearches, isWorkspaceVisible: async () => visible, isWorkspaceIsolated: async () => options.isolated ?? true,
    search: async (query) => {
      nativeSearches += options.nativeCallsPerSearch ?? 1;
      return query.text === "unknown" ? [] : [{ canonicalId: "code:a", documentId: "doc:a", repoId: "repo:a", kind: "code", rank: 1, matchReasons: ["token"], renderRef: "render:a" }];
    }
  } };
}

describe("workspace lexical provider conformance", () => {
  it("observes write and cleanup visibility, real native calls, ordering, and quality", async () => {
    const report = await runWorkspaceLexicalConformance(fake().harness, cases, "workspace:test");
    expect(report.lifecycle).toEqual({ visibleBeforeWrite: false, visibleAfterWrite: true, visibleAfterCleanup: false });
    expect(report.cases[0]).toMatchObject({ nativeSearchCalls: 1, topK: 5, repoIds: ["repo:a"], latencyMs: 1, expectedHits: ["code:a"] });
  });
  it("identifies provider, case, and the measured failed dimension", async () => {
    await expect(runWorkspaceLexicalConformance(fake({ nativeCallsPerSearch: 2 }).harness, cases, "workspace:test")).rejects.toThrow("provider=memory case=case-a dimension=native-search-count");
  });
  it.each([{ prepareFails: true }, { writeFails: true }, { visibleBeforeWrite: true }, { isolated: false }])("cleans up after setup failure %#", async (options) => {
    const provider = fake(options);
    await expect(runWorkspaceLexicalConformance(provider.harness, cases, "workspace:test")).rejects.toThrow();
    expect(provider.cleanupCalls()).toBe(1);
  });
});
