import type Parser from "tree-sitter";
import { confidenceFor } from "../../../../shared/confidence.js";
import { stableFactId, type SchemaDeclarationCandidate, type SchemaFieldSpec, type TypeExpression } from "../../../schema/model.js";
import type { ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { compatExtractor } from "./compat.js";
import { parsedCodeFiles } from "./shared.js";
import { indexedSourceAstNodes, parseSourceAst } from "./sourceAstUtils.js";

const DECLARATION_TYPES = new Set([
  "class_declaration",
  "record_declaration",
  "enum_declaration",
  "interface_declaration"
]);

/**
 * Java's extractor is deliberately a declaration prepass only. Public
 * SchemaSpecs are created later by contract-root reachability; declaration
 * names never decide whether a type is a schema.
 */
export const javaSchemaExtractor = compatExtractor({
  name: "builtin:java-type-declarations",
  languages: ["java"],
  extract(context, collector: FactCollector) {
    const candidates = [...parsedCodeFiles(context.parsedFiles)]
      .filter((file) => file.language === "java")
      .flatMap(javaSchemaCandidatesForFile)
      .sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
    for (const candidate of candidates) collector.addSchemaDeclaration(candidate);
  }
});

export function javaSchemaCandidatesForFile(file: ParsedFile): SchemaDeclarationCandidate[] {
  const ast = parseSourceAst(file, "java");
  if (!ast) return [];
  const packageName = javaPackageName(file.source ?? "");
  const resolutionScopeId = javaResolutionScopeId(file.path);
  const result: SchemaDeclarationCandidate[] = [];
  for (const node of indexedSourceAstNodes(ast, [...DECLARATION_TYPES])) {
    if (!DECLARATION_TYPES.has(node.type)) continue;
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    const enclosingNames = enclosingDeclarationNames(node);
    const canonicalName = [...(packageName ? [packageName] : []), ...enclosingNames, name].join(".");
    const enclosingCanonicalName = enclosingNames.length > 0
      ? [...(packageName ? [packageName] : []), ...enclosingNames].join(".")
      : undefined;
    const declarationKind = declarationKindFor(node.type);
    const modifiers = modifierWords(node);
    const typeParameters = extractTypeParameters(node);
    const shape = declarationKind === "enum"
      ? { kind: "enum" as const, values: extractEnumValues(node) }
      : {
        kind: "object" as const,
        fields: declarationKind === "record" ? extractRecordComponents(node, file) : extractFields(node, file),
        baseTypes: extractBaseTypes(node)
      };
    const line = node.startPosition.row + 1;
    result.push({
      declaration: { languageId: "java", repoId: file.repoId, resolutionScopeId, canonicalName },
      displayName: name,
      typeParameters: typeParameters.map((parameter) => parameter.name),
      typeParameterBounds: Object.fromEntries(typeParameters.filter((parameter) => parameter.bounds.length > 0)
        .map((parameter) => [parameter.name, parameter.bounds])),
      declarationKind,
      modifiers,
      enclosingDeclarationId: enclosingCanonicalName
        ? stableFactId("declaration", { languageId: "java", repoId: file.repoId, resolutionScopeId, canonicalName: enclosingCanonicalName })
        : undefined,
      shape,
      fileId: file.fileId,
      filePath: file.path,
      sourceSymbolId: sourceSymbolId(file, name, line),
      framework: "java-source",
      evidence: {
        line,
        raw: declarationHeader(node),
        rule: "java-declaration-index",
        confidence: confidenceFor("heuristic-schema-fields")
      }
    });
  }
  return result.sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
}

export function javaResolutionScopeId(filePath: string): string {
  const normalized = filePath.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const sourceMatch = /^(.*?)(?:\/)?src\/([^/]+)\/(?:java|kotlin)\//u.exec(normalized);
  if (sourceMatch) {
    const moduleId = sourceMatch[1] || ".";
    return `module:${moduleId}:source-set:${sourceMatch[2]}`;
  }
  const generatedMatch = /^(.*?)(?:\/)?(?:generated|build\/generated)\/([^/]+)\//u.exec(normalized);
  if (generatedMatch) return `module:${generatedMatch[1] || "."}:source-set:generated-${generatedMatch[2]}`;
  return `module:.:source-set:source`;
}

export function javaPackageName(source: string): string {
  return source.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/mu)?.[1] ?? "";
}

