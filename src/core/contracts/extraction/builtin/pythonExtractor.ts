import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  evidence,
  isParsedCodeFile,
  pushApiContractFromPath,
  sourceLine, } from "./shared.js";
import {
  attributeParts,
  callArguments,
  findContainingSymbol,
  parseSourceAst,
  stringLiteralValue,
  symbolOffset,
  walkSourceAst
} from "./sourceAstUtils.js";

const ROUTE_METHODS = new Set(["route", "get", "post", "put", "delete", "patch"]);
const HTTP_CLIENT_OBJECTS = new Set(["requests", "httpx", "urllib", "client"]);
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "request"]);

function isRouteDecorator(name: string): boolean {
  const methodName = name.split(".").at(-1) ?? name;
  return ROUTE_METHODS.has(methodName);
}

function pythonHttpCall(node: Parser.SyntaxNode): { urlNode?: Parser.SyntaxNode; raw: string; httpMethod?: string } | undefined {
  if (node.type !== "call") return undefined;
  const fn = node.childForFieldName("function") ?? node.namedChild(0);
  if (!fn || fn.type !== "attribute") return undefined;
  const { object, property } = attributeParts(fn);
  if (!object || !property || !HTTP_CLIENT_OBJECTS.has(object) || !HTTP_METHODS.has(property)) return undefined;
  const httpMethod = property !== "request" ? property.toUpperCase() : undefined;
  return { urlNode: callArguments(node)[0], raw: node.text, httpMethod };
}

function isInsidePythonHttpCall(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "call") return Boolean(pythonHttpCall(current));
    current = current.parent;
  }
  return false;
}

function isInsideUnknownHttpLikeCall(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "call") {
      const fn = current.childForFieldName("function") ?? current.namedChild(0);
      if (fn?.type !== "attribute") return false;
      const { object, property } = attributeParts(fn);
      return Boolean(property && HTTP_METHODS.has(property) && (!object || !HTTP_CLIENT_OBJECTS.has(object)));
    }
    current = current.parent;
  }
  return false;
}

function isInsideDecorator(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "decorator") return true;
    current = current.parent;
  }
  return false;
}

function pushDynamicUnresolvedEvidence(input: {
  collector: FactCollector;
  file: ParsedFile;
  symbol: CodeSymbol;
  offset: number;
  raw: string;
}): void {
  input.collector.addEvidence(evidence({
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    filePath: input.file.path,
    line: sourceLine(input.symbol.source, input.offset, input.symbol.startLine),
    raw: `${input.raw} // unresolved: HTTP call argument is not a resolvable static path`,
    rule: "dynamic-unresolved",
    confidence: 0
  }));
}

export const pythonExtractor = compatExtractor({
  name: "builtin:python-extractor",
  languages: ["python"],
  frameworks: ["python:generic", "python:fastapi"],
  extract(context, collector: FactCollector) {
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "python") continue;
      const ast = parseSourceAst(file, "python");
      const seenStringOffsets = new Set<number>();

      for (const decorator of file.facts?.decorators ?? []) {
        if (!decorator.ownerSymbolId || !isRouteDecorator(decorator.name)) continue;
        const pathArg = decorator.arguments[0];
        if (typeof pathArg !== "string" || !pathArg.startsWith("/")) continue;
        const ownerSymbol = file.symbols.find((s) => s.id === decorator.ownerSymbolId);
        if (!ownerSymbol) continue;
        const decoratorMethod = decorator.name.split(".").at(-1);
        const httpMethod = decoratorMethod && decoratorMethod !== "route" && ROUTE_METHODS.has(decoratorMethod)
          ? decoratorMethod.toUpperCase() : undefined;
        pushApiContractFromPath({
          collector,
          file,
          symbol: ownerSymbol,
          apiPath: pathArg,
          role: "producer",
          offset: Math.max(0, ownerSymbol.source.indexOf(decorator.raw)),
          raw: decorator.raw,
          rule: "python-decorator-producer",
          confidence: confidenceFor("exact-parser-route"),
          method: httpMethod,
          framework: "python"
        });
      }

      if (!ast) continue;
      walkSourceAst(ast.tree.rootNode, (node) => {
        const httpCall = pythonHttpCall(node);
        if (httpCall) {
          const symbol = findContainingSymbol(file.symbols, node);
          if (!symbol || !httpCall.urlNode) return;
          const offset = symbolOffset(file, symbol, node);
          const apiPath = stringLiteralValue(httpCall.urlNode);
          if (!apiPath?.startsWith("/")) {
            pushDynamicUnresolvedEvidence({ collector, file, symbol, offset, raw: httpCall.raw });
            return;
          }
          seenStringOffsets.add(httpCall.urlNode.startIndex);
          pushApiContractFromPath({
            collector,
            file,
            symbol,
            apiPath,
            role: "consumer",
            offset,
            raw: httpCall.raw,
            rule: "python-http-client-consumer",
            confidence: httpCall.httpMethod ? confidenceFor("probable-http-client") : confidenceFor("method-unknown-fallback"),
            method: httpCall.httpMethod,
            framework: "python"
          });
          return;
        }

        if (node.type !== "string" || seenStringOffsets.has(node.startIndex) || isInsidePythonHttpCall(node) || isInsideUnknownHttpLikeCall(node) || isInsideDecorator(node)) return;
        const apiPath = stringLiteralValue(node);
        if (!apiPath?.startsWith("/api/")) return;
        const symbol = findContainingSymbol(file.symbols, node);
        if (!symbol) return;
        pushApiContractFromPath({
          collector,
          file,
          symbol,
          apiPath,
          role: "consumer",
          offset: symbolOffset(file, symbol, node),
          raw: node.text,
          rule: "python-api-path-consumer",
          confidence: confidenceFor("probable-http-route"),
          framework: "python"
        });
      });
    }
  }
});
