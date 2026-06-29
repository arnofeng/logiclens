import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { codeId } from "../../../../shared/path.js";
import { hashText } from "../../../../shared/hash.js";
import { isParsedCodeFile, pushGrpcContract } from "./shared.js";
import { attributeParts, callArguments, namedChildren, parseSourceAst, walkSourceAst } from "./sourceAstUtils.js";
import type { GrpcStreaming } from "../../spec.js";

function makeSymbol(file: ParsedFile, node: Parser.SyntaxNode, kind: CodeSymbol["kind"], name: string, qualifiedName: string): CodeSymbol {
  const startLine = node.startPosition.row + 1;
  const raw = node.text;
  return {
    id: codeId(file.repoId, file.path, kind, qualifiedName, startLine),
    repoId: file.repoId,
    fileId: file.fileId,
    kind,
    name,
    qualifiedName,
    startLine,
    endLine: node.endPosition.row + 1,
    signature: raw.split(/\r?\n/, 1)[0] ?? raw,
    source: raw,
    hash: hashText(raw)
  };
}

function pythonCall(node: Parser.SyntaxNode): { object?: string; functionName?: string; method?: string; args: Parser.SyntaxNode[] } | undefined {
  if (node.type !== "call") return undefined;
  const fn = node.childForFieldName("function") ?? node.namedChild(0);
  if (!fn) return undefined;
  if (fn.type === "identifier") return { functionName: fn.text, args: callArguments(node) };
  if (fn.type === "attribute") {
    const { object, property } = attributeParts(fn);
    return { object, method: property, args: callArguments(node) };
  }
  return undefined;
}

function classService(node: Parser.SyntaxNode): string | undefined {
  return node.text.match(/\bclass\s+[A-Za-z_]\w*\s*\([^)]*\b([A-Za-z_]\w*)Servicer\b/)?.[1];
}

function assignedName(node: Parser.SyntaxNode): string | undefined {
  const left = node.childForFieldName("left") ?? node.namedChild(0);
  return left?.type === "identifier" ? left.text : undefined;
}

function assignedValue(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  return node.childForFieldName("right") ?? node.namedChild(1) ?? undefined;
}

function typeFromCall(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node || node.type !== "call") return undefined;
  const fn = node.childForFieldName("function") ?? node.namedChild(0);
  if (!fn) return undefined;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "attribute") return attributeParts(fn).property;
  return undefined;
}

function pythonParameterNames(functionNode: Parser.SyntaxNode): string[] {
  const params = functionNode.childForFieldName("parameters");
  return params ? namedChildren(params).filter((node) => node.type === "identifier").map((node) => node.text) : [];
}

function isGrpcServicerMethod(functionNode: Parser.SyntaxNode): boolean {
  const params = pythonParameterNames(functionNode);
  // Unary/server-streaming take `request`; client-/bidi-streaming take
  // `request_iterator`. Both carry the trailing `context` argument.
  return params.length >= 3 && params[0] === "self" && params.includes("context")
    && (params.includes("request") || params.includes("request_iterator"));
}

/**
 * Best-effort streaming detection for a servicer method: a streaming request is
 * delivered as `request_iterator`, while a streaming response is produced with
 * `yield` in the method body.
 */
function pythonServicerStreaming(functionNode: Parser.SyntaxNode): GrpcStreaming {
  const params = pythonParameterNames(functionNode);
  const clientStreams = params.some((name) => name !== "self" && name !== "context" && /iterator/i.test(name));
  const body = functionNode.childForFieldName("body");
  const serverStreams = body ? /\byield\b/.test(body.text) : false;
  if (clientStreams && serverStreams) return "bidi-stream";
  if (clientStreams) return "client-stream";
  if (serverStreams) return "server-stream";
  return "unary";
}

export const pythonGrpcExtractor = compatExtractor({
  name: "builtin:python-grpc",
  languages: ["python"],
  extract(context, collector: FactCollector) {
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "python") continue;
      const ast = parseSourceAst(file, "python");
      if (!ast) continue;

      walkSourceAst(ast.tree.rootNode, (node) => {
        if (node.type !== "class_definition") return;
        const service = classService(node);
        if (!service) return;
        for (const child of namedChildren(node)) {
          const bodyChildren = child.type === "block" ? namedChildren(child) : [];
          for (const member of bodyChildren) {
            if (member.type !== "function_definition") continue;
            const method = member.childForFieldName("name")?.text;
            if (!method || method.startsWith("_")) continue;
            if (!isGrpcServicerMethod(member)) continue;
            const symbol = makeSymbol(file, member, "method", method, `${service}.${method}`);
            pushGrpcContract({
              collector,
              file,
              symbol,
              fullName: `${service}/${method}`,
              role: "producer",
              offset: 0,
              raw: member.text,
              rule: "python-grpc-server",
              confidence: confidenceFor("exact-parser-route"),
              service,
              method,
              streaming: pythonServicerStreaming(member),
              framework: "grpc-python"
            });
          }
        }
      });

      const stubVariables = new Map<string, string>();
      walkSourceAst(ast.tree.rootNode, (node) => {
        if (node.type !== "assignment") return;
        const name = assignedName(node);
        const value = assignedValue(node);
        if (!name || !value || value.type !== "call") return;
        const calledType = typeFromCall(value);
        const service = calledType?.match(/^([A-Za-z_]\w*)Stub$/)?.[1];
        if (service) stubVariables.set(name, service);
      });

      const seen = new Set<string>();
      walkSourceAst(ast.tree.rootNode, (node) => {
        const call = pythonCall(node);
        if (!call?.object || !call.method) return;
        const service = stubVariables.get(call.object);
        if (!service) return;
        const method = call.method;
        const fullName = `${service}/${method}`;
        if (seen.has(fullName)) return;
        seen.add(fullName);

        const symbol = makeSymbol(file, node, "method", method, `${service}.${method}`);
        pushGrpcContract({
          collector,
          file,
          symbol,
          fullName,
          role: "consumer",
          offset: 0,
          raw: node.text,
          rule: "python-grpc-client",
          confidence: confidenceFor("exact-parser-route"),
          service,
          method,
          requestType: typeFromCall(call.args[0]),
          streaming: "unary",
          framework: "grpc-python"
        });
      });
    }
  }
});
