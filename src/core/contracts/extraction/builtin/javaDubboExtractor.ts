import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { codeId } from "../../../../shared/path.js";
import { hashText } from "../../../../shared/hash.js";
import { isParsedCodeFile, javaPackageFromPath, pushDubboContract } from "./shared.js";
import { namedChildren, parseSourceAst, walkSourceAst } from "./sourceAstUtils.js";

type JavaImportMap = Map<string, string>;

const DUBBO_SERVICE_ANNOTATIONS = new Set([
  "DubboService",
  "Service",
  "org.apache.dubbo.config.annotation.DubboService",
  "org.apache.dubbo.config.annotation.Service",
  "com.alibaba.dubbo.config.annotation.Service"
]);

const DUBBO_REFERENCE_ANNOTATIONS = new Set([
  "DubboReference",
  "Reference",
  "org.apache.dubbo.config.annotation.DubboReference",
  "org.apache.dubbo.config.annotation.Reference",
  "com.alibaba.dubbo.config.annotation.Reference"
]);

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

function simpleTypeName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\b(final|var)\b/g, "").replace(/[?*&]/g, "").trim();
  const generic = cleaned.match(/([A-Za-z_$][\w$]*)\s*(?:<|$)/)?.[1];
  return generic?.split(".").at(-1);
}

function javaParamTypes(methodNode: Parser.SyntaxNode): string[] {
  const params = methodNode.childForFieldName("parameters");
  if (!params) return [];
  return namedChildren(params)
    .filter((p) => p.type === "formal_parameter" || p.type === "spread_parameter")
    .map((p) => simpleTypeName(p.childForFieldName("type")?.text) ?? "")
    .filter(Boolean);
}

function javaReturnType(methodNode: Parser.SyntaxNode): string | undefined {
  return simpleTypeName(methodNode.childForFieldName("type")?.text);
}

function annotationNames(node: Parser.SyntaxNode): string[] {
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
  if (!modifiers) return [];
  const names: string[] = [];
  for (const child of modifiers.namedChildren) {
    if (child.type !== "marker_annotation" && child.type !== "annotation") continue;
    const name = child.namedChildren[0]?.text;
    if (name) names.push(name);
  }
  return names;
}

function annotationValue(node: Parser.SyntaxNode, annotationName: string, property: "group" | "version"): string | undefined {
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
  const annotation = modifiers?.namedChildren.find((child) => (
    (child.type === "marker_annotation" || child.type === "annotation") &&
    child.namedChildren[0]?.text.split(".").at(-1) === annotationName
  ));
  if (!annotation) return undefined;
  const match = annotation.text.match(new RegExp(`\\b${property}\\s*=\\s*"([^"]+)"`));
  return match?.[1];
}

function hasAnyAnnotation(node: Parser.SyntaxNode, names: Set<string>, imports: JavaImportMap): boolean {
  return annotationNames(node).some((name) => {
    if (names.has(name)) return true;
    const simple = name.split(".").at(-1) ?? name;
    if (!names.has(simple)) return false;
    const imported = imports.get(simple);
    return !imported || names.has(imported) || imported.startsWith("org.apache.dubbo.") || imported.startsWith("com.alibaba.dubbo.");
  });
}

function javaImports(source: string): JavaImportMap {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/^\s*import\s+([\w.]+)\s*;/gm)) {
    const fqn = match[1]!;
    imports.set(fqn.split(".").at(-1)!, fqn);
  }
  return imports;
}

function javaPackage(source: string, file: ParsedFile): string | undefined {
  return source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? javaPackageFromPath(file.path);
}

function resolveJavaType(raw: string | undefined, imports: JavaImportMap, packageName?: string): string | undefined {
  if (!raw) return undefined;
  const typeName = raw.replace(/<[\s\S]*>/g, "").trim();
  if (!typeName) return undefined;
  if (typeName.includes(".")) return typeName;
  return imports.get(typeName) ?? (packageName ? `${packageName}.${typeName}` : typeName);
}

