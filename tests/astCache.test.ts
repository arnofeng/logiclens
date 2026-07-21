import { beforeAll, describe, expect, it } from "vitest";
import { astNodeIndexMetrics, astNodesOfTypes } from "../src/core/contracts/extraction/builtin/astCache.js";
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

function parsedJavaFile(id: string, source: string): ParsedFile {
  return {
    ...parsedFile(id, source),
    path: `src/${id}.java`,
    language: "java"
  };
}

describe("builtin extractor AST cache", () => {
  beforeAll(async () => {
    await registerBuiltinParsers(new Set(["typescript", "java"]));
    await ensureBuiltinGrammarsForParsedFiles([
      parsedFile("grammar", "export const value = 0;"),
      parsedJavaFile("Grammar", "class Grammar { void run() {} }")
    ]);
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

  it("builds one bounded node index per tree and reuses identical queries", () => {
    const file = parsedFile("indexed", "const first = client.get('/first');\nconst second = client.post('/second');");
    const ast = parseJsAst(file)!;
    const before = astNodeIndexMetrics();
    const first = astNodesOfTypes(ast, ["call_expression"]);
    const second = astNodesOfTypes(ast, ["call_expression"]);
    const after = astNodeIndexMetrics();

    expect(second).toBe(first);
    expect(first.map((node) => node.text)).toEqual(["client.get('/first')", "client.post('/second')"]);
    expect(after.indexesBuilt - before.indexesBuilt).toBe(1);
    expect(after.queryCacheHits - before.queryCacheHits).toBe(1);
    expect(after.nodesRetained - before.nodesRetained).toBeLessThan(after.nodesVisited - before.nodesVisited);
  });

  it("merges multiple node types in Tree-sitter preorder", () => {
    const file = parsedFile("preorder", "const first = client.get('/first');\nconst second = client.post('/second');");
    const ast = parseJsAst(file)!;
    const nodes = astNodesOfTypes(ast, ["call_expression", "variable_declarator"]);

    expect(nodes.map((node) => node.type)).toEqual([
      "variable_declarator",
      "call_expression",
      "variable_declarator",
      "call_expression"
    ]);
    expect(nodes.map((node) => node.startIndex)).toEqual([...nodes].map((node) => node.startIndex).sort((left, right) => left - right));
  });

  it("keeps derived indexes isolated by file, language, and replacement tree", () => {
    const tsFile = parsedFile("language", "const value = client.get('/value');");
    const javaFile = parsedJavaFile("Language", "class Language { void run() { client.call(); } }");
    const tsAst = parseJsAst(tsFile)!;
    const javaAst = parseSourceAst(javaFile, "java")!;
    const before = astNodeIndexMetrics();

    expect(astNodesOfTypes(tsAst, ["call_expression"])).toHaveLength(1);
    expect(astNodesOfTypes(javaAst, ["method_invocation"])).toHaveLength(1);
    tsFile.source = "const value = client.post('/value');";
    const replacement = parseJsAst(tsFile)!;
    expect(replacement.tree).not.toBe(tsAst.tree);
    expect(astNodesOfTypes(replacement, ["call_expression"])[0]?.text).toBe("client.post('/value')");

    const after = astNodeIndexMetrics();
    expect(after.indexesBuilt - before.indexesBuilt).toBe(3);
  });
});
