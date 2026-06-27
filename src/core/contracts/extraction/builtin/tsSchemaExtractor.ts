import type Parser from "tree-sitter";
import type { ContractExtractor } from "../../../../plugins/types.js";
import type { ParsedFile } from "../../../parsing/types.js";
import type { SchemaFieldSpec, SchemaSpec } from "../../spec.js";
import { normalizePrimitiveType } from "../../spec.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  classifySharedContract,
  contract,
  createCrossRepoExtraction,
  evidence,
  isParsedCodeFile,
  pushContractEvidence,
  pushContractSpec,
  toBusinessEntityName,
  toFactBundle
} from "./shared.js";
import {
  findContainingSymbol,
  parseSourceAst,
  walkSourceAst
} from "./sourceAstUtils.js";
import { entityId } from "../../../../shared/path.js";

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
 * Extracts field-level schema information from TypeScript interface / type-alias
 * declarations that match DTO / schema naming conventions.
 *
 * Produces a `SchemaSpec` for each matching declaration, populating `fields`
 * with name, normalized type, optional, nullable, and source line.  Also emits
 * a `ContractSpecNode` + `HAS_SPEC` edge via `pushContractSpec`.
 *
 * TS utility types (`Omit`, `Pick`, `Partial`, `Required`, `Readonly`) are
 * unwrapped to extract the base type reference so the semantic layer can
 * still link consumers to the canonical schema definition.
 */
export const tsSchemaExtractor: ContractExtractor = {
  name: "builtin:ts-schema",
  // Include "javascript" / "jsx" so the jsFallbackDetector (which lumps JS/TS
  // under language:"javascript") enables this extractor for JS/TS repos.
  // Per-file filtering inside extract() still only processes TS/TSX files.
  languages: ["typescript", "tsx", "javascript", "jsx"],
  extract(context) {
    const result = createCrossRepoExtraction();

    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "typescript" && file.language !== "tsx") continue;

      const ast = parseSourceAst(file, file.language as "typescript" | "tsx");
      if (!ast) continue;

      // Collect schema-relevant declarations: interfaces + type aliases
      for (const symbol of file.symbols) {
        const sharedKind = classifySharedContract(symbol.name, symbol.kind);
        if (sharedKind !== "schema" && sharedKind !== "dto") continue;

        // Find the AST node for this symbol
        const node = findDeclarationNode(ast.tree.rootNode, symbol);
        if (!node) continue;

        const fields = extractFields(node, file);
        const baseTypeRef = extractBaseTypeFromUtilityType(node);

        // Skip declarations that neither have extractable fields nor
        // reference a utility-wrapped base type.
        if (fields.length === 0 && !baseTypeRef) continue;

        const language = file.language === "tsx" ? "typescript" : file.language;
        const schemaSpec: SchemaSpec = {
          kind: "schema",
          name: symbol.name,
          language,
          fields
        };

        const schemaContract = contract(sharedKind, symbol.name, `${sharedKind.toUpperCase()} ${symbol.name}`);
        const evidenceNode = evidence({
          repoId: file.repoId,
          fileId: file.fileId,
          filePath: file.path,
          line: symbol.startLine,
          raw: symbol.signature,
          rule: "ts-schema-fields",
          confidence: confidenceFor("heuristic-schema-fields")
        });

        pushContractEvidence(result, file.repoId, schemaContract, "shared", evidenceNode);

        pushContractSpec({
          result,
          contractNode: schemaContract,
          spec: schemaSpec,
          repoId: file.repoId,
          fileId: file.fileId,
          evidenceNode,
          sourceSymbolId: symbol.id,
          framework: "ts-schema",
          version: undefined
        });

        // Wire up business entity if applicable
        const entityName = toBusinessEntityName(schemaContract);
        if (entityName) {
          result.entities.push({
            id: entityId(entityName),
            name: entityName,
            kind: "domain",
            description: "Domain entity inferred from cross-repo contracts"
          });
          result.contractEntities.push({
            contractId: schemaContract.id,
            entityId: entityId(entityName),
            evidenceId: evidenceNode.id,
            confidence: evidenceNode.confidence
          });
        }

        // For utility types (Omit/Pick/Partial/etc.), emit a USES_SCHEMA
        // semantic relation to the base type so impact analysis can traverse
        // from the derived type back to the canonical definition.
        if (baseTypeRef) {
          // We record the base type as a referenced schema name; the actual
          // SEMANTIC_REL edge will be created in postExtract when the target
          // schema is guaranteed to be in the batch.
          result.semanticRelations.push({
            fromSpecId: `spec:${schemaContract.id}:pending`, // resolved in postExtract
            toSpecId: `schema-ref:${baseTypeRef}`,           // resolved in postExtract
            kind: "USES_SCHEMA",
            evidenceId: evidenceNode.id,
            reason: `TS utility type references base schema ${baseTypeRef}`,
            confidence: confidenceFor("heuristic-generic-type-param")
          });
        }
      }
    }

    return toFactBundle(result);
  },

};

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
    // but type_alias_declaration does NOT — the type_identifier is just a named child.
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

