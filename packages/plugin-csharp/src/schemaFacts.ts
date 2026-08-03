import type {
  FactExtractorPlugin,
  PluginFileView,
  PluginHttpEndpointFact,
  PluginPostExtractContext,
  PluginCanonicalTypeExpression,
  PluginSchemaFact,
  PluginSchemaField,
  PluginSymbolView,
  PluginTypeExpression
} from "@repohelix/plugin-sdk";
import { csharpParseBufferSize } from "./parseBuffer.js";

type Point = { row: number; column: number };
type SyntaxNode = {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: Point;
  endPosition: Point;
  namedChildren: SyntaxNode[];
  parent: SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  hasError?: boolean;
};
type Tree = { rootNode: SyntaxNode };
type ParserInstance = { setLanguage(language: unknown): void; parse(source: string, oldTree?: Tree, options?: { bufferSize?: number }): Tree };
type ParserConstructor = new () => ParserInstance;

type Candidate = {
  file: PluginFileView;
  node: SyntaxNode;
  name: string;
  qualifiedName: string;
  resolutionScopeId: string;
  fields: PluginSchemaField[];
  sourceSymbolId?: string;
  reasons: string[];
};

const DECLARATIONS = new Set(["record_declaration", "class_declaration", "struct_declaration"]);
const TYPE_ATTRIBUTES = new Set(["DataContract", "JsonSerializable", "Serializable", "JsonObject", "MessagePackObject"]);
const SERIALIZED_MEMBER_ATTRIBUTES = new Set(["JsonPropertyName", "JsonInclude", "JsonRequired", "DataMember"]);
const REQUIRED_ATTRIBUTES = new Set(["JsonRequired", "Required"]);
const COLLECTIONS = new Set(["IEnumerable", "ICollection", "IList", "IReadOnlyCollection", "IReadOnlyList", "List", "Collection", "HashSet", "ISet"]);
const DICTIONARIES = new Set(["Dictionary", "IDictionary", "IReadOnlyDictionary", "SortedDictionary"]);
const PRIMITIVES: Record<string, string> = {
  string: "string", char: "string", bool: "boolean", byte: "integer", sbyte: "integer", short: "integer",
  ushort: "integer", int: "integer", uint: "integer", long: "integer", ulong: "integer", float: "number",
  double: "number", decimal: "number", object: "object", Guid: "string", DateTime: "string", DateTimeOffset: "string",
  TimeSpan: "string", Uri: "string", dynamic: "object", "System.String": "string", "System.Char": "string",
  "System.Boolean": "boolean", "System.Byte": "integer", "System.SByte": "integer", "System.Int16": "integer",
  "System.UInt16": "integer", "System.Int32": "integer", "System.UInt32": "integer", "System.Int64": "integer",
  "System.UInt64": "integer", "System.Single": "number", "System.Double": "number", "System.Decimal": "number",
  "System.Object": "object", "System.Guid": "string", "System.DateTime": "string", "System.DateTimeOffset": "string"
};

function moduleDefault(value: unknown): unknown {
  return value && typeof value === "object" && "default" in value ? (value as { default: unknown }).default : value;
}

let parserPromise: Promise<ParserInstance> | undefined;
async function parser(): Promise<ParserInstance> {
  if (!parserPromise) parserPromise = Promise.all([import("tree-sitter"), import("tree-sitter-c-sharp")]).then(([parserModule, grammarModule]) => {
    const Parser = moduleDefault(parserModule) as ParserConstructor;
    const value = new Parser();
    value.setLanguage(moduleDefault(grammarModule));
    return value;
  });
  try { return await parserPromise; } catch (error) { parserPromise = undefined; throw error; }
}

