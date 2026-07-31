import type { LexicalHit, LexicalSearchOptions } from "../../src/core/retrieval/types.js";
import type { WorkspaceCorpusCase } from "./workspaceCorpus.js";

export interface LexicalProviderHarness {
  provider: string;
  prepare(): Promise<void>;
  write(): Promise<void>;
  search(query: { workspaceId: string; text: string }, options: LexicalSearchOptions): Promise<LexicalHit[]>;
  /** Returns the provider's native full-text invocation count. */
  nativeSearchCount(): number;
  /** Observes committed lexical visibility without performing a search. */
  isWorkspaceVisible(workspaceId: string): Promise<boolean>;
  /** Verifies that a workspace cannot observe another workspace's documents. */
  isWorkspaceIsolated(workspaceId: string): Promise<boolean>;
  cleanup(): Promise<void>;
  now?(): number;
}

export interface ConformanceCaseResult {
  caseId: string;
  nativeSearchCalls: number;
  topK: number;
  repoIds: string[];
  latencyMs: number;
  expectedHits: string[];
  hits: LexicalHit[];
}

export interface WorkspaceLexicalConformanceReport {
  provider: string;
  lifecycle: { visibleBeforeWrite: boolean; visibleAfterWrite: boolean; visibleAfterCleanup: boolean };
  qualityInputs: WorkspaceCorpusCase[];
  cases: ConformanceCaseResult[];
}

function failure(provider: string, caseId: string, dimension: string, detail?: string): Error {
  return new Error(`Lexical conformance failed: provider=${provider} case=${caseId} dimension=${dimension}${detail ? ` detail=${detail}` : ""}`);
}

export async function runWorkspaceLexicalConformance(harness: LexicalProviderHarness, cases: WorkspaceCorpusCase[], workspaceId: string, topK = 5): Promise<WorkspaceLexicalConformanceReport> {
  const lifecycle = { visibleBeforeWrite: false, visibleAfterWrite: false, visibleAfterCleanup: false };
  const results: ConformanceCaseResult[] = [];
  try {
    await harness.prepare();
    lifecycle.visibleBeforeWrite = await harness.isWorkspaceVisible(workspaceId);
    if (lifecycle.visibleBeforeWrite) throw failure(harness.provider, "lifecycle", "write-boundary-before");
    await harness.write();
    lifecycle.visibleAfterWrite = await harness.isWorkspaceVisible(workspaceId);
    if (!lifecycle.visibleAfterWrite) throw failure(harness.provider, "lifecycle", "write-boundary-after");
    if (!await harness.isWorkspaceIsolated(workspaceId)) throw failure(harness.provider, "lifecycle", "workspace-isolation");
    for (const entry of cases) {
      const nativeCallsBefore = harness.nativeSearchCount();
      const started = harness.now?.() ?? Date.now();
      const hits = await harness.search({ workspaceId, text: entry.question }, { topK });
      const latencyMs = (harness.now?.() ?? Date.now()) - started;
      const nativeSearchCalls = harness.nativeSearchCount() - nativeCallsBefore;
      if (nativeSearchCalls !== 1) throw failure(harness.provider, entry.id, "native-search-count");
      if (hits.some((hit, index) => hit.rank !== index + 1)) throw failure(harness.provider, entry.id, "global-rank");
      if (hits.length > topK) throw failure(harness.provider, entry.id, "top-k");
      if (hits.some((hit) => !hit.repoId || !hit.renderRef)) throw failure(harness.provider, entry.id, "source");
      const hitIds = new Set(hits.map((hit) => hit.canonicalId));
      const expectedHits = entry.expectedCanonicalIds.filter((id) => hitIds.has(id));
      const qualityDetail = `expected=${JSON.stringify(entry.expectedCanonicalIds)} actual=${JSON.stringify(hits.map((hit) => hit.canonicalId))}`;
      if (entry.answerable && expectedHits.length === 0) throw failure(harness.provider, entry.id, "quality", qualityDetail);
      if (!entry.answerable && hits.length > 0) throw failure(harness.provider, entry.id, "refusal", qualityDetail);
      results.push({ caseId: entry.id, nativeSearchCalls, topK, repoIds: [...new Set(hits.map((hit) => hit.repoId))], latencyMs, expectedHits, hits });
    }
  } finally {
    await harness.cleanup();
    lifecycle.visibleAfterCleanup = await harness.isWorkspaceVisible(workspaceId);
  }
  if (lifecycle.visibleAfterCleanup) throw failure(harness.provider, "lifecycle", "cleanup");
  return { provider: harness.provider, lifecycle, qualityInputs: cases, cases: results };
}
