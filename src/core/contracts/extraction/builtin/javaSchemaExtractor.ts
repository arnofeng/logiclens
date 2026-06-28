import { compatExtractor } from "./compat.js";
import type Parser from "tree-sitter";
import type { FactCollector } from "../factCollector.js";
import type { ParsedFile } from "../../../parsing/types.js";
import type { SchemaFieldSpec, SchemaSpec } from "../../spec.js";
import { normalizePrimitiveType } from "../../spec.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import {
  classifySharedContract,
  contract,
  evidence,
  isParsedCodeFile,
  pushContractEvidence,
  pushContractSpec,
  toBusinessEntityName, } from "./shared.js";
import {
  findContainingSymbol,
  parseSourceAst,
  walkSourceAst
} from "./sourceAstUtils.js";
import { entityId } from "../../../../shared/path.js";

/**
 * Java Schema Extractor — extracts field-level schema information from POJO /
 * DTO class declarations.
 *
 * Handles:
 *  - Plain field declarations (`private String name`)
 *  - Generic wrappers: `Optional<T>`, `List<T>`, `Map<K,V>`, `ResponseEntity<T>`
 *  - Lombok `@Data` / `@Getter` / `@Setter` annotated classes (fields only —
 *    no setter/getter expansion needed)
 *  - Inheritance: records the parent class name but does NOT expand parent
 *    fields (keeps the schema graph simple; parent schemas get their own node)
 *  - `@NotNull` / `@Nullable` annotations for nullability signal
 *  - Static / transient / final fields are skipped
 *
 * Produces a `SchemaSpec` + `ContractSpecNode` + `HAS_SPEC` edge for each
 * matching class, plus a `USES_SCHEMA` semantic relation for superclass refs.
 */
export const javaSchemaExtractor = compatExtractor({
  name: "builtin:java-schema",
  languages: ["java"],
  extract(context, collector: FactCollector) {

    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "java") continue;

      const ast = parseSourceAst(file, "java");
      if (!ast) continue;

      for (const symbol of file.symbols) {
        if (symbol.kind !== "class") continue;

        const sharedKind = classifySharedContract(symbol.name, symbol.kind);
        if (sharedKind !== "schema" && sharedKind !== "dto") continue;

        // Find the class_declaration node
        const classNode = findClassNode(ast.tree.rootNode, symbol.name, symbol.startLine);
        if (!classNode) continue;

        const parentClass = extractParentClass(classNode);
        const hasLombokData = classHasAnnotation(classNode, "Data");

        const fields = extractClassFields(classNode, file);
        if (fields.length === 0 && !parentClass) continue;

        const schemaSpec: SchemaSpec = {
          kind: "schema",
          name: symbol.name,
          language: "java",
          fields
        };

        const schemaContract = contract(sharedKind, symbol.name, `${sharedKind.toUpperCase()} ${symbol.name}`);
        const evidenceNode = evidence({
          repoId: file.repoId,
          fileId: file.fileId,
          filePath: file.path,
          line: symbol.startLine,
          raw: symbol.signature,
          rule: "java-schema-fields",
          confidence: confidenceFor("heuristic-schema-fields")
        });

        pushContractEvidence(collector, file.repoId, schemaContract, "shared", evidenceNode);

        pushContractSpec({
          collector,
          contractNode: schemaContract,
          spec: schemaSpec,
          repoId: file.repoId,
          fileId: file.fileId,
          evidenceNode,
          sourceSymbolId: symbol.id,
          framework: hasLombokData ? "lombok" : "java-pojo",
          version: undefined
        });

        // Wire up business entity if applicable
        const entityName = toBusinessEntityName(schemaContract);
        if (entityName) {
          collector.addEntity({
            id: entityId(entityName),
            name: entityName,
            kind: "domain",
            description: "Domain entity inferred from cross-repo contracts"
          });
          collector.addContractEntity({
            contractId: schemaContract.id,
            entityId: entityId(entityName),
            evidenceId: evidenceNode.id,
            confidence: evidenceNode.confidence
          });
        }

        // If the class extends a parent, emit a USES_SCHEMA edge placeholder
        if (parentClass) {
          collector.addSemanticRelation({
            fromSpecId: `spec:${schemaContract.id}:pending`,
            toSpecId: `schema-ref:${parentClass}`,
            kind: "USES_SCHEMA",
            evidenceId: evidenceNode.id,
            reason: `Java class extends ${parentClass}`,
            confidence: confidenceFor("heuristic-generic-type-param")
          });
        }
      }
    }

  }, });

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function findClassNode(
  root: Parser.SyntaxNode,
  name: string,
  startLine: number
): Parser.SyntaxNode | undefined {
  let found: Parser.SyntaxNode | undefined;
  walkSourceAst(root, (node) => {
    if (found) return;
    if (node.type !== "class_declaration") return;
    const id = node.childForFieldName("name");
    if (id?.text === name && node.startPosition.row + 1 === startLine) {
      found = node;
    }
  });
  return found;
}

