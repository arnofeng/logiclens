import Parser from "tree-sitter";
import type { SourceLanguage } from "./types.js";
import { getLanguageDefinition } from "./languages/registry.js";

export function getLanguageGrammar(language: string): any {
  const def = getLanguageDefinition(language);
  if (!def) throw new Error(`No grammar registered for "${language}".`);
  return def.loadGrammar();
}

export function parseWithTreeSitter(source: string, language: SourceLanguage): Parser.Tree {
  const parser = new Parser();
  const grammar = getLanguageGrammar(language);
  parser.setLanguage(grammar as never);
  return parseTreeSitterSource(parser, source);
}

export function parseTreeSitterSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index) => index < source.length ? source.slice(index, index + 8192) : null);
}

export function isBuiltinSourceLanguage(language: string): language is SourceLanguage {
  return getLanguageDefinition(language) !== undefined;
}

const queryCache = new Map<string, Parser.Query>();

export function getCachedQuery(language: SourceLanguage, kind: "symbols" | "imports" | "calls"): Parser.Query {
  const key = `${language}:${kind}`;
  let query = queryCache.get(key);
  if (!query) {
    const grammar = getLanguageGrammar(language);
    const def = getLanguageDefinition(language);
    if (!def) throw new Error(`No query definition for language "${language}".`);
    const queryStr = def.queries[kind];
    query = new Parser.Query(grammar, queryStr);
    queryCache.set(key, query);
  }
  return query;
}
