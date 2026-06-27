import type Parser from "tree-sitter";
import { parseWithTreeSitter } from "../../../parsing/treeSitter.js";
import type { ParsedFile, SourceLanguage } from "../../../parsing/types.js";

export type SourceAstContext = {
  tree: Parser.Tree;
  source: string;
};

export function parseSourceAst(file: ParsedFile, language: SourceLanguage): SourceAstContext | undefined {
  if (file.language !== language) return undefined;
  const source = file.source ?? sourceFromSymbols(file);
  if (!source) return undefined;
  return { tree: parseWithTreeSitter(source, language), source };
}

export function walkSourceAst(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (let i = 0; i < node.childCount; i++) {
    walkSourceAst(node.child(i)!, visit);
  }
}

export function namedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const children: Parser.SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) children.push(child);
  }
  return children;
}

export function callArguments(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const args = node.childForFieldName("arguments");
  return args ? namedChildren(args) : [];
}

export function stringLiteralValue(node: Parser.SyntaxNode): string | undefined {
  if (
    node.type !== "string" &&
    node.type !== "interpreted_string_literal" &&
    node.type !== "raw_string_literal"
  ) {
    return undefined;
  }
  return unquote(node.text);
}

export function selectorParts(node: Parser.SyntaxNode): { object?: string; property?: string } {
  const object = node.childForFieldName("object");
  const field = node.childForFieldName("field");
  if (object && field) return { object: object.text, property: field.text };
  const children = namedChildren(node);
  return { object: children[0]?.text, property: children[1]?.text };
}

export function attributeParts(node: Parser.SyntaxNode): { object?: string; property?: string } {
  const children = namedChildren(node);
  return { object: children[0]?.text, property: children[1]?.text };
}

export function findContainingSymbol<T extends { startLine: number; endLine: number }>(symbols: T[], node: Parser.SyntaxNode): T | undefined {
  const line = node.startPosition.row + 1;
  return symbols
    .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

export function symbolOffset(file: ParsedFile, symbol: { source: string }, node: Parser.SyntaxNode): number {
  const source = file.source ?? sourceFromSymbols(file);
  const symbolStart = source.indexOf(symbol.source);
  return symbolStart >= 0 ? Math.max(0, node.startIndex - symbolStart) : 0;
}

function sourceFromSymbols(file: ParsedFile): string {
  if (file.symbols.length === 0) return "";
  const lines: string[] = Array.from({ length: Math.max(...file.symbols.map((symbol) => symbol.endLine), 1) }, () => "");
  for (const symbol of file.symbols) {
    const symbolLines = symbol.source.split(/\r?\n/);
    for (const [index, line] of symbolLines.entries()) {
      lines[symbol.startLine - 1 + index] = line;
    }
  }
  return lines.join("\n");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === last && (first === "\"" || first === "'" || first === "`"))
    ? trimmed.slice(1, -1)
    : trimmed;
}