/**
 * Extracts field definitions from an interface_declaration or type_alias_declaration
 * AST node. Returns an array of `SchemaFieldSpec`.
 */
function extractFields(
  node: Parser.SyntaxNode,
  _file: ParsedFile
): SchemaFieldSpec[] {
  if (node.type === "interface_declaration") {
    return extractInterfaceFields(node);
  }
  if (node.type === "type_alias_declaration") {
    return extractTypeAliasFields(node);
  }
  return [];
}

/** Extracts fields from `interface_declaration`. */
function extractInterfaceFields(node: Parser.SyntaxNode): SchemaFieldSpec[] {
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
      const field = parsePropertySignature(child);
      if (field) fields.push(field);
    }
  }

  return fields;
}

/** Extracts fields from `type_alias_declaration`. */
function extractTypeAliasFields(node: Parser.SyntaxNode): SchemaFieldSpec[] {
  const valueNode = node.namedChildren.find(
    (c) => c.type !== "type_identifier" && c.type !== "type_parameters" && c.type !== "=" && c.type !== ";" && c.type !== "type"
  );
  if (!valueNode) return [];

  return extractFieldsFromTypeNode(valueNode);
}

/**
 * Recursively extracts fields from a type node.  Handles:
 * - object_type → direct properties
 * - intersection_type → merge properties from each branch
 * - generic_type (utility) → only when the first arg is an object_type
 */
function extractFieldsFromTypeNode(node: Parser.SyntaxNode): SchemaFieldSpec[] {
  if (node.type === "object_type") {
    const fields: SchemaFieldSpec[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === "index_signature") continue;
      if (child.type === "method_signature") continue;
      if (child.type === "property_signature") {
        const field = parsePropertySignature(child);
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
      fields.push(...extractFieldsFromTypeNode(child));
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
            return extractFieldsFromTypeNode(arg);
          }
          // For intersections inside utility types, dig deeper
          if (arg.type === "intersection_type" || arg.type === "generic_type") {
            const inner = extractFieldsFromTypeNode(arg);
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
function parsePropertySignature(node: Parser.SyntaxNode): SchemaFieldSpec | undefined {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return undefined;

  const name = nameNode.text;
  const optional = node.children.some((c) => c.type === "?");
  // childForFieldName("type") returns the type_annotation node (": string"),
  // so unwrap one level: its first named child is the actual type node.
  const typeAnnotation = node.childForFieldName("type");
  const innerType = typeAnnotation ? typeAnnotation.namedChild(0) : null;
  const rawType = innerType ? typeText(innerType) : "any";

  // Normalize the type first — the normalization function handles nullable
  // unwrapping (e.g. "string | null" → "string?").
  const normalized = normalizePrimitiveType("typescript", rawType);

  // Detect whether the result signals nullability (trailing "?").
  const nullable = normalized.endsWith("?") ? true : undefined;

  return {
    name,
    type: normalized,
    optional,
    nullable: nullable || undefined,
    sourceLine: node.startPosition.row + 1
  };
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
 * e.g. `Omit<Order, 'id'>` → `Order`, `Partial<OrderDTO>` → `OrderDTO`.
 * Returns `undefined` when the RHS is not a recognised utility type.
 */
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
        if (firstArg && (firstArg.type === "type_identifier" || firstArg.type === "generic_type")) {
          return firstArg.text.split("<")[0]!.trim();
        }
      }
    }
  }

  return undefined;
}

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