/** Checks whether a class_declaration node carries the given annotation name. */
function classHasAnnotation(classNode: Parser.SyntaxNode, annotationName: string): boolean {
  const modifiers = findModifiers(classNode);
  if (!modifiers) return false;
  for (const child of modifiers.namedChildren) {
    if (child.type === "marker_annotation" || child.type === "annotation") {
      // marker_annotation children include "@" and "identifier"
      const id = child.namedChildren.find((n) => n.type === "identifier" && n.text === annotationName);
      if (id) return true;
    }
  }
  return false;
}

/** Extracts the parent class name from `extends BaseClass`. */
function extractParentClass(node: Parser.SyntaxNode): string | undefined {
  // tree-sitter-java doesn't expose "superclass" as a named field,
  // so find it by node type.
  const superclass = node.namedChildren.find((c) => c.type === "superclass");
  if (!superclass) return undefined;
  // superclass node is e.g. `extends BaseResponse`
  const typeId = superclass.namedChild(0);
  return typeId?.type === "type_identifier" ? typeId.text : undefined;
}

/** Extracts field specs from a class_declaration's body. */
function extractClassFields(
  classNode: Parser.SyntaxNode,
  _file: ParsedFile
): SchemaFieldSpec[] {
  const body = classNode.childForFieldName("body");
  if (!body) return [];

  const fields: SchemaFieldSpec[] = [];

  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    if (child.type !== "field_declaration") continue;

    const field = parseJavaField(child);
    if (field) fields.push(field);
  }

  return fields;
}

/**
 * Parses a single Java `field_declaration` into a `SchemaFieldSpec`.
 * Skips static / transient / final fields because they are not part of the
 * data schema (they are constants, utilities, or framework internals).
 */
function parseJavaField(node: Parser.SyntaxNode): SchemaFieldSpec | undefined {
  // Find modifiers by type (tree-sitter-java may not expose "modifiers" as a
  // named field, only as a named node type).
  const modifiers = findModifiers(node);

  // Check for static/transient modifiers
  if (modifiers) {
    const modText = modifiers.text.toLowerCase();
    if (/\bstatic\b/.test(modText)) return undefined;
    if (/\btransient\b/.test(modText)) return undefined;
  }

  // Find the type node (first named child that is a type, not a modifier)
  let typeNode: Parser.SyntaxNode | undefined;
  let declarator: Parser.SyntaxNode | undefined;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "variable_declarator") {
      declarator = child;
      break;
    }
    // Type nodes come before the declarator
    if (isJavaTypeNode(child.type)) {
      typeNode = child;
    }
  }

  if (!declarator) return undefined;

  // The field name is the identifier inside the variable_declarator
  const nameNode = declarator.childForFieldName("name");
  const name = nameNode?.text;
  if (!name) return undefined;

  const rawType = typeNode ? typeNode.text : "Object";
  const normalized = normalizePrimitiveType("java", rawType);

  // Detect nullable from @NotNull / @Nullable annotations
  let nullable: boolean | undefined;
  if (modifiers) {
    if (/@NotNull\b/.test(modifiers.text)) nullable = false;
    else if (/@Nullable\b/.test(modifiers.text)) nullable = true;
  }
  // Optional<T> implies nullable
  if (rawType.startsWith("Optional<")) nullable = true;

  return {
    name,
    type: normalized,
    optional: false, // Java fields are required by default
    nullable: nullable || undefined,
    sourceLine: node.startPosition.row + 1
  };
}

/** Finds the modifiers child of a class or field declaration by node type. */
function findModifiers(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  return node.namedChildren.find((c) => c.type === "modifiers");
}

function isJavaTypeNode(type: string): boolean {
  return type === "type_identifier" ||
    type === "generic_type" ||
    type === "integral_type" ||
    type === "floating_point_type" ||
    type === "boolean_type" ||
    type === "void_type" ||
    type === "array_type" ||
    type === "scoped_type_identifier" ||
    type === "dimensions";
}

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
