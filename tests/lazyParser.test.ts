import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { parserRegistry } from "../src/core/registries/registry.js";
import {
  parseSourceFile,
  registerBuiltinParsers
} from "../src/core/parsing/parserRegistry.js";
import {
  getLanguageDefinition,
  getLoadedLanguageGrammar
} from "../src/core/parsing/languages/registry.js";
import type { ParsedFile, RepoNode } from "../src/core/parsing/types.js";
import { fileId, repoId } from "../src/shared/path.js";

describe("lazy tree-sitter parsers", () => {
  it("registers parsers without loading grammars and deduplicates concurrent first parses", async () => {
    const definition = getLanguageDefinition("go")!;
    const originalLoadGrammar = definition.loadGrammar;
    const loadGrammar = vi.fn(originalLoadGrammar);
    definition.loadGrammar = loadGrammar;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-lazy-go-"));
    const firstPath = path.join(dir, "first.go");
    const secondPath = path.join(dir, "second.go");
    await fs.writeFile(firstPath, "package main\nfunc first() {}\n", "utf8");
    await fs.writeFile(secondPath, "package main\nfunc second() {}\n", "utf8");

    try {
      await registerBuiltinParsers(new Set(["go"]));
      expect(parserRegistry.resolve({ language: "go" })).toBeDefined();
      expect(getLoadedLanguageGrammar("go")).toBeUndefined();

      await Promise.all([
        parseSourceFile({ repoId: repoId("go"), absolutePath: firstPath, relativePath: "first.go", language: "go" }),
        parseSourceFile({ repoId: repoId("go"), absolutePath: secondPath, relativePath: "second.go", language: "go" })
      ]);

      expect(loadGrammar).toHaveBeenCalledTimes(1);
      expect(getLoadedLanguageGrammar("go")).toBeDefined();
    } finally {
      definition.loadGrammar = originalLoadGrammar;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("retries grammar loading after the first load fails", async () => {
    const definition = getLanguageDefinition("python")!;
    const originalLoadGrammar = definition.loadGrammar;
    const loadGrammar = vi.fn()
      .mockRejectedValueOnce(new Error("temporary grammar load failure"))
      .mockImplementation(originalLoadGrammar);
    definition.loadGrammar = loadGrammar;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-lazy-python-"));
    const absolutePath = path.join(dir, "app.py");
    await fs.writeFile(absolutePath, "def run():\n    return 1\n", "utf8");
    const input = {
      repoId: repoId("python"),
      absolutePath,
      relativePath: "app.py",
      language: "python"
    } as const;

    try {
      await registerBuiltinParsers(new Set(["python"]));
      expect(getLoadedLanguageGrammar("python")).toBeUndefined();
      await expect(parseSourceFile(input)).rejects.toThrow("temporary grammar load failure");
      expect(getLoadedLanguageGrammar("python")).toBeUndefined();

      const parsed = await parseSourceFile(input);
      expect(parsed.language).toBe("python");
      expect(loadGrammar).toHaveBeenCalledTimes(2);
      expect(getLoadedLanguageGrammar("python")).toBeDefined();
    } finally {
      definition.loadGrammar = originalLoadGrammar;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a TypeScript grammar only when the registered parser first parses", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-lazy-typescript-"));
    const absolutePath = path.join(dir, "app.ts");
    await fs.writeFile(absolutePath, "export const value = 1;\n", "utf8");

    try {
      await registerBuiltinParsers(new Set(["typescript"]));
      expect(parserRegistry.resolve({ language: "typescript" })).toBeDefined();
      expect(getLoadedLanguageGrammar("typescript")).toBeUndefined();

      await parseSourceFile({
        repoId: repoId("typescript"),
        absolutePath,
        relativePath: "app.ts",
        language: "typescript"
      });
      expect(getLoadedLanguageGrammar("typescript")).toBeDefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("prepares grammars for pre-parsed source files before graph fact extraction", async () => {
    const repo: RepoNode = {
      id: repoId("preparsed-java"),
      name: "preparsed-java",
      path: ".",
      remoteUrl: "",
      branch: "",
      commitSha: "",
      language: "java",
      indexedAt: "now"
    };
    const relativePath = "src/App.java";
    const parsed: ParsedFile = {
      repoId: repo.id,
      fileId: fileId(repo.id, relativePath),
      path: relativePath,
      language: "java",
      hash: "preparsed-java-hash",
      loc: 2,
      source: "package sample;\nclass App { void run() {} }\n",
      imports: [],
      symbols: [],
      calls: []
    };

    expect(getLoadedLanguageGrammar("java")).toBeUndefined();
    const facts = await buildGraphFactsBatch({
      batchId: "batch:preparsed-java",
      repos: [repo],
      parsedFiles: [parsed],
      semantic: false
    });

    expect(facts.files).toHaveLength(1);
    expect(getLoadedLanguageGrammar("java")).toBeDefined();
  });
});