function implementedInterfaces(classNode: Parser.SyntaxNode): string[] {
  const text = classNode.text.slice(0, Math.max(classNode.text.indexOf("{"), classNode.text.length));
  const match = text.match(/\bimplements\s+([^{]+)/);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((part) => part.trim().replace(/<[\s\S]*>/g, ""))
    .filter(Boolean);
}

function javaMethodCall(node: Parser.SyntaxNode): { object?: string; method?: string; args: Parser.SyntaxNode[] } | undefined {
  if (node.type !== "method_invocation") return undefined;
  const object = node.childForFieldName("object");
  const name = node.childForFieldName("name");
  const argsNode = node.childForFieldName("arguments");
  return { object: object?.text, method: name?.text, args: argsNode ? namedChildren(argsNode) : [] };
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

export const javaDubboExtractor = compatExtractor({
  name: "builtin:java-dubbo",
  languages: ["java"],
  extract(context, collector: FactCollector) {
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "java") continue;
      const ast = parseSourceAst(file, "java");
      if (!ast) continue;

      const imports = javaImports(ast.source);
      const packageName = javaPackage(ast.source, file);

      walkSourceAst(ast.tree.rootNode, (node) => {
        if (node.type !== "class_declaration") return;
        if (!hasAnyAnnotation(node, DUBBO_SERVICE_ANNOTATIONS, imports)) return;
        const implemented = implementedInterfaces(node)[0];
        const interfaceName = resolveJavaType(implemented, imports, packageName);
        if (!interfaceName) return;
        const group = annotationValue(node, "DubboService", "group") ?? annotationValue(node, "Service", "group");
        const version = annotationValue(node, "DubboService", "version") ?? annotationValue(node, "Service", "version");

        walkSourceAst(node, (child) => {
          if (child.type !== "method_declaration") return;
          const method = child.childForFieldName("name")?.text;
          if (!method) return;
          const symbol = makeSymbol(file, child, "method", method, `${interfaceName}.${method}`);
          pushDubboContract({
            collector,
            file,
            symbol,
            interfaceName,
            method,
            role: "producer",
            offset: 0,
            raw: child.text,
            rule: "java-dubbo-service",
            confidence: confidenceFor("exact-parser-route"),
            group,
            version,
            requestTypes: javaParamTypes(child),
            responseType: javaReturnType(child),
            config: "annotation",
            framework: "dubbo-java"
          });
        });
      });

      const referenceFields = new Map<string, { interfaceName: string; group?: string; version?: string }>();
      walkSourceAst(ast.tree.rootNode, (node) => {
        if (node.type !== "field_declaration") return;
        if (!hasAnyAnnotation(node, DUBBO_REFERENCE_ANNOTATIONS, imports)) return;
        const typeNode = node.namedChildren.find((child) => /type/.test(child.type));
        const declarator = node.namedChildren.find((child) => child.type === "variable_declarator");
        const fieldName = declarator?.childForFieldName("name")?.text;
        const interfaceName = resolveJavaType(typeNode?.text, imports, packageName);
        if (!fieldName || !interfaceName) return;
        const group = annotationValue(node, "DubboReference", "group") ?? annotationValue(node, "Reference", "group");
        const version = annotationValue(node, "DubboReference", "version") ?? annotationValue(node, "Reference", "version");
        referenceFields.set(fieldName, { interfaceName, group, version });
      });

      const seen = new Set<string>();
      walkSourceAst(ast.tree.rootNode, (node) => {
        const call = javaMethodCall(node);
        if (!call?.object || !call.method) return;
        const reference = referenceFields.get(call.object);
        if (!reference) return;
        const fullName = `${reference.interfaceName}#${call.method}`;
        if (seen.has(fullName)) return;
        seen.add(fullName);
        const symbol = makeSymbol(file, node, "method", call.method, `${reference.interfaceName}.${call.method}`);
        pushDubboContract({
          collector,
          file,
          symbol,
          interfaceName: reference.interfaceName,
          method: call.method,
          role: "consumer",
          offset: 0,
          raw: node.text,
          rule: "java-dubbo-reference",
          confidence: confidenceFor("exact-parser-route"),
          group: reference.group,
          version: reference.version,
          requestTypes: call.args.map(typeFromObjectCreation).filter((value): value is string => Boolean(value)),
          config: "annotation",
          framework: "dubbo-java"
        });
      });
    }
  }
});
