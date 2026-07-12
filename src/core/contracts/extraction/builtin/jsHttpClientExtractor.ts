import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { CodeSymbol, ContractRole, ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  evidence,
  parsedCodeFiles,
  pushApiContractFromPath,
  sourceLine, } from "./shared.js";
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
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "request"]);

type HttpCall = {
  node: Parser.SyntaxNode;
  raw: string;
  functionName?: string;
  objectPath?: string;
  receiverText?: string;
  methodName?: string;
  urlNode?: Parser.SyntaxNode;
  rule: "http-client-api-consumer" | "http-client-object-url-consumer";
  httpMethod?: string;
  knownClient: boolean;
};

function importedHttpClientNames(file: Pick<ParsedFile, "imports">): Set<string> {
  const names = new Set(["axios", "request", "http", "httpClient", "apiClient"]);
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

function inferMethodFromFunctionName(name: string): string | undefined {
  const match = name.match(/^api(Get|Post|Put|Patch|Delete|Request)$/i);
  return match ? match[1]!.toUpperCase() : undefined;
}

function inferMethodFromFetchOptions(args: Parser.SyntaxNode[]): string | undefined {
  const optionsArg = args[1];
  if (!optionsArg || optionsArg.type !== "object") return undefined;
  const methodNode = objectPropertyValue(optionsArg, "method");
  if (!methodNode) return undefined;
  const value = stringLiteralValue(methodNode);
  return value ? value.toUpperCase() : undefined;
}

function memberInvocation(fn: Parser.SyntaxNode): {
  methodName?: string;
  objectPath?: string;
  receiverText?: string;
} | undefined {
  if (fn.type === "member_expression") {
    const object = fn.childForFieldName("object");
    return {
      methodName: fn.childForFieldName("property")?.text.toLowerCase(),
      objectPath: object ? staticPropertyPath(object) : undefined,
      receiverText: object?.text
    };
  }
  if (fn.type === "subscript_expression") {
    const object = fn.childForFieldName("object");
    const index = fn.childForFieldName("index");
    return {
      methodName: index ? stringLiteralValue(index)?.toLowerCase() : undefined,
      objectPath: object ? staticPropertyPath(object) : undefined,
      receiverText: object?.text
    };
  }
  return undefined;
}

function methodAndUrlFromRequestObject(firstArg: Parser.SyntaxNode | undefined): {
  httpMethod?: string;
  urlNode?: Parser.SyntaxNode;
} {
  if (firstArg?.type !== "object") return { urlNode: firstArg };
  const methodNode = objectPropertyValue(firstArg, "method");
  const method = methodNode ? stringLiteralValue(methodNode)?.toUpperCase() : undefined;
  return {
    httpMethod: method && HTTP_METHODS.has(method.toLowerCase()) && method !== "REQUEST" ? method : undefined,
    urlNode: objectPropertyValue(firstArg, "url")
  };
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
      let httpMethod: string | undefined;
      if (fn.text === "fetch") {
        httpMethod = inferMethodFromFetchOptions(args) ?? "GET";
      } else if (API_FUNCTION_RE.test(fn.text)) {
        httpMethod = inferMethodFromFunctionName(fn.text);
      } else if (objectUrl) {
        const methodNode = firstArg?.type === "object" ? objectPropertyValue(firstArg, "method") : undefined;
        httpMethod = methodNode ? (stringLiteralValue(methodNode)?.toUpperCase() ?? undefined) : undefined;
      }
      call = {
        node,
        raw: node.text,
        functionName: fn.text,
        urlNode: objectUrl ?? firstArg,
        rule: objectUrl ? "http-client-object-url-consumer" : "http-client-api-consumer",
        httpMethod,
        knownClient: isKnownHttpInvocation({ functionName: fn.text }, knownClients)
      };
    } else {
      const invocation = memberInvocation(fn);
      if (!invocation?.methodName || !HTTP_METHODS.has(invocation.methodName)) return;
      const firstArg = args[0];
      const requestShape = invocation.methodName === "request"
        ? methodAndUrlFromRequestObject(firstArg)
        : { httpMethod: invocation.methodName.toUpperCase(), urlNode: firstArg };
      const knownClient = isKnownHttpInvocation({
        objectPath: invocation.objectPath,
        methodName: invocation.methodName
      }, knownClients);
      call = {
        node,
        raw: node.text,
        objectPath: invocation.objectPath,
        receiverText: invocation.receiverText,
        methodName: invocation.methodName,
        urlNode: requestShape.urlNode,
        rule: "http-client-api-consumer",
        httpMethod: requestShape.httpMethod,
        knownClient
      };
    }
    if (call && (call.knownClient || Boolean(call.methodName && HTTP_METHODS.has(call.methodName)))) calls.push(call);
  });
  return calls;
}

