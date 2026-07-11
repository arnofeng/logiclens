import type {
  PluginAstFacts,
  PluginExtractedAnnotation,
  PluginExtractedLiteral,
  PluginParseInput,
  PluginParsedCall,
  PluginParsedImport,
  PluginParsedSymbol,
  PluginParseResult
} from "@logiclens/plugin-sdk";

type Point = { row: number; column: number };
type SyntaxNode = {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: Point;
  endPosition: Point;
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
  hasError?: boolean;
};
type Tree = { rootNode: SyntaxNode };
type ParserInstance = {
  setLanguage(language: unknown): void;
  parse(source: string): Tree;
};
type ParserConstructor = new () => ParserInstance;
type ModuleLoader = (specifier: string) => Promise<unknown>;

const TYPE_KINDS: Record<string, PluginParsedSymbol["kind"]> = {
  class_declaration: "class",
  interface_declaration: "interface",
  struct_declaration: "struct",
  enum_declaration: "enum"
};
const CALLER_TYPES = new Set(["method_declaration", "constructor_declaration", "local_function_statement"]);
const STRING_TYPES = new Set(["string_literal", "verbatim_string_literal", "raw_string_literal"]);
const NUMBER_TYPES = new Set([
  "integer_literal",
  "real_literal"
]);

function symbolKind(node: SyntaxNode): PluginParsedSymbol["kind"] | undefined {
  if (node.type === "record_declaration") {
    return /\brecord\s+struct\b/.test(signature(node)) ? "struct" : "class";
  }
  return TYPE_KINDS[node.type];
}

function moduleDefault(moduleValue: unknown): unknown {
  if (moduleValue && typeof moduleValue === "object" && "default" in moduleValue) {
    return (moduleValue as { default: unknown }).default;
  }
  return moduleValue;
}

