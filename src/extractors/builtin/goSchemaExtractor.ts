import type Parser from "tree-sitter";
import type { ContractExtractor } from "../../plugins/types.js";
import type { ParsedFile } from "../../parsers/types.js";
import type { SchemaFieldSpec, SchemaSpec } from "../../contracts/spec.js";
import { normalizePrimitiveType } from "../../contracts/spec.js";
import { confidenceFor } from "../../confidence.js";
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
import { entityId } from "../../utils/path.js";

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
