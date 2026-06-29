import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { codeId } from "../../../../shared/path.js";
import { hashText } from "../../../../shared/hash.js";
import { isParsedCodeFile, pushGrpcContract } from "./shared.js";
import { callArguments, namedChildren, parseJsAst, staticPropertyPath, walkAst } from "./jsAstUtils.js";

function upperFirst(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
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

function importsGrpcJs(file: ParsedFile): boolean {
  return file.imports.some((ref) => /(?:^|\/)@grpc\/grpc-js$/.test(ref.module) || /grpc-js/.test(ref.module));
}

function memberCall(node: Parser.SyntaxNode): { objectPath?: string; method?: string; args: Parser.SyntaxNode[] } | undefined {
  if (node.type !== "call_expression") return undefined;
  const fn = node.childForFieldName("function");
  if (!fn || fn.type !== "member_expression") return undefined;
  const object = fn.childForFieldName("object");
  const property = fn.childForFieldName("property");
  return {
    objectPath: object ? staticPropertyPath(object) : undefined,
    method: property?.text,
    args: callArguments(node)
  };
}

function normalizeServiceName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let service = raw.replace(/Client$/, "").replace(/ServiceDefinition$/, "");
  if (service.endsWith("ServiceService")) service = service.slice(0, -"Service".length);
  return service;
}

function serviceFromDefinition(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  const path = staticPropertyPath(node) ?? node.text;
  const parts = path.split(".").filter(Boolean);
  if (parts.at(-1) === "service") parts.pop();
  return normalizeServiceName(parts.at(-1));
}

function clientConstructorService(value: Parser.SyntaxNode | undefined): string | undefined {
  if (!value || value.type !== "new_expression") return undefined;
  const ctor = value.childForFieldName("constructor") ?? value.namedChild(0);
  const raw = ctor ? (staticPropertyPath(ctor) ?? ctor.text) : undefined;
  const typeName = raw?.split(".").filter(Boolean).at(-1);
  return typeName?.endsWith("Client") ? normalizeServiceName(typeName) : undefined;
}

function propertyName(node: Parser.SyntaxNode): string | undefined {
  if (node.type === "pair") {
    const key = node.childForFieldName("key");
    return key?.text.replace(/^["'`]|["'`]$/g, "");
  }
  if (node.type === "method_definition") {
    return node.childForFieldName("name")?.text;
  }
  return undefined;
}

function propertyValue(node: Parser.SyntaxNode): Parser.SyntaxNode {
  return node.childForFieldName("value") ?? node;
}

function variableDeclarator(node: Parser.SyntaxNode): { name?: string; value?: Parser.SyntaxNode } | undefined {
  if (node.type !== "variable_declarator") return undefined;
  return {
    name: node.childForFieldName("name")?.text,
    value: node.childForFieldName("value") ?? undefined
  };
}

function typeFromExpression(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "new_expression") {
    const ctor = node.childForFieldName("constructor") ?? node.namedChild(0);
    return ctor ? staticPropertyPath(ctor)?.split(".").filter(Boolean).at(-1) ?? ctor.text : undefined;
  }
  const path = staticPropertyPath(node);
  if (!path) return undefined;
  return normalizeServiceName(path.split(".").filter(Boolean).at(-1));
}

function shouldScanFile(file: ParsedFile): boolean {
  if (importsGrpcJs(file)) return true;
  return /\bgrpc\b|GrpcClient|ServiceClient|addService/.test(file.source ?? "");
}

export const jsGrpcExtractor = compatExtractor({
  name: "builtin:js-grpc",
  languages: ["javascript", "typescript"],
  extract(context, collector: FactCollector) {
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (!(file.language === "typescript" || file.language === "tsx" || file.language === "javascript" || file.language === "jsx")) continue;
      if (!shouldScanFile(file)) continue;
      const ast = parseJsAst(file);
      if (!ast) continue;

      walkAst(ast.tree.rootNode, (node) => {
        const call = memberCall(node);
        if (call?.method !== "addService") return;
        const service = serviceFromDefinition(call.args[0]);
        const handlers = call.args[1];
        if (!service || !handlers || handlers.type !== "object") return;
        for (const entry of namedChildren(handlers)) {
          const rawMethod = propertyName(entry);
          if (!rawMethod) continue;
          const method = upperFirst(rawMethod);
          const value = propertyValue(entry);
          const symbol = makeSymbol(file, value, "method", method, `${service}.${method}`);
          pushGrpcContract({
            collector,
            file,
            symbol,
            fullName: `${service}/${method}`,
            role: "producer",
            offset: 0,
            raw: value.text,
            rule: "js-grpc-server",
            confidence: confidenceFor("exact-parser-route"),
            service,
            method,
            streaming: "unary",
            framework: "grpc-js"
          });
        }
      });

      const clientVariables = new Map<string, string>();
      walkAst(ast.tree.rootNode, (node) => {
        const variable = variableDeclarator(node);
        if (!variable?.name) return;
        const service = clientConstructorService(variable.value);
        if (service) clientVariables.set(variable.name, service);
      });

      const seen = new Set<string>();
      walkAst(ast.tree.rootNode, (node) => {
        const call = memberCall(node);
        if (!call?.objectPath || !call.method) return;
        const root = call.objectPath.split(".")[0]!;
        const service = clientVariables.get(call.objectPath) ?? clientVariables.get(root);
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
          rule: "js-grpc-client",
          confidence: confidenceFor("exact-parser-route"),
          service,
          method,
          requestType: typeFromExpression(call.args[0]),
          streaming: "unary",
          framework: "grpc-js"
        });
      });
    }
  }
});
