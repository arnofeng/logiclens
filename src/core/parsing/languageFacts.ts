import type Parser from "tree-sitter";
import { getLanguageDefinition } from "./languages/registry.js";
import type { CodeSymbol, ParsedFile } from "./types.js";
import type { AnnotationArgument, AnnotationFact, DecoratorFact, LiteralFact, ParsedSourceFacts } from "./facts.js";

function sourceLine(source: string, offset: number, startLine: number): number {
  return startLine + source.slice(0, offset).split(/\r?\n/).length - 1;
}

function ownerKindForAnnotation(symbol: CodeSymbol): AnnotationFact["ownerKind"] {
  if (symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum") return "class";
  if (symbol.kind === "method" || symbol.kind === "function") return "method";
  return "field";
}

function ownerKindForDecorator(symbol: CodeSymbol): DecoratorFact["ownerKind"] {
  if (symbol.kind === "class") return "class";
  if (symbol.kind === "method") return "method";
  if (symbol.kind === "function" || symbol.kind === "variable") return "function";
  return "property";
}

function parseASTValue(node: Parser.SyntaxNode): any {
  const type = node.type;

  // String literals
  if (type === "string" || type === "string_literal" || type === "raw_string_literal" || type === "template_string" || type === "template_literal") {
    return stripLiteralQuotes(node.text);
  }

  // Number literals
  if (
    type === "number" ||
    type === "integer" ||
    type === "float" ||
    type === "decimal_integer_literal" ||
    type === "decimal_floating_point_literal" ||
    type === "hex_integer_literal" ||
    type === "int_literal" ||
    type === "float_literal"
  ) {
    const val = Number(node.text);
    return isNaN(val) ? node.text : val;
  }

  // Boolean literals
  if (type === "true" || type === "true_literal") return true;
  if (type === "false" || type === "false_literal") return false;
  if (type === "null" || type === "null_literal") return null;
  if (type === "undefined") return undefined;

  // Arrays (JS/TS array, Python list, Java array_initializer)
  if (type === "array" || type === "array_literal" || type === "list" || type === "element_value_array_initializer") {
    const arr: any[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "[" || child.type === "]" || child.type === "{" || child.type === "}" || child.type === ",") {
        continue;
      }
      arr.push(parseASTValue(child));
    }
    return arr;
  }

  // Objects (JS/TS object, Python dictionary)
  if (type === "object" || type === "dictionary") {
    const obj: Record<string, any> = {};
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "pair") {
        const keyNode = child.childForFieldName("key") || child.child(0);
        const valNode = child.childForFieldName("value") || child.child(2);
        if (keyNode && valNode) {
          const key = stripLiteralQuotes(keyNode.text);
          obj[key] = parseASTValue(valNode);
        }
      } else if (child.type === "shorthand_property_identifier" || child.type === "shorthand_property_identifier_pattern") {
        obj[child.text] = child.text;
      }
    }
    return obj;
  }

  // Assignment/Pairs or other complex nodes -> if we don't know how to parse, we can return node.text or a simplified representation.
  if (type === "assignment_expression") {
    const keyNode = node.childForFieldName("left") || node.child(0);
    const valNode = node.childForFieldName("right") || node.child(2);
    if (keyNode && valNode) {
      const key = stripLiteralQuotes(keyNode.text);
      return { [key]: parseASTValue(valNode) };
    }
  }

  // Python keyword argument: e.g. methods=["GET"]
  if (type === "keyword_argument") {
    const keyNode = node.childForFieldName("name") || node.child(0);
    const valNode = node.childForFieldName("value") || node.child(2);
    if (keyNode && valNode) {
      const key = keyNode.text;
      return { [key]: parseASTValue(valNode) };
    }
  }

  // Fallback to text
  return node.text;
}