function line(node: SyntaxNode): number { return node.startPosition.row + 1; }
function name(node: SyntaxNode): string | undefined { return node.childForFieldName("name")?.text; }
function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}
function containsType(node: SyntaxNode, type: string): boolean {
  if (node.type === type) return true;
  return node.namedChildren.some((child) => containsType(child, type));
}
function attributes(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === "attribute_list")
    .flatMap((list) => list.namedChildren.filter((child) => child.type === "attribute"));
}
function attributeName(node: SyntaxNode): string {
  return (node.namedChildren[0]?.text ?? "").replace(/^.*\./, "").replace(/Attribute$/, "");
}
function attributeString(node: SyntaxNode): string | undefined {
  const argument = node.namedChildren.find((child) => child.type === "attribute_argument_list")?.namedChildren[0];
  const value = argument?.namedChildren.at(-1) ?? argument;
  if (!value || !value.text.startsWith("\"") || !value.text.endsWith("\"")) return undefined;
  try { return JSON.parse(value.text) as string; } catch { return undefined; }
}
function namedAttributeValue(node: SyntaxNode, requested: string): string | undefined {
  const argumentsNode = node.namedChildren.find((child) => child.type === "attribute_argument_list");
  for (const argument of argumentsNode?.namedChildren ?? []) {
    const expression = argument.namedChildren[0] ?? argument;
    const parts = expression.type === "assignment_expression" || expression.type === "name_equals"
      ? expression.namedChildren : argument.namedChildren;
    if (parts[0]?.text === requested && parts.at(-1)) return parts.at(-1)!.text;
    const prefix = `${requested} =`;
    if (argument.text.trimStart().startsWith(prefix)) return argument.text.slice(argument.text.indexOf("=") + 1).trim();
  }
  return undefined;
}
function namedAttributeString(node: SyntaxNode, requested: string): string | undefined {
  const raw = namedAttributeValue(node, requested);
  if (!raw?.startsWith("\"") || !raw.endsWith("\"")) return undefined;
  try { return JSON.parse(raw) as string; } catch { return undefined; }
}
function hasModifier(node: SyntaxNode, modifier: string): boolean {
  return node.namedChildren.some((child) => child.type === "modifier" && child.text === modifier);
}
function hasDefaultAfter(node: SyntaxNode, boundary: SyntaxNode | undefined): boolean {
  if (!boundary) return containsType(node, "equals_value_clause");
  return node.text.slice(boundary.endIndex - node.startIndex).trimStart().startsWith("=");
}
function typeChild(node: SyntaxNode): SyntaxNode | undefined {
  const nameNode = node.childForFieldName("name");
  return node.namedChildren.find((child) => child !== nameNode && child.type !== "attribute_list" && child.type !== "modifier"
    && child.type !== "accessor_list" && child.type !== "equals_value_clause" && child.type !== "variable_declaration");
}

function splitGeneric(value: string): { base: string; args: string[] } | undefined {
  const start = value.indexOf("<");
  if (start < 0 || !value.endsWith(">")) return undefined;
  const args: string[] = [];
  let depth = 0;
  let begin = start + 1;
  for (let index = start + 1; index < value.length - 1; index++) {
    const char = value[index];
    if (char === "<") depth++;
    else if (char === ">") depth--;
    else if (char === "," && depth === 0) { args.push(value.slice(begin, index).trim()); begin = index + 1; }
  }
  args.push(value.slice(begin, -1).trim());
  return { base: value.slice(0, start).trim().replace(/^global::/, ""), args };
}

function normalizeType(raw: string, file?: PluginFileView, declaredCanonicalNames: ReadonlySet<string> = new Set()): { type: string; nullable: boolean } {
  let value = raw.trim().replace(/\s+/g, " ").replace(/^global::/, "");
  let nullable = false;
  if (value.endsWith("?")) { nullable = true; value = value.slice(0, -1).trim(); }
  const array = value.match(/\[[,\s]*\]$/);
  if (array) {
    return { type: `array<${nestedType(value.slice(0, -array[0].length))}>`, nullable };
  }
  const generic = splitGeneric(value);
  if (generic) {
    const base = generic.base.replace(/^.*\./, "");
    if (base === "Nullable" && generic.args[0]) {
      const inner = normalizeType(generic.args[0], file, declaredCanonicalNames);
      return { type: inner.type, nullable: true };
    }
    const userType = file && endpointReferenceCandidates(generic.base, file, declaredCanonicalNames)
      .some((candidate) => declaredCanonicalNames.has(candidate));
    if (!userType && COLLECTIONS.has(base) && generic.args[0]) {
      return { type: `array<${nestedType(generic.args[0], file, declaredCanonicalNames)}>`, nullable };
    }
    if (!userType && DICTIONARIES.has(base) && generic.args.length === 2) {
      return {
        type: `dictionary<${nestedType(generic.args[0]!, file, declaredCanonicalNames)},${nestedType(generic.args[1]!, file, declaredCanonicalNames)}>`,
        nullable
      };
    }
    return { type: `${generic.base}<${generic.args.map((argument) => nestedType(argument, file, declaredCanonicalNames)).join(",")}>`, nullable };
  }
  return { type: PRIMITIVES[value] ?? value, nullable };
}

