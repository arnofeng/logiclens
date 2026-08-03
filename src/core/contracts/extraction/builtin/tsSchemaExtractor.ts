import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { FactCollector } from "../factCollector.js";
import type { ParsedFile } from "../../../parsing/types.js";
import type { SchemaFieldSpec } from "../../spec.js";
import { normalizePrimitiveType } from "../../spec.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { parsedCodeFiles } from "./shared.js";
import {
  parseSourceAst,
  walkSourceAst
} from "./sourceAstUtils.js";
import { schemaFieldFromNormalized, typeExpressionFromNormalized } from "../../../schema/model.js";
import { resolutionScopeIdForFile } from "../../../schema/sourceScopes.js";

/**
 * TS utility types whose first type-argument is the underlying DTO / schema type.
 * When we encounter e.g. `Partial<CreateOrderDTO>`, we extract the base type
 * reference `CreateOrderDTO` so schema matching can still locate the canonical
 * definition. The utility wrapper name itself is recorded in the field's type
 * so consumers can see the actual usage.
 */
const TS_UTILITY_TYPES = new Set([
  "Omit",
  "Pick",
  "Partial",
  "Required",
  "Readonly",
  "Record"
]);

/**
 * Indexes field-level declaration candidates from TypeScript interfaces and
 * object type aliases without publishing them as SchemaSpecs. Public schema
 * facts are materialized later only when a typed contract root reaches them.
 *
 * TS utility types (`Omit`, `Pick`, `Partial`, `Required`, `Readonly`) are
 * unwrapped to extract the base type reference so the semantic layer can
 * still link consumers to the canonical schema definition.
 */
export const tsSchemaExtractor = compatExtractor({
  name: "builtin:ts-schema",
  // Include "javascript" / "jsx" so the jsFallbackDetector (which lumps JS/TS
  // under language:"javascript") enables this extractor for JS/TS repos.
  // Per-file filtering inside extract() still only processes TS/TSX files.
  languages: ["typescript", "tsx", "javascript", "jsx"],
  extract(context, collector: FactCollector) {

    for (const file of parsedCodeFiles(context.parsedFiles)) {
      if (file.language !== "typescript" && file.language !== "tsx") continue;

      const ast = parseSourceAst(file, file.language as "typescript" | "tsx");
      if (!ast) continue;

      // Collect schema-relevant declarations: interfaces + type aliases
      for (const symbol of file.symbols) {
        if (symbol.kind !== "interface" && symbol.kind !== "type") continue;

        // Find the AST node for this symbol
        const node = findDeclarationNode(ast.tree.rootNode, symbol);
        if (!node) continue;

        const fields = extractFields(node, file);
        const baseTypes = extractBaseTypes(node);
        const typeParameters = extractTypeParameters(node);

        // Skip declarations that neither have extractable fields nor
        // reference a utility-wrapped base type.
        if (fields.length === 0 && baseTypes.length === 0 && !isObjectDeclaration(node)) continue;

        const language = file.language === "tsx" ? "typescript" : file.language;
        collector.addSchemaDeclaration({
          declaration: { languageId: language, repoId: file.repoId, resolutionScopeId: resolutionScopeIdForFile(file), canonicalName: symbol.qualifiedName || symbol.name },
          displayName: symbol.name,
          typeParameters,
          shape: { kind: "object", fields, baseTypes: baseTypes.length > 0 ? baseTypes : undefined },
          fileId: file.fileId,
          filePath: file.path,
          sourceSymbolId: symbol.id,
          framework: "ts-schema",
          evidence: {
            line: symbol.startLine,
            raw: symbol.signature,
            rule: "ts-schema-declaration",
            confidence: confidenceFor("heuristic-schema-fields")
          }
        });

      }
    }

  }, });

// ---------------------------------------------------------------------------
// AST traversal helpers
// ---------------------------------------------------------------------------

/** Finds the AST declaration node corresponding to a symbol. */
function findDeclarationNode(
  root: Parser.SyntaxNode,
  symbol: { name: string; kind: string; startLine: number }
): Parser.SyntaxNode | undefined {
  let found: Parser.SyntaxNode | undefined;
  walkSourceAst(root, (node) => {
    if (found) return;
    if (node.type !== "interface_declaration" && node.type !== "type_alias_declaration") return;
    // In tree-sitter-typescript, interface_declaration uses field "name"
    // but type_alias_declaration does NOT; the type_identifier is just a named child.
    let nameNode = node.childForFieldName("name");
    if (!nameNode) {
      nameNode = node.namedChildren.find(
        (c) => c.type === "type_identifier"
      ) ?? null;
    }
    if (!nameNode || nameNode.text !== symbol.name) return;
    if (node.startPosition.row + 1 === symbol.startLine) {
      found = node;
    }
  });
  return found;
}

