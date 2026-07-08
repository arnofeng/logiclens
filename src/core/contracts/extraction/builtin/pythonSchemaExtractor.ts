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
  parsedCodeFiles,
  pushContractEvidence,
  pushContractSpec,
  toBusinessEntityName, } from "./shared.js";
import {
  parseSourceAst,
  walkSourceAst
} from "./sourceAstUtils.js";
import { entityId } from "../../../../shared/path.js";

/**
 * Python Schema Extractor extracts field-level schema information from:
 *  - @dataclass decorated classes
 *  - TypedDict subclasses
 *  - NamedTuple subclasses
 *
 * Field extraction works by walking the class body for annotated assignments
 * (`identifier: type`), which is the common pattern across all three forms.
 * Default-followed-by-type annotations (`DEBUG: bool = True`) are also handled.
 */

/** Decorator names that mark a class as a data-bearing type. */
const SCHEMA_DECORATORS = new Set(["dataclass", "dataclasses.dataclass"]);

/** Base-class names that mark a class as a schema. */
const SCHEMA_BASES = new Set(["TypedDict", "NamedTuple"]);

export const pythonSchemaExtractor = compatExtractor({
  name: "builtin:python-schema",
  languages: ["python"],
  extract(context, collector: FactCollector) {

    for (const file of parsedCodeFiles(context.parsedFiles)) {
      if (file.language !== "python") continue;

      for (const symbol of file.symbols) {
        if (symbol.kind !== "class") continue;

        const sharedKind = classifySharedContract(symbol.name, symbol.kind);
        if (sharedKind !== "schema" && sharedKind !== "dto") continue;

        const ast = parseSourceAst(file, "python");
        if (!ast) continue;

        const classNode = findClassNode(ast.tree.rootNode, symbol.name, symbol.startLine);
        if (!classNode) continue;

        // Determine the schema mechanism: @dataclass, TypedDict, NamedTuple
        const hasDecorator = classHasSchemaDecorator(classNode);
        const schemaBase = classSchemaBase(classNode);

        // Only process classes that use a recognised schema mechanism
        if (!hasDecorator && !schemaBase) continue;

        const fields = extractClassFields(classNode, file);
        if (fields.length === 0) continue;

        const schemaSpec: SchemaSpec = {
          kind: "schema",
          name: symbol.name,
          language: "python",
          fields
        };

        const schemaContract = contract(sharedKind, symbol.name, `${sharedKind.toUpperCase()} ${symbol.name}`);
        const evidenceNode = evidence({
          repoId: file.repoId,
          fileId: file.fileId,
          filePath: file.path,
          line: symbol.startLine,
          raw: symbol.signature,
          rule: "python-schema-fields",
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
          framework: schemaBase ? `python-${schemaBase.toLowerCase()}` : "python-dataclass",
          version: undefined
        });

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

        // For each user-defined base class, emit a USES_SCHEMA placeholder so
        // impact analysis can traverse from the derived class to its parent.
        // The schema-marker bases (TypedDict/NamedTuple) and `object` are
        // excluded they are mechanism markers, not data-bearing schemas.
        // The placeholder is resolved by schemaResolver once the full batch is
        // available (mirrors the Java `extends` / TS utility-type handling).
        for (const base of extractBaseClasses(classNode)) {
          collector.addSemanticRelation({
            fromSpecId: `spec:${schemaContract.id}:pending`,
            toSpecId: `schema-ref:${base}`,
            kind: "USES_SCHEMA",
            evidenceId: evidenceNode.id,
            reason: `Python class inherits ${base}`,
            confidence: confidenceFor("heuristic-generic-type-param")
          });
        }
      }
    }

  }
});

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
    // Python classes can be wrapped in decorated_definition
    if (node.type === "decorated_definition") {
      const classNode = node.namedChildren.find((c) => c.type === "class_definition");
      if (classNode && className(classNode) === name && node.startPosition.row + 1 === startLine) {
        found = node;
        return;
      }
    }
    if (node.type !== "class_definition") return;
    if (className(node) !== name) return;
    if (node.startPosition.row + 1 === startLine) found = node;
  });
  return found;
}

function className(node: Parser.SyntaxNode): string | undefined {
  const nameNode = node.childForFieldName("name");
  return nameNode?.text;
}

/** Checks whether a decorated_definition or class_definition carries a @dataclass decorator. */
function classHasSchemaDecorator(node: Parser.SyntaxNode): boolean {
  // For @dataclass, the class_definition is wrapped in decorated_definition
  const wrapper = node.type === "decorated_definition" ? node : node.parent;
  if (wrapper?.type !== "decorated_definition") return false;
  for (const child of wrapper.namedChildren) {
    if (child.type !== "decorator") continue;
    const name = child.namedChildren.find((c) => c.type === "identifier" || c.type === "attribute");
    if (name && SCHEMA_DECORATORS.has(name.text)) return true;
  }
  return false;
}

