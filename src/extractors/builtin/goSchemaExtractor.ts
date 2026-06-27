import type Parser from "tree-sitter";
import type { ContractExtractor } from "../../plugins/types.js";
import type { ParsedFile } from "../../parsers/types.js";
import type { SchemaFieldSpec, SchemaSpec } from "../../contracts/spec.js";
import { normalizePrimitiveType } from "../../contracts/spec.js";
import { confidenceFor } from "../../shared/confidence.js";
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
  parseSourceAst,
  walkSourceAst
} from "./sourceAstUtils.js";
import { entityId } from "../../shared/path.js";

/**
 * Go Schema Extractor — extracts field-level schema information from Go struct
 * definitions whose type name matches DTO / Schema naming conventions.
 *
 * Struct field extraction handles:
 *  - Basic types: `string`, `int`, `float64`, `bool`, etc.
 *  - Pointer types: `*string` → nullable
 *  - Slice types: `[]string`, `[]OrderItem`
 *  - Map types: `map[string]interface{}`
 *  - Embedded structs (field_identifier omitted): recorded by their type name
 *  - Struct tags (`` `json:"name"` ``) are ignored for now
 */

export const goSchemaExtractor: ContractExtractor = {
  name: "builtin:go-schema",
  languages: ["go"],
  extract(context) {
    const result = createCrossRepoExtraction();

    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "go") continue;

      const ast = parseSourceAst(file, "go");
      if (!ast) continue;

      walkSourceAst(ast.tree.rootNode, (node) => {
        if (node.type !== "type_spec") return;

        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const typeName = nameNode.text;

        const sharedKind = classifySharedContract(typeName, "struct");
        if (sharedKind !== "schema" && sharedKind !== "dto") return;

        const structType = node.namedChildren.find(
          (c) => c.type === "struct_type"
        );
        if (!structType) return;

        const fields = extractStructFields(structType, file);
        if (fields.length === 0) return;

        const schemaSpec: SchemaSpec = {
          kind: "schema",
          name: typeName,
          language: "go",
          fields
        };

        const schemaContract = contract(sharedKind, typeName, `${sharedKind.toUpperCase()} ${typeName}`);
        const evidenceNode = evidence({
          repoId: file.repoId,
          fileId: file.fileId,
          filePath: file.path,
          line: node.startPosition.row + 1,
          raw: node.text.slice(0, 160),
          rule: "go-schema-fields",
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
          sourceSymbolId: undefined, // Go type_spec nodes are not captured as symbols
          framework: "go-struct",
          version: undefined
        });

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

        // For each embedded struct, emit a USES_SCHEMA placeholder so impact
        // analysis can traverse from the composing struct to the embedded one.
        // Resolved by schemaResolver once the full batch is available (mirrors
        // the Java `extends` / TS utility-type handling).
        for (const base of extractEmbeddedTypeNames(structType)) {
          result.semanticRelations.push({
            fromSpecId: `spec:${schemaContract.id}:pending`,
            toSpecId: `schema-ref:${base}`,
            kind: "USES_SCHEMA",
            evidenceId: evidenceNode.id,
            reason: `Go struct embeds ${base}`,
            confidence: confidenceFor("heuristic-generic-type-param")
          });
        }
      });
    }

    return toFactBundle(result);
  }
};

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/** Extracts field specs from a `struct_type` node's `field_declaration_list`. */
function extractStructFields(
  structType: Parser.SyntaxNode,
  _file: ParsedFile
): SchemaFieldSpec[] {
  const fieldList = structType.namedChildren.find(
    (c) => c.type === "field_declaration_list"
  );
  if (!fieldList) return [];

  const fields: SchemaFieldSpec[] = [];
  for (const child of fieldList.namedChildren) {
    if (child.type !== "field_declaration") continue;
    const parsed = parseGoField(child);
    if (parsed) fields.push(...parsed);
  }

  return fields;
}

/**
 * Parses a single Go `field_declaration` into one or more `SchemaFieldSpec`s.
 * A single Go field line can declare multiple names sharing the same type:
 *   `X, Y int` → two fields
 *   `Name string` → one field
 *   `ID string \`json:"id"\`` → one field (tag ignored)
 */
