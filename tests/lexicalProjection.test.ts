import { describe, expect, it } from "vitest";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import { projectFileDocuments, projectRepoDocuments } from "../src/core/retrieval/projection.js";
import { parseRenderRef } from "../src/core/retrieval/renderRef.js";

function fixtureFacts(): GraphFactsBatch {
  return {
    batchId: "batch:fallback",
    indexedAt: "2026-01-01T00:00:00.000Z",
    repos: [
      { id: "repo:z", name: "Zulu", path: "C:\\private\\zulu", remoteUrl: "https://example.test/zulu.git", branch: "main", commitSha: "abc", language: "TypeScript", indexedAt: "2026-01-01", active: false, batchId: "batch:repo" },
      { id: "repo:a", name: "Alpha", path: "/private/alpha", remoteUrl: "", branch: "dev", commitSha: "def", language: "Go", indexedAt: "2026-01-01", summary: "Order API" }
    ],
    files: [
      { id: "file:z", repoId: "repo:z", path: "src\\orders\\OrderService.ts", language: "typescript", hash: "hash:z", loc: 20, batchId: "batch:file", indexedAt: "2026-01-01", active: false },
      { id: "file:a", repoId: "repo:a", path: "docs/订单.md", language: "markdown", hash: "hash:a", loc: 10 }
    ]
  } as unknown as GraphFactsBatch;
}

describe("repo/file lexical projection", () => {
  it("projects multiple repositories with stable ownership and lifecycle", () => {
    const facts = fixtureFacts();
    const repos = projectRepoDocuments(facts, "workspace:a");
    const files = projectFileDocuments(facts, "workspace:a");
    expect(repos).toHaveLength(2);
    expect(files).toHaveLength(2);
    expect(repos.find((document) => document.repoId === "repo:z")).toMatchObject({ canonicalId: "repo:z", batchId: "batch:repo", active: false });
    expect(repos.find((document) => document.repoId === "repo:a")).toMatchObject({ canonicalId: "repo:a", batchId: "batch:fallback", active: true });
    expect(files.find((document) => document.canonicalId === "file:z")).toMatchObject({ repoId: "repo:z", batchId: "batch:file", active: false, path: "src/orders/OrderService.ts" });
    expect(files.find((document) => document.canonicalId === "file:a")).toMatchObject({ repoId: "repo:a", batchId: "batch:fallback", active: true });
  });

  it("creates parseable render references and workspace-scoped identities", () => {
    const facts = fixtureFacts();
    const repo = projectRepoDocuments(facts, "workspace:a")[0]!;
    const file = projectFileDocuments(facts, "workspace:a")[0]!;
    expect(parseRenderRef(repo.renderRef, "workspace:a")).toMatchObject({ kind: "repo", canonicalId: repo.canonicalId, repoId: repo.repoId });
    expect(parseRenderRef(file.renderRef, "workspace:a")).toMatchObject({ kind: "file", canonicalId: file.canonicalId, repoId: file.repoId, fileId: file.canonicalId, path: file.path });
    expect(projectRepoDocuments(facts, "workspace:b").map((document) => document.id)).not.toEqual(projectRepoDocuments(facts, "workspace:a").map((document) => document.id));
  });

  it("is byte-for-byte deterministic and ignores indexedAt", () => {
    const facts = fixtureFacts();
    const first = JSON.stringify({ repos: projectRepoDocuments(facts, "workspace:a"), files: projectFileDocuments(facts, "workspace:a") });
    facts.indexedAt = "2099-01-01T00:00:00.000Z";
    facts.repos[0]!.indexedAt = "2099-01-01";
    facts.files[0]!.indexedAt = "2099-01-01";
    const second = JSON.stringify({ repos: projectRepoDocuments(facts, "workspace:a"), files: projectFileDocuments(facts, "workspace:a") });
    expect(second).toBe(first);
  });

  it("changes source hashes for effective file changes and always sorts by document id", () => {
    const facts = fixtureFacts();
    const before = projectFileDocuments(facts, "workspace:a");
    facts.files[0]!.hash = "changed";
    facts.files[1]!.path = "docs/库存.md";
    const after = projectFileDocuments(facts, "workspace:a");
    for (const documents of [projectRepoDocuments(facts, "workspace:a"), after]) {
      expect(documents.map((document) => document.id)).toEqual(documents.map((document) => document.id).sort());
    }
    expect(after.find((document) => document.canonicalId === "file:z")!.sourceHash).not.toBe(before.find((document) => document.canonicalId === "file:z")!.sourceHash);
    expect(after.find((document) => document.canonicalId === "file:a")!.sourceHash).not.toBe(before.find((document) => document.canonicalId === "file:a")!.sourceHash);
  });

  it("never exposes local repository paths or file contents", () => {
    const facts = fixtureFacts();
    const repoJson = JSON.stringify(projectRepoDocuments(facts, "workspace:a"));
    const files = projectFileDocuments(facts, "workspace:a");
    expect(repoJson).not.toContain("C:\\\\private");
    expect(repoJson).not.toContain("/private/alpha");
    expect(files.every((document) => !("source" in document) && !("contents" in document))).toBe(true);
  });
});