function extractFields(declaration: Parser.SyntaxNode, file: ParsedFile): SchemaFieldSpec[] {
  const body = declaration.childForFieldName("body") ?? declaration.namedChildren.find((child) => child.type.endsWith("_body"));
  if (!body) return [];
  const fields: SchemaFieldSpec[] = [];
  for (const node of body.namedChildren) {
    if (node.type !== "field_declaration") continue;
    const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
    if (/\b(?:static|transient)\b/u.test(modifiers?.text ?? "")) continue;
    if (hasAnnotation(modifiers, "JsonIgnore")) continue;
    const typeNode = node.childForFieldName("type") ?? node.namedChildren.find(isTypeNode);
    if (!typeNode) continue;
    const expression = parseJavaTypeExpression(typeNode.text);
    const nullable = fieldNullable(typeNode.text, modifiers?.text ?? "");
    for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
      const sourceName = declarator.childForFieldName("name")?.text;
      if (!sourceName) continue;
      fields.push(unresolvedField({
        file,
        sourceName,
        serializedName: jsonPropertyName(modifiers) ?? sourceName,
        expression,
        nullable,
        line: node.startPosition.row + 1
      }));
    }
  }
  return fields.sort(fieldOrder);
}

function extractRecordComponents(declaration: Parser.SyntaxNode, file: ParsedFile): SchemaFieldSpec[] {
  const parameters = declaration.childForFieldName("parameters")
    ?? declaration.namedChildren.find((child) => child.type === "formal_parameters");
  if (!parameters) return [];
  const fields: SchemaFieldSpec[] = [];
  for (const component of parameters.namedChildren) {
    if (component.type !== "formal_parameter" && component.type !== "record_component") continue;
    const modifiers = component.namedChildren.find((child) => child.type === "modifiers");
    if (hasAnnotation(modifiers, "JsonIgnore")) continue;
    const typeNode = component.childForFieldName("type") ?? component.namedChildren.find(isTypeNode);
    const sourceName = component.childForFieldName("name")?.text;
    if (!typeNode || !sourceName) continue;
    fields.push(unresolvedField({
      file,
      sourceName,
      serializedName: jsonPropertyName(modifiers) ?? sourceName,
      expression: parseJavaTypeExpression(typeNode.text),
      nullable: fieldNullable(typeNode.text, modifiers?.text ?? ""),
      line: component.startPosition.row + 1
    }));
  }
  return fields.sort(fieldOrder);
}

function unresolvedField(input: {
  file: ParsedFile;
  sourceName: string;
  serializedName: string;
  expression: TypeExpression;
  nullable: boolean;
  line: number;
}): SchemaFieldSpec {
  return {
    sourceName: input.sourceName,
    serializedName: input.serializedName,
    type: {
      kind: "unresolved",
      normalizedExpression: input.expression,
      diagnosticId: stableFactId("schema-diagnostic", {
        code: "unresolved",
        repoId: input.file.repoId,
        fileId: input.file.fileId,
        field: input.sourceName,
        expression: input.expression
      })
    },
    optional: false,
    nullable: input.nullable,
    sourceLocation: { fileId: input.file.fileId, line: input.line }
  };
}

export function parseJavaTypeExpression(raw: string): TypeExpression {
  let value = raw.trim().replace(/\.\.\.$/u, "[]");
  const annotations = /^(?:@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*)+/u.exec(value)?.[0];
  if (annotations) value = value.slice(annotations.length).trim();
  if (value.endsWith("[]")) return { kind: "array", element: parseJavaTypeExpression(value.slice(0, -2)) };
  if (value === "?") return { kind: "wildcard" };
  const wildcard = /^\?\s+(extends|super)\s+(.+)$/u.exec(value);
  if (wildcard) return { kind: "wildcard", bound: wildcard[1] as "extends" | "super", type: parseJavaTypeExpression(wildcard[2]!) };
  const intersections = splitTopLevel(value, "&");
  if (intersections.length > 1) return { kind: "intersection", members: intersections.map(parseJavaTypeExpression) };
  const genericStart = firstTopLevelGeneric(value);
  if (genericStart > 0 && value.endsWith(">")) {
    return {
      kind: "application",
      target: { kind: "reference", name: value.slice(0, genericStart).trim() },
      arguments: splitTopLevel(value.slice(genericStart + 1, -1), ",").map(parseJavaTypeExpression)
    };
  }
  return { kind: "reference", name: value };
}

function extractBaseTypes(node: Parser.SyntaxNode): TypeExpression[] {
  return node.namedChildren
    .filter((child) => child.type === "superclass" || child.type === "super_interfaces" || child.type === "extends_interfaces")
    .flatMap((child) => child.namedChildren.flatMap((typeNode) => typeNode.type === "type_list"
      ? typeNode.namedChildren.map((item) => parseJavaTypeExpression(item.text))
      : [parseJavaTypeExpression(typeNode.text)]));
}

