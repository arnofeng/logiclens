import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import type { ParsedGraphFile, RepoNode } from "../src/parsers/types.js";

const openAiMock = vi.hoisted(() => {
  const create = vi.fn(async ({ input }: { input: string | string[] }) => {
    const inputs = Array.isArray(input) ? input : [input];
    return {
      data: inputs.map((text, index) => ({ embedding: [text.length, index] }))
    };
  });
  const client = vi.fn(function () {
    return { embeddings: { create } };
  });
  return { create, client };
});

vi.mock("openai", () => ({ default: openAiMock.client }));

describe("embedding batching", () => {
  beforeEach(() => {
    openAiMock.create.mockClear();
    openAiMock.client.mockClear();
    openAiMock.create.mockImplementation(async ({ input }: { input: string | string[] }) => {
      const inputs = Array.isArray(input) ? input : [input];
      return {
        data: inputs.map((text, index) => ({ embedding: [text.length, index] }))
      };
    });
  });

  it("embeds multiple texts with one OpenAI request in order", async () => {
    const { embedTexts } = await import("../src/semantic/embeddings.js");
    const longText = "x".repeat(8100);

    const embeddings = await embedTexts(["alpha", longText], {
      apiKey: "key",
      baseURL: "https://embedding.example.com/v1",
      model: "test-embedding"
    });

    expect(openAiMock.client).toHaveBeenCalledTimes(1);
    expect(openAiMock.client).toHaveBeenCalledWith({ apiKey: "key", baseURL: "https://embedding.example.com/v1" });
    expect(openAiMock.create).toHaveBeenCalledTimes(1);
    expect(openAiMock.create).toHaveBeenCalledWith(
      { model: "test-embedding", input: ["alpha", "x".repeat(8000)] },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(embeddings).toEqual([[5, 0], [8000, 1]]);
  });

  it("returns empty embeddings without an api key", async () => {
    const { embedTexts } = await import("../src/semantic/embeddings.js");

    await expect(embedTexts(["alpha", "beta"], { apiKey: "" })).resolves.toEqual([undefined, undefined]);
    expect(openAiMock.create).not.toHaveBeenCalled();
  });

  it("does not read OPENAI_API_KEY in the low-level embedding helper", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "env-key";
    const { embedTexts } = await import("../src/semantic/embeddings.js");

    try {
      await expect(embedTexts(["alpha"])).resolves.toEqual([undefined]);
      expect(openAiMock.client).not.toHaveBeenCalled();
      expect(openAiMock.create).not.toHaveBeenCalled();
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it("splits payload/input embedding batch failures and keeps successful single items", async () => {
    const { embedTexts } = await import("../src/semantic/embeddings.js");
    openAiMock.create.mockImplementation(async ({ input }: { input: string | string[] }) => {
      const inputs = Array.isArray(input) ? input : [input];
      if (inputs.length > 1) throw Object.assign(new Error("payload too large"), { status: 413 });
      return { data: inputs.map((text, index) => ({ embedding: [text.length, index] })) };
    });

    await expect(embedTexts(["alpha", "beta"], {
      apiKey: "key",
      providerPolicy: { retry: { maxRetries: 0, timeoutMs: 0 } }
    })).resolves.toEqual([[5, 0], [4, 0]]);
    expect(openAiMock.create).toHaveBeenCalledTimes(3);
    expect(openAiMock.create.mock.calls.map(([call]) => (call.input as string[]).length)).toEqual([2, 1, 1]);
  });

  it("does not split global embedding failures such as auth or 5xx errors", async () => {
    const { embedTexts } = await import("../src/semantic/embeddings.js");
    openAiMock.create.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));

    await expect(embedTexts(["alpha", "beta"], {
      apiKey: "key",
      providerPolicy: { retry: { maxRetries: 0, timeoutMs: 0 } }
    })).rejects.toMatchObject({ kind: "permanent-failed", status: 401 });
    expect(openAiMock.create).toHaveBeenCalledTimes(1);

    openAiMock.create.mockClear();
    openAiMock.create.mockRejectedValue(Object.assign(new Error("server failed"), { status: 503 }));
    await expect(embedTexts(["alpha", "beta"], {
      apiKey: "key",
      providerPolicy: { retry: { maxRetries: 0, timeoutMs: 0 } }
    })).rejects.toMatchObject({ kind: "transient-failed", status: 503 });
    expect(openAiMock.create).toHaveBeenCalledTimes(1);
  });

  it("batches changed semantic records and skips cached records", async () => {
    const { indexSemanticText } = await import("../src/semantic/semanticIndex.js");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-embedding-batch-"));
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
    const parsedFiles: ParsedGraphFile[] = [1, 2, 3].map((index) => ({
      repoId: repo.id,
      fileId: `file:test:${index}`,
      path: `src/file${index}.ts`,
      language: "typescript",
      hash: `hash-${index}`,
      loc: 3,
      imports: [],
      calls: [],
      symbols: [{
        id: `code:test:${index}`,
        repoId: repo.id,
        fileId: `file:test:${index}`,
        kind: "function",
        name: `handler${index}`,
        qualifiedName: `handler${index}`,
        startLine: 1,
        endLine: 3,
        signature: `export function handler${index}()`,
        source: `export function handler${index}() { return ${index}; }`,
        hash: `symbol-${index}`
      }]
    }));
    const config = configSchema.parse({
      embedding: {
        level: "file",
        batchSize: 2,
        concurrency: 1
      }
    });

    await indexSemanticText({ cwd, repos: [repo], parsedFiles, apiKey: "key", config });

    expect(openAiMock.create).toHaveBeenCalledTimes(3);
    expect(openAiMock.create.mock.calls.map(([call]) => (call.input as string[]).length)).toEqual([2, 2, 1]);
    const indexPath = path.join(cwd, ".logiclens", "semantic-index.json");
    const records = JSON.parse(await fs.readFile(indexPath, "utf8")) as { nodeId: string; embedding?: number[] }[];
    expect(records).toHaveLength(5);
    expect(records.every((record) => Array.isArray(record.embedding))).toBe(true);

    openAiMock.create.mockClear();
    await indexSemanticText({ cwd, repos: [repo], parsedFiles, apiKey: "key", config });

    expect(openAiMock.create).not.toHaveBeenCalled();
  });

  it("does not treat records without embeddings as cached", async () => {
    const { indexSemanticText } = await import("../src/semantic/semanticIndex.js");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-embedding-missing-cache-"));
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
      path: "src/source.ts",
      language: "typescript",
      hash: "hash",
      loc: 3,
      imports: [],
      calls: [],
      symbols: []
    }];
    const config = configSchema.parse({ embedding: { level: "file", batchSize: 2, concurrency: 1 } });

    await indexSemanticText({ cwd, repos: [repo], parsedFiles, apiKey: "", config });
    expect(openAiMock.create).not.toHaveBeenCalled();
    const indexPath = path.join(cwd, ".logiclens", "semantic-index.json");
    const recordsWithoutEmbeddings = JSON.parse(await fs.readFile(indexPath, "utf8")) as { embedding?: number[] }[];
    expect(recordsWithoutEmbeddings.every((record) => record.embedding === undefined)).toBe(true);

    await indexSemanticText({ cwd, repos: [repo], parsedFiles, apiKey: "key", config });
    expect(openAiMock.create).toHaveBeenCalledTimes(2);
    const recordsWithEmbeddings = JSON.parse(await fs.readFile(indexPath, "utf8")) as { embedding?: number[] }[];
    expect(recordsWithEmbeddings.every((record) => Array.isArray(record.embedding))).toBe(true);
  });

  it("only indexes docs and repo level metadata when level is docs", async () => {
    const { indexSemanticText } = await import("../src/semantic/semanticIndex.js");
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-embedding-docs-level-"));
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
    const parsedFiles: ParsedGraphFile[] = [
      {
        repoId: repo.id,
        fileId: "file:test:md",
        path: "README.md",
        language: "markdown",
        hash: "hash-md",
        loc: 10,
        sections: [
          {
            id: "section:test:intro",
            repoId: repo.id,
            fileId: "file:test:md",
            level: 1,
            heading: "Intro",
            text: "This is intro documentation.",
            summary: "Intro details",
            startLine: 1,
            endLine: 10,
            hash: "section-hash",
            links: [],
            codeBlocks: []
          }
        ],
        links: [],
        codeBlocks: []
      },
      {
        repoId: repo.id,
        fileId: "file:test:code",
        path: "src/source.ts",
        language: "typescript",
        hash: "hash-code",
        loc: 3,
        imports: [],
        calls: [],
        symbols: [
          {
            id: "code:test:func",
            repoId: repo.id,
            fileId: "file:test:code",
            kind: "function",
            name: "func",
            qualifiedName: "func",
            startLine: 1,
            endLine: 3,
            signature: "export function func()",
            source: "export function func() {}",
            hash: "hash-func"
          }
        ]
      }
    ];

    const config = configSchema.parse({
      embedding: {
        level: "docs",
        batchSize: 2,
        concurrency: 1
      }
    });

    await indexSemanticText({ cwd, repos: [repo], parsedFiles, apiKey: "key", config });

    const indexPath = path.join(cwd, ".logiclens", "semantic-index.json");
    const records = JSON.parse(await fs.readFile(indexPath, "utf8")) as { nodeId: string; nodeKind: string }[];
    
    const kinds = records.map((record) => record.nodeKind);
    expect(kinds).toContain("System");
    expect(kinds).toContain("Repo");
    expect(kinds).toContain("File");
    expect(kinds).toContain("Section");
    expect(kinds).not.toContain("Code");
    
    const paths = records.filter(r => r.nodeKind === "File").map(r => r.nodeId);
    expect(paths).toContain("file:test:md");
    expect(paths).not.toContain("file:test:code");
  });
});
