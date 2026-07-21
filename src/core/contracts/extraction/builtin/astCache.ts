import type Parser from "tree-sitter";
import { parseWithTreeSitter } from "../../../parsing/treeSitter.js";
import type { ParsedFile, SourceLanguage } from "../../../parsing/types.js";

export type CachedAstContext = {
  tree: Parser.Tree;
  source: string;
  language: SourceLanguage;
};

export type AstNodeIndexMetrics = {
  indexesBuilt: number;
  nodesVisited: number;
  nodesRetained: number;
  buildDurationMs: number;
  queries: number;
  queryCacheHits: number;
};

type CacheEntry = CachedAstContext;

type IndexedNode = {
  node: Parser.SyntaxNode;
  ordinal: number;
};

type AstNodeIndex = {
  byType: Map<string, readonly IndexedNode[]>;
  queryCache: Map<string, readonly Parser.SyntaxNode[]>;
};

const JS_INDEXED_NODE_TYPES = new Set([
  "call_expression",
  "class_declaration",
  "member_expression",
  "public_field_definition",
  "string",
  "string_fragment",
  "subscript_expression",
  "variable_declarator"
]);
const JAVA_INDEXED_NODE_TYPES = new Set([
  "class_declaration",
  "field_declaration",
  "method_declaration",
  "method_invocation",
  "variable_declarator"
]);

const AST_CACHE = new WeakMap<ParsedFile, Map<SourceLanguage, CacheEntry>>();
const AST_NODE_INDEX_CACHE = new WeakMap<Parser.Tree, AstNodeIndex>();
const AST_NODE_INDEX_METRICS: AstNodeIndexMetrics = {
  indexesBuilt: 0,
  nodesVisited: 0,
  nodesRetained: 0,
  buildDurationMs: 0,
  queries: 0,
  queryCacheHits: 0
};

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

export function astNodeIndexMetrics(): AstNodeIndexMetrics {
  return { ...AST_NODE_INDEX_METRICS };
}

export function astNodesOfTypes(context: CachedAstContext, types: readonly string[]): readonly Parser.SyntaxNode[] {
  AST_NODE_INDEX_METRICS.queries += 1;
  const uniqueTypes = [...new Set(types)].sort();
  if (uniqueTypes.length === 0) return [];
  const index = AST_NODE_INDEX_CACHE.get(context.tree) ?? buildAstNodeIndex(context);
  const queryKey = uniqueTypes.join("\0");
  const cached = index.queryCache.get(queryKey);
  if (cached) {
    AST_NODE_INDEX_METRICS.queryCacheHits += 1;
    return cached;
  }
  const indexed = uniqueTypes.flatMap((type) => index.byType.get(type) ?? []);
  if (uniqueTypes.length > 1) indexed.sort((left, right) => left.ordinal - right.ordinal);
  const nodes = Object.freeze(indexed.map((entry) => entry.node));
  index.queryCache.set(queryKey, nodes);
  return nodes;
}

function buildAstNodeIndex(context: CachedAstContext): AstNodeIndex {
  const started = Date.now();
  const retainedTypes = indexedNodeTypes(context.language);
  const mutableByType = new Map<string, IndexedNode[]>();
  const stack: Parser.SyntaxNode[] = [context.tree.rootNode];
  let ordinal = 0;
  let nodesVisited = 0;
  let nodesRetained = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeOrdinal = ordinal;
    ordinal += 1;
    nodesVisited += 1;
    if (retainedTypes.has(node.type)) {
      const entries = mutableByType.get(node.type) ?? [];
      entries.push({ node, ordinal: nodeOrdinal });
      mutableByType.set(node.type, entries);
      nodesRetained += 1;
    }
    for (let index = node.childCount - 1; index >= 0; index -= 1) {
      const child = node.child(index);
      if (child) stack.push(child);
    }
  }
  const result: AstNodeIndex = {
    byType: new Map(Array.from(mutableByType, ([type, entries]) => [type, Object.freeze(entries)])),
    queryCache: new Map()
  };
  AST_NODE_INDEX_CACHE.set(context.tree, result);
  AST_NODE_INDEX_METRICS.indexesBuilt += 1;
  AST_NODE_INDEX_METRICS.nodesVisited += nodesVisited;
  AST_NODE_INDEX_METRICS.nodesRetained += nodesRetained;
  AST_NODE_INDEX_METRICS.buildDurationMs += Date.now() - started;
  return result;
}

function indexedNodeTypes(language: SourceLanguage): ReadonlySet<string> {
  if (language === "java") return JAVA_INDEXED_NODE_TYPES;
  if (language === "javascript" || language === "jsx" || language === "typescript" || language === "tsx") {
    return JS_INDEXED_NODE_TYPES;
  }
  return new Set();
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
