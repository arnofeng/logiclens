import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { extractHeuristicEntities } from "../src/core/semantic/extractEntities.js";
import { buildSemanticRecords, FallbackSemanticIndex, indexSemanticText, JsonSemanticIndex, type SemanticIndex, type SemanticRecord } from "../src/core/semantic/semanticIndex.js";
import { NullEmbeddingProvider } from "../src/core/semantic/embeddings.js";
import type { EmbeddingProvider } from "../src/plugins/types.js";
import type { CodeSymbol, ParsedGraphFile, RepoNode } from "../src/core/parsing/types.js";

describe("semantic heuristics", () => {
  it("extracts domain-looking entities from symbols", () => {
    const symbol: CodeSymbol = {
      id: "code:1",
      repoId: "repo:test",
      fileId: "file:test",
      kind: "class",
      name: "OrderCreatedEvent",
      qualifiedName: "OrderCreatedEvent",
      startLine: 1,
      endLine: 3,
      signature: "export class OrderCreatedEvent",
      source: "export class OrderCreatedEvent {}",
      hash: "hash"
    };
    expect(extractHeuristicEntities(symbol).map((entity) => entity.name)).toContain("OrderCreatedEvent");
  });

  it("supports json and chroma semantic index configuration", () => {
    const defaultConfig = configSchema.parse({});
    expect(defaultConfig.llm.baseUrl).toBeUndefined();
    expect(defaultConfig.embedding.provider).toBe("off");
    expect(defaultConfig.embedding.model).toBeUndefined();
    expect(defaultConfig.embedding.level).toBe("off");
    expect(defaultConfig.embedding.batchSize).toBe(64);
    expect(defaultConfig.embedding.concurrency).toBe(2);
    expect(defaultConfig.embedding.retry.maxRetries).toBe(2);
    expect(defaultConfig.embedding.rateLimit.minDelayMs).toBe(0);
    expect(defaultConfig.indexing.llmSummaryLevel).toBe("off");
    expect(defaultConfig.semantic.provider).toBe("json");
    expect(defaultConfig.semantic.chroma.mode).toBe("local");
    expect(defaultConfig.semantic.chroma.url).toBe("http://localhost:8000");

    const remoteConfig = configSchema.parse({
      semantic: {
        provider: "chroma",
        chroma: {
          mode: "remote",
          url: "https://chroma.example.com",
          collection: "logiclens",
          authToken: "token"
        }
      }
    });
    expect(remoteConfig.semantic.provider).toBe("chroma");
    expect(remoteConfig.semantic.chroma.mode).toBe("remote");
    expect(remoteConfig.semantic.chroma.authToken).toBe("token");
  });

  it("supports separate OpenAI and embedding endpoint configuration", () => {
    const config = configSchema.parse({
      llm: {
        provider: "openai",
        apiKey: "key",
        baseUrl: "https://openai-compatible.example.com/v1",
        model: "gpt-4.1-mini",
        maxSourceCharsPerNode: 6000
      },
      embedding: {
        provider: "openai",
        apiKey: "ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "bge-m3",
        level: "file",
        batchSize: 16,
        concurrency: 3,
        retry: { maxRetries: 4, initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0, timeoutMs: 30000 },
        budget: { maxRequests: 100, maxEstimatedTokens: 50000 },
        rateLimit: { minDelayMs: 25 }
      },
      indexing: {
        llmSummaryLevel: "repo"
      }
    });
    expect(config.llm.baseUrl).toBe("https://openai-compatible.example.com/v1");
    expect(config.embedding.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.embedding.model).toBe("bge-m3");
    expect(config.embedding.level).toBe("file");
    expect(config.embedding.batchSize).toBe(16);
    expect(config.embedding.concurrency).toBe(3);
    expect(config.embedding.retry.maxRetries).toBe(4);
    expect(config.embedding.budget.maxRequests).toBe(100);
    expect(config.embedding.rateLimit.minDelayMs).toBe(25);
    expect(config.indexing.llmSummaryLevel).toBe("repo");
  });

  it("serializes concurrent JSON semantic index upserts with atomic writes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-semantic-atomic-"));
    const indexPath = path.join(dir, "semantic.json");
    const index = new JsonSemanticIndex(indexPath);
    const record = (nodeId: string): SemanticRecord => ({
      nodeId,
      nodeKind: "Code",
      repoId: "repo:test",
      title: nodeId,
      sourceText: `source for ${nodeId}`,
      sourceHash: `${nodeId}:hash`,
      updatedAt: "now"
    });

    await Promise.all([
      index.upsert([record("code:a")]),
      index.upsert([record("code:b")]),
      index.upsert([record("code:c")])
    ]);

    expect((await index.records()).map((row) => row.nodeId).sort()).toEqual(["code:a", "code:b", "code:c"]);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("records fallback events when the primary semantic index fails", async () => {
    const primary: SemanticIndex = {
      records: async () => {
        throw new Error("primary records unavailable");
      },
      upsert: async () => {
        throw new Error("primary upsert unavailable");
      },
      search: async () => {
        throw new Error("primary search unavailable");
      }
    };
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-semantic-fallback-"));
    const fallback = new JsonSemanticIndex(path.join(cwd, "semantic.json"));
    const index = new FallbackSemanticIndex(primary, fallback, cwd);
    const record: SemanticRecord = {
      nodeId: "code:fallback",
      nodeKind: "Code",
      repoId: "repo:test",
      title: "fallback",
      sourceText: "fallback source",
      sourceHash: "hash",
      updatedAt: "now"
    };

    await expect(index.records()).resolves.toEqual([]);
    await expect(index.upsert([record])).resolves.toBeUndefined();
    await expect(index.search("fallback")).resolves.toEqual([expect.objectContaining({ nodeId: "code:fallback" })]);

    expect(index.consumeFallbackEvents()).toEqual([
      { operation: "records", message: "primary records unavailable" },
      { operation: "upsert", message: "primary upsert unavailable" },
      { operation: "search", message: "primary search unavailable" }
    ]);
    expect(index.consumeFallbackEvents()).toEqual([]);
  });

  it("validates LLM summary and embedding levels", () => {
    for (const llmSummaryLevel of ["off", "repo", "file", "node"] as const) {
      expect(configSchema.parse({ indexing: { llmSummaryLevel } }).indexing.llmSummaryLevel).toBe(llmSummaryLevel);
    }
    for (const level of ["off", "repo", "file", "node", "all"] as const) {
      expect(configSchema.parse({ embedding: { level } }).embedding.level).toBe(level);
    }
    expect(() => configSchema.parse({ indexing: { llmSummaryLevel: "symbol" } })).toThrow();
    expect(() => configSchema.parse({ embedding: { level: "section" } })).toThrow();
    expect(() => configSchema.parse({ embedding: { batchSize: 0 } })).toThrow();
    expect(() => configSchema.parse({ embedding: { concurrency: 0 } })).toThrow();
  });

  it("builds semantic records by configured embedding level", () => {
    const repo: RepoNode = {
      id: "repo:test",
      name: "test",
      path: "/repo/test",
      remoteUrl: "",
      branch: "",
      commitSha: "",
      language: "typescript",
      indexedAt: "now",
      summary: "repo summary"
    };
    const parsedFiles: ParsedGraphFile[] = [
      {
        repoId: repo.id,
        fileId: "file:test:source",
        path: "src/OrderController.ts",
        language: "typescript",
        hash: "hash",
        loc: 10,
        imports: [{ fileId: "file:test:source", module: "./OrderService", raw: "import", line: 1 }],
        calls: [],
        symbols: [{
          id: "code:test:OrderController",
          repoId: repo.id,
          fileId: "file:test:source",
          kind: "class",
          name: "OrderController",
          qualifiedName: "OrderController",
          startLine: 1,
          endLine: 3,
          signature: "export class OrderController",
          source: "export class OrderController {}",
          hash: "symbol-hash"
        }]
      },
      {
        repoId: repo.id,
        fileId: "file:test:doc",
        path: "README.md",
        language: "markdown",
        hash: "doc-hash",
        loc: 5,
        links: [],
        codeBlocks: [],
        sections: [{
          id: "section:test:readme",
          repoId: repo.id,
          fileId: "file:test:doc",
          heading: "Events",
          level: 2,
          startLine: 1,
          endLine: 5,
          text: "OrderCreatedEvent",
          hash: "section-hash",
          links: [],
          codeBlocks: []
        }]
      }
    ];

    const kindsFor = (level: "off" | "repo" | "file" | "node" | "all") => buildSemanticRecords({ repos: [repo], parsedFiles, level }).map((record) => record.nodeKind);

    expect(kindsFor("off")).toEqual([]);
    expect(kindsFor("repo")).toEqual(["System", "Repo"]);
    expect(kindsFor("file")).toEqual(["System", "Repo", "File", "File"]);
    expect(kindsFor("node")).toEqual(expect.arrayContaining(["Code", "Section", "Entity"]));
    expect(kindsFor("node")).not.toContain("Repo");
    expect(kindsFor("all")).toEqual(expect.arrayContaining(["System", "Repo", "File", "Code", "Section", "Entity"]));
  });

  it("reports semantic indexing progress for node-level embeddings", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-semantic-progress-"));
    const repo: RepoNode = {
      id: "repo:test",
      name: "test",
      path: "/repo/test",
      remoteUrl: "",
      branch: "",
      commitSha: "",
      language: "typescript",
      indexedAt: "now"
    };
    const parsedFiles: ParsedGraphFile[] = [{
      repoId: repo.id,
      fileId: "file:test:source",
      path: "src/OrderController.ts",
      language: "typescript",
      hash: "hash",
      loc: 10,
      imports: [],
      calls: [],
      symbols: [{
        id: "code:test:OrderController",
        repoId: repo.id,
        fileId: "file:test:source",
        kind: "class",
        name: "OrderController",
        qualifiedName: "OrderController",
        startLine: 1,
        endLine: 3,
        signature: "export class OrderController",
        source: "export class OrderController {}",
        hash: "symbol-hash"
      }]
    }];
    const events: { current: number; total: number; label?: string }[] = [];

    const fakeProvider: EmbeddingProvider = {
      name: "fake",
      async embedTexts(texts) { return texts.map((_, i) => [i]); },
      async embedText(text) { return [text.length]; }
    };
    await indexSemanticText({
      cwd,
      repos: [repo],
      parsedFiles,
      embeddingProvider: fakeProvider,
      config: configSchema.parse({ embedding: { provider: "fake", level: "node" } }),
      progress: (event) => events.push(event)
    });

    expect(events[0]).toMatchObject({ current: 0, label: "prepare embedding batches" });
    expect(events.at(-1)).toMatchObject({ current: 2, total: 2, label: "semantic index written" });
  });

  it("treats empty OpenAI and embedding credentials as unset placeholders", () => {
    const config = configSchema.parse({
      llm: {
        provider: "openai",
        apiKey: "",
        baseUrl: "",
        model: "gpt-4.1-mini",
        maxSourceCharsPerNode: 6000
      },
      embedding: {
        provider: "openai",
        apiKey: "",
        baseUrl: "",
        model: "bge-m3"
      }
    });
    expect(config.llm.apiKey).toBeUndefined();
    expect(config.llm.baseUrl).toBeUndefined();
    expect(config.embedding.apiKey).toBeUndefined();
    expect(config.embedding.baseUrl).toBeUndefined();
  });
});
