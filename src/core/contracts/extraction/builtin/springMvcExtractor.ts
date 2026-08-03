import { defineBuiltinExtractor } from "./defineBuiltinExtractor.js";
import { joinApiPaths } from "../../apiPath.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import type { AnnotationFact } from "../../../parsing/facts.js";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import {
  parsedCodeFiles,
  pushApiContractFromPath, } from "./shared.js";
import { findContainingSymbol, indexedSourceAstNodes, parseSourceAst } from "./sourceAstUtils.js";
import type Parser from "tree-sitter";

const ANNOTATION_METHOD_MAP: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH"
};

function springHttpMethod(annotation: AnnotationFact): string | undefined {
  const mapped = ANNOTATION_METHOD_MAP[annotation.name];
  if (mapped) return mapped;
  if (annotation.name === "RequestMapping") {
    const methodArg = annotation.arguments.find((a) => a.name === "method");
    if (!methodArg) return undefined;
    const match = methodArg.value.match(/RequestMethod\.(\w+)/);
    return match ? match[1]!.toUpperCase() : undefined;
  }
  return undefined;
}

function springPathsFromAnnotation(annotation: AnnotationFact): string[] {
  if (annotation.arguments.length === 0) return [""];
  const pathArgs = annotation.arguments.filter((argument) => !argument.name || argument.name === "value" || argument.name === "path");
  return pathArgs.length > 0 ? pathArgs.map((argument) => argument.value) : [""];
}

type SpringMapping = { annotation: string; path: string; raw: string; line: number };