function nestedType(raw: string, file?: PluginFileView, declaredCanonicalNames: ReadonlySet<string> = new Set()): string {
  const normalized = normalizeType(raw, file, declaredCanonicalNames);
  return `${normalized.type}${normalized.nullable ? "?" : ""}`;
}

function serializedName(node: SyntaxNode, fallback: string): string {
  const attrs = attributes(node);
  const json = attrs.find((attribute) => attributeName(attribute) === "JsonPropertyName");
  const data = attrs.find((attribute) => attributeName(attribute) === "DataMember");
  return (json && attributeString(json)) || (data && (namedAttributeString(data, "Name") ?? attributeString(data))) || fallback;
}

function fieldFor(
  node: SyntaxNode,
  file: PluginFileView,
  fieldName: string,
  rawType: string,
  defaulted: boolean,
  declaredCanonicalNames: ReadonlySet<string>
): PluginSchemaField | undefined {
  const attrs = attributes(node);
  if (attrs.some((attribute) => {
    const attrName = attributeName(attribute);
    if (attrName === "IgnoreDataMember") return true;
    if (attrName !== "JsonIgnore") return false;
    const condition = namedAttributeValue(attribute, "Condition")?.replace(/^.*\./, "");
    return condition === undefined || condition === "Always";
  })) return undefined;
  const normalized = normalizeType(rawType, file, declaredCanonicalNames);
  const required = hasModifier(node, "required") || attrs.some((attribute) => REQUIRED_ATTRIBUTES.has(attributeName(attribute))
    || attributeName(attribute) === "DataMember" && namedAttributeValue(attribute, "IsRequired") === "true");
  const typeExpression = pluginTypeExpression(normalized.type);
  const canonical = canonicalPluginType(typeExpression);
  return {
    sourceName: fieldName,
    serializedName: serializedName(node, fieldName),
    type: canonical
      ? { kind: "resolved", expression: canonical }
      : { kind: "unresolved", normalizedExpression: typeExpression, diagnosticId: `schema-diagnostic:csharp:${file.repoId}:${file.path}:${fieldName}:${normalized.type}` },
    optional: !required && (defaulted || normalized.nullable),
    nullable: normalized.nullable,
    sourceLocation: { fileId: file.fileId, line: line(node) }
  };
}

function pluginTypeExpression(value: string): PluginTypeExpression {
  const generic = splitGeneric(value);
  if (generic) {
    if (generic.base === "array" && generic.args[0]) return { kind: "array", element: pluginTypeExpression(generic.args[0]) };
    if (generic.base === "dictionary" && generic.args[0] && generic.args[1]) {
      return { kind: "map", key: pluginTypeExpression(generic.args[0]), value: pluginTypeExpression(generic.args[1]) };
    }
    return {
      kind: "application",
      target: { kind: "reference", name: generic.base },
      arguments: generic.args.map(pluginTypeExpression)
    };
  }
  return value.endsWith("?")
    ? { kind: "nullable", inner: pluginTypeExpression(value.slice(0, -1)) }
    : { kind: "reference", name: value };
}

function canonicalPluginType(expression: PluginTypeExpression): PluginCanonicalTypeExpression | undefined {
  if (expression.kind === "reference") {
    return new Set(Object.values(PRIMITIVES)).has(expression.name) || ["string", "boolean", "integer", "number", "object"].includes(expression.name)
      ? { kind: "scalar", name: expression.name }
      : undefined;
  }
  if (expression.kind === "array") {
    const element = canonicalPluginType(expression.element);
    return element ? { kind: "array", element } : undefined;
  }
  if (expression.kind === "map") {
    const key = canonicalPluginType(expression.key);
    const value = canonicalPluginType(expression.value);
    return key && value ? { kind: "map", key, value } : undefined;
  }
  if (expression.kind === "nullable") {
    const inner = canonicalPluginType(expression.inner);
    return inner ? { kind: "nullable", inner } : undefined;
  }
  return undefined;
}

