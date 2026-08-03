import { describe, expect, it } from "vitest";
import { createCypherCrud, type CypherExecutor } from "../src/core/graph-model/cypherCrud.js";
import type { CodeSymbol, FileNode, SemanticRelationEdge } from "../src/core/parsing/types.js";
import type { GraphValue } from "../src/core/graph-model/db.js";

const scope = { workspaceId: "workspace:test", generation: "generation:test" };

type QueryCall = {
  cypher: string;
  params?: Record<string, GraphValue>;
};

function createExecutor(rows: unknown[] = []): { executor: CypherExecutor; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    executor: {
      async query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
        calls.push({ cypher, params });
        return rows as T[];
      }
    }
  };
}

function fileNode(input: Partial<FileNode> = {}): FileNode {
  return {
    id: "file:1",
    repoId: "repo:1",
    path: "src/index.ts",
    directory: "src",
    language: "typescript",
    hash: "hash",
    loc: 10,
    ...input
  };
}

function codeNode(input: Partial<CodeSymbol> = {}): CodeSymbol {
  return {
    id: "code:1",
    repoId: "repo:1",
    fileId: "file:1",
    kind: "function",
    name: "main",
    qualifiedName: "main",
    startLine: 1,
    endLine: 2,
    signature: "main()",
    source: "function main() {}",
    hash: "hash",
    ...input
  };
}

describe("createCypherCrud", () => {
  it("normalizes optional file fields when upserting a single file", async () => {
    const { executor, calls } = createExecutor();
    const crud = createCypherCrud(executor);

    await crud.upsertFile(fileNode(), scope);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cypher).toContain("MERGE (n:File {storageId: row.storageId})");
    expect(calls[0]!.params?.row).toEqual(expect.objectContaining({
      id: "file:1",
      workspaceId: scope.workspaceId,
      generation: scope.generation,
      batchId: "",
      indexedAt: "",
      active: true
    }));
  });

  it("does not call query for empty batches", async () => {
    const { executor, calls } = createExecutor();
    const crud = createCypherCrud(executor);

    await crud.upsertFilesBatch([], scope);
    await crud.upsertCodeBatch([], scope);

    expect(calls).toHaveLength(0);
  });

  it("splits batch writes at 5000 rows", async () => {
    const { executor, calls } = createExecutor();
    const crud = createCypherCrud(executor);
    const files = Array.from({ length: 5001 }, (_, index) => fileNode({ id: `file:${index}` }));

    await crud.upsertFilesBatch(files, scope);

    expect(calls).toHaveLength(2);
    expect((calls[0]!.params!.batch as GraphValue[]).length).toBe(5000);
    expect((calls[1]!.params!.batch as GraphValue[]).length).toBe(1);
  });

  it("normalizes optional code fields in batch writes", async () => {
    const { executor, calls } = createExecutor();
    const crud = createCypherCrud(executor);

    await crud.upsertCodeBatch([codeNode()], scope);

    const batch = calls[0]!.params!.batch as Array<Record<string, GraphValue>>;
    expect(batch[0]).toEqual(expect.objectContaining({
      summary: "",
      workspaceId: scope.workspaceId,
      generation: scope.generation,
      batchId: "",
      indexedAt: "",
      active: true
    }));
  });

  it("merges semantic relations by logical identity while retaining deterministic evidence attributes", async () => {
    const { executor, calls } = createExecutor();
    const crud = createCypherCrud(executor);
    const relations: SemanticRelationEdge[] = [
      {
        fromSpecId: "spec:source",
        toSpecId: "spec:target",
        kind: "USES_SCHEMA",
        evidenceId: "evidence:low",
        reason: "lower confidence path",
        confidence: 0.7
      },
      {
        fromSpecId: "spec:source",
        toSpecId: "spec:target",
        kind: "USES_SCHEMA",
        evidenceId: "evidence:high",
        reason: "higher confidence path",
        confidence: 0.9
      }
    ];

    await crud.addSemanticRelationsBatch(relations, scope);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cypher).toContain("MERGE (a)-[r:SEMANTIC_REL {kind: row.kind}]->(b)");
    expect(calls[0]!.cypher).not.toContain("evidenceId: row.evidenceId");
    const batch = calls[0]!.params!.batch as Array<Record<string, GraphValue>>;
    expect(batch).toHaveLength(1);
    expect(batch[0]).toEqual(expect.objectContaining({
      kind: "USES_SCHEMA",
      evidenceId: "evidence:high",
      reason: "higher confidence path",
      confidence: 0.9
    }));
  });
});