function springMappingsFromFacts(file: ParsedFile): Map<string, SpringMapping[]> {
  const result = new Map<string, SpringMapping[]>();
  for (const annotation of file.facts?.annotations ?? []) {
    if (!annotation.ownerSymbolId) continue;
    if (!["RequestMapping", "GetMapping", "PostMapping", "PutMapping", "DeleteMapping", "PatchMapping"].includes(annotation.name)) continue;
    const rows = result.get(annotation.ownerSymbolId) ?? [];
    for (const path of springPathsFromAnnotation(annotation)) {
      rows.push({ annotation: annotation.name, path, raw: annotation.raw, line: annotation.line });
    }
    result.set(annotation.ownerSymbolId, rows);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase 3-E: Body type extraction from Java AST
// ---------------------------------------------------------------------------

type BodyTypeInfo = {
  requestBodies: { index: number; name?: string; type: string }[];
  requestBodyType?: string;
  responseBodyType?: string;
  declaredResponseType?: string;
  methodSignature: string;
};

/**
 * Extracts @RequestBody parameter types and ResponseEntity<T> return types
 * from Java method declarations. Returns a map keyed by method symbol ID.
 */
function extractBodyTypes(file: ParsedFile): Map<string, BodyTypeInfo> {
  const map = new Map<string, BodyTypeInfo>();
  const ast = parseSourceAst(file, "java");
  if (!ast) return map;

  for (const node of indexedSourceAstNodes(ast, ["method_declaration"])) {
    const methodSymbol = findContainingSymbol(file.symbols, node);
    if (!methodSymbol) continue;

    const info: BodyTypeInfo = { requestBodies: [], methodSignature: canonicalJavaMethodSignature(node) };

    // Request body: find formal parameter annotated with @RequestBody
    const params = node.childForFieldName("parameters");
    if (params) {
      let parameterIndex = 0;
      for (let i = 0; i < params.namedChildCount; i++) {
        const param = params.namedChild(i);
        if (!param) continue;
        if (param.type !== "formal_parameter" && param.type !== "spread_parameter") continue;
        const hasRequestBody = hasAnnotation(param, "RequestBody");
        if (!hasRequestBody) {
          parameterIndex++;
          continue;
        }
        const typeName = extractParameterTypeName(param);
        if (typeName) {
          const name = param.childForFieldName("name")?.text;
          info.requestBodies.push({ index: parameterIndex, name, type: typeName });
          info.requestBodyType ??= typeName;
        }
        parameterIndex++;
      }
    }

    // Response body: extract type argument from ResponseEntity<T> return type
    const returnType = node.childForFieldName("type");
    if (returnType) {
      const declaredResponseType = returnType.text.replace(/\s+/g, " ").trim();
      if (declaredResponseType && declaredResponseType !== "void") info.responseBodyType = declaredResponseType;
      if (declaredResponseType && declaredResponseType !== "void") info.declaredResponseType = declaredResponseType;
    }

    if (info.requestBodyType || info.responseBodyType || info.declaredResponseType) {
      map.set(methodSymbol.id, info);
    }
  }

  return map;
}

function hasAnnotation(node: Parser.SyntaxNode, annotationName: string): boolean {
  const modifiers = node.childForFieldName("modifiers");
  if (modifiers) {
    for (let i = 0; i < modifiers.namedChildCount; i++) {
      const mod = modifiers.namedChild(i);
      if (!mod) continue;
      if (mod.type === "annotation" || mod.type === "marker_annotation") {
        const name = mod.childForFieldName("name");
        if (name && (name.text === annotationName || name.text === `@${annotationName}`)) {
          return true;
        }
      }
    }
  }
  // Java grammar versions differ on whether formal-parameter annotations are
  // exposed through a named `modifiers` field. The AST node is already scoped
  // to one parameter, so this fallback remains precise.
  return new RegExp(`@(?:[A-Za-z_$][\\w$]*\\.)*${annotationName}\\b`).test(node.text);
}

function extractParameterTypeName(param: Parser.SyntaxNode): string | undefined {
  // For a formal_parameter like "@RequestBody CreateOrderDTO dto"
  // the type node is a child. Look for type_identifier or generic_type.
  for (let i = 0; i < param.namedChildCount; i++) {
    const child = param.namedChild(i);
    if (!child) continue;
    if (child.type === "type_identifier") return child.text;
    if (child.type === "generic_type") return child.text.replace(/\s+/gu, " ").trim();
    if (child.type === "array_type") return child.text;
    if (child.type === "integral_type" || child.type === "floating_point_type" ||
        child.type === "boolean_type" || child.type === "void_type") {
      return child.text;
    }
  }
  return undefined;
}

type JavaTypeDescriptor = {
  file: ParsedFile;
  symbol: CodeSymbol;
  canonicalName: string;
  annotations: AnnotationFact[];
  mappingsByOwner: Map<string, SpringMapping[]>;
  bodyTypesBySymbol: Map<string, BodyTypeInfo>;
  typeParameters: string[];
  parents: { name: string; arguments: string[] }[];
};

type ControllerHierarchyEntry = {
  descriptor: JavaTypeDescriptor;
  genericBindings: Map<string, string>;
};

function javaTypeDescriptors(files: ParsedFile[]): JavaTypeDescriptor[] {
  return files.flatMap((file) => {
    if (file.language !== "java") return [];
    const mappingsByOwner = springMappingsFromFacts(file);
    const bodyTypesBySymbol = extractBodyTypes(file);
    return file.symbols.filter((symbol) => symbol.kind === "class" || symbol.kind === "interface").map((symbol) => {
      const header = parseJavaTypeHeader(symbol.source, symbol.name, symbol.kind as "class" | "interface");
      return {
        file,
        symbol,
        canonicalName: javaOwnerType(file, symbol.name),
        annotations: (file.facts?.annotations ?? []).filter((annotation) => annotation.ownerSymbolId === symbol.id),
        mappingsByOwner,
        bodyTypesBySymbol,
        typeParameters: header.typeParameters,
        parents: header.parents
      };
    });
  }).sort((left, right) => left.canonicalName.localeCompare(right.canonicalName)
    || left.file.fileId.localeCompare(right.file.fileId)
    || left.symbol.id.localeCompare(right.symbol.id));
}

function controllerHierarchy(controller: JavaTypeDescriptor, descriptors: JavaTypeDescriptor[]): ControllerHierarchyEntry[] {
  const result: ControllerHierarchyEntry[] = [{ descriptor: controller, genericBindings: new Map() }];
  const visited = new Set([controller.canonicalName]);
  for (let index = 0; index < result.length; index++) {
    const current = result[index]!;
    const parents = current.descriptor.parents.flatMap((reference) => {
      const descriptor = resolveParentDescriptor(current.descriptor, reference.name, descriptors);
      return descriptor ? [{ descriptor, reference }] : [];
    }).sort((left, right) => left.descriptor.canonicalName.localeCompare(right.descriptor.canonicalName));
    for (const { descriptor, reference } of parents) {
      if (visited.has(descriptor.canonicalName)) continue;
      visited.add(descriptor.canonicalName);
      const bindings = new Map<string, string>();
      for (const [parameterIndex, parameter] of descriptor.typeParameters.entries()) {
        const argument = reference.arguments[parameterIndex];
        if (argument) bindings.set(parameter, substituteJavaType(argument, current.genericBindings));
      }
      result.push({ descriptor, genericBindings: bindings });
    }
  }
  return result;
}

function resolveParentDescriptor(owner: JavaTypeDescriptor, rawName: string, descriptors: JavaTypeDescriptor[]): JavaTypeDescriptor | undefined {
  const normalized = rawName.replace(/\s+/gu, "");
  const packageName = javaPackage(owner.file);
  const imported = owner.file.imports.find((value) => value.importKind !== "static"
    && value.module.split(".").at(-1) === normalized)?.module;
  const canonicalCandidates = new Set([
    normalized,
    ...(packageName ? [`${packageName}.${normalized}`] : []),
    ...(imported ? [imported] : [])
  ]);
  const exact = descriptors.filter((value) => value.file.repoId === owner.file.repoId && canonicalCandidates.has(value.canonicalName));
  if (exact.length === 1) return exact[0];
  const scoped = descriptors.filter((value) => value.file.repoId === owner.file.repoId
    && value.canonicalName.split(".").at(-1) === normalized
    && javaPackage(value.file) === packageName);
  return scoped.length === 1 ? scoped[0] : undefined;
}

function parseJavaTypeHeader(
  source: string,
  typeName: string,
  kind: "class" | "interface"
): { typeParameters: string[]; parents: { name: string; arguments: string[] }[] } {
  const declaration = new RegExp(`\\b${kind}\\s+${escapeRegExp(typeName)}\\b`, "u").exec(source);
  if (!declaration) return { typeParameters: [], parents: [] };
  let cursor = declaration.index + declaration[0].length;
  cursor = skipWhitespace(source, cursor);
  let typeParameters: string[] = [];
  if (source[cursor] === "<") {
    const group = balancedGroup(source, cursor);
    if (group) {
      typeParameters = splitJavaTypes(group.value).flatMap((value) => /^([A-Za-z_$][\w$]*)/u.exec(value.trim())?.[1] ?? []);
      cursor = group.end;
    }
  }
  const headerEnd = source.indexOf("{", cursor);
  const header = source.slice(cursor, headerEnd >= 0 ? headerEnd : source.length);
  const clauses = [...header.matchAll(/\b(?:extends|implements)\s+/gu)];
  const parents = clauses.flatMap((clause, index) => {
    const start = (clause.index ?? 0) + clause[0].length;
    const end = clauses[index + 1]?.index ?? header.length;
    return splitJavaTypes(header.slice(start, end)).flatMap(parseJavaParentReference);
  });
  return { typeParameters, parents };
}

function parseJavaParentReference(value: string): { name: string; arguments: string[] }[] {
  const match = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/u.exec(value.trim());
  if (!match) return [];
  const genericStart = value.indexOf("<", match[0].length);
  const group = genericStart >= 0 ? balancedGroup(value, genericStart) : undefined;
  return [{ name: match[1]!, arguments: group ? splitJavaTypes(group.value) : [] }];
}

function balancedGroup(source: string, start: number): { value: string; end: number } | undefined {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === "<") depth++;
    else if (source[index] === ">") {
      depth--;
      if (depth === 0) return { value: source.slice(start + 1, index), end: index + 1 };
    }
  }
  return undefined;
}