function parseAnnotationArguments(argsTextOrNode: string | Parser.SyntaxNode | undefined): AnnotationArgument[] {
  if (!argsTextOrNode) return [];
  if (typeof argsTextOrNode === "string") {
    if (!argsTextOrNode.trim()) return [];
    return argsTextOrNode
      .split(/,(?![^{([]*[}\])])/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((raw) => {
        const named = raw.match(/^([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
        return named
          ? { name: named[1], value: stripLiteralQuotes(named[2] ?? ""), raw }
          : { value: stripLiteralQuotes(raw), raw };
      });
  }

  const node = argsTextOrNode;
  const args: AnnotationArgument[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "(" || child.type === ")" || child.type === ",") {
      continue;
    }
    if (child.type === "element_value_pair") {
      const nameNode = child.childForFieldName("key") || child.child(0);
      const valueNode = child.childForFieldName("value") || child.child(2);
      if (nameNode && valueNode) {
        const name = nameNode.text;
        const val = parseASTValue(valueNode);
        args.push({
          name,
          value: typeof val === "string" ? val : (typeof val === "object" && val !== null ? JSON.stringify(val) : String(val)),
          raw: child.text
        });
      }
    } else {
      const val = parseASTValue(child);
      args.push({
        value: typeof val === "string" ? val : (typeof val === "object" && val !== null ? JSON.stringify(val) : String(val)),
        raw: child.text
      });
    }
  }
  return args;
}

function parseDecoratorArguments(argsTextOrNode: string | Parser.SyntaxNode | undefined): unknown[] {
  if (!argsTextOrNode) return [];
  if (typeof argsTextOrNode === "string") {
    if (!argsTextOrNode.trim()) return [];
    return argsTextOrNode
      .split(/,(?![^{([]*[}\])])/)
      .map((part) => stripLiteralQuotes(part.trim()))
      .filter(Boolean);
  }

  const node = argsTextOrNode;
  const args: unknown[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "(" || child.type === ")" || child.type === ",") {
      continue;
    }
    args.push(parseASTValue(child));
  }
  return args;
}

function stripLiteralQuotes(value: string): string {
  return value.trim().replace(/^["'`]|["'`]$/g, "");
}

function javaPackageName(source: string): string | undefined {
  return source.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1];
}

function findContainingOwner(symbols: CodeSymbol[], line: number): CodeSymbol | undefined {
  const containing = symbols
    .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  if (containing) return containing;
  return findFollowingOwner(symbols, line);
}

function findFollowingOwner(symbols: CodeSymbol[], line: number): CodeSymbol | undefined {
  return symbols
    .filter((symbol) => symbol.startLine >= line)
    .sort((a, b) => a.startLine - b.startLine || (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

function extractJavaAnnotations(source: string, symbols: CodeSymbol[]): AnnotationFact[] {
  const facts: AnnotationFact[] = [];
  const annotationRe = /@([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\(([^)]*)\))?/g;
  const lines = source.split(/\r?\n/);
  for (const [index, lineText] of lines.entries()) {
    for (const match of lineText.matchAll(annotationRe)) {
      const line = index + 1;
      const owner = findContainingOwner(symbols, line);
      facts.push({
        ownerSymbolId: owner?.id,
        ownerKind: owner ? ownerKindForAnnotation(owner) : "file",
        name: match[1] ?? "",
        arguments: parseAnnotationArguments(match[2]),
        raw: match[0],
        line
      });
    }
  }
  return facts;
}

function extractDecorators(source: string, symbols: CodeSymbol[]): DecoratorFact[] {
  const facts: DecoratorFact[] = [];
  const decoratorRe = /@([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\(([^)]*)\))?/g;
  const lines = source.split(/\r?\n/);
  for (const [index, lineText] of lines.entries()) {
    for (const match of lineText.matchAll(decoratorRe)) {
      const line = index + 1;
      const owner = findFollowingOwner(symbols, line) ?? findContainingOwner(symbols, line);
      facts.push({
        ownerSymbolId: owner?.id,
        ownerKind: owner ? ownerKindForDecorator(owner) : "property",
        name: match[1] ?? "",
        arguments: parseDecoratorArguments(match[2]),
        raw: match[0],
        line
      });
    }
  }
  return facts;
}

function extractLiterals(symbols: CodeSymbol[]): LiteralFact[] {
  const facts: LiteralFact[] = [];
  const literalRe = /(`(?:\\.|[^`])*`|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\b\d+(?:\.\d+)?\b)/g;
  for (const symbol of symbols) {
    for (const match of symbol.source.matchAll(literalRe)) {
      const raw = match[0];
      const kind = raw.startsWith("`") ? "template" : raw.startsWith("\"") || raw.startsWith("'") ? "string" : "number";
      facts.push({
        ownerSymbolId: symbol.id,
        value: stripLiteralQuotes(raw),
        kind,
        raw,
        line: sourceLine(symbol.source, match.index ?? 0, symbol.startLine)
      });
    }
  }
  return facts;
}

export function extractLanguageFacts(input: { parsedFile: ParsedFile; source: string; tree?: Parser.Tree }): ParsedSourceFacts {
  const parsedFile = input.parsedFile;
  const dialect = getLanguageDefinition(parsedFile.language)?.factsDialect ?? "none";
  const wantsAnnotations = dialect === "java-annotations";
  const wantsDecorators = dialect === "js-decorators";

  if (input.tree) {
    return extractLanguageFactsAST(parsedFile, input.source, input.tree);
  }

  return {
    repoId: parsedFile.repoId,
    fileId: parsedFile.fileId,
    path: parsedFile.path,
    language: parsedFile.language,
    packageName: wantsAnnotations ? javaPackageName(input.source) : undefined,
    imports: parsedFile.imports,
    symbols: parsedFile.symbols,
    annotations: wantsAnnotations ? extractJavaAnnotations(input.source, parsedFile.symbols) : [],
    decorators: wantsDecorators ? extractDecorators(input.source, parsedFile.symbols) : [],
    calls: parsedFile.calls,
    literals: extractLiterals(parsedFile.symbols)
  };
}

function walkTree(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void) {
  visit(node);
  for (let i = 0; i < node.childCount; i++) {
    walkTree(node.child(i)!, visit);
  }
}

function getAnnotationName(node: Parser.SyntaxNode): string {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "identifier" || child.type === "scoped_identifier" || child.type === "type_identifier") {
      return child.text;
    }
  }
  return node.text.replace(/^@/, "").split("(")[0]!.trim();
}

function getAnnotationArgsNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "annotation_argument_list") {
      return child;
    }
  }
  return undefined;
}

function findOwnerSymbol(symbols: CodeSymbol[], node: Parser.SyntaxNode): CodeSymbol | undefined {
  let curr: Parser.SyntaxNode | null = node.parent;
  while (curr) {
    if (
      curr.type === "class_declaration" ||
      curr.type === "method_declaration" ||
      curr.type === "constructor_declaration" ||
      curr.type === "field_declaration" ||
      curr.type === "interface_declaration" ||
      curr.type === "enum_declaration"
    ) {
      const startLine = curr.startPosition.row + 1;
      const endLine = curr.endPosition.row + 1;
      const matched = symbols.find(s => s.startLine === startLine && s.endLine === endLine);
      if (matched) return matched;
    }
    curr = curr.parent;
  }
  return undefined;
}

function findOwnerSymbolByProximity(symbols: CodeSymbol[], line: number): CodeSymbol | undefined {
  const candidates = symbols.filter(s => s.startLine >= line);
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.startLine - b.startLine);
  return candidates[0];
}

function getJavaPackageName(rootNode: Parser.SyntaxNode): string | undefined {
  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i)!;
    if (child.type === "package_declaration") {
      for (let j = 0; j < child.childCount; j++) {
        const subChild = child.child(j)!;
        if (subChild.type === "scoped_identifier" || subChild.type === "identifier") {
          return subChild.text;
        }
      }
    }
  }
  return undefined;
}

function getDecoratorNameAndArgsNode(node: Parser.SyntaxNode): { name: string, argsNode?: Parser.SyntaxNode } {
  let name = "";
  let argsNode: Parser.SyntaxNode | undefined;

  let callNode: Parser.SyntaxNode | null = null;
  walkTree(node, (n) => {
    if (n.type === "call" || n.type === "call_expression") {
      callNode = n;
    }
  });

  if (callNode) {
    const fn = (callNode as Parser.SyntaxNode).childForFieldName("function") || (callNode as Parser.SyntaxNode).child(0);
    if (fn) name = fn.text;
    argsNode = (callNode as Parser.SyntaxNode).childForFieldName("arguments") ?? (callNode as Parser.SyntaxNode).child(1) ?? undefined;
  } else {
    name = node.text.replace(/^@/, "").trim();
  }

  if (!name) {
    name = node.text.replace(/^@/, "").split("(")[0]!.trim();
  }
  return { name, argsNode };
}