/**
 * Extracts the names of user-defined base classes from a class definition,
 * excluding schema-mechanism markers (TypedDict/NamedTuple) and `object`.
 * Dotted bases (`pkg.Base`) are reduced to their last component so they match
 * the simple schema names indexed by the resolver. Keyword arguments
 * (`total=False`, `metaclass=...`) and parametrised bases (`Generic[T]`) are
 * ignored.
 */
function extractBaseClasses(node: Parser.SyntaxNode): string[] {
  const innerClass = node.type === "decorated_definition"
    ? node.namedChildren.find((c) => c.type === "class_definition")
    : node;
  if (!innerClass) return [];
  const argList = innerClass.namedChildren.find((c) => c.type === "argument_list");
  if (!argList) return [];

  const bases: string[] = [];
  for (const child of argList.namedChildren) {
    let name: string | undefined;
    if (child.type === "identifier") {
      name = child.text;
    } else if (child.type === "attribute") {
      const parts = child.text.split(".");
      name = parts[parts.length - 1];
    }
    if (!name) continue;
    if (SCHEMA_BASES.has(name) || name === "object") continue;
    bases.push(name);
  }
  return bases;
}

/** Checks whether a class inherits from TypedDict or NamedTuple. */
function classSchemaBase(node: Parser.SyntaxNode): string | undefined {
  const innerClass = node.type === "decorated_definition"
    ? node.namedChildren.find((c) => c.type === "class_definition")
    : node;
  if (!innerClass) return undefined;
  const argList = innerClass.namedChildren.find((c) => c.type === "argument_list");
  if (!argList) return undefined;
  for (const child of argList.namedChildren) {
    if (child.type === "identifier" && SCHEMA_BASES.has(child.text)) return child.text;
  }
  return undefined;
}

/** Extracts typed field specs from a class body. */
function extractClassFields(
  classNode: Parser.SyntaxNode,
  _file: ParsedFile
): SchemaFieldSpec[] {
  const innerClass = classNode.type === "decorated_definition"
    ? classNode.namedChildren.find((c) => c.type === "class_definition")
    : classNode;
  if (!innerClass) return [];

  const block = innerClass.namedChildren.find((c) => c.type === "block");
  if (!block) return [];

  const fields: SchemaFieldSpec[] = [];
  for (const stmt of block.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const assignment = stmt.namedChildren.find((c) => c.type === "assignment");
    if (!assignment) continue;

    const field = parseFieldAssignment(assignment);
    if (field) fields.push(field);
  }

  return fields;
}

/** Parses an `assignment` node like `name: type` or `name: type = default`. */
function parseFieldAssignment(node: Parser.SyntaxNode): SchemaFieldSpec | undefined {
  // The identifier (field name) is the first named child
  const nameNode = node.namedChildren.find((c) => c.type === "identifier");
  if (!nameNode) return undefined;
  const name = nameNode.text;

  // tree-sitter-python wraps the type annotation in a "type" field.
  // e.g. `sku: str` assignment(identifier "sku", type(identifier "str"))
  const typeWrapper = node.childForFieldName("type");
  const innerTypeNode = typeWrapper ? typeWrapper.namedChild(0) : undefined;
  const rawType = innerTypeNode ? pythonTypeText(innerTypeNode) : "Any";

  // Check optional (has default = None).
  // In tree-sitter-python, `=` is an anonymous token, so the named children
  // are `identifier`, `type(...)`, and optionally `none` at the end.
  const lastChild = node.namedChild(node.namedChildCount - 1);
  const hasDefaultNone = lastChild?.type === "none";

  const normalized = normalizePrimitiveType("python", rawType);

  return {
    name,
    type: normalized,
    optional: hasDefaultNone,
    nullable: normalized.endsWith("?") ? true : undefined,
    sourceLine: node.startPosition.row + 1
  };
}

/**
 * Returns a source-text representation of a Python type node, handling
 * generic_type (Optional[str], list[int]), identifiers, and subscript.
 */
function pythonTypeText(node: Parser.SyntaxNode): string {
  if (node.type === "generic_type") {
    // generic_type: identifier + type_parameter
    const name = node.namedChildren.find((c) => c.type === "identifier");
    const param = node.namedChildren.find((c) => c.type === "type_parameter");
    const base = name?.text ?? node.text;
    if (param) {
      const innerType = param.namedChildren.find((c) => c.type !== "[" && c.type !== "]");
      const inner = innerType ? pythonTypeText(innerType) : param.text.replace(/^\[|\]$/g, "");
      return `${base}[${inner}]`;
    }
    return base;
  }
  if (node.type === "attribute") {
    return node.text; // e.g. datetime.datetime
  }
  return node.text;
}
