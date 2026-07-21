import { describe, expect, it } from "vitest";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import type { EvidenceNode, FileNode, RepoNode } from "../src/core/parsing/types.js";
import { projectLexicalDocuments } from "../src/core/retrieval/projection.js";

const FILE_COUNT = 2_000;
const EVIDENCE_COUNT = 5_000;
const MAX_PROJECTION_DURATION_MS = 5_000;

function largeFacts(): GraphFactsBatch {
  const repo: RepoNode = {
    id: "repo:projection-performance",
    name: "projection-performance",
    path: "fixtures/projection-performance",
    remoteUrl: "",
    branch: "main",
    commitSha: "fixture",
    language: "typescript",
    indexedAt: "2026-07-21T00:00:00.000Z"
  };
  const files: FileNode[] = Array.from({ length: FILE_COUNT }, (_, index) => ({
    id: `file:performance:${index}`,
    repoId: repo.id,
    path: `src/generated/file-${index}.ts`,
    language: "typescript",
    hash: `hash-${index}`,
    loc: 10,
    batchId: "batch:projection-performance",
    indexedAt: "2026-07-21T00:00:00.000Z",
    active: true
  }));
  const evidence: EvidenceNode[] = Array.from({ length: EVIDENCE_COUNT }, (_, index) => {
    const file = files[index % files.length]!;
    return {
      id: `evidence:performance:${index}`,
      repoId: repo.id,
      fileId: file.id,
      filePath: file.path,
      line: 1,
      raw: `fixture evidence ${index}`,
      rule: "performance-fixture",
      confidence: 0.9,
      batchId: "batch:projection-performance",
      indexedAt: "2026-07-21T00:00:00.000Z",
      active: true
    };
  });
  return {
    batchId: "batch:projection-performance",
    indexedAt: "2026-07-21T00:00:00.000Z",
    repos: [repo],
    parsedFiles: [],
    files,
    code: [],
    sections: [],
    entities: [],
    operations: [],
    workflows: [],
    contracts: [],
    evidence,
    contains: [],
    imports: [],
    calls: [],
    mentions: [],
    sectionDescribesRepos: [],
    sectionDocumentsCode: [],
    sectionReferencesFile: [],
    repoContracts: [],
    packageUsages: [],
    contractEntities: [],
    operationRepos: [],
    workflowOperations: [],
    repoDependencies: [],
    contractSpecs: [],
    contractSpecEdges: [],
    semanticRelations: [],
    crossRepo: {} as GraphFactsBatch["crossRepo"]
  };
}

describe("lexical projection performance", () => {
  it("projects a large located-fact corpus without rescanning every file per document", () => {
    const facts = largeFacts();
    const started = performance.now();
    const documents = projectLexicalDocuments(facts, "workspace:projection-performance");
    const durationMs = performance.now() - started;

    expect(documents).toHaveLength(1 + FILE_COUNT + EVIDENCE_COUNT);
    expect(durationMs, `projection took ${durationMs.toFixed(1)}ms`).toBeLessThanOrEqual(MAX_PROJECTION_DURATION_MS);
  }, 10_000);
});