function line(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function nodeName(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text;
}

function signature(node: SyntaxNode): string {
  const boundary = node.childForFieldName("body")
    ?? node.namedChildren.find((child) => child.type === "declaration_list" || child.type === "arrow_expression_clause");
  const value = boundary ? node.text.slice(0, boundary.startIndex - node.startIndex) : node.text;
  return value.trim().replace(/\s+/g, " ").replace(/\s*;$/, "");
}

function literalValue(raw: string): string {
  if (raw.startsWith("@\"")) return raw.slice(2, -1).replace(/\"\"/g, "\"");
  if (raw.startsWith("\"\"\"")) return raw.replace(/^\"\"\"\s*/, "").replace(/\s*\"\"\"$/, "");
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    try { return JSON.parse(raw) as string; } catch { return raw.slice(1, -1); }
  }
  return raw.replace(/_/g, "");
}

function attributeArguments(node: SyntaxNode): PluginExtractedAnnotation["arguments"] {
  const list = node.namedChildren.find((child) => child.type === "attribute_argument_list");
  if (!list) return undefined;
  return list.namedChildren.map((argument) => {
    const expression = argument.namedChildren[0] ?? argument;
    if (expression.type === "assignment_expression" || expression.type === "name_equals") {
      const [name, value] = expression.namedChildren;
      const rawValue = value?.text ?? "";
      return { name: name?.text, value: literalValue(rawValue), raw: argument.text };
    }
    if (argument.namedChildren.length >= 2 && argument.text.includes(":")) {
      const [name, value] = argument.namedChildren;
      return { name: name?.text, value: literalValue(value?.text ?? ""), raw: argument.text };
    }
    return { value: literalValue(expression.text), raw: argument.text };
  });
}

function calleeParts(functionNode: SyntaxNode): { calleeName: string; receiver?: string } {
  if (functionNode.type === "member_access_expression" || functionNode.type === "conditional_access_expression") {
    const name = functionNode.childForFieldName("name") ?? functionNode.namedChildren.at(-1);
    if (name) {
      const boundName = name.childForFieldName("name") ?? name.namedChildren.at(-1);
      const calleeName = name.type === "generic_name"
        ? name.childForFieldName("name")?.text ?? name.namedChildren[0]?.text ?? name.text
        : boundName?.type === "generic_name"
          ? boundName.childForFieldName("name")?.text ?? boundName.namedChildren[0]?.text ?? boundName.text
          : boundName?.text ?? name.text.replace(/^[?.]+/, "");
      const prefix = functionNode.text.slice(0, name.startIndex - functionNode.startIndex).replace(/[?.]+$/, "");
      return { calleeName, ...(prefix ? { receiver: prefix } : {}) };
    }
  }
  if (functionNode.type === "generic_name") {
    return { calleeName: functionNode.childForFieldName("name")?.text ?? functionNode.namedChildren[0]?.text ?? functionNode.text };
  }
  return { calleeName: functionNode.text };
}

function extract(root: SyntaxNode): PluginParseResult {
  if (!Array.isArray(root.namedChildren)) return { symbols: [], imports: [], calls: [], facts: {} };
  const symbols: PluginParsedSymbol[] = [];
  const imports: PluginParsedImport[] = [];
  const calls: PluginParsedCall[] = [];
  const annotations: PluginExtractedAnnotation[] = [];
  const literals: PluginExtractedLiteral[] = [];

  function visit(
    node: SyntaxNode,
    namespace: string,
    types: string[],
    caller?: string,
    annotationOwner: PluginExtractedAnnotation["ownerKind"] = "file"
  ): void {
    let nextNamespace = namespace;
    if (node.type === "namespace_declaration" || node.type === "file_scoped_namespace_declaration") {
      const own = nodeName(node) ?? "";
      nextNamespace = [namespace, own].filter(Boolean).join(".");
    }

    const mappedKind = symbolKind(node);
    const ownName = nodeName(node);
    let nextTypes = types;
    if (mappedKind && ownName && !node.hasError) {
      const qualifiedName = [nextNamespace, ...types, ownName].filter(Boolean).join(".");
      symbols.push({
        kind: mappedKind,
        name: ownName,
        qualifiedName,
        startLine: line(node),
        endLine: node.endPosition.row + 1,
        signature: signature(node),
        source: node.text
      });
      nextTypes = [...types, ownName];
    }

    let nextCaller = caller;
    let nextAnnotationOwner = annotationOwner;
    if (mappedKind) nextAnnotationOwner = "class";
    if (CALLER_TYPES.has(node.type) && ownName && !node.hasError) {
      const kind = node.type === "local_function_statement" ? "function" : "method";
      const qualifiedName = kind === "function" && caller
        ? `${caller}.${ownName}`
        : [nextNamespace, ...types, ownName].filter(Boolean).join(".");
      symbols.push({ kind, name: ownName, qualifiedName, startLine: line(node), endLine: node.endPosition.row + 1,
        signature: signature(node), source: node.text });
      nextCaller = qualifiedName;
      nextAnnotationOwner = "method";
    }
    if (node.type === "field_declaration" || node.type === "property_declaration") nextAnnotationOwner = "field";

    if (node.type === "using_directive" && !node.hasError) {
      const alias = node.childForFieldName("name");
      const target = alias
        ? node.namedChildren.find((child) => child.startIndex !== alias.startIndex)
        : node.namedChildren.at(-1);
      if (target) imports.push({ module: target.text, raw: node.text, line: line(node) });
    }

    if (node.type === "invocation_expression" && !node.hasError) {
      const functionNode = node.childForFieldName("function") ?? node.namedChildren[0];
      const argumentsNode = node.childForFieldName("arguments");
      if (functionNode) calls.push({ ...calleeParts(functionNode), argsCount: argumentsNode?.namedChildren.length ?? 0,
        raw: node.text, line: line(node), ...(caller ? { callerSymbolName: caller } : {}) });
    }

    if (node.type === "attribute" && !node.hasError) {
      annotations.push({ ownerKind: annotationOwner, name: ownName ?? node.namedChildren[0]?.text ?? node.text,
        arguments: attributeArguments(node), raw: node.text, line: line(node) });
    }
    if (STRING_TYPES.has(node.type) || NUMBER_TYPES.has(node.type)) {
      literals.push({ kind: STRING_TYPES.has(node.type) ? "string" : "number", value: literalValue(node.text), raw: node.text, line: line(node) });
    }
    if (node.type === "interpolated_string_expression" && !node.hasError) {
      literals.push({ kind: "template", value: node.text, raw: node.text, line: line(node) });
    }

    let siblingNamespace = nextNamespace;
    for (const child of node.namedChildren) {
      visit(child, siblingNamespace, nextTypes, nextCaller, nextAnnotationOwner);
      if (child.type === "file_scoped_namespace_declaration") {
        const own = nodeName(child) ?? "";
        siblingNamespace = [siblingNamespace, own].filter(Boolean).join(".");
      }
    }
  }

  visit(root, "", []);
  const facts: PluginAstFacts = {};
  if (annotations.length) facts.annotations = annotations;
  if (literals.length) facts.literals = literals;
  return { symbols, imports, calls, facts };
}

export function createCSharpParser(moduleLoader: ModuleLoader = (specifier) => import(specifier)) {
  let loading: Promise<ParserInstance> | undefined;

  async function load(): Promise<ParserInstance> {
    if (loading) return loading;
    const attempt = Promise.all([moduleLoader("tree-sitter"), moduleLoader("tree-sitter-c-sharp")])
      .then(([parserModule, grammarModule]) => {
        const Parser = moduleDefault(parserModule) as ParserConstructor;
        const parser = new Parser();
        parser.setLanguage(moduleDefault(grammarModule));
        return parser;
      });
    loading = attempt;
    try { return await attempt; } catch (error) {
      if (loading === attempt) loading = undefined;
      throw error;
    }
  }

  return async function parse(input: PluginParseInput): Promise<PluginParseResult> {
    const tree = (await load()).parse(input.source);
    if (tree.rootNode.type !== "compilation_unit") throw new Error(`Unexpected C# syntax tree root: ${tree.rootNode.type}`);
    return extract(tree.rootNode);
  };
}

export const parseCSharp = createCSharpParser();
