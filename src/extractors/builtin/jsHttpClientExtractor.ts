import type Parser from "tree-sitter";
import type { CodeSymbol, ContractRole, ParsedFile } from "../../parsers/types.js";
import type { ContractExtractor } from "../../plugins/types.js";
import { confidenceFor } from "../../confidence.js";
import {
  createCrossRepoExtraction,
  evidence,
  isParsedCodeFile,
  pushApiContractFromPath,
  sourceLine,
  toFactBundle
} from "./shared.js";
import {
  buildAstConstantIndex,
  callArguments,
  objectPropertyValue,
  parseJsAst,
  resolveAstExpression,
  staticPropertyPath,
  stringLiteralValue,
  walkAst
} from "./jsAstUtils.js";

const IMPORTED_HTTP_MODULE_RE = /^(axios|ky|umi-request|request|@?\/?request|.*\/request|.*\/http)$/i;
const API_FUNCTION_RE = /^api(?:Get|Post|Put|Patch|Delete|Request)$/;
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "request"]);

type HttpCall = {
  node: Parser.SyntaxNode;
  raw: string;
  functionName?: string;
  objectPath?: string;
  methodName?: string;
  urlNode?: Parser.SyntaxNode;
  rule: "http-client-api-consumer" | "http-client-object-url-consumer";
};

function importedHttpClientNames(file: Pick<ParsedFile, "imports">): Set<string> {
  const names = new Set(["axios", "request", "service", "http", "httpClient", "apiClient"]);
  for (const importRef of file.imports) {
    if (!IMPORTED_HTTP_MODULE_RE.test(importRef.module)) continue;
    for (const binding of importRef.bindings ?? []) {
      if (binding.localName) names.add(binding.localName);
    }
  }
  return names;
}

function isKnownHttpInvocation(call: Pick<HttpCall, "functionName" | "objectPath" | "methodName">, knownClients: Set<string>): boolean {
  if (call.functionName === "fetch" || (call.functionName && API_FUNCTION_RE.test(call.functionName))) return true;
  if (call.functionName && knownClients.has(call.functionName)) return true;
  if (!call.methodName || !HTTP_METHODS.has(call.methodName)) return false;
  const rootObject = call.objectPath?.split(".")[0] ?? "";
  return knownClients.has(rootObject) || Boolean(call.objectPath && knownClients.has(call.objectPath));
}

function findContainingSymbol(symbols: CodeSymbol[], node: Parser.SyntaxNode): CodeSymbol | undefined {
  const line = node.startPosition.row + 1;
  return symbols
    .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

function symbolOffset(file: ParsedFile, symbol: CodeSymbol, node: Parser.SyntaxNode): number {
  const source = file.source ?? "";
  const symbolStart = source.indexOf(symbol.source);
  return symbolStart >= 0 ? Math.max(0, node.startIndex - symbolStart) : 0;
}

function collectHttpCalls(root: Parser.SyntaxNode, knownClients: Set<string>): HttpCall[] {
  const calls: HttpCall[] = [];
  walkAst(root, (node) => {
    if (node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");
    if (!fn) return;

    const args = callArguments(node);
    let call: HttpCall | undefined;
    if (fn.type === "identifier") {
      const firstArg = args[0];
      const objectUrl = firstArg?.type === "object" ? objectPropertyValue(firstArg, "url") : undefined;
      call = {
        node,
        raw: node.text,
        functionName: fn.text,
        urlNode: objectUrl ?? firstArg,
        rule: objectUrl ? "http-client-object-url-consumer" : "http-client-api-consumer"
      };
    } else if (fn.type === "member_expression") {
      const property = fn.childForFieldName("property")?.text;
      const object = fn.childForFieldName("object");
      const firstArg = args[0];
      call = {
        node,
        raw: node.text,
        objectPath: object ? staticPropertyPath(object) : undefined,
        methodName: property,
        urlNode: firstArg,
        rule: "http-client-api-consumer"
      };
    }
    if (call && isKnownHttpInvocation(call, knownClients)) calls.push(call);
  });
  return calls;
}

function pushDynamicUnresolvedEvidence(input: {
  result: ReturnType<typeof createCrossRepoExtraction>;
  file: ParsedFile;
  symbol: CodeSymbol;
  offset: number;
  raw: string;
  reason: string;
}): void {
  input.result.evidence.push(evidence({
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    filePath: input.file.path,
    line: sourceLine(input.symbol.source, input.offset, input.symbol.startLine),
    raw: `${input.raw} // unresolved: ${input.reason}`,
    rule: "dynamic-unresolved",
    confidence: 0
  }));
}

function isApiPathLiteral(node: Parser.SyntaxNode): string | undefined {
  const value = stringLiteralValue(node);
  return value?.startsWith("/api/") ? value : undefined;
}

function isInsideKnownHttpCall(node: Parser.SyntaxNode, knownClients: Set<string>): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "call_expression") {
      return collectHttpCalls(current, knownClients).length > 0;
    }
    current = current.parent;
  }
  return false;
}