function fields(node: SyntaxNode, file: PluginFileView, declaredCanonicalNames: ReadonlySet<string>): PluginSchemaField[] {
  const result: PluginSchemaField[] = [];
  const parameters = node.namedChildren.find((child) => child.type === "parameter_list");
  for (const parameter of parameters?.namedChildren ?? []) {
    if (parameter.type !== "parameter") continue;
    const parameterName = name(parameter);
    const type = typeChild(parameter);
    if (parameterName && type) {
      const field = fieldFor(parameter, file, parameterName, type.text, hasDefaultAfter(parameter, parameter.childForFieldName("name") ?? undefined), declaredCanonicalNames);
      if (field) result.push(field);
    }
  }
  const body = node.namedChildren.find((child) => child.type === "declaration_list");
  for (const member of body?.namedChildren ?? []) {
    if (member.type === "property_declaration" && hasModifier(member, "public") && !hasModifier(member, "static")) {
      const memberName = name(member);
      const type = typeChild(member);
      const accessor = member.namedChildren.find((child) => child.type === "accessor_list");
      const getter = accessor?.namedChildren.find((child) => /\bget\b/.test(child.text));
      if (!memberName || !type || !accessor || !getter
        || getter.namedChildren.some((child) => child.type === "modifier" && ["private", "protected", "internal"].includes(child.text))) continue;
      const field = fieldFor(member, file, memberName, type.text, hasDefaultAfter(member, accessor), declaredCanonicalNames);
      if (field) result.push(field);
    }
    if (member.type === "field_declaration" && hasModifier(member, "public") && !hasModifier(member, "static")) {
      const attrs = attributes(member);
      if (!attrs.some((attribute) => SERIALIZED_MEMBER_ATTRIBUTES.has(attributeName(attribute)))) continue;
      const declaration = member.namedChildren.find((child) => child.type === "variable_declaration");
      const type = declaration?.namedChildren[0];
      for (const variable of declaration?.namedChildren.filter((child) => child.type === "variable_declarator") ?? []) {
        const memberName = name(variable) ?? variable.namedChildren[0]?.text;
        if (!memberName || !type) continue;
        const field = fieldFor(member, file, memberName, type.text, hasDefaultAfter(variable, variable.childForFieldName("name") ?? variable.namedChildren[0]), declaredCanonicalNames);
        if (field) result.push(field);
      }
    }
  }
  const seen = new Set<string>();
  return result.sort((a, b) => (a.sourceLocation.line ?? 0) - (b.sourceLocation.line ?? 0))
    .filter((field) => !seen.has(field.serializedName) && Boolean(seen.add(field.serializedName)));
}

function namespaceOf(node: SyntaxNode, fileNamespace: string): string {
  const parts: string[] = [];
  let current = node.parent;
  while (current) {
    if (current.type === "namespace_declaration" || current.type === "file_scoped_namespace_declaration") {
      const value = current.childForFieldName("name")?.text;
      if (value) parts.unshift(value);
    } else if (DECLARATIONS.has(current.type)) {
      const value = name(current);
      if (value) parts.unshift(value);
    }
    current = current.parent;
  }
  return [fileNamespace, ...parts].filter(Boolean).join(".");
}

function namespaceScopeOf(node: SyntaxNode, fileNamespace: string): string {
  const parts: string[] = [];
  let current = node.parent;
  while (current) {
    if (current.type === "namespace_declaration" || current.type === "file_scoped_namespace_declaration") {
      const value = current.childForFieldName("name")?.text;
      if (value) parts.unshift(value);
    }
    current = current.parent;
  }
  const namespace = parts.length > 0 ? parts.join(".") : fileNamespace;
  return `namespace:${namespace || "<global>"}`;
}

function referencedNames(raw: string | undefined): Set<string> {
  const result = new Set<string>();
  if (!raw) return result;
  const visit = (value: string): void => {
    let clean = value.trim().replace(/\?$/, "").replace(/^global::/, "");
    while (clean.endsWith("[]")) clean = clean.slice(0, -2);
    const generic = splitGeneric(clean);
    if (generic) {
      for (const arg of generic.args) visit(arg);
      if (!(generic.base in PRIMITIVES)) result.add(generic.base);
      return;
    }
    if (!(clean in PRIMITIVES)) result.add(clean);
  };
  visit(raw);
  return result;
}

