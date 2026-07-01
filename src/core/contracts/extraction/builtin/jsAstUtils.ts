import type Parser from "tree-sitter";
import { parseWithTreeSitter } from "../../../parsing/treeSitter.js";
import type { ParsedFile, SourceLanguage } from "../../../parsing/types.js";

type JsLikeLanguage = SourceLanguage | "vue";

export type JsAstContext = {
  tree: Parser.Tree;
  source: string;
};

export type ResolvedExpression = {
  value?: string;
  dynamic: boolean;
};

export function parseJsAst(file: ParsedFile): JsAstContext | undefined {
  if (!isJsLikeLanguage(file.language)) return undefined;
  const source = file.source ?? sourceFromSymbols(file);
  if (!source) return undefined;
  const parseLanguage = file.language === "vue" ? "tsx" : file.language;
  return { tree: parseWithTreeSitter(source, parseLanguage), source };
}

export function walkAst(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (let i = 0; i < node.childCount; i++) {
    walkAst(node.child(i)!, visit);
  }
}

export function firstNamedChild(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) return child;
  }
  return undefined;
}

export function namedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const children: Parser.SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) children.push(child);
  }
  return children;
}

export function stringLiteralValue(node: Parser.SyntaxNode): string | undefined {
  if (node.type !== "string" && node.type !== "string_fragment") return undefined;
  return unquote(node.text);
}

export function staticPropertyPath(node: Parser.SyntaxNode): string | undefined {
  if (node.type === "this") return "this";
  if (node.type === "identifier" || node.type === "property_identifier") return node.text;
  if (node.type !== "member_expression") return undefined;
  const object = node.childForFieldName("object");
  const property = node.childForFieldName("property");
  const objectPath = object ? staticPropertyPath(object) : undefined;
  if (!objectPath || !property) return undefined;
  return `${objectPath}.${property.text}`;
}

export function buildAstConstantIndex(root: Parser.SyntaxNode): Map<string, string> {
  const constants = new Map<string, string>();
  walkAst(root, (node) => {
    if (node.type !== "variable_declarator") return;
    if (!isConstDeclarator(node)) return;
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode || !isConstantName(nameNode.text)) return;

    const resolved = resolveAstExpression(valueNode, constants);
    if (resolved.value?.startsWith("/")) constants.set(nameNode.text, resolved.value);

    if (valueNode.type === "object") {
      for (const pair of namedChildren(valueNode).filter((child) => child.type === "pair")) {
        const keyNode = pair.childForFieldName("key");
        const value = pair.childForFieldName("value");
        if (!keyNode || !value) continue;
        const pairValue = resolveAstExpression(value, constants).value;
        if (pairValue?.startsWith("/")) constants.set(`${nameNode.text}.${unquote(keyNode.text)}`, pairValue);
      }
    }
  });
  return constants;
}

export function resolveAstExpression(node: Parser.SyntaxNode, constants: Map<string, string>): ResolvedExpression {
  const literal = stringLiteralValue(node);
  if (literal !== undefined) return { value: literal, dynamic: false };

  if (node.type === "template_string") return resolveTemplateString(node, constants);

  if (node.type === "identifier" || node.type === "member_expression") {
    const key = staticPropertyPath(node);
    return key && constants.has(key)
      ? { value: constants.get(key), dynamic: false }
      : { dynamic: true };
  }

  if (node.type === "binary_expression") return resolveBinaryExpression(node, constants);
  return { dynamic: true };
}

export function callArguments(callNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const args = callNode.childForFieldName("arguments");
  return args ? namedChildren(args) : [];
}

export function objectPropertyValue(objectNode: Parser.SyntaxNode, propertyName: string): Parser.SyntaxNode | undefined {
  if (objectNode.type !== "object") return undefined;
  for (const pair of namedChildren(objectNode).filter((child) => child.type === "pair")) {
    const key = pair.childForFieldName("key");
    if (key && unquote(key.text) === propertyName) return pair.childForFieldName("value") ?? undefined;
  }
  return undefined;
}

function resolveBinaryExpression(node: Parser.SyntaxNode, constants: Map<string, string>): ResolvedExpression {
  const children = namedChildren(node);
  if (children.length !== 2 || !node.text.includes("+")) return { dynamic: true };
  const left = resolveAstExpression(children[0]!, constants);
  const right = resolveAstExpression(children[1]!, constants);
  if (left.value !== undefined && right.value !== undefined) {
    return { value: `${left.value}${right.value}`, dynamic: left.dynamic || right.dynamic };
  }
  if (left.value?.startsWith("/")) {
    const placeholder = staticPropertyPath(children[1]!) ?? "param";
    return { value: left.value.endsWith("/") ? `${left.value}{${placeholder}}` : `${left.value}/{${placeholder}}`, dynamic: true };
  }
  return { dynamic: true };
}

function resolveTemplateString(node: Parser.SyntaxNode, constants: Map<string, string>): ResolvedExpression {
  let value = "";
  let dynamic = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === "string_fragment") {
      value += child.text;
    } else if (child.type === "template_substitution") {
      const expression = firstNamedChild(child);
      const name = expression ? staticPropertyPath(expression) ?? "param" : "param";
      if (constants.has(name)) {
        value += constants.get(name);
      } else {
        value += `{${name}}`;
        dynamic = true;
      }
    }
  }
  if (value) return { value, dynamic };
  return { value: unquote(node.text), dynamic: false };
}

function isConstantName(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
}

function isConstDeclarator(node: Parser.SyntaxNode): boolean {
  return node.parent?.text.trimStart().startsWith("const ") ?? false;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === last && (first === "\"" || first === "'" || first === "`"))
    ? trimmed.slice(1, -1)
    : trimmed;
}

function isJsLikeLanguage(language: string): language is JsLikeLanguage {
  return language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx" || language === "vue";
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
