import { beforeAll, describe, expect, it } from "vitest";
import { parseJsAst } from "../src/core/contracts/extraction/builtin/jsAstUtils.js";
import { parseSourceAst } from "../src/core/contracts/extraction/builtin/sourceAstUtils.js";
import { ensureBuiltinGrammarsForParsedFiles, registerBuiltinParsers } from "../src/core/parsing/parserRegistry.js";
import type { ParsedFile } from "../src/core/parsing/types.js";

function parsedFile(id: string, source: string): ParsedFile {
  return {
    repoId: "repo:ast-cache",
    fileId: `file:${id}`,
    path: `src/${id}.ts`,
    language: "typescript",
    hash: `hash:${id}`,
    loc: source.split(/\r?\n/).length,
    source,
    imports: [],
    symbols: [],
    calls: []
  };
}

describe("builtin extractor AST cache", () => {
  beforeAll(async () => {
    await registerBuiltinParsers(new Set(["typescript"]));
    await ensureBuiltinGrammarsForParsedFiles([parsedFile("grammar", "export const value = 0;")]);
  });

  it("shares one tree across JS and source utilities for the same parsed file", () => {
    const file = parsedFile("one", "export const value = 1;");
    const js = parseJsAst(file);
    const source = parseSourceAst(file, "typescript");

    expect(js?.tree).toBe(source?.tree);
    expect(js?.source).toBe(file.source);
  });

  it("keeps files isolated and invalidates a mutated source", () => {
    const first = parsedFile("first", "export const value = 1;");
    const second = parsedFile("second", "export const value = 1;");
    const firstTree = parseJsAst(first)?.tree;
    const secondTree = parseJsAst(second)?.tree;
    expect(firstTree).not.toBe(secondTree);

    first.source = "export const value = 2;";
    expect(parseJsAst(first)?.tree).not.toBe(firstTree);
  });
});
