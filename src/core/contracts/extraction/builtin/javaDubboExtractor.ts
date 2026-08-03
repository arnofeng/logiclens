import { defineBuiltinExtractor } from "./defineBuiltinExtractor.js";
import type Parser from "tree-sitter";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { codeId } from "../../../../shared/path.js";
import { hashText } from "../../../../shared/hash.js";
import { parsedCodeFiles, javaPackageFromPath, pushDubboContract } from "./shared.js";
import { findContainingSymbol, indexedSourceAstNodes, namedChildren, parseSourceAst, symbolOffset } from "./sourceAstUtils.js";

type JavaImportMap = Map<string, string>;

const DUBBO_SERVICE_ANNOTATIONS = new Set([
  "DubboService",
  "org.apache.dubbo.config.annotation.DubboService",
  "org.apache.dubbo.config.annotation.Service",
  "com.alibaba.dubbo.config.annotation.Service"
]);

const DUBBO_REFERENCE_ANNOTATIONS = new Set([
  "DubboReference",
  "org.apache.dubbo.config.annotation.DubboReference",
  "org.apache.dubbo.config.annotation.Reference",
  "com.alibaba.dubbo.config.annotation.Reference"
]);

const AMBIGUOUS_DUBBO_SIMPLE_NAMES = new Set(["Service", "Reference"]);

export function makeJavaDubboSymbol(file: ParsedFile, node: Parser.SyntaxNode, kind: CodeSymbol["kind"], name: string, qualifiedName: string): CodeSymbol {
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

function declaredType(raw: string | undefined): string | undefined {
  const value = raw?.replace(/\s+/g, " ").trim();
  return value || undefined;
}

export function javaDubboParamTypes(methodNode: Parser.SyntaxNode): string[] {
  const params = methodNode.childForFieldName("parameters");
  if (!params) return [];
  return namedChildren(params)
    .filter((p) => p.type === "formal_parameter" || p.type === "spread_parameter")
    .map((p) => declaredType(p.childForFieldName("type")?.text) ?? "")
    .filter(Boolean);
}

export function javaDubboParamSlots(methodNode: Parser.SyntaxNode): { index: number; name?: string; type: string }[] {
  const params = methodNode.childForFieldName("parameters");
  if (!params) return [];
  return namedChildren(params)
    .filter((parameter) => parameter.type === "formal_parameter" || parameter.type === "spread_parameter")
    .map((parameter, index) => ({
      index,
      name: parameter.childForFieldName("name")?.text,
      type: declaredType(parameter.childForFieldName("type")?.text) ?? ""
    }))
    .filter((slot) => Boolean(slot.type));
}

export function javaDubboReturnType(methodNode: Parser.SyntaxNode): string | undefined {
  return declaredType(methodNode.childForFieldName("type")?.text);
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
    if (!names.has(simple) && !AMBIGUOUS_DUBBO_SIMPLE_NAMES.has(simple)) return false;
    const imported = imports.get(simple);
    return Boolean(imported && (names.has(imported) || imported.startsWith("org.apache.dubbo.") || imported.startsWith("com.alibaba.dubbo.")));
  });
}

export function javaDubboImports(source: string): JavaImportMap {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/^\s*import\s+([\w.]+)\s*;/gm)) {
    const fqn = match[1]!;
    imports.set(fqn.split(".").at(-1)!, fqn);
  }
  return imports;
}

export function javaDubboPackage(source: string, file: ParsedFile): string | undefined {
  return source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? javaPackageFromPath(file.path);
}

export function resolveJavaDubboType(raw: string | undefined, imports: JavaImportMap, packageName?: string): string | undefined {
  if (!raw) return undefined;
  const typeName = raw.replace(/<[\s\S]*>/g, "").trim();
  if (!typeName) return undefined;
  if (typeName.includes(".")) return typeName;
  return imports.get(typeName) ?? (packageName ? `${packageName}.${typeName}` : typeName);
}

export function javaDubboImplementedInterfaces(classNode: Parser.SyntaxNode): string[] {
  return javaDubboImplementedInterfaceApplications(classNode).map((value) => typeApplication(value).name);
}