function isObjectDeclaration(node: Parser.SyntaxNode): boolean {
  if (node.type === "interface_declaration") return true;
  return node.type === "type_alias_declaration" && node.namedChildren.some((child) => child.type === "object_type");
}

function extractTypeParameters(node: Parser.SyntaxNode): string[] {
  const parameters = node.namedChildren.find((child) => child.type === "type_parameters");
  if (!parameters) return [];
  return parameters.namedChildren.flatMap((child) => {
    const name = child.type === "type_identifier" || child.type === "identifier"
      ? child.text
      : child.namedChildren.find((part) => part.type === "type_identifier" || part.type === "identifier")?.text;
    return name ? [name] : [];
  });
}

/**
 * Extracts field definitions from an interface_declaration or type_alias_declaration
 * AST node. Returns an array of `SchemaFieldSpec`.
 */
function extractFields(
  node: Parser.SyntaxNode,
  file: ParsedFile
): SchemaFieldSpec[] {
  if (node.type === "interface_declaration") {
    return extractInterfaceFields(node, file);
  }
  if (node.type === "type_alias_declaration") {
    return extractTypeAliasFields(node, file);
  }
  return [];
}

/** Extracts fields from `interface_declaration`. */
function extractInterfaceFields(node: Parser.SyntaxNode, file: ParsedFile): SchemaFieldSpec[] {
  const body = node.childForFieldName("body");
  if (!body) return [];

  const fields: SchemaFieldSpec[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;

    // Skip index signatures: `[key: string]: Type`
    if (child.type === "index_signature") continue;
    // Skip method signatures: `foo(): void`
    if (child.type === "method_signature") continue;
    // Skip construct signatures
    if (child.type === "construct_signature") continue;

    if (child.type === "property_signature") {
      const field = parsePropertySignature(child, file);
      if (field) fields.push(field);
    }
  }

  return fields;
}

/** Extracts fields from `type_alias_declaration`. */
function extractTypeAliasFields(node: Parser.SyntaxNode, file: ParsedFile): SchemaFieldSpec[] {
  const valueNode = node.namedChildren.find(
    (c) => c.type !== "type_identifier" && c.type !== "type_parameters" && c.type !== "=" && c.type !== ";" && c.type !== "type"
  );
  if (!valueNode) return [];

  return extractFieldsFromTypeNode(valueNode, file);
}

/**
 * Recursively extracts fields from a type node.  Handles:
 * - object_type direct properties
 * - intersection_type merge properties from each branch
 * - generic_type (utility) only when the first arg is an object_type
 */
function extractFieldsFromTypeNode(node: Parser.SyntaxNode, file: ParsedFile): SchemaFieldSpec[] {
  if (node.type === "object_type") {
    const fields: SchemaFieldSpec[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === "index_signature") continue;
      if (child.type === "method_signature") continue;
      if (child.type === "property_signature") {
        const field = parsePropertySignature(child, file);
        if (field) fields.push(field);
      }
    }
    return fields;
  }

  if (node.type === "intersection_type") {
    const fields: SchemaFieldSpec[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      fields.push(...extractFieldsFromTypeNode(child, file));
    }
    return fields;
  }

  if (node.type === "generic_type") {
    const nameNode = node.childForFieldName("name") ?? node.namedChild(0);
    const name = nameNode?.text;
    if (name && TS_UTILITY_TYPES.has(name)) {
      // For utility types with an object_type arg, extract from that arg
      const typeArgs = node.childForFieldName("type_arguments");
      if (typeArgs) {
        for (let i = 0; i < typeArgs.namedChildCount; i++) {
          const arg = typeArgs.namedChild(i);
          if (!arg) continue;
          if (arg.type === "object_type") {
            return extractFieldsFromTypeNode(arg, file);
          }
          // For intersections inside utility types, dig deeper
          if (arg.type === "intersection_type" || arg.type === "generic_type") {
            const inner = extractFieldsFromTypeNode(arg, file);
            if (inner.length > 0) return inner;
          }
        }
      }
    }
  }

  return [];
}

/**
 * Parses a single `property_signature` node into a `SchemaFieldSpec`.
 */
