import Parser from "tree-sitter";
import { parseWithTreeSitter, getLanguageGrammar } from "../parsers/treeSitter.js";
import { tsQueries, jsQueries } from "../parsers/languages/typescript.js";
import { javaQueries } from "../parsers/languages/java.js";
import { pythonQueries } from "../parsers/languages/python.js";
import { goQueries } from "../parsers/languages/go.js";
import type { CodeKind, CodeSymbol, ParsedFile, SourceLanguage } from "../parsers/types.js";
import { codeId } from "../utils/path.js";
import { hashText } from "../utils/hash.js";
import { extractImportsFromTreeSitter } from "./extractImports.js";
import { extractCallsFromTreeSitter } from "./extractCalls.js";
import { extractLanguageFacts } from "../parsers/languageFacts.js";

const symbolQueriesCache = new Map<SourceLanguage, Parser.Query>();

function getSymbolQuery(language: SourceLanguage): Parser.Query {
  let query = symbolQueriesCache.get(language);
  if (!query) {
    const grammar = getLanguageGrammar(language);
    const queryStr = getBuiltinSymbolQuery(language);
    query = new Parser.Query(grammar, queryStr);
    symbolQueriesCache.set(language, query);
  }
  return query;
}

function getBuiltinSymbolQuery(language: SourceLanguage): string {
  return (language === "typescript" || language === "tsx")
    ? tsQueries.symbols
    : language === "java"
      ? javaQueries.symbols
      : language === "python"
        ? pythonQueries.symbols
        : language === "go"
          ? goQueries.symbols
          : jsQueries.symbols;
}

function getQualifiedPrefix(node: Parser.SyntaxNode): string {
  const classes: string[] = [];
  let curr = node.parent;
  while (curr) {
    if (curr.type === "class_declaration") {
      const nameNode = curr.childForFieldName("name");
      if (nameNode) {
        classes.unshift(nameNode.text);
      }
    }
    curr = curr.parent;
  }
  return classes.length > 0 ? classes.join(".") + "." : "";
}

function getSignature(node: Parser.SyntaxNode): string {
  const text = node.text;
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  return first.length > 240 ? `${first.slice(0, 237)}...` : first;
}

function dedent(text: string): string {
  const lines = text.split(/\r?\n/);
  let minIndent = Infinity;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const match = line.match(/^([ \t]*)/);
    if (match) {
      minIndent = Math.min(minIndent, match[1].length);
    }
  }
  if (minIndent === Infinity) minIndent = 0;

  const processed = lines.map((line, idx) => {
    if (idx === 0) return line.trim();
    return line.slice(minIndent).trimEnd();
  });

  while (processed.length > 0 && processed[0] === "") {
    processed.shift();
  }
  while (processed.length > 0 && processed[processed.length - 1] === "") {
    processed.pop();
  }

  return processed.join("\n");
}