function splitJavaTypes(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "<") depth++;
    else if (value[index] === ">") depth--;
    else if (value[index] === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function substituteJavaType(value: string, bindings: Map<string, string>): string {
  let result = value;
  for (const [name, replacement] of [...bindings.entries()].sort(([left], [right]) => right.length - left.length || left.localeCompare(right))) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gu"), replacement);
  }
  return result;
}

function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (/\s/u.test(source[cursor] ?? "")) cursor++;
  return cursor;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const springMvcExtractor = defineBuiltinExtractor({
  name: "builtin:spring-mvc",
  languages: ["java"],
  frameworks: ["java:spring-mvc"],
  extract(context, collector: FactCollector) {
    const descriptors = javaTypeDescriptors([...parsedCodeFiles(context.parsedFiles)]);
    for (const controller of descriptors) {
      const isRestController = controller.annotations.some((annotation) => annotation.name === "RestController");
      const isController = isRestController || controller.annotations.some((annotation) => annotation.name === "Controller");
      if (!isController) continue;
      const hierarchy = controllerHierarchy(controller, descriptors);
      const routeOwner = hierarchy.find(({ descriptor }) => (descriptor.mappingsByOwner.get(descriptor.symbol.id) ?? [])
        .some((mapping) => mapping.annotation === "RequestMapping"))?.descriptor ?? controller;
      const baseMappings = (routeOwner.mappingsByOwner.get(routeOwner.symbol.id) ?? [])
        .filter((mapping) => mapping.annotation === "RequestMapping")
        .map((mapping) => ({ ...mapping, offset: Math.max(0, routeOwner.symbol.source.indexOf(mapping.raw)) }));
        for (const baseMapping of baseMappings) {
          if (!baseMapping.path) continue;
          pushApiContractFromPath({
            collector,
            file: routeOwner.file,
            symbol: routeOwner.symbol,
            apiPath: baseMapping.path,
            role: "producer",
            offset: baseMapping.offset,
            raw: baseMapping.raw,
            rule: "spring-request-mapping-producer",
            confidence: confidenceFor("exact-parser-route"),
            framework: "spring-mvc"
          });
        }

        const basePaths = baseMappings.length > 0 ? baseMappings.map((mapping) => mapping.path) : [""];
        const overriddenSignatures = new Set<string>();
        for (const entry of hierarchy) {
          const { descriptor } = entry;
          const methodSymbols = descriptor.file.symbols.filter((symbol) => symbol.kind === "method"
            && symbol.startLine >= descriptor.symbol.startLine && symbol.endLine <= descriptor.symbol.endLine);
          for (const methodSymbol of methodSymbols) {
          const bodyTypes = descriptor.bodyTypesBySymbol.get(methodSymbol.id);
          const signature = bodyTypes?.methodSignature ?? methodSymbol.signature;
          if (overriddenSignatures.has(signature)) continue;
          overriddenSignatures.add(signature);
          const methodAnnotations = (descriptor.file.facts?.annotations ?? []).filter((annotation) => annotation.ownerSymbolId === methodSymbol.id);
          const declaredResponseType = bodyTypes?.declaredResponseType;
          const responseBody = isRestController
            || controller.annotations.some((annotation) => annotation.name === "ResponseBody")
            || descriptor.annotations.some((annotation) => annotation.name === "ResponseBody")
            || methodAnnotations.some((annotation) => annotation.name === "ResponseBody")
            || Boolean(declaredResponseType && /^(?:[A-Za-z_$][\w$]*\.)*ResponseEntity\s*</u.test(declaredResponseType));
          const rawMappings = descriptor.mappingsByOwner.get(methodSymbol.id) ?? [];
          const mappings = rawMappings
            .map((mapping) => ({ ...mapping, offset: Math.max(0, methodSymbol.source.indexOf(mapping.raw)) }));
          for (const mapping of mappings) {
            const annotationFact = (descriptor.file.facts?.annotations ?? []).find(
              (a) => a.ownerSymbolId === methodSymbol.id && a.raw === mapping.raw
            );
            const httpMethod = annotationFact ? springHttpMethod(annotationFact) : undefined;
            for (const basePath of basePaths) {
              pushApiContractFromPath({
                collector,
                file: descriptor.file,
                symbol: methodSymbol,
                apiPath: joinApiPaths(basePath, mapping.path),
                role: "producer",
                offset: mapping.offset,
                raw: mapping.raw,
                rule: "spring-mapping-producer",
                confidence: confidenceFor("exact-parser-route"),
                method: httpMethod,
                framework: "spring-mvc",
                requestBodyType: bodyTypes?.requestBodyType,
                requestBodySlots: bodyTypes?.requestBodies,
                responseBodyType: responseBody ? bodyTypes?.responseBodyType : undefined,
                declaredResponseType: bodyTypes?.declaredResponseType,
                responseBody,
                ownerType: controller.canonicalName,
                methodSignature: signature,
                ownerGenericBindings: [...entry.genericBindings.entries()]
                  .map(([name, type]) => ({ name, type }))
                  .sort((left, right) => left.name.localeCompare(right.name))
              });
            }
          }
        }
      }
      }
  }
});

function canonicalJavaMethodSignature(node: Parser.SyntaxNode): string {
  const name = node.childForFieldName("name")?.text ?? "<unknown>";
  const returnType = node.childForFieldName("type")?.text.replace(/\s+/gu, " ").trim() ?? "void";
  const parameters = node.childForFieldName("parameters");
  const parameterTypes = (parameters?.namedChildren ?? []).flatMap((parameter) => {
    if (parameter.type !== "formal_parameter" && parameter.type !== "spread_parameter") return [];
    const type = parameter.childForFieldName("type")
      ?? parameter.namedChildren.find((child) => /(?:_type|type_identifier|generic_type|scoped_type_identifier)$/u.test(child.type));
    return type ? [type.text.replace(/\s+/gu, " ").trim()] : [];
  });
  const typeParameters = node.childForFieldName("type_parameters")?.text.replace(/\s+/gu, " ").trim() ?? "";
  return `${typeParameters}${name}(${parameterTypes.join(",")}):${returnType}`;
}

function javaOwnerType(file: ParsedFile, className: string): string {
  const packageName = javaPackage(file);
  return packageName ? `${packageName}.${className}` : className;
}

function javaPackage(file: ParsedFile): string | undefined {
  return file.source?.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/mu)?.[1];
}