function findPythonOwner(symbols: CodeSymbol[], node: Parser.SyntaxNode): CodeSymbol | undefined {
  const parent = node.parent;
  if (parent && parent.type === "decorated_definition") {
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i)!;
      if (child.type === "function_definition" || child.type === "class_definition") {
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;
        return symbols.find(s => s.startLine === startLine && s.endLine === endLine);
      }
    }
  }
  return undefined;
}

function findDecoratorOwner(symbols: CodeSymbol[], node: Parser.SyntaxNode, isPython: boolean): CodeSymbol | undefined {
  if (isPython) {
    const pyOwner = findPythonOwner(symbols, node);
    if (pyOwner) return pyOwner;
  }
  // For decorators, matching by proximity of symbol definition immediately following is extremely robust
  return findOwnerSymbolByProximity(symbols, node.startPosition.row + 1);
}

function findLiteralOwner(symbols: CodeSymbol[], node: Parser.SyntaxNode): CodeSymbol | undefined {
  const line = node.startPosition.row + 1;
  return symbols
    .filter(s => s.startLine <= line && s.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

function extractLanguageFactsAST(parsedFile: ParsedFile, source: string, tree: Parser.Tree): ParsedSourceFacts {
  const dialect = getLanguageDefinition(parsedFile.language)?.factsDialect ?? "none";
  const wantsAnnotations = dialect === "java-annotations";
  const wantsDecorators = dialect === "js-decorators";
  const isPython = parsedFile.language === "python";

  let packageName: string | undefined;
  if (wantsAnnotations) {
    packageName = getJavaPackageName(tree.rootNode);
  }

  const annotations: AnnotationFact[] = [];
  const decorators: DecoratorFact[] = [];
  const literals: LiteralFact[] = [];

  const LITERAL_TYPES = new Set([
    "string", "string_literal", "raw_string_literal", "template_string", "template_literal",
    "number", "integer", "float", "decimal_integer_literal", "decimal_floating_point_literal",
    "hex_integer_literal", "int_literal", "float_literal"
  ]);

  walkTree(tree.rootNode, (node) => {
    if (wantsAnnotations && (node.type === "annotation" || node.type === "marker_annotation")) {
      const name = getAnnotationName(node);
      const argsNode = getAnnotationArgsNode(node);
      const owner = findOwnerSymbol(parsedFile.symbols, node);
      annotations.push({
        ownerSymbolId: owner?.id,
        ownerKind: owner ? ownerKindForAnnotation(owner) : "file",
        name,
        arguments: parseAnnotationArguments(argsNode),
        raw: node.text,
        line: node.startPosition.row + 1
      });
    }

    if (wantsDecorators && node.type === "decorator") {
      const { name, argsNode } = getDecoratorNameAndArgsNode(node);
      const owner = findDecoratorOwner(parsedFile.symbols, node, isPython);
      decorators.push({
        ownerSymbolId: owner?.id,
        ownerKind: owner ? ownerKindForDecorator(owner) : (isPython ? "method" : "property"),
        name,
        arguments: parseDecoratorArguments(argsNode),
        raw: node.text,
        line: node.startPosition.row + 1
      });
    }

    if (LITERAL_TYPES.has(node.type)) {
      const owner = findLiteralOwner(parsedFile.symbols, node);
      if (owner) {
        const raw = node.text;
        let kind: LiteralFact["kind"] = "string";
        if (node.type.includes("template") || raw.startsWith("`")) {
          kind = "template";
        } else if (
          node.type.includes("number") ||
          node.type.includes("integer") ||
          node.type.includes("float") ||
          node.type.includes("int") ||
          /^\d+/.test(raw)
        ) {
          kind = "number";
        }
        literals.push({
          ownerSymbolId: owner.id,
          value: stripLiteralQuotes(raw),
          kind,
          raw,
          line: node.startPosition.row + 1
        });
      }
    }
  });

  return {
    repoId: parsedFile.repoId,
    fileId: parsedFile.fileId,
    path: parsedFile.path,
    language: parsedFile.language,
    packageName,
    imports: parsedFile.imports,
    symbols: parsedFile.symbols,
    annotations,
    decorators,
    calls: parsedFile.calls,
    literals
  };
}