function sourceNamespace(source: string | undefined): string | undefined {
  return source?.match(/^\s*namespace\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:;|\{)/mu)?.[1];
}

function endpointReferenceCandidates(
  reference: string,
  file: PluginFileView | undefined,
  declaredCanonicalNames: ReadonlySet<string>
): string[] {
  const clean = reference.replace(/^global::/u, "");
  if (!file) return [clean];
  for (const imported of file.imports) {
    if (imported.importKind !== "alias" || !imported.alias) continue;
    if (clean === imported.alias) return [imported.module];
    if (clean.startsWith(`${imported.alias}.`)) return [`${imported.module}${clean.slice(imported.alias.length)}`];
  }
  if (clean.includes(".")) return [clean];
  const namespace = sourceNamespace(file.source);
  const local = namespace ? `${namespace}.${clean}` : clean;
  if (declaredCanonicalNames.has(local)) return [local];
  const imported = file.imports.flatMap((item) => {
    if (item.importKind === "namespace") return [`${item.module}.${clean}`];
    if (item.importKind === "static") return [`${item.module}.${clean}`];
    return [];
  }).filter((candidate) => declaredCanonicalNames.has(candidate));
  if (imported.length > 0) return [...new Set(imported)].sort();
  return [local];
}

function expressionReferences(expression: PluginTypeExpression): string[] {
  switch (expression.kind) {
    case "reference": return [expression.name];
    case "application": return [...expressionReferences(expression.target), ...expression.arguments.flatMap(expressionReferences)];
    case "array": return expressionReferences(expression.element);
    case "map": return [...expressionReferences(expression.key), ...expressionReferences(expression.value)];
    case "union":
    case "intersection": return expression.members.flatMap(expressionReferences);
    case "nullable": return expressionReferences(expression.inner);
    case "wildcard": return expression.type ? expressionReferences(expression.type) : [];
    case "variable":
    case "literal":
    case "opaque": return [];
  }
}

function candidateFieldReferences(candidate: Candidate): string[] {
  return candidate.fields.flatMap((field) => field.type.kind === "resolved" ? [] : expressionReferences(field.type.normalizedExpression));
}

function symbolId(symbols: readonly PluginSymbolView[], node: SyntaxNode, declarationName: string): string | undefined {
  return symbols.find((symbol) => symbol.name === declarationName && symbol.startLine === line(node))?.id;
}

async function candidates(file: PluginFileView, endpointRefs: Set<string>, declaredCanonicalNames: ReadonlySet<string>): Promise<Candidate[]> {
  if (!file.source) return [];
  const root = (await parser()).parse(file.source, undefined, { bufferSize: csharpParseBufferSize(file.source) }).rootNode;
  const fileNamespace = root.namedChildren.find((child) => child.type === "file_scoped_namespace_declaration")
    ?.childForFieldName("name")?.text ?? "";
  const result: Candidate[] = [];
  walk(root, (node) => {
    if (!DECLARATIONS.has(node.type) || node.hasError) return;
    const declarationName = name(node);
    if (!declarationName) return;
    const qualifiedName = [namespaceOf(node, fileNamespace), declarationName].filter(Boolean).join(".");
    const attrNames = attributes(node).map(attributeName);
    const reasons: string[] = [];
    if (endpointRefs.has(declarationName) || endpointRefs.has(qualifiedName)) reasons.push("http-body-type");
    if (attrNames.some((attribute) => TYPE_ATTRIBUTES.has(attribute))) reasons.push("serialization-attribute");
    result.push({ file, node, name: declarationName, qualifiedName, resolutionScopeId: namespaceScopeOf(node, fileNamespace), fields: fields(node, file, declaredCanonicalNames),
      sourceSymbolId: symbolId(file.symbols, node, declarationName), reasons });
  });
  return result;
}

function factKey(fact: Omit<PluginSchemaFact, "kind">): string {
  return [fact.repoId, fact.filePath, fact.declaration.canonicalName, fact.sourceSymbolId ?? "", JSON.stringify(fact.shape)].join("\0");
}