export function javaDubboImplementedInterfaceApplications(classNode: Parser.SyntaxNode): string[] {
  const text = classNode.text.slice(0, Math.max(classNode.text.indexOf("{"), classNode.text.length));
  const match = text.match(/\bimplements\s+([^{]+)/);
  if (!match) return [];
  return splitTopLevelTypes(match[1]!);
}

function selectDubboInterface(interfaces: string[]): string | undefined {
  return interfaces.find((name) => /(?:^|[.$])\w*Service$/.test(typeApplication(name).name)) ?? interfaces[0];
}

export function directJavaDubboMethodDeclarations(classNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const body = classNode.childForFieldName("body");
  if (!body) return [];
  return namedChildren(body).filter((child) => child.type === "method_declaration");
}

export function javaDubboMethodSignature(methodNode: Parser.SyntaxNode): string | undefined {
  const method = methodNode.childForFieldName("name")?.text;
  if (!method) return undefined;
  const requestTypes = javaDubboParamTypes(methodNode).map((type) => type.replace(/\s+/gu, ""));
  const responseType = javaDubboReturnType(methodNode)?.replace(/\s+/gu, "") ?? "void";
  return `${method}(${requestTypes.join(",")}):${responseType}`;
}

export type DubboInterfaceMethod = {
  node: Parser.SyntaxNode;
  file: ParsedFile;
  interfaceName: string;
  method: string;
  requestSlots: { index: number; name?: string; type: string }[];
  responseType: string | undefined;
  methodSignature: string;
};

function interfaceParents(node: Parser.SyntaxNode): string[] {
  const header = node.text.slice(0, Math.max(node.text.indexOf("{"), 0));
  const parents = /\bextends\s+([^\{]+)/u.exec(header)?.[1];
  return parents ? parents.split(",").map((value) => value.trim()).filter(Boolean) : [];
}

function substituteType(type: string, bindings: Map<string, string>): string {
  let result = type;
  for (const [name, value] of [...bindings].sort(([left], [right]) => right.length - left.length)) {
    result = result.replace(new RegExp(`\\b${name}\\b`, "gu"), value);
  }
  return result;
}

function splitTopLevelTypes(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "<") depth++;
    else if (value[index] === ">") depth--;
    else if (value[index] === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function typeApplication(raw: string): { name: string; args: string[] } {
  const match = /^([^<]+)(?:<([\s\S]+)>)?$/u.exec(raw.trim());
  return { name: match?.[1]?.trim() ?? raw.trim(), args: match?.[2] ? splitTopLevelTypes(match[2]) : [] };
}

export type JavaDubboInterfaceIndex = {
  byName: Map<string, DubboInterfaceMethod[]>;
  resolve(rawType: string, imports?: JavaImportMap, packageName?: string): DubboInterfaceMethod[];
};

export function createJavaDubboInterfaceIndex(files: readonly ParsedFile[]): JavaDubboInterfaceIndex {
  const declarations = new Map<string, { node: Parser.SyntaxNode; file: ParsedFile; imports: JavaImportMap; packageName?: string; typeParameters: string[] }>();
  for (const file of files) {
    if (file.language !== "java") continue;
    const ast = parseSourceAst(file, "java");
    if (!ast) continue;
    const imports = javaDubboImports(ast.source);
    const packageName = javaDubboPackage(ast.source, file);
    for (const node of indexedSourceAstNodes(ast, ["interface_declaration"])) {
      const name = node.childForFieldName("name")?.text;
      if (!name) continue;
      const fqn = resolveJavaDubboType(name, imports, packageName)!;
      const parameters = /<([^>{]+)>/u.exec(node.text.slice(0, Math.max(node.text.indexOf("{"), 0)))?.[1]
        ?.split(",").map((value) => value.trim().split(/\s+/u)[0]!).filter(Boolean) ?? [];
      declarations.set(fqn, { node, file, imports, packageName, typeParameters: parameters });
    }
  }
  const result = new Map<string, DubboInterfaceMethod[]>();
  const collect = (fqn: string, bindings = new Map<string, string>(), seen = new Set<string>()): DubboInterfaceMethod[] => {
    const visitKey = `${fqn}:${JSON.stringify([...bindings])}`;
    if (seen.has(visitKey)) return [];
    seen.add(visitKey);
    const declaration = declarations.get(fqn);
    if (!declaration) return [];
    const methods = directJavaDubboMethodDeclarations(declaration.node).flatMap((node) => {
      const method = node.childForFieldName("name")?.text;
      if (!method) return [];
      const requestSlots = javaDubboParamSlots(node).map((slot) => ({ ...slot, type: substituteType(slot.type, bindings) }));
      const responseType = javaDubboReturnType(node);
      const resolvedResponse = responseType ? substituteType(responseType, bindings) : undefined;
      return [{ node, file: declaration.file, interfaceName: fqn, method, requestSlots, responseType: resolvedResponse,
        methodSignature: `${method}(${requestSlots.map((slot) => slot.type.replace(/\s+/gu, "")).join(",")}):${resolvedResponse?.replace(/\s+/gu, "") ?? "void"}` }];
    });
    for (const rawParent of interfaceParents(declaration.node)) {
      const application = typeApplication(rawParent);
      const parentFqn = resolveJavaDubboType(application.name, declaration.imports, declaration.packageName);
      const parent = parentFqn ? declarations.get(parentFqn) : undefined;
      if (!parentFqn || !parent) continue;
      const parentBindings = new Map<string, string>();
      parent.typeParameters.forEach((parameter, index) => parentBindings.set(parameter, substituteType(application.args[index] ?? parameter, bindings)));
      methods.push(...collect(parentFqn, parentBindings, seen));
    }
    return methods;
  };
  for (const fqn of declarations.keys()) result.set(fqn, collect(fqn));
  return {
    byName: result,
    resolve(rawType, imports = new Map(), packageName) {
      const application = typeApplication(rawType);
      const fqn = resolveJavaDubboType(application.name, imports, packageName);
      const declaration = fqn ? declarations.get(fqn) : undefined;
      if (!fqn || !declaration) return [];
      const bindings = new Map<string, string>();
      declaration.typeParameters.forEach((parameter, index) => bindings.set(parameter, application.args[index] ?? parameter));
      return collect(fqn, bindings, new Set());
    }
  };
}

function javaMethodCall(node: Parser.SyntaxNode): { object?: string; method?: string; args: Parser.SyntaxNode[] } | undefined {
  if (node.type !== "method_invocation") return undefined;
  const object = node.childForFieldName("object");
  const name = node.childForFieldName("name");
  const argsNode = node.childForFieldName("arguments");
  return { object: object?.text, method: name?.text, args: argsNode ? namedChildren(argsNode) : [] };
}

function typeFromStaticExpression(node: Parser.SyntaxNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "object_creation_expression") {
    return node.childForFieldName("type")?.text ?? node.namedChild(0)?.text;
  }
  if (node.type === "identifier") {
    let owner: Parser.SyntaxNode | null = node.parent;
    while (owner && owner.type !== "method_declaration") owner = owner.parent;
    const parameter = owner ? javaDubboParamSlots(owner).find((slot) => slot.name === node.text) : undefined;
    if (parameter) return parameter.type;
  }
  const text = node.text;
  return text.match(/\b([A-Za-z_$][\w$]*)\.newBuilder\s*\(/)?.[1]
    ?? text.match(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1];
}

function canonicalStaticType(raw: string, file: ParsedFile): string {
  const compact = raw.replace(/\s+/gu, "").replace(/\.\.\.$/u, "[]");
  const arraySuffix = compact.endsWith("[]") ? "[]" : "";
  const erased = compact.replace(/\[\]$/u, "").replace(/<.*>/su, "");
  if (/^(?:byte|short|int|long|float|double|boolean|char|void)$/u.test(erased)) return `${erased}${arraySuffix}`;
  const source = file.source ?? "";
  const canonical = resolveJavaDubboType(erased, javaDubboImports(source), javaDubboPackage(source, file)) ?? erased;
  return `${canonical}${arraySuffix}`;
}

function referenceReceiverName(objectText: string): string {
  return objectText.replace(/^this\./, "");
}

export const javaDubboExtractor = defineBuiltinExtractor({
  name: "builtin:java-dubbo",
  languages: ["java"],
  extract(context, collector: FactCollector) {
    const files = [...parsedCodeFiles(context.parsedFiles)];
    const interfaceIndex = createJavaDubboInterfaceIndex(files);
    const interfaceMethods = interfaceIndex.byName;
    for (const file of files) {
      if (file.language !== "java") continue;
      const ast = parseSourceAst(file, "java");
      if (!ast) continue;

      const imports = javaDubboImports(ast.source);
      const packageName = javaDubboPackage(ast.source, file);

      for (const node of indexedSourceAstNodes(ast, ["class_declaration", "interface_declaration"])) {
        if (!hasAnyAnnotation(node, DUBBO_SERVICE_ANNOTATIONS, imports)) continue;
        const declaredName = node.childForFieldName("name")?.text;
        const implemented = node.type === "interface_declaration" ? declaredName : selectDubboInterface(javaDubboImplementedInterfaceApplications(node));
        const interfaceName = resolveJavaDubboType(implemented ? typeApplication(implemented).name : undefined, imports, packageName);
        if (!interfaceName) continue;
        const group = annotationValue(node, "DubboService", "group") ?? annotationValue(node, "Service", "group");
        const version = annotationValue(node, "DubboService", "version") ?? annotationValue(node, "Service", "version");

        const indexedMethods = node.type === "interface_declaration"
          ? interfaceIndex.resolve(interfaceName, imports, packageName)
          : implemented ? interfaceIndex.resolve(implemented, imports, packageName) : [];
        const producerMethods = indexedMethods.length > 0 ? indexedMethods : directJavaDubboMethodDeclarations(node).map((child) => ({
          node: child, file, interfaceName, method: child.childForFieldName("name")?.text ?? "",
          requestSlots: javaDubboParamSlots(child), responseType: javaDubboReturnType(child),
          methodSignature: javaDubboMethodSignature(child) ?? ""
        }));
        for (const indexedMethod of producerMethods) {
          const child = indexedMethod.node;
          const method = indexedMethod.method;
          if (!method) continue;
          const symbol = makeJavaDubboSymbol(indexedMethod.file, child, "method", method, `${interfaceName}.${indexedMethod.methodSignature}`);
          pushDubboContract({
            collector,
            file: indexedMethod.file,
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
            requestTypes: indexedMethod.requestSlots.map((slot) => slot.type),
            requestSlots: indexedMethod.requestSlots,
            responseType: indexedMethod.responseType,
            methodSignature: indexedMethod.methodSignature,
            ownerType: interfaceName,
            config: "annotation",
            framework: "dubbo-java"
          });
        }
      }

      const referenceFields = new Map<string, { interfaceName: string; group?: string; version?: string }>();
      for (const node of indexedSourceAstNodes(ast, ["field_declaration"])) {
        if (!hasAnyAnnotation(node, DUBBO_REFERENCE_ANNOTATIONS, imports)) continue;
        const typeNode = node.namedChildren.find((child) => /type/.test(child.type));
        const declarator = node.namedChildren.find((child) => child.type === "variable_declarator");
        const fieldName = declarator?.childForFieldName("name")?.text;
        const interfaceName = resolveJavaDubboType(typeNode?.text, imports, packageName);
        if (!fieldName || !interfaceName) continue;
        const group = annotationValue(node, "DubboReference", "group") ?? annotationValue(node, "Reference", "group");
        const version = annotationValue(node, "DubboReference", "version") ?? annotationValue(node, "Reference", "version");
        referenceFields.set(fieldName, { interfaceName, group, version });
      }

      const seen = new Set<string>();
      for (const node of indexedSourceAstNodes(ast, ["method_invocation"])) {
        const call = javaMethodCall(node);
        if (!call?.object || !call.method) continue;
        const reference = referenceFields.get(referenceReceiverName(call.object));
        if (!reference) continue;
        const caller = findContainingSymbol(file.symbols, node);
        if (!caller) continue;
        const candidates = (interfaceMethods.get(reference.interfaceName) ?? [])
          .filter((candidate) => candidate.method === call.method && candidate.requestSlots.length === call.args.length);
        const argumentTypes = call.args.map(typeFromStaticExpression);
        const proven = candidates.filter((candidate) => candidate.requestSlots.every((slot, index) => {
          const argumentType = argumentTypes[index];
          return Boolean(argumentType
            && canonicalStaticType(slot.type, candidate.file) === canonicalStaticType(argumentType, file));
        }));
        const signature = proven.length === 1 ? proven[0] : candidates.length === 1 && call.args.length === 0 ? candidates[0] : undefined;
        const fullName = `${reference.interfaceName}#${call.method}`;
        const invocationKey = `${caller.id}:${fullName}:${signature?.methodSignature ?? "unproven"}`;
        if (seen.has(invocationKey)) continue;
        seen.add(invocationKey);
        pushDubboContract({
          collector,
          file,
          symbol: caller,
          interfaceName: reference.interfaceName,
          method: call.method,
          role: "consumer",
          offset: symbolOffset(file, caller, node),
          raw: node.text,
          rule: "java-dubbo-reference",
          confidence: confidenceFor("exact-parser-route"),
          group: reference.group,
          version: reference.version,
          requestTypes: signature?.requestSlots.map((slot) => slot.type)
            ?? argumentTypes.filter((value): value is string => Boolean(value)),
          requestSlots: signature?.requestSlots,
          responseType: signature?.responseType,
          methodSignature: signature?.methodSignature,
          ownerType: reference.interfaceName,
          config: "annotation",
          framework: "dubbo-java"
        });
      }
    }
  }
});