function extractTypeParameters(node: Parser.SyntaxNode): { name: string; bounds: TypeExpression[] }[] {
  const parameters = node.childForFieldName("type_parameters")
    ?? node.namedChildren.find((child) => child.type === "type_parameters");
  if (!parameters) return [];
  return parameters.namedChildren.flatMap((parameter) => {
    if (parameter.type !== "type_parameter") return [];
    const name = parameter.childForFieldName("name")?.text ?? parameter.namedChildren.find((child) => child.type === "type_identifier")?.text;
    if (!name) return [];
    const bound = parameter.namedChildren.find((child) => child.type === "type_bound");
    return [{ name, bounds: bound ? bound.namedChildren.map((child) => parseJavaTypeExpression(child.text)) : [] }];
  });
}

function extractEnumValues(node: Parser.SyntaxNode): string[] {
  const body = node.childForFieldName("body") ?? node.namedChildren.find((child) => child.type === "enum_body");
  return (body?.namedChildren ?? []).filter((child) => child.type === "enum_constant")
    .map((child) => child.childForFieldName("name")?.text ?? child.namedChildren[0]?.text)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => left.localeCompare(right));
}

function enclosingDeclarationNames(node: Parser.SyntaxNode): string[] {
  const names: string[] = [];
  let parent = node.parent;
  while (parent) {
    if (DECLARATION_TYPES.has(parent.type)) {
      const name = parent.childForFieldName("name")?.text;
      if (name) names.unshift(name);
    }
    parent = parent.parent;
  }
  return names;
}

function modifierWords(node: Parser.SyntaxNode): string[] {
  const text = node.namedChildren.find((child) => child.type === "modifiers")?.text ?? "";
  return [...text.matchAll(/\b(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\b/gu)]
    .map((match) => match[0]!)
    .sort((left, right) => left.localeCompare(right));
}

function hasAnnotation(modifiers: Parser.SyntaxNode | undefined, name: string): boolean {
  return new RegExp(`@(?:[A-Za-z_$][\\w$]*\\.)*${name}\\b`, "u").test(modifiers?.text ?? "");
}

function jsonPropertyName(modifiers: Parser.SyntaxNode | undefined): string | undefined {
  return /@(?:[A-Za-z_$][\w$]*\.)*JsonProperty\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/u.exec(modifiers?.text ?? "")?.[1];
}

function fieldNullable(rawType: string, modifiers: string): boolean {
  if (/@(?:[A-Za-z_$][\w$]*\.)*(?:NotNull|NonNull)\b/u.test(modifiers)) return false;
  if (/@(?:[A-Za-z_$][\w$]*\.)*Nullable\b/u.test(modifiers)) return true;
  if (/^(?:byte|short|int|long|float|double|boolean|char)$/u.test(rawType.trim())) return false;
  return true;
}

function declarationKindFor(type: string): "class" | "interface" | "record" | "enum" {
  if (type === "interface_declaration") return "interface";
  if (type === "record_declaration") return "record";
  if (type === "enum_declaration") return "enum";
  return "class";
}

function isTypeNode(node: Parser.SyntaxNode): boolean {
  return /(?:_type|type_identifier|generic_type|scoped_type_identifier)$/u.test(node.type)
    || ["integral_type", "floating_point_type", "boolean_type", "array_type"].includes(node.type);
}

function sourceSymbolId(file: ParsedFile, name: string, line: number): string | undefined {
  return file.symbols.find((symbol) => symbol.name === name && symbol.startLine === line)?.id;
}

function declarationHeader(node: Parser.SyntaxNode): string {
  const body = node.childForFieldName("body") ?? node.namedChildren.find((child) => child.type.endsWith("_body"));
  return node.text.slice(0, body ? Math.max(0, body.startIndex - node.startIndex) : Math.min(node.text.length, 240)).trim();
}

function firstTopLevelGeneric(value: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "<") {
      if (depth === 0) return index;
      depth++;
    }
  }
  return -1;
}

function splitTopLevel(value: string, separator: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "<" || char === "(" || char === "[") depth++;
    else if (char === ">" || char === ")" || char === "]") depth--;
    else if (char === separator && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

function candidateKey(candidate: SchemaDeclarationCandidate): string {
  return `${candidate.declaration.languageId}\0${candidate.declaration.repoId}\0${candidate.declaration.resolutionScopeId}\0${candidate.declaration.canonicalName}`;
}

function fieldOrder(left: SchemaFieldSpec, right: SchemaFieldSpec): number {
  return left.serializedName.localeCompare(right.serializedName) || left.sourceName.localeCompare(right.sourceName);
}
