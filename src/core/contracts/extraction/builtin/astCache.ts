import type Parser from "tree-sitter";
import { parseWithTreeSitter } from "../../../parsing/treeSitter.js";
import type { ParsedFile, SourceLanguage } from "../../../parsing/types.js";

export type CachedAstContext = {
  tree: Parser.Tree;
  source: string;
};

type CacheEntry = CachedAstContext & {
  language: SourceLanguage;
};

const AST_CACHE = new WeakMap<ParsedFile, Map<SourceLanguage, CacheEntry>>();

/**
 * Shares immutable Tree-sitter trees across the sequential builtin extractor
 * pass. ParsedFile objects are run-scoped, so the WeakMap does not retain an
 * index run after its parsed files become unreachable.
 */
export function parseCachedAst(file: ParsedFile, language: SourceLanguage): CachedAstContext | undefined {
  const source = sourceForParsedFile(file);
  if (!source) return undefined;

  const byLanguage = AST_CACHE.get(file) ?? new Map<SourceLanguage, CacheEntry>();
  if (!AST_CACHE.has(file)) AST_CACHE.set(file, byLanguage);
  const cached = byLanguage.get(language);
  if (cached?.source === source) return cached;

  const entry: CacheEntry = {
    tree: parseWithTreeSitter(source, language),
    source,
    language
  };
  byLanguage.set(language, entry);
  return entry;
}

export function sourceForParsedFile(file: ParsedFile): string {
  if (file.source) return file.source;
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