function pushDynamicUnresolvedEvidence(input: {
  collector: FactCollector;
  file: ParsedFile;
  symbol: CodeSymbol;
  offset: number;
  raw: string;
  reason: string;
}): void {
  input.collector.addEvidence(evidence({
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    filePath: input.file.path,
    line: sourceLine(input.symbol.source, input.offset, input.symbol.startLine),
    raw: `${input.raw} // unresolved: ${input.reason}`,
    rule: "dynamic-unresolved",
    confidence: 0
  }));
}

function shouldRecordUnresolvedHttpCall(call: HttpCall, resolvedValue: string | undefined, dynamic: boolean): boolean {
  // A statically resolved non-path value is positive evidence that this is a
  // local get/delete-style operation, not an unresolved HTTP request.
  if (resolvedValue !== undefined && !dynamic) return false;
  if (call.knownClient) return true;
  const receiverLooksHttp = /api|http|client|request/i.test(call.receiverText ?? call.objectPath ?? "");
  const argumentLooksLikeUrl = /url|uri|path/i.test(call.urlNode?.text ?? "");
  return receiverLooksHttp || argumentLooksLikeUrl;
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

function isInsideDynamicSubscriptCall(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "call_expression") {
      const fn = current.childForFieldName("function");
      const index = fn?.type === "subscript_expression" ? fn.childForFieldName("index") : undefined;
      return fn?.type === "subscript_expression" && (!index || !stringLiteralValue(index));
    }
    current = current.parent;
  }
  return false;
}

export const jsHttpClientExtractor = compatExtractor({
  name: "builtin:js-http-client",
  languages: ["javascript", "typescript"],
  frameworks: ["js:axios", "js:generic-fetch"],
  extract(context, collector: FactCollector) {
    for (const file of parsedCodeFiles(context.parsedFiles)) {
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
        seenPathOffsets.add(call.urlNode.startIndex);
        const resolved = resolveAstExpression(call.urlNode, constants);
        if (!resolved.value?.startsWith("/")) {
          if (shouldRecordUnresolvedHttpCall(call, resolved.value, resolved.dynamic)) {
            pushDynamicUnresolvedEvidence({
              collector,
              file,
              symbol,
              offset,
              raw: call.raw,
              reason: call.rule === "http-client-object-url-consumer"
                ? "HTTP object url is not a resolvable static path"
                : "HTTP call argument is not a resolvable static path"
            });
          }
          continue;
        }
        pushApiContractFromPath({
          collector,
          file,
          symbol,
          apiPath: resolved.value,
          role: "consumer",
          offset,
          raw: call.raw,
          rule: call.rule,
          confidence: call.httpMethod
            ? confidenceFor(call.knownClient ? "probable-http-client" : "probable-http-route")
            : confidenceFor("method-unknown-fallback"),
          method: call.httpMethod,
          framework: "js-http-client"
        });
      }

      walkAst(ast.tree.rootNode, (node) => {
        const apiPath = isApiPathLiteral(node);
        if (!apiPath || seenPathOffsets.has(node.startIndex) || isInsideKnownHttpCall(node, knownHttpClients) || isInsideDynamicSubscriptCall(node)) return;
        const symbol = findContainingSymbol(file.symbols, node);
        if (!symbol) return;
        const isLikelyProducerFile = /controller|route|server|api/i.test(file.path + " " + symbol.qualifiedName);
        const role: ContractRole = isLikelyProducerFile ? "producer" : "consumer";
        pushApiContractFromPath({
          collector,
          file,
          symbol,
          apiPath,
          role,
          offset: symbolOffset(file, symbol, node),
          raw: node.text,
          rule: role === "producer" ? "api-path-producer" : "api-path-consumer",
          confidence: role === "producer" ? confidenceFor("probable-http-client") : confidenceFor("probable-http-route"),
          framework: "js-http-client"
        });
      });
    }
  }
});
