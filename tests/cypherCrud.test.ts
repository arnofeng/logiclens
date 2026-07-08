import { describe, expect, it } from "vitest";
import { createCypherCrud, type CypherExecutor } from "../src/core/graph-model/cypherCrud.js";
import type { CodeSymbol, FileNode } from "../src/core/parsing/types.js";
import type { GraphValue } from "../src/core/graph-model/db.js";

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

    await crud.upsertFile(fileNode());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cypher).toContain("MERGE (f:File {id: $id})");
    expect(calls[0]!.params).toEqual(expect.objectContaining({
      batchId: "",
      indexedAt: "",
      active: true
    }));
  });

  it("does not call query for empty batches", async () => {
    const { executor, calls } = createExecutor();
    const crud = createCypherCrud(executor);

    await crud.upsertFilesBatch([]);
    await crud.upsertCodeBatch([]);

    expect(calls).toHaveLength(0);
  });

  it("splits batch writes at 5000 rows", async () => {
    const { executor, calls } = createExecutor();
    const crud = createCypherCrud(executor);
    const files = Array.from({ length: 5001 }, (_, index) => fileNode({ id: `file:${index}` }));

    await crud.upsertFilesBatch(files);

    expect(calls).toHaveLength(2);
    expect((calls[0]!.params!.batch as GraphValue[]).length).toBe(5000);
    expect((calls[1]!.params!.batch as GraphValue[]).length).toBe(1);
  });

  it("normalizes optional code fields in batch writes", async () => {
    const { executor, calls } = createExecutor();
    const crud = createCypherCrud(executor);

    await crud.upsertCodeBatch([codeNode()]);

    const batch = calls[0]!.params!.batch as Array<Record<string, GraphValue>>;
    expect(batch[0]).toEqual(expect.objectContaining({
      summary: "",
      batchId: "",
      indexedAt: "",
      active: true
    }));
  });
});