function parseGoField(node: Parser.SyntaxNode): SchemaFieldSpec[] | undefined {
  // Collect field_identifiers (Go allows `a, b int` syntax)
  const identifiers: string[] = [];
  let typeNode: Parser.SyntaxNode | undefined;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "field_identifier") {
      identifiers.push(child.text);
    } else if (isGoTypeNode(child.type)) {
      // Embedded struct or the type of the preceding identifiers
      if (identifiers.length === 0) {
        // Embedded field — use the type name as the field name
        identifiers.push(child.text);
      }
      typeNode = child;
    }
  }

  if (identifiers.length === 0) return undefined;

  // If no explicit type node was found, the last named child that is not a
  // field_identifier is probably the type (fallback for embedded fields)
  if (!typeNode && identifiers.length === 1) {
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child && child.type !== "field_identifier") {
        typeNode = child;
        break;
      }
    }
  }

  const rawType = typeNode ? goTypeText(typeNode) : "interface{}";
  const normalized = normalizePrimitiveType("go", rawType);

  return identifiers.map((name) => ({
    name,
    type: normalized,
    optional: false,
    nullable: normalized.endsWith("?") ? true : undefined,
    sourceLine: node.startPosition.row + 1
  }));
}

/**
 * Returns the type names of a struct's embedded fields — `field_declaration`s
 * that carry a type but no `field_identifier`. Pointer (`*Base`), qualified
 * (`pkg.Base`) and generic (`Base[T]`) embeds are reduced to the bare type
 * name so they match the simple schema names indexed by the resolver.
 */
function extractEmbeddedTypeNames(structType: Parser.SyntaxNode): string[] {
  const fieldList = structType.namedChildren.find(
    (c) => c.type === "field_declaration_list"
  );
  if (!fieldList) return [];

  const names: string[] = [];
  for (const child of fieldList.namedChildren) {
    if (child.type !== "field_declaration") continue;
    // A named field (`Name string`) has a field_identifier; embedded fields do not.
    if (child.namedChildren.some((c) => c.type === "field_identifier")) continue;
    const typeNode = child.namedChildren.find((c) => isGoTypeNode(c.type));
    if (!typeNode) continue;
    const name = embeddedBaseName(typeNode);
    if (name) names.push(name);
  }
  return names;
}

/** Unwraps pointer/qualified/generic wrappers to the bare embedded type name. */
function embeddedBaseName(node: Parser.SyntaxNode): string | undefined {
  if (node.type === "type_identifier") return node.text;
  if (node.type === "pointer_type") {
    const inner = node.namedChild(0);
    return inner ? embeddedBaseName(inner) : undefined;
  }
  if (node.type === "qualified_type" || node.type === "generic_type") {
    const id = node.namedChildren.find((c) => c.type === "type_identifier");
    return id?.text;
  }
  return undefined;
}

function isGoTypeNode(type: string): boolean {
  return type === "type_identifier" ||
    type === "pointer_type" ||
    type === "slice_type" ||
    type === "map_type" ||
    type === "array_type" ||
    type === "channel_type" ||
    type === "function_type" ||
    type === "interface_type" ||
    type === "qualified_type" ||
    type === "generic_type";
}

/**
 * Returns a source-text representation of a Go type node.
 */
function goTypeText(node: Parser.SyntaxNode): string {
  if (node.type === "pointer_type") {
    const inner = node.namedChild(0);
    return inner ? "*" + goTypeText(inner) : node.text;
  }
  if (node.type === "slice_type") {
    const inner = node.namedChildren.find((c) => c.type !== "[" && c.type !== "]");
    return inner ? "[]" + goTypeText(inner) : node.text;
  }
  if (node.type === "map_type") {
    // tree-sitter-go map_type has named children: type_identifier (key) and
    // the value type (interface_type / type_identifier / ...).
    // `map`, `[`, `]` are anonymous tokens and excluded from namedChildren.
    const named = node.namedChildren.filter((c) => c.type !== "[" && c.type !== "]");
    const key = named[0];
    const val = named[1];
    const keyStr = key ? goTypeText(key) : "string";
    const valStr = val ? goTypeText(val) : "interface{}";
    return `map[${keyStr}]${valStr}`;
  }
  return node.text;
}
