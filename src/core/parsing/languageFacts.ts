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

function parseASTValue(node: Parser.SyntaxNode, depth = 0): any {
  if (depth > 100) {
    return node.text;
  }
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
      arr.push(parseASTValue(child, depth + 1));
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
          obj[key] = parseASTValue(valNode, depth + 1);
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
      return { [key]: parseASTValue(valNode, depth + 1) };
    }
  }

  // Python keyword argument: e.g. methods=["GET"]
  if (type === "keyword_argument") {
    const keyNode = node.childForFieldName("name") || node.child(0);
    const valNode = node.childForFieldName("value") || node.child(2);
    if (keyNode && valNode) {
      const key = keyNode.text;
      return { [key]: parseASTValue(valNode, depth + 1) };
    }
  }

  // Fallback to text
  return node.text;
}

export function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inString: '"' | "'" | "`" | null = null;
  let isEscape = false;
  const stack: string[] = [];

  const bracketPairs: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}"
  };
  const closeToOpen: Record<string, string> = {
    ")": "(",
    "]": "[",
    "}": "{"
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (inString) {
      current += char;
      if (isEscape) {
        isEscape = false;
      } else if (char === "\\") {
        isEscape = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      current += char;
      continue;
    }

    if (bracketPairs[char]) {
      stack.push(char);
      current += char;
      continue;
    }

    if (closeToOpen[char]) {
      if (stack[stack.length - 1] === closeToOpen[char]) {
        stack.pop();
      }
      current += char;
      continue;
    }

    if (char === "," && stack.length === 0) {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function parseAnnotationArguments(argsTextOrNode: string | Parser.SyntaxNode | undefined): AnnotationArgument[] {
  if (!argsTextOrNode) return [];
  if (typeof argsTextOrNode === "string") {
    if (!argsTextOrNode.trim()) return [];
    return splitTopLevelCommas(argsTextOrNode)
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
    return splitTopLevelCommas(argsTextOrNode)
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

const KIND_PRIORITY: Record<string, number> = {
  class: 10,
  interface: 9,
  enum: 8,
  struct: 7,
  method: 6,
  function: 5,
  constructor: 4,
  field: 3,
  variable: 2,
};

export class SymbolsIndex {
  private symbolsByRange = new Map<string, CodeSymbol[]>();
  private sortedByStartLine: CodeSymbol[];
  private sortedBySize: CodeSymbol[];
  private symbolByLine: (CodeSymbol | undefined)[];

  constructor(symbols: CodeSymbol[]) {
    for (const s of symbols) {
      const key = `${s.startLine}:${s.endLine}`;
      const list = this.symbolsByRange.get(key) ?? [];
      list.push(s);
      this.symbolsByRange.set(key, list);
    }
    this.sortedByStartLine = [...symbols].sort((a, b) => a.startLine - b.startLine);
    this.sortedBySize = [...symbols].sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));

    let maxLine = 0;
    for (const s of symbols) {
      if (s.endLine > maxLine) maxLine = s.endLine;
    }
    this.symbolByLine = new Array(maxLine + 1);
    for (let i = this.sortedBySize.length - 1; i >= 0; i--) {
      const s = this.sortedBySize[i];
      for (let line = s.startLine; line <= s.endLine; line++) {
        this.symbolByLine[line] = s;
      }
    }
  }

  findRange(startLine: number, endLine: number): CodeSymbol | undefined {
    const list = this.symbolsByRange.get(`${startLine}:${endLine}`);
    if (!list) return undefined;
    let best = list[0]!;
    for (let i = 1; i < list.length; i++) {
      const s = list[i]!;
      const prioBest = KIND_PRIORITY[best.kind] ?? 0;
      const prioS = KIND_PRIORITY[s.kind] ?? 0;
      if (prioS > prioBest) {
        best = s;
      }
    }
    return best;
  }

  findContaining(line: number): CodeSymbol | undefined {
    if (line < 0 || line >= this.symbolByLine.length) return undefined;
    return this.symbolByLine[line];
  }

  findFollowing(line: number): CodeSymbol | undefined {
    let low = 0;
    let high = this.sortedByStartLine.length - 1;
    let idx = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.sortedByStartLine[mid].startLine >= line) {
        idx = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return idx !== -1 ? this.sortedByStartLine[idx] : undefined;
  }

  findContainingOwner(line: number): CodeSymbol | undefined {
    const containing = this.findContaining(line);
    if (containing) return containing;
    return this.findFollowingOwner(line);
  }

  findFollowingOwner(line: number): CodeSymbol | undefined {
    let low = 0;
    let high = this.sortedByStartLine.length - 1;
    let idx = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.sortedByStartLine[mid].startLine >= line) {
        idx = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    if (idx === -1) return undefined;

    let best = this.sortedByStartLine[idx];
    const matchStartLine = best.startLine;
    for (let i = idx + 1; i < this.sortedByStartLine.length; i++) {
      const s = this.sortedByStartLine[i];
      if (s.startLine !== matchStartLine) break;
      const sizeS = s.endLine - s.startLine;
      const sizeBest = best.endLine - best.startLine;
      if (sizeS < sizeBest) {
        best = s;
      }
    }
    return best;
  }
}

function scanAnnotationsOrDecorators(
  source: string,
  index: SymbolsIndex,
  kind: "annotation" | "decorator"
): any[] {
  const facts: any[] = [];
  let i = 0;

  const lineOffsets: number[] = [0];
  for (let j = 0; j < source.length; j++) {
    if (source[j] === "\n") {
      lineOffsets.push(j + 1);
    }
  }
  const getLineNumber = (offsetIndex: number): number => {
    let low = 0;
    let high = lineOffsets.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lineOffsets[mid]! <= offsetIndex) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return high + 1;
  };

  while (i < source.length) {
    const char = source[i]!;

    if (char === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i++;
      let isEscape = false;
      while (i < source.length) {
        const c = source[i]!;
        if (isEscape) {
          isEscape = false;
        } else if (c === "\\") {
          isEscape = true;
        } else if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (char === "@") {
      const startIdx = i;
      i++;
      const nameStart = i;
      while (i < source.length && /[a-zA-Z0-9_$.]/.test(source[i]!)) {
        i++;
      }
      const name = source.substring(nameStart, i).trim();
      if (!name || name.endsWith(".")) {
        continue;
      }

      while (i < source.length && /\s/.test(source[i]!)) {
        i++;
      }

      let args: string | undefined = undefined;
      let rawText = source.substring(startIdx, i);

      if (i < source.length && source[i] === "(") {
        const argsStart = i + 1;
        i++;
        let depth = 1;
        let inStr: '"' | "'" | "`" | null = null;
        let isEsc = false;

        while (i < source.length && depth > 0) {
          const c = source[i]!;
          if (inStr) {
            if (isEsc) {
              isEsc = false;
            } else if (c === "\\") {
              isEsc = true;
            } else if (c === inStr) {
              inStr = null;
            }
          } else {
            if (c === '"' || c === "'" || c === "`") {
              inStr = c;
            } else if (c === "(") {
              depth++;
            } else if (c === ")") {
              depth--;
            }
          }
          i++;
        }

        if (depth === 0) {
          args = source.substring(argsStart, i - 1);
          rawText = source.substring(startIdx, i);
        }
      }

      const line = getLineNumber(startIdx);
      if (kind === "annotation") {
        const owner = index.findContainingOwner(line);
        facts.push({
          ownerSymbolId: owner?.id,
          ownerKind: owner ? ownerKindForAnnotation(owner) : "file",
          name,
          arguments: parseAnnotationArguments(args),
          raw: rawText,
          line
        });
      } else {
        const owner = index.findFollowingOwner(line) ?? index.findContainingOwner(line);
        facts.push({
          ownerSymbolId: owner?.id,
          ownerKind: owner ? ownerKindForDecorator(owner) : "property",
          name,
          arguments: parseDecoratorArguments(args),
          raw: rawText,
          line
        });
      }
      continue;
    }

    i++;
  }

  return facts;
}

function extractJavaAnnotations(source: string, symbols: CodeSymbol[]): AnnotationFact[] {
  const index = new SymbolsIndex(symbols);
  return scanAnnotationsOrDecorators(source, index, "annotation");
}

function extractDecorators(source: string, symbols: CodeSymbol[]): DecoratorFact[] {
  const index = new SymbolsIndex(symbols);
  return scanAnnotationsOrDecorators(source, index, "decorator");
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
  const stack: Parser.SyntaxNode[] = [node];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    visit(curr);
    for (let i = curr.childCount - 1; i >= 0; i--) {
      stack.push(curr.child(i)!);
    }
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

function findOwnerSymbol(index: SymbolsIndex, node: Parser.SyntaxNode): CodeSymbol | undefined {
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
      const matched = index.findRange(startLine, endLine);
      if (matched) return matched;
    }
    curr = curr.parent;
  }
  return undefined;
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

function findPythonOwner(index: SymbolsIndex, node: Parser.SyntaxNode): CodeSymbol | undefined {
  const parent = node.parent;
  if (parent && parent.type === "decorated_definition") {
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i)!;
      if (child.type === "function_definition" || child.type === "class_definition") {
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;
        return index.findRange(startLine, endLine);
      }
    }
  }
  return undefined;
}

function findDecoratorOwner(index: SymbolsIndex, node: Parser.SyntaxNode, isPython: boolean): CodeSymbol | undefined {
  if (isPython) {
    const pyOwner = findPythonOwner(index, node);
    if (pyOwner) return pyOwner;
  }
  return index.findFollowingOwner(node.startPosition.row + 1);
}

function findLiteralOwner(index: SymbolsIndex, node: Parser.SyntaxNode): CodeSymbol | undefined {
  const line = node.startPosition.row + 1;
  return index.findContaining(line);
}

function extractLanguageFactsAST(parsedFile: ParsedFile, _source: string, tree: Parser.Tree): ParsedSourceFacts {
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

  const index = new SymbolsIndex(parsedFile.symbols);

  walkTree(tree.rootNode, (node) => {
    if (wantsAnnotations && (node.type === "annotation" || node.type === "marker_annotation")) {
      const name = getAnnotationName(node);
      const argsNode = getAnnotationArgsNode(node);
      const owner = findOwnerSymbol(index, node);
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
      const owner = findDecoratorOwner(index, node, isPython);
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
      const owner = findLiteralOwner(index, node);
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
