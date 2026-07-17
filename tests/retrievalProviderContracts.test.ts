import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  WorkspaceLexicalStoreError,
  type CleanupBatchRequest,
  type GraphProviderCapabilities,
  type LoadDocumentsRequest,
  type NativeLexicalCapabilities,
  type ReconcileRepoDocumentsRequest,
  type WorkspaceLexicalStore,
  type WorkspaceLexicalStoreErrorCode,
  type WorkspaceLexicalStoreErrorContext
} from "../src/core/retrieval/provider.js";
import type {
  LexicalDocument,
  LexicalHit,
  LexicalIndexHealth,
  LexicalQuery,
  LexicalSearchOptions
} from "../src/core/retrieval/types.js";

const fakeStore: WorkspaceLexicalStore = {
  async ensureSchema(): Promise<void> {},
  async commitVersions(): Promise<void> {},
  async upsertDocuments(documents: readonly LexicalDocument[]): Promise<void> {
    void documents;
  },
  async reconcileRepoDocuments(request: Readonly<ReconcileRepoDocumentsRequest>): Promise<void> {
    void request;
  },
  async cleanupBatch(request: Readonly<CleanupBatchRequest>): Promise<void> {
    void request;
  },
  async search(
    query: Readonly<LexicalQuery>,
    options: Readonly<LexicalSearchOptions>
  ): Promise<readonly LexicalHit[]> {
    void query;
    void options;
    return [];
  },
  async loadDocuments(request: Readonly<LoadDocumentsRequest>): Promise<readonly LexicalDocument[]> {
    void request;
    return [];
  },
  async health(workspaceId: string): Promise<LexicalIndexHealth> {
    return {
      providerVersion: "fake-1",
      projectionSchemaVersion: "1",
      tokenizerVersion: "1",
      status: workspaceId ? "healthy" : "unavailable",
      reasons: [],
      metrics: { documentCount: 0, indexSizeBytes: 0 }
    };
  }
};

describe("workspace lexical provider contracts", () => {
  it("defines exact method parameters and Promise return types", () => {
    expectTypeOf<Parameters<WorkspaceLexicalStore["ensureSchema"]>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["commitVersions"]>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["upsertDocuments"]>>().toEqualTypeOf<[
      readonly LexicalDocument[]
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["reconcileRepoDocuments"]>>().toEqualTypeOf<[
      Readonly<ReconcileRepoDocumentsRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["cleanupBatch"]>>().toEqualTypeOf<[
      Readonly<CleanupBatchRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["search"]>>().toEqualTypeOf<[
      Readonly<LexicalQuery>,
      Readonly<LexicalSearchOptions>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["loadDocuments"]>>().toEqualTypeOf<[
      Readonly<LoadDocumentsRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["health"]>>().toEqualTypeOf<[string]>();

    expectTypeOf<ReturnType<WorkspaceLexicalStore["ensureSchema"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["commitVersions"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["upsertDocuments"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["reconcileRepoDocuments"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["cleanupBatch"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["search"]>>().toEqualTypeOf<Promise<readonly LexicalHit[]>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["loadDocuments"]>>().toEqualTypeOf<Promise<readonly LexicalDocument[]>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["health"]>>().toEqualTypeOf<Promise<LexicalIndexHealth>>();
    expectTypeOf(fakeStore).toMatchTypeOf<WorkspaceLexicalStore>();
  });

  it("keeps collection inputs readonly", () => {
    expectTypeOf<ReconcileRepoDocumentsRequest["activeDocumentIds"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<LoadDocumentsRequest["documentIds"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["upsertDocuments"]>[0]>().toEqualTypeOf<readonly LexicalDocument[]>();
  });

  it("keeps capability fields exhaustive", () => {
    expectTypeOf<keyof GraphProviderCapabilities>().toEqualTypeOf<"nativeFullText">();
    expectTypeOf<keyof NativeLexicalCapabilities>().toEqualTypeOf<
      "scope" | "updateConsistency" | "supportsFieldBoost" | "supportsPrefix"
    >();
    expectTypeOf<NativeLexicalCapabilities["scope"]>().toEqualTypeOf<"workspace">();
    expectTypeOf<NativeLexicalCapabilities["updateConsistency"]>().toEqualTypeOf<
      "transactional" | "synchronous"
    >();
  });

  it("provides stable discriminable error code and context", () => {
    const code: WorkspaceLexicalStoreErrorCode = "reconcile_failed";
    const context: WorkspaceLexicalStoreErrorContext = {
      operation: "reconcileRepoDocuments",
      workspaceId: "workspace:1",
      repoId: "repo:1",
      batchId: "batch:1"
    };
    const error = new WorkspaceLexicalStoreError(code, context);

    expect(error.code).toBe("reconcile_failed");
    expect(error.context).toEqual(context);
    expectTypeOf(error.code).toEqualTypeOf<WorkspaceLexicalStoreErrorCode>();
    expectTypeOf(error.context).toEqualTypeOf<Readonly<WorkspaceLexicalStoreErrorContext>>();
  });

  it("does not depend on adapter or provider-specific types", async () => {
    const sourcePath = fileURLToPath(new URL("../src/core/retrieval/provider.ts", import.meta.url));
    const source = await readFile(sourcePath, "utf8");
    expect(source).not.toMatch(/adapters|Kuzu|Neo4j|Cypher|FTS score/i);
  });
});
