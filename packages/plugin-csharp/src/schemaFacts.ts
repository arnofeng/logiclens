import type {
  FactExtractorPlugin,
  PluginFileView,
  PluginHttpEndpointFact,
  PluginPostExtractContext,
  PluginSchemaFact,
  PluginSchemaField,
  PluginSymbolView
} from "@logiclens/plugin-sdk";

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
type ParserInstance = { setLanguage(language: unknown): void; parse(source: string): Tree };
type ParserConstructor = new () => ParserInstance;

type Candidate = {
  file: PluginFileView;
  node: SyntaxNode;
  name: string;
  qualifiedName: string;
  fields: PluginSchemaField[];
  sourceSymbolId?: string;
  reasons: string[];
};

const DECLARATIONS = new Set(["record_declaration", "class_declaration", "struct_declaration"]);
const NAME_SUFFIX = /(?:DTO|Dto|Request|Response|Payload|Contract|Model)$/;
const TYPE_ATTRIBUTES = new Set(["DataContract", "JsonSerializable", "Serializable", "JsonObject", "MessagePackObject"]);
const SERIALIZED_MEMBER_ATTRIBUTES = new Set(["JsonPropertyName", "JsonInclude", "JsonRequired", "DataMember"]);
const REQUIRED_ATTRIBUTES = new Set(["JsonRequired", "Required"]);
const COLLECTIONS = new Set(["IEnumerable", "ICollection", "IList", "IReadOnlyCollection", "IReadOnlyList", "List", "Collection", "HashSet", "ISet"]);
const DICTIONARIES = new Set(["Dictionary", "IDictionary", "IReadOnlyDictionary", "SortedDictionary"]);
const WRAPPERS = new Set(["Task", "ValueTask", "ActionResult", "Results", "Ok", "Created", "ObjectResult"]);
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

function normalizeType(raw: string): { type: string; nullable: boolean } {
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
      const inner = normalizeType(generic.args[0]);
      return { type: inner.type, nullable: true };
    }
    if (COLLECTIONS.has(base) && generic.args[0]) return { type: `array<${nestedType(generic.args[0])}>`, nullable };
    if (DICTIONARIES.has(base) && generic.args.length === 2) {
      return { type: `dictionary<${nestedType(generic.args[0]!)},${nestedType(generic.args[1]!)}>`, nullable };
    }
    return { type: `${generic.base}<${generic.args.map(nestedType).join(",")}>`, nullable };
  }
  return { type: PRIMITIVES[value] ?? value, nullable };
}

function nestedType(raw: string): string {
  const normalized = normalizeType(raw);
  return `${normalized.type}${normalized.nullable ? "?" : ""}`;
}

function serializedName(node: SyntaxNode, fallback: string): string {
  const attrs = attributes(node);
  const json = attrs.find((attribute) => attributeName(attribute) === "JsonPropertyName");
  const data = attrs.find((attribute) => attributeName(attribute) === "DataMember");
  return (json && attributeString(json)) || (data && (namedAttributeString(data, "Name") ?? attributeString(data))) || fallback;
}

function fieldFor(node: SyntaxNode, fieldName: string, rawType: string, defaulted: boolean): PluginSchemaField | undefined {
  const attrs = attributes(node);
  if (attrs.some((attribute) => {
    const attrName = attributeName(attribute);
    if (attrName === "IgnoreDataMember") return true;
    if (attrName !== "JsonIgnore") return false;
    const condition = namedAttributeValue(attribute, "Condition")?.replace(/^.*\./, "");
    return condition === undefined || condition === "Always";
  })) return undefined;
  const normalized = normalizeType(rawType);
  const required = hasModifier(node, "required") || attrs.some((attribute) => REQUIRED_ATTRIBUTES.has(attributeName(attribute))
    || attributeName(attribute) === "DataMember" && namedAttributeValue(attribute, "IsRequired") === "true");
  return {
    name: serializedName(node, fieldName),
    type: normalized.type,
    optional: !required && (defaulted || normalized.nullable),
    nullable: normalized.nullable,
    sourceLine: line(node)
  };
}