function cleanCommentText(rawText: string, language: string): string {
  const trimmed = rawText.trim();

  if (language === "python") {
    if (trimmed.startsWith("#")) {
      return trimmed.slice(1).trim();
    }
    const docstringMatch = trimmed.match(/^([rRuU]{0,2})("""|''')([\s\S]*)\2$/);
    if (docstringMatch) {
      return dedent(docstringMatch[3] ?? "");
    }
  }

  if (trimmed.startsWith("//")) {
    return trimmed.slice(2).trim();
  }

  if (trimmed.startsWith("/*") && trimmed.endsWith("*/")) {
    const isDoc = trimmed.startsWith("/**");
    const inner = trimmed.slice(isDoc ? 3 : 2, -2);
    const lines = inner.split(/\r?\n/);

    const processed = lines.map((line) => {
      let l = line.trim();
      if (l.startsWith("*")) {
        l = l.slice(1).trim();
      }
      return l;
    });

    while (processed.length > 0 && processed[0] === "") {
      processed.shift();
    }
    while (processed.length > 0 && processed[processed.length - 1] === "") {
      processed.pop();
    }

    return processed.join("\n");
  }

  return trimmed;
}

function cleanCommentBlock(commentTexts: string[], language: string): string {
  const cleaned = commentTexts.map((text) => cleanCommentText(text, language)).filter(Boolean);
  return cleaned.join("\n");
}

function getPrecedingComments(node: Parser.SyntaxNode): string[] {
  let targetNode = node;
  while (
    targetNode.parent &&
    (targetNode.parent.type === "export_statement" ||
      targetNode.parent.type === "decorated_definition" ||
      targetNode.parent.type === "lexical_declaration" ||
      targetNode.parent.type === "variable_declaration" ||
      targetNode.parent.type === "type_declaration")
  ) {
    targetNode = targetNode.parent;
  }

  const comments: Parser.SyntaxNode[] = [];
  let curr = targetNode.previousNamedSibling;
  let lastStartLine = targetNode.startPosition.row;

  while (
    curr &&
    (curr.type === "comment" ||
      curr.type === "line_comment" ||
      curr.type === "block_comment")
  ) {
    const commentEndLine = curr.endPosition.row;
    if (lastStartLine - commentEndLine > 2) {
      break;
    }
    comments.unshift(curr);
    lastStartLine = curr.startPosition.row;
    curr = curr.previousNamedSibling;
  }

  return comments.map((c) => c.text);
}

function getPythonDocstring(node: Parser.SyntaxNode): string | undefined {
  if (node.type !== "function_definition" && node.type !== "class_definition") {
    return undefined;
  }
  const bodyNode = node.childForFieldName("body");
  if (!bodyNode) return undefined;

  const firstStmt = bodyNode.firstNamedChild;
  if (!firstStmt) return undefined;

  if (firstStmt.type === "expression_statement") {
    const child = firstStmt.firstNamedChild;
    if (child && child.type === "string") {
      return child.text;
    }
  } else if (firstStmt.type === "string") {
    return firstStmt.text;
  }

  return undefined;
}

export function extractSymbolsFromTreeSitter(input: {
  repoId: string;
  relativePath: string;
  tree: Parser.Tree;
  fileId: string;
  language: string;
  query: Parser.Query;
  getQualifiedPrefix: (node: Parser.SyntaxNode) => string;
  getSignature?: (node: Parser.SyntaxNode) => string;
}): CodeSymbol[] {
  const query = input.query;
  const matches = query.matches(input.tree.rootNode);
  const nodeMap = new Map<string, CodeSymbol>();

  for (const match of matches) {
    let kind: CodeKind | undefined;
    let name = "";
    let node: Parser.SyntaxNode | undefined;

    for (const capture of match.captures) {
      if (
        capture.name === "class" ||
        capture.name === "struct" ||
        capture.name === "method" ||
        capture.name === "function" ||
        capture.name === "interface" ||
        capture.name === "type" ||
        capture.name === "enum" ||
        capture.name === "variable"
      ) {
        kind = capture.name as CodeKind;
        node = capture.node;
      } else if (capture.name.endsWith(".name")) {
        name = capture.node.text;
      }
    }

    if (kind && name && node) {
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const prefix = input.getQualifiedPrefix(node);
      const qualifiedName = kind === "method" ? `${prefix}${name}` : name;
      const source = node.text;
      const signatureFn = input.getSignature ?? getSignature;

      let docstring = "";
      if (input.language === "python") {
        const pythonDoc = getPythonDocstring(node);
        if (pythonDoc) {
          docstring = cleanCommentText(pythonDoc, "python");
        }
      }
      if (!docstring) {
        const preceding = getPrecedingComments(node);
        if (preceding.length > 0) {
          docstring = cleanCommentBlock(preceding, input.language);
        }
      }

      const nodeKey = `${node.startIndex}-${node.endIndex}`;
      const existing = nodeMap.get(nodeKey);
      
      const newSymbol: CodeSymbol = {
        id: codeId(input.repoId, input.relativePath, kind, qualifiedName, startLine),
        repoId: input.repoId,
        fileId: input.fileId,
        kind,
        name,
        qualifiedName,
        startLine,
        endLine,
        signature: signatureFn(node),
        source,
        hash: hashText(source),
        ...(docstring ? { summary: docstring } : {})
      };

      if (!existing) {
        nodeMap.set(nodeKey, newSymbol);
      } else {
        if (existing.kind === "function" && kind === "method") {
          nodeMap.set(nodeKey, newSymbol);
        }
      }
    }
  }

  return Array.from(nodeMap.values());
}

export function parseTypeScriptFile(input: {
  repoId: string;
  fileId: string;
  relativePath: string;
  language: SourceLanguage;
  source: string;
  hash: string;
}): ParsedFile {
  const tree = parseWithTreeSitter(input.source, input.language);
  const query = getSymbolQuery(input.language);
  const symbols = extractSymbolsFromTreeSitter({
    repoId: input.repoId,
    relativePath: input.relativePath,
    tree,
    fileId: input.fileId,
    language: input.language,
    query,
    getQualifiedPrefix
  });
  const parsedFile: ParsedFile = {
    repoId: input.repoId,
    fileId: input.fileId,
    path: input.relativePath,
    language: input.language,
    hash: input.hash,
    loc: input.source.split(/\r?\n/).length,
    imports: extractImportsFromTreeSitter(tree, input.fileId, input.language, undefined, input.relativePath),
    symbols,
    calls: extractCallsFromTreeSitter(tree, input.fileId, input.language, symbols)
  };
  parsedFile.facts = extractLanguageFacts({ parsedFile, source: input.source, tree });
  return parsedFile;
}