function isInsideUnknownHttpLikeMemberCall(node: Parser.SyntaxNode, knownClients: Set<string>): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "call_expression") {
      const fn = current.childForFieldName("function");
      if (fn?.type === "member_expression") {
        const method = fn.childForFieldName("property")?.text;
        const objectPath = fn.childForFieldName("object") ? staticPropertyPath(fn.childForFieldName("object")!) : undefined;
        const rootObject = objectPath?.split(".")[0] ?? "";
        return Boolean(method && HTTP_METHODS.has(method) && !knownClients.has(rootObject) && !knownClients.has(objectPath ?? ""));
      }
      return false;
    }
    current = current.parent;
  }
  return false;
}

export const jsHttpClientExtractor: ContractExtractor = {
  name: "builtin:js-http-client",
  languages: ["javascript", "typescript"],
  frameworks: ["js:axios", "js:generic-fetch"],
  extract(context) {
    const result = createCrossRepoExtraction();
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (!(file.language === "typescript" || file.language === "tsx" || file.language === "javascript" || file.language === "jsx")) continue;
      const ast = parseJsAst(file);
      if (!ast) continue;

      const constants = buildAstConstantIndex(ast.tree.rootNode);
      const knownHttpClients = importedHttpClientNames(file);
      const seenPathOffsets = new Set<number>();

      for (const call of collectHttpCalls(ast.tree.rootNode, knownHttpClients)) {
        const symbol = findContainingSymbol(file.symbols, call.node);
        if (!symbol || !call.urlNode) continue;
        const offset = symbolOffset(file, symbol, call.node);
        const resolved = resolveAstExpression(call.urlNode, constants);
        if (!resolved.value?.startsWith("/")) {
          pushDynamicUnresolvedEvidence({
            result,
            file,
            symbol,
            offset,
            raw: call.raw,
            reason: call.rule === "http-client-object-url-consumer"
              ? "HTTP object url is not a resolvable static path"
              : "HTTP call argument is not a resolvable static path"
          });
          continue;
        }
        seenPathOffsets.add(call.urlNode.startIndex);
        pushApiContractFromPath({
          result,
          file,
          symbol,
          apiPath: resolved.value,
          role: "consumer",
          offset,
          raw: call.raw,
          rule: call.rule,
          confidence: confidenceFor("probable-http-client")
        });
      }

      walkAst(ast.tree.rootNode, (node) => {
        const apiPath = isApiPathLiteral(node);
        if (!apiPath || seenPathOffsets.has(node.startIndex) || isInsideKnownHttpCall(node, knownHttpClients) || isInsideUnknownHttpLikeMemberCall(node, knownHttpClients)) return;
        const symbol = findContainingSymbol(file.symbols, node);
        if (!symbol) return;
        const isLikelyProducerFile = /controller|route|server|api/i.test(file.path + " " + symbol.qualifiedName);
        const role: ContractRole = isLikelyProducerFile ? "producer" : "consumer";
        pushApiContractFromPath({
          result,
          file,
          symbol,
          apiPath,
          role,
          offset: symbolOffset(file, symbol, node),
          raw: node.text,
          rule: role === "producer" ? "api-path-producer" : "api-path-consumer",
          confidence: role === "producer" ? confidenceFor("probable-http-client") : confidenceFor("probable-http-route")
        });
      });
    }
    return toFactBundle(result);
  }
};
