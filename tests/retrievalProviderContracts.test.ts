import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  WorkspaceLexicalStoreError,
  type CleanupBatchRequest,
  type InitializeLexicalGenerationRequest,
  type DeleteDocumentsRequest,
  type DocumentIdsForSourcesRequest,
  type GraphProviderCapabilities,
  type IncrementalLexicalMutationRequest,
  type LoadDocumentsRequest,
  type LexicalGenerationRequest,
  type NativeLexicalCapabilities,
  type ReconcileRepoDocumentsRequest,
  type ReconcileRepoFileDocumentsRequest,
  type UpsertDocumentsRequest,
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
  async initializeGeneration(request: Readonly<InitializeLexicalGenerationRequest>): Promise<void> {
    void request;
  },
  async deleteGeneration(request: Readonly<LexicalGenerationRequest>): Promise<void> {
    void request;
  },
  async upsertDocuments(request: Readonly<UpsertDocumentsRequest>): Promise<void> {
    void request;
  },
  async deleteDocuments(request: Readonly<DeleteDocumentsRequest>): Promise<void> {
    void request;
  },
  async applyIncrementalMutation(request: Readonly<IncrementalLexicalMutationRequest>): Promise<void> {
    void request;
  },
  async reconcileRepoDocuments(request: Readonly<ReconcileRepoDocumentsRequest>): Promise<void> {
    void request;
  },
  async reconcileRepoFileDocuments(request: Readonly<ReconcileRepoFileDocumentsRequest>): Promise<void> {
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
  async pendingHealth(request: Readonly<LexicalGenerationRequest>): Promise<LexicalIndexHealth> {
    return this.health(request);
  },
  async documentIdsForSources(request: Readonly<DocumentIdsForSourcesRequest>): Promise<readonly string[]> {
    void request;
    return [];
  },
  async health(request: Readonly<LexicalGenerationRequest>): Promise<LexicalIndexHealth> {
    return {
      providerVersion: "fake-1",
      projectionSchemaVersion: "1",
      tokenizerVersion: "1",
      status: request.workspaceId && request.generation ? "healthy" : "unavailable",
      reasons: [],
      metrics: { documentCount: 0, indexSizeBytes: 0 }
    };
  }
};

describe("workspace lexical provider contracts", () => {
  it("defines exact method parameters and Promise return types", () => {
    expectTypeOf<Parameters<WorkspaceLexicalStore["ensureSchema"]>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["commitVersions"]>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["initializeGeneration"]>>().toEqualTypeOf<[
      Readonly<InitializeLexicalGenerationRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["deleteGeneration"]>>().toEqualTypeOf<[
      Readonly<LexicalGenerationRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["upsertDocuments"]>>().toEqualTypeOf<[
      Readonly<UpsertDocumentsRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["deleteDocuments"]>>().toEqualTypeOf<[
      Readonly<DeleteDocumentsRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["applyIncrementalMutation"]>>().toEqualTypeOf<[
      Readonly<IncrementalLexicalMutationRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["reconcileRepoDocuments"]>>().toEqualTypeOf<[
      Readonly<ReconcileRepoDocumentsRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["reconcileRepoFileDocuments"]>>().toEqualTypeOf<[
      Readonly<ReconcileRepoFileDocumentsRequest>
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
    expectTypeOf<Parameters<WorkspaceLexicalStore["documentIdsForSources"]>>().toEqualTypeOf<[
      Readonly<DocumentIdsForSourcesRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["pendingHealth"]>>().toEqualTypeOf<[
      Readonly<LexicalGenerationRequest>
    ]>();
    expectTypeOf<Parameters<WorkspaceLexicalStore["health"]>>().toEqualTypeOf<[
      Readonly<LexicalGenerationRequest>
    ]>();

    expectTypeOf<ReturnType<WorkspaceLexicalStore["ensureSchema"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["commitVersions"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["initializeGeneration"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["deleteGeneration"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["upsertDocuments"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["deleteDocuments"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["applyIncrementalMutation"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["reconcileRepoDocuments"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["reconcileRepoFileDocuments"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["cleanupBatch"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["search"]>>().toEqualTypeOf<Promise<readonly LexicalHit[]>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["loadDocuments"]>>().toEqualTypeOf<Promise<readonly LexicalDocument[]>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["documentIdsForSources"]>>().toEqualTypeOf<Promise<readonly string[]>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["pendingHealth"]>>().toEqualTypeOf<Promise<LexicalIndexHealth>>();
    expectTypeOf<ReturnType<WorkspaceLexicalStore["health"]>>().toEqualTypeOf<Promise<LexicalIndexHealth>>();
    expectTypeOf(fakeStore).toMatchTypeOf<WorkspaceLexicalStore>();
  });

  it("keeps collection inputs readonly", () => {
    expectTypeOf<ReconcileRepoDocumentsRequest["activeDocumentIds"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<LoadDocumentsRequest["documentIds"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<UpsertDocumentsRequest["documents"]>().toEqualTypeOf<readonly LexicalDocument[]>();
    expectTypeOf<DeleteDocumentsRequest["documentIds"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<IncrementalLexicalMutationRequest["deleteDocumentIds"]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<IncrementalLexicalMutationRequest["upsertDocuments"]>().toEqualTypeOf<readonly LexicalDocument[]>();
    expectTypeOf<DocumentIdsForSourcesRequest["fileIds"]>().toEqualTypeOf<readonly string[]>();
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