function parsePropertySignature(node: Parser.SyntaxNode, file: ParsedFile): SchemaFieldSpec | undefined {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return undefined;

  const name = nameNode.text;
  const optional = node.children.some((c) => c.type === "?");
  // childForFieldName("type") returns the type_annotation node (": string"),
  // so unwrap one level: its first named child is the actual type node.
  const typeAnnotation = node.childForFieldName("type");
  const innerType = typeAnnotation ? typeAnnotation.namedChild(0) : null;
  const rawType = innerType ? typeText(innerType) : "any";

  // Normalize the type first; the normalization function handles nullable
  // unwrapping (e.g. "string | null" -> "string?").
  const normalized = normalizePrimitiveType("typescript", rawType);

  // Detect whether the result signals nullability (trailing "?").
  const nullable = normalized.endsWith("?") ? true : undefined;

  return schemaFieldFromNormalized({
    languageId: "typescript",
    repoId: file.repoId,
    fileId: file.fileId,
    sourceName: name,
    normalizedType: normalized,
    optional,
    nullable: nullable || undefined,
    line: node.startPosition.row + 1
  });
}

/**
 * Returns the "source text" representation of a type node, reconstructing
 * generic types, union types, array types, etc.
 */
function typeText(node: Parser.SyntaxNode): string {
  // For most node types the text is already correct
  if (node.type === "generic_type" || node.type === "union_type" ||
      node.type === "intersection_type" || node.type === "array_type" ||
      node.type === "predefined_type" || node.type === "type_identifier" ||
      node.type === "literal_type" || node.type === "object_type" ||
      node.type === "function_type" || node.type === "indexed_access_type" ||
      node.type === "nested_type_identifier" || node.type === "tuple_type" ||
      node.type === "mapped_type" || node.type === "conditional_type" ||
      node.type === "parenthesized_type" || node.type === "this_type") {
    return node.text;
  }
  return node.text;
}

/**
 * Extracts the base type reference from a TS utility type wrapping.
 * e.g. `Omit<Order, 'id'>` -> `Order`, `Partial<OrderDTO>` -> `OrderDTO`.
 * Returns `undefined` when the RHS is not a recognised utility type.
 */
function extractBaseTypes(node: Parser.SyntaxNode): ReturnType<typeof typeExpressionFromNormalized>[] {
  if (node.type === "interface_declaration") {
    const header = node.text.slice(0, Math.max(0, node.text.indexOf("{")));
    const match = header.match(/\bextends\s+(.+)$/su);
    if (!match) return [];
    return splitTopLevelTypes(match[1]!, ",").map((raw) =>
      typeExpressionFromNormalized(normalizePrimitiveType("typescript", raw), "typescript")
    );
  }

  const valueNode = node.type === "type_alias_declaration"
    ? node.namedChildren.find(
      (child) => child.type !== "type_identifier" && child.type !== "type_parameters" && child.type !== "=" && child.type !== ";" && child.type !== "type"
    )
    : node;
  if (!valueNode) return [];

  const utilityBase = extractBaseTypeFromUtilityType(valueNode);
  if (utilityBase) {
    return [typeExpressionFromNormalized(normalizePrimitiveType("typescript", utilityBase), "typescript")];
  }

  if (valueNode.type === "intersection_type" || valueNode.type === "union_type") {
    const members = valueNode.namedChildren
      .filter((child) => child.type !== "object_type")
      .map((child) => typeExpressionFromNormalized(normalizePrimitiveType("typescript", child.text), "typescript"));
    if (members.length === 0) return [];
    return members.length === 1 ? members : [{ kind: valueNode.type === "intersection_type" ? "intersection" : "union", members }];
  }

  return [];
}

function extractBaseTypeFromUtilityType(node: Parser.SyntaxNode): string | undefined {
  if (node.type === "type_alias_declaration") {
    const valueNode = node.namedChildren.find(
      (c) => c.type !== "type_identifier" && c.type !== "type_parameters" && c.type !== "=" && c.type !== ";" && c.type !== "type"
    );
    if (!valueNode) return undefined;
    return extractBaseTypeFromUtilityType(valueNode);
  }

  if (node.type === "intersection_type") {
    // Walk each branch; return the first utility-wrapped base type found.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const ref = extractBaseTypeFromUtilityType(child);
      if (ref) return ref;
    }
    return undefined;
  }

  if (node.type === "generic_type") {
    const nameNode = node.childForFieldName("name") ?? node.namedChild(0);
    const name = nameNode?.text;
    if (name && TS_UTILITY_TYPES.has(name)) {
      const typeArgs = node.childForFieldName("type_arguments");
      if (typeArgs) {
        const firstArg = typeArgs.namedChild(0);
        if (firstArg) return firstArg.text.trim();
      }
    }
  }

  return undefined;
}

function splitTopLevelTypes(value: string, separator: string): string[] {
  const result: string[] = [];
  let angleDepth = 0;
  let squareDepth = 0;
  let parenDepth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "<") angleDepth++;
    else if (character === ">") angleDepth--;
    else if (character === "[") squareDepth++;
    else if (character === "]") squareDepth--;
    else if (character === "(") parenDepth++;
    else if (character === ")") parenDepth--;
    else if (character === separator && angleDepth === 0 && squareDepth === 0 && parenDepth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}
