import { describe, expect, it } from "vitest";
import { LEXICAL_DOCUMENT_KINDS, LEXICAL_PROJECTION_SCHEMA_VERSION, TOKENIZER_VERSION, type LexicalDocument, type LexicalHit, type LexicalIndexHealth, type LexicalQuery, type LexicalSearchOptions } from "../src/core/retrieval/types.js";

const document: LexicalDocument = { id: "doc:1", canonicalId: "code:1", workspaceId: "workspace:1", repoId: "repo:1", kind: "code", title: "handler", searchableText: "handler", tokens: ["handler"], active: true, sourceHash: "hash", batchId: "batch:1", renderRef: "render:1" };

describe("lexical document contract", () => {
  it("defines the complete, finite document kind set", () => {
    expect(LEXICAL_DOCUMENT_KINDS).toEqual(["repo", "file", "code", "section", "contract", "contractSpec", "operation", "workflow", "entity", "package", "evidence"]);
    expect(LEXICAL_PROJECTION_SCHEMA_VERSION).toBe("5");
  });
  it("requires stable identity and lifecycle fields", () => {
    expect(document).toMatchObject({ workspaceId: "workspace:1", repoId: "repo:1", canonicalId: "code:1", active: true, sourceHash: "hash", batchId: "batch:1", renderRef: "render:1" });
  });
});

describe("lexical index health contract", () => {
  it("is explicit and JSON serializable", () => {
    const health: LexicalIndexHealth = { providerVersion: "provider-1", projectionSchemaVersion: LEXICAL_PROJECTION_SCHEMA_VERSION, tokenizerVersion: TOKENIZER_VERSION, status: "unhealthy", reasons: ["index_missing"], metrics: { documentCount: 0, indexSizeBytes: 0, buildDurationMs: 12 } };
    expect(JSON.parse(JSON.stringify(health))).toEqual(health);
    expect(health.status).toBe("unhealthy");
  });
});

describe("lexical search contract", () => {
  it("uses a workspace-scoped query and global top-k", () => {
    const query: LexicalQuery = {
      workspaceId: "workspace:1",
      generation: "generation:1",
      text: "find handler"
    };
    const options: LexicalSearchOptions = { topK: 5 };
    expect(query.workspaceId).toBe("workspace:1");
    expect(query.generation).toBe("generation:1");
    expect(options.topK).toBe(5);
  });
  it("uses one-based ordered ranks with stable hit identity", () => {
    const hits: LexicalHit[] = [
      { canonicalId: "code:1", documentId: "doc:1", repoId: "repo:a", kind: "code", rank: 1, matchReasons: ["token"], renderRef: "render:1" },
      { canonicalId: "code:2", documentId: "doc:2", repoId: "repo:b", kind: "code", rank: 2, matchReasons: ["title"], renderRef: "render:2" }
    ];
    expect(hits.map((hit) => hit.rank)).toEqual([1, 2]);
    expect(hits.every((hit) => hit.renderRef.length > 0 && hit.matchReasons.length > 0)).toBe(true);
  });
});
