import { defineBuiltinExtractor } from "./defineBuiltinExtractor.js";
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
import { canonicalResolutionScopeIdForFile } from "../../../schema/sourceScopes.js";

/**
 * Go Schema Extractor indexes field-level declaration candidates from structs.
 * It does not publish isolated structs as SchemaSpecs; typed contract roots
 * drive public materialization in the shared reconciliation engine.
 *
 * Struct field extraction handles:
 *  - Basic types: `string`, `int`, `float64`, `bool`, etc.
 *  - Pointer types: `*string` → nullable
 *  - Slice types: `[]string`, `[]OrderItem`
 *  - Map types: `map[string]interface{}`
 *  - Embedded structs (field_identifier omitted): recorded by their type name
 *  - Struct tags (`` `json:"name"` ``) are ignored for now
 */

export const goSchemaExtractor = defineBuiltinExtractor({
  name: "builtin:go-schema",
  languages: ["go"],
  async extract(context, collector: FactCollector) {

    const scopeIds = new Map<string, string>();
    for (const file of parsedCodeFiles(context.parsedFiles)) {
      if (file.language !== "go") continue;
      const repo = context.repos.find((candidate) => candidate.id === file.repoId);
      scopeIds.set(file.fileId, await canonicalResolutionScopeIdForFile(file, repo?.path));
    }

    for (const file of parsedCodeFiles(context.parsedFiles)) {
      if (file.language !== "go") continue;

      const ast = parseSourceAst(file, "go");
      if (!ast) continue;

      walkSourceAst(ast.tree.rootNode, (node) => {
        if (node.type !== "type_spec") return;

        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const typeName = nameNode.text;

        const structType = node.namedChildren.find(
          (c) => c.type === "struct_type"
        );
        if (!structType) return;

        const fields = extractStructFields(structType, file);
        const baseTypes = extractEmbeddedTypeExpressions(structType);
        const typeParameters = extractGoTypeParameters(node, typeName);

        collector.addSchemaDeclaration({
          declaration: { languageId: "go", repoId: file.repoId, resolutionScopeId: scopeIds.get(file.fileId)!, canonicalName: typeName },
          displayName: typeName,
          typeParameters,
          shape: { kind: "object", fields, baseTypes },
          fileId: file.fileId,
          filePath: file.path,
          framework: "go-struct",
          evidence: {
            line: node.startPosition.row + 1,
            raw: node.text.slice(0, 160),
            rule: "go-schema-declaration",
            confidence: confidenceFor("heuristic-schema-fields")
          }
        });

      });
    }

  }
});

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
    const parsed = parseGoField(child, _file);
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
function parseGoField(node: Parser.SyntaxNode, file: ParsedFile): SchemaFieldSpec[] | undefined {
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

  return identifiers.map((name) => schemaFieldFromNormalized({
    languageId: "go",
    repoId: file.repoId,
    fileId: file.fileId,
    sourceName: name,
    normalizedType: normalized,
    optional: false,
    nullable: normalized.endsWith("?"),
    line: node.startPosition.row + 1
  }));
}

/**
 * Returns the type names of a struct's embedded fields — `field_declaration`s
 * that carry a type but no `field_identifier`. Pointer (`*Base`), qualified
 * (`pkg.Base`) and generic (`Base[T]`) embeds are reduced to the bare type
 * name so they match the simple schema names indexed by the resolver.
 */
function extractEmbeddedTypeExpressions(structType: Parser.SyntaxNode): ReturnType<typeof typeExpressionFromNormalized>[] {
  const fieldList = structType.namedChildren.find(
    (c) => c.type === "field_declaration_list"
  );
  if (!fieldList) return [];

  const expressions: ReturnType<typeof typeExpressionFromNormalized>[] = [];
  for (const child of fieldList.namedChildren) {
    if (child.type !== "field_declaration") continue;
    // A named field (`Name string`) has a field_identifier; embedded fields do not.
    if (child.namedChildren.some((c) => c.type === "field_identifier")) continue;
    const typeNode = child.childForFieldName("type")
      ?? child.namedChildren.find((candidate) => isGoTypeNode(candidate.type));
    if (!typeNode) continue;
    const rawType = child.text.replace(/`[^`]*`\s*$/su, "").trim() || goTypeText(typeNode);
    expressions.push(typeExpressionFromNormalized(normalizePrimitiveType("go", rawType), "go"));
  }
  return expressions;
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

function extractGoTypeParameters(typeSpec: Parser.SyntaxNode, typeName: string): string[] {
  const header = typeSpec.text.slice(0, Math.max(0, typeSpec.text.indexOf("struct")));
  const start = header.indexOf("[", header.indexOf(typeName) + typeName.length);
  if (start < 0) return [];
  const end = header.lastIndexOf("]");
  if (end <= start) return [];
  return header.slice(start + 1, end).split(",").flatMap((part) => {
    const name = part.trim().match(/^([A-Za-z_]\w*)/u)?.[1];
    return name ? [name] : [];
  });
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