export const csharpSchemaExtractor: FactExtractorPlugin = {
  name: "csharp-schema",
  languages: ["csharp"],
  extract(): void {},
  async postExtract(context: PluginPostExtractContext): Promise<void> {
    const refsByRepo = new Map<string, Set<string>>();
    const declarationsByRepo = new Map<string, Set<string>>();
    for (const file of context.files.all()) {
      for (const symbol of file.symbols) {
        if (!DECLARATIONS.has(`${symbol.kind}_declaration`)) continue;
        const names = declarationsByRepo.get(file.repoId) ?? new Set<string>();
        names.add(symbol.qualifiedName);
        declarationsByRepo.set(file.repoId, names);
      }
    }
    for (const endpoint of context.facts.httpEndpoints()) {
      const refs = refsByRepo.get(endpoint.repoId) ?? new Set<string>();
      const file = context.files.get(endpoint.repoId, endpoint.filePath);
      const declarations = declarationsByRepo.get(endpoint.repoId) ?? new Set<string>();
      for (const value of [endpoint.requestBodyType, endpoint.responseBodyType]) {
        for (const ref of referencedNames(value)) {
          for (const candidate of endpointReferenceCandidates(ref, file, declarations)) refs.add(candidate);
        }
      }
      refsByRepo.set(endpoint.repoId, refs);
    }
    const found: Candidate[] = [];
    for (const file of [...context.files.byLanguage("csharp")].sort((a, b) => a.path.localeCompare(b.path))) {
      try {
        found.push(...await candidates(file, refsByRepo.get(file.repoId) ?? new Set(), declarationsByRepo.get(file.repoId) ?? new Set()));
      } catch { /* One malformed or unparsable file must not suppress other schema facts. */ }
    }
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const source of found.filter((candidate) => candidate.reasons.length > 0)) {
        const declarations = declarationsByRepo.get(source.file.repoId) ?? new Set<string>();
        const referenced = new Set(candidateFieldReferences(source)
          .flatMap((reference) => endpointReferenceCandidates(reference, source.file, declarations)));
        for (const target of found) {
          if (target.file.repoId !== source.file.repoId || !referenced.has(target.qualifiedName)
            || target.reasons.includes("schema-field-type")) continue;
          target.reasons.push("schema-field-type");
          expanded = true;
        }
      }
    }
    const grouped = new Map<string, Candidate[]>();
    for (const candidate of found) {
      if (candidate.reasons.length === 0) continue;
      const key = `${candidate.file.repoId}\0${candidate.qualifiedName}`;
      grouped.set(key, [...grouped.get(key) ?? [], candidate]);
    }
    const facts: Array<Omit<PluginSchemaFact, "kind">> = [];
    for (const declarations of grouped.values()) {
      declarations.sort((a, b) => a.file.path.localeCompare(b.file.path) || line(a.node) - line(b.node));
      const primary = declarations[0]!;
      const refs = refsByRepo.get(primary.file.repoId) ?? new Set<string>();
      const schemaName = refs.has(primary.qualifiedName) ? primary.qualifiedName : primary.name;
      const reasons = [...new Set(declarations.flatMap((candidate) => candidate.reasons))].sort();
      const mergedFields = declarations.flatMap((candidate) => candidate.fields);
      const fieldNames = new Set<string>();
      facts.push({ repoId: primary.file.repoId, filePath: primary.file.path,
        declaration: { languageId: "csharp", repoId: primary.file.repoId, resolutionScopeId: primary.resolutionScopeId, canonicalName: primary.qualifiedName },
        displayName: schemaName,
        shape: { kind: "object", fields: mergedFields.filter((field) => !fieldNames.has(field.serializedName) && Boolean(fieldNames.add(field.serializedName))) },
        sourceSymbolId: primary.sourceSymbolId,
        evidence: { filePath: primary.file.path, line: line(primary.node), raw: primary.node.text,
          rule: `csharp-schema:${reasons.join("+")}`, confidence: "exact" } });
    }
    const seen = new Set<string>();
    facts.sort((a, b) => factKey(a).localeCompare(factKey(b)));
    for (const fact of facts) if (!seen.has(factKey(fact))) { seen.add(factKey(fact)); context.emit.schema(fact); }
  }
};
