import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { codeId } from "../../../../shared/path.js";
import { hashText } from "../../../../shared/hash.js";
import { parsedCodeFiles, pushGrpcContract } from "./shared.js";
import { namedChildren, parseSourceAst, walkSourceAst } from "./sourceAstUtils.js";
import type { GrpcStreaming } from "../../spec.js";

function upperFirst(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function simpleTypeName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/\b(final|var)\b/g, "")
    .replace(/[?*&]/g, "")
    .trim();
  const generic = cleaned.match(/([A-Za-z_$][\w$]*)\s*(?:<|$)/)?.[1];
  return generic?.split(".").at(-1);
}

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

function javaMethodCall(node: Parser.SyntaxNode): { object?: string; method?: string; args: Parser.SyntaxNode[] } | undefined {
  if (node.type !== "method_invocation") return undefined;
  const object = node.childForFieldName("object");
  const name = node.childForFieldName("name");
  const argsNode = node.childForFieldName("arguments");
  return { object: object?.text, method: name?.text, args: argsNode ? namedChildren(argsNode) : [] };
}

function producerClassService(classNode: Parser.SyntaxNode): string | undefined {
  const match = classNode.text.match(/\bextends\s+(?:[\w$]+\.)?([A-Za-z_$][\w$]*)Grpc\.([A-Za-z_$][\w$]*)ImplBase\b/);
  return match?.[2];
}

function methodSignatureTypes(methodNode: Parser.SyntaxNode): { requestType?: string; responseType?: string } {
  const text = methodNode.text;
  const header = text.slice(0, Math.max(text.indexOf("{"), text.length));
  const params = header.match(/\(([\s\S]*?)\)/)?.[1] ?? "";
  const responseType = header.match(/\bStreamObserver\s*<\s*([A-Za-z_$][\w$]*)\s*>/)?.[1];
  const requestParam = params
    .split(",")
    .map((part) => part.trim())
    .find((part) => part && !part.includes("StreamObserver") && !/\b(Observer|Context)\b/.test(part));
  const requestType = simpleTypeName(requestParam?.split(/\s+/).slice(0, -1).join(" "));
  return { requestType, responseType };
}

/** Type texts of a method's formal parameters (e.g. ["CreateOrderRequest", "StreamObserver<Order>"]). */
function javaParamTypes(methodNode: Parser.SyntaxNode): string[] {
  const params = methodNode.childForFieldName("parameters");
  if (!params) return [];
  return namedChildren(params)
    .filter((p) => p.type === "formal_parameter" || p.type === "spread_parameter")
    .map((p) => p.childForFieldName("type")?.text ?? "");
}

/**
 * A gRPC ImplBase server method always carries a `StreamObserver<...>` response
 * observer parameter. Inspecting the parameter types (rather than the whole
 * method text) avoids false positives from helper methods that merely mention
 * StreamObserver in their body.
 */
function isGrpcServerMethod(methodNode: Parser.SyntaxNode): boolean {
  return javaParamTypes(methodNode).some((t) => /\bStreamObserver\s*</.test(t));
}

/**
 * Best-effort streaming detection for an ImplBase server method. Client-/bidi-
 * streaming methods return a `StreamObserver<Request>`, whereas unary/server-
 * streaming methods return void â€?the latter two are indistinguishable from the
 * Java signature alone (the proto extractor remains the source of truth).
 */
function javaServerStreaming(methodNode: Parser.SyntaxNode): GrpcStreaming {
  const returnType = methodNode.childForFieldName("type")?.text ?? "";
  return /\bStreamObserver\s*</.test(returnType) ? "client-stream" : "unary";
}

function variableDeclarator(node: Parser.SyntaxNode): { name?: string; value?: Parser.SyntaxNode } | undefined {
  if (node.type !== "variable_declarator") return undefined;
  return {
    name: node.childForFieldName("name")?.text,
    value: node.childForFieldName("value") ?? undefined
  };
}

function serviceFromStubFactory(text: string): string | undefined {
  return text.match(/\b([A-Za-z_$][\w$]*)Grpc\.new(?:Blocking|Future)?Stub\s*\(/)?.[1];
}

function typeFromObjectCreation(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "object_creation_expression") {
    return simpleTypeName(node.childForFieldName("type")?.text ?? node.namedChild(0)?.text);
  }
  const text = node.text;
  return text.match(/\b([A-Za-z_$][\w$]*)\.newBuilder\s*\(/)?.[1]
    ?? text.match(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1];
}

export const javaGrpcExtractor = compatExtractor({
  name: "builtin:java-grpc",
  languages: ["java"],
  extract(context, collector: FactCollector) {
    for (const file of parsedCodeFiles(context.parsedFiles)) {
      if (file.language !== "java") continue;
      const ast = parseSourceAst(file, "java");
      if (!ast) continue;

      walkSourceAst(ast.tree.rootNode, (node) => {
        if (node.type !== "class_declaration") return;
        const service = producerClassService(node);
        if (!service) return;

        walkSourceAst(node, (child) => {
          if (child.type !== "method_declaration") return;
          if (!isGrpcServerMethod(child)) return;
          const rawMethod = child.childForFieldName("name")?.text;
          if (!rawMethod) return;
          const method = upperFirst(rawMethod);
          const { requestType, responseType } = methodSignatureTypes(child);
          const symbol = makeSymbol(file, child, "method", method, `${service}.${method}`);
          pushGrpcContract({
            collector,
            file,
            symbol,
            fullName: `${service}/${method}`,
            role: "producer",
            offset: 0,
            raw: child.text,
            rule: "java-grpc-server",
            confidence: confidenceFor("exact-parser-route"),
            service,
            method,
            requestType,
            responseType,
            streaming: javaServerStreaming(child),
            framework: "grpc-java"
          });
        });
      });

      const clientVariables = new Map<string, string>();
      walkSourceAst(ast.tree.rootNode, (node) => {
        const variable = variableDeclarator(node);
        if (!variable?.name || !variable.value) return;
        const service = serviceFromStubFactory(variable.value.text);
        if (service) clientVariables.set(variable.name, service);
      });

      const seen = new Set<string>();
      walkSourceAst(ast.tree.rootNode, (node) => {
        const call = javaMethodCall(node);
        if (!call?.object || !call.method) return;
        const service = clientVariables.get(call.object);
        if (!service) return;
        const method = upperFirst(call.method);
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
          rule: "java-grpc-client",
          confidence: confidenceFor("exact-parser-route"),
          service,
          method,
          requestType: typeFromObjectCreation(call.args[0]),
          streaming: "unary",
          framework: "grpc-java"
        });
      });
    }
  }
});
