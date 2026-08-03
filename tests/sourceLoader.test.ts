import { describe, expect, it, vi } from "vitest";
import { createRenderRef } from "../src/core/retrieval/renderRef.js";
import { WorkspaceLexicalStoreError, type WorkspaceLexicalStore } from "../src/core/retrieval/provider.js";
import type { LexicalDocument } from "../src/core/retrieval/types.js";
import { createRetrievalCandidate } from "../src/features/ask/candidates.js";
import { reciprocalRankFusion, type FusedRetrievalCandidate } from "../src/features/ask/fusion.js";
import { loadSelectedEvidence } from "../src/features/ask/sourceLoader.js";

const WORKSPACE_ID = "workspace:test";
const GENERATION = "generation:test";

function loadEvidence(
  input: Omit<Parameters<typeof loadSelectedEvidence>[0], "generation">
): ReturnType<typeof loadSelectedEvidence> {
  return loadSelectedEvidence({ ...input, generation: GENERATION });
}

function fixture(id: string, overrides: Partial<LexicalDocument> = {}): { candidate: FusedRetrievalCandidate; document: LexicalDocument } {
  const repoId = "repo:a";
  const canonicalId = `code:${id}`;
  const renderRef = createRenderRef({ workspaceId: WORKSPACE_ID, repoId, kind: "code", canonicalId, fileId: `file:${id}`, path: `src/${id}.ts`, startLine: 2, endLine: 3 });
  const document: LexicalDocument = {
    id: `doc:${id}`, canonicalId, workspaceId: WORKSPACE_ID, repoId, kind: "code", title: id,
    path: `src/${id}.ts`, searchableText: `function ${id}() {}`, tokens: [id], active: true,
    sourceHash: "hash", batchId: "batch", renderRef, ...overrides
  };
  const candidate = reciprocalRankFusion([createRetrievalCandidate({
    canonicalId, repoId, kind: "code", routes: [{ route: "lexical", rank: 1, documentIds: [document.id] }],
    provenance: [{ route: "lexical", rank: 1, confidence: "discovery", documentId: document.id, renderRef }],
    matchReasons: ["lexical"], confidence: "discovery"
  })])[0]!;
  return { candidate, document };
}

function store(loadDocuments: WorkspaceLexicalStore["loadDocuments"]): WorkspaceLexicalStore {
  return { loadDocuments } as WorkspaceLexicalStore;
}

describe("selected evidence source loader", () => {
  it("loads only selected IDs once, deduplicates, and preserves selected order", async () => {
    const a = fixture("a");
    const b = fixture("b");
    const unselected = fixture("unselected");
    const load = vi.fn(async ({ documentIds, generation }) => {
      expect(generation).toBe(GENERATION);
      expect(documentIds).toEqual([a.document.id, b.document.id]);
      return [b.document, a.document, unselected.document];
    });
    const result = await loadEvidence({ workspaceId: WORKSPACE_ID, selectedCandidates: [a.candidate, a.candidate, b.candidate], store: store(load) });
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.queryCount).toBe(1);
    expect(result.evidence.map(({ document }) => document.id)).toEqual([a.document.id, b.document.id]);
  });

  it("does not call the provider when no selected provenance is loadable", async () => {
    const load = vi.fn();
    const result = await loadEvidence({ workspaceId: WORKSPACE_ID, selectedCandidates: [], store: store(load) });
    expect(load).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "skipped", queryCount: 0, evidence: [] });
  });

  it("bounds the batch and loaded evidence by the public topK document limit", async () => {
    const a = fixture("a");
    const b = fixture("b");
    const load = vi.fn(async ({ documentIds }) => {
      expect(documentIds).toEqual([a.document.id]);
      return [a.document, b.document];
    });
    const result = await loadEvidence({
      workspaceId: WORKSPACE_ID,
      selectedCandidates: [a.candidate, b.candidate],
      maxDocuments: 1,
      store: store(load),
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.evidence.map(({ document }) => document.id)).toEqual([a.document.id]);
  });

  it("rejects inactive, missing, cross-workspace, malformed, and identity-mismatched evidence independently", async () => {
    const valid = fixture("valid");
    const inactive = fixture("inactive", { active: false });
    const missing = fixture("missing");
    const mismatch = fixture("mismatch", { canonicalId: "code:other" });
    const cross = fixture("cross");
    const crossRef = createRenderRef({ workspaceId: "workspace:other", repoId: "repo:a", kind: "code", canonicalId: cross.candidate.canonicalId, fileId: "file:cross", path: "src/cross.ts" });
    const crossCandidate = reciprocalRankFusion([createRetrievalCandidate({
      ...cross.candidate,
      provenance: [{ route: "lexical", rank: 1, confidence: "discovery", documentId: cross.document.id, renderRef: crossRef }]
    })])[0]!;
    const malformed = reciprocalRankFusion([createRetrievalCandidate({
      ...cross.candidate,
      canonicalId: "code:malformed",
      provenance: [{ route: "lexical", rank: 1, confidence: "discovery", documentId: "doc:malformed", renderRef: "bad-ref" }]
    })])[0]!;
    const result = await loadEvidence({
      workspaceId: WORKSPACE_ID,
      selectedCandidates: [valid.candidate, inactive.candidate, missing.candidate, mismatch.candidate, crossCandidate, malformed],
      store: store(vi.fn(async () => [valid.document, inactive.document, mismatch.document]))
    });
    expect(result.evidence.map(({ document }) => document.id)).toEqual([valid.document.id]);
    expect(result.rejections.map(({ reason }) => reason)).toEqual(expect.arrayContaining([
      "inactive_document", "missing_document", "cross_workspace", "malformed_render_ref", "document_identity_mismatch"
    ]));
  });

  it("classifies operational provider failures and rethrows ordinary errors", async () => {
    const a = fixture("a");
    const operational = await loadEvidence({
      workspaceId: WORKSPACE_ID,
      selectedCandidates: [a.candidate],
      store: store(async () => { throw new WorkspaceLexicalStoreError("load_failed", { operation: "loadDocuments", workspaceId: WORKSPACE_ID }, { cause: new Error("secret") }); })
    });
    expect(operational).toMatchObject({ status: "failed", queryCount: 1, reason: "provider_failed", evidence: [] });
    expect(JSON.stringify(operational)).not.toContain("secret");
    await expect(loadEvidence({ workspaceId: WORKSPACE_ID, selectedCandidates: [a.candidate], store: store(async () => { throw new Error("programming bug"); }) })).rejects.toThrow("programming bug");
  });

  it("reports provider unavailability without issuing a query", async () => {
    const a = fixture("a");
    const result = await loadEvidence({ workspaceId: WORKSPACE_ID, selectedCandidates: [a.candidate], storeUnavailable: true });
    expect(result).toMatchObject({ status: "unavailable", queryCount: 0, reason: "provider_unavailable", evidence: [] });
  });
});