function fields(node: SyntaxNode): PluginSchemaField[] {
  const result: PluginSchemaField[] = [];
  const parameters = node.namedChildren.find((child) => child.type === "parameter_list");
  for (const parameter of parameters?.namedChildren ?? []) {
    if (parameter.type !== "parameter") continue;
    const parameterName = name(parameter);
    const type = typeChild(parameter);
    if (parameterName && type) {
      const field = fieldFor(parameter, parameterName, type.text, hasDefaultAfter(parameter, parameter.childForFieldName("name") ?? undefined));
      if (field) result.push(field);
    }
  }
  const body = node.namedChildren.find((child) => child.type === "declaration_list");
  for (const member of body?.namedChildren ?? []) {
    if (member.type === "property_declaration" && hasModifier(member, "public")) {
      const memberName = name(member);
      const type = typeChild(member);
      const accessor = member.namedChildren.find((child) => child.type === "accessor_list");
      const getter = accessor?.namedChildren.find((child) => /\bget\b/.test(child.text));
      if (!memberName || !type || !accessor || !getter
        || getter.namedChildren.some((child) => child.type === "modifier" && ["private", "protected", "internal"].includes(child.text))) continue;
      const field = fieldFor(member, memberName, type.text, hasDefaultAfter(member, accessor));
      if (field) result.push(field);
    }
    if (member.type === "field_declaration" && hasModifier(member, "public")) {
      const attrs = attributes(member);
      if (!attrs.some((attribute) => SERIALIZED_MEMBER_ATTRIBUTES.has(attributeName(attribute)))) continue;
      const declaration = member.namedChildren.find((child) => child.type === "variable_declaration");
      const type = declaration?.namedChildren[0];
      for (const variable of declaration?.namedChildren.filter((child) => child.type === "variable_declarator") ?? []) {
        const memberName = name(variable) ?? variable.namedChildren[0]?.text;
        if (!memberName || !type) continue;
        const field = fieldFor(member, memberName, type.text, hasDefaultAfter(variable, variable.childForFieldName("name") ?? variable.namedChildren[0]));
        if (field) result.push(field);
      }
    }
  }
  const seen = new Set<string>();
  return result.sort((a, b) => (a.sourceLine ?? 0) - (b.sourceLine ?? 0))
    .filter((field) => !seen.has(field.name) && Boolean(seen.add(field.name)));
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

function referencedNames(raw: string | undefined): Set<string> {
  const result = new Set<string>();
  if (!raw) return result;
  const visit = (value: string): void => {
    let clean = value.trim().replace(/\?$/, "").replace(/^global::/, "");
    while (clean.endsWith("[]")) clean = clean.slice(0, -2);
    const generic = splitGeneric(clean);
    if (generic) {
      const base = generic.base.replace(/^.*\./, "");
      for (const arg of generic.args) visit(arg);
      if (!WRAPPERS.has(base) && !COLLECTIONS.has(base) && !DICTIONARIES.has(base)) result.add(clean);
      return;
    }
    if (!(clean in PRIMITIVES)) result.add(clean);
  };
  visit(raw);
  return result;
}

function symbolId(symbols: readonly PluginSymbolView[], node: SyntaxNode, declarationName: string): string | undefined {
  return symbols.find((symbol) => symbol.name === declarationName && symbol.startLine === line(node))?.id;
}

async function candidates(file: PluginFileView, endpointRefs: Set<string>): Promise<Candidate[]> {
  if (!file.source) return [];
  const root = (await parser()).parse(file.source).rootNode;
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
    if (NAME_SUFFIX.test(declarationName)) reasons.push("dto-name");
    if (!reasons.length) return;
    result.push({ file, node, name: declarationName, qualifiedName, fields: fields(node),
      sourceSymbolId: symbolId(file.symbols, node, declarationName), reasons });
  });
  return result;
}

function factKey(fact: Omit<PluginSchemaFact, "kind">): string {
  return [fact.repoId, fact.filePath, fact.name, fact.sourceSymbolId ?? "", JSON.stringify(fact.fields)].join("\0");
}

export const csharpSchemaExtractor: FactExtractorPlugin = {
  name: "csharp-schema",
  languages: ["csharp"],
  extract(): void {},
  async postExtract(context: PluginPostExtractContext): Promise<void> {
    const refsByRepo = new Map<string, Set<string>>();
    for (const endpoint of context.facts.httpEndpoints()) {
      const refs = refsByRepo.get(endpoint.repoId) ?? new Set<string>();
      for (const value of [endpoint.requestBodyType, endpoint.responseBodyType]) for (const ref of referencedNames(value)) refs.add(ref);
      refsByRepo.set(endpoint.repoId, refs);
    }
    const found: Candidate[] = [];
    for (const file of [...context.files.byLanguage("csharp")].sort((a, b) => a.path.localeCompare(b.path))) {
      try {
        found.push(...await candidates(file, refsByRepo.get(file.repoId) ?? new Set()));
      } catch { /* One malformed or unparsable file must not suppress other schema facts. */ }
    }
    const grouped = new Map<string, Candidate[]>();
    for (const candidate of found) {
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
      facts.push({ repoId: primary.file.repoId, filePath: primary.file.path, name: schemaName, language: "csharp",
        fields: mergedFields.filter((field) => !fieldNames.has(field.name) && Boolean(fieldNames.add(field.name))),
        sourceSymbolId: primary.sourceSymbolId,
        evidence: { filePath: primary.file.path, line: line(primary.node), raw: primary.node.text,
          rule: `csharp-schema:${reasons.join("+")}`, confidence: "exact" } });
    }
    const seen = new Set<string>();
    facts.sort((a, b) => factKey(a).localeCompare(factKey(b)));
    for (const fact of facts) if (!seen.has(factKey(fact))) { seen.add(factKey(fact)); context.emit.schema(fact); }
  }
};
