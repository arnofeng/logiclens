import type {
  FactExtractorPlugin,
  PluginContext,
  PluginFileView,
  PluginHttpEndpointFact,
  PluginSymbolView
} from "@logiclens/plugin-sdk";
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

type Endpoint = Omit<PluginHttpEndpointFact, "kind" | "repoId" | "filePath" | "sourceSymbolId"> & {
  symbolName?: string;
  symbolLine?: number;
};

const CONTROLLER_METHODS: Record<string, string> = {
  HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpDelete: "DELETE",
  HttpPatch: "PATCH", HttpHead: "HEAD", HttpOptions: "OPTIONS"
};
const MINIMAL_METHODS: Record<string, string> = {
  MapGet: "GET", MapPost: "POST", MapPut: "PUT", MapDelete: "DELETE", MapPatch: "PATCH"
};
const CLIENT_METHODS: Record<string, string> = {
  GetAsync: "GET", GetStringAsync: "GET", GetStreamAsync: "GET", GetByteArrayAsync: "GET",
  GetFromJsonAsync: "GET", PostAsync: "POST", PostAsJsonAsync: "POST", PutAsync: "PUT",
  PutAsJsonAsync: "PUT", PatchAsync: "PATCH", PatchAsJsonAsync: "PATCH", DeleteAsync: "DELETE"
};
const STRING_NODES = new Set(["string_literal", "verbatim_string_literal", "raw_string_literal"]);
type ConstantTable = { resolve(identifier: string, use: SyntaxNode): string | undefined };

function moduleDefault(value: unknown): unknown {
  return value && typeof value === "object" && "default" in value ? (value as { default: unknown }).default : value;
}

let parserPromise: Promise<ParserInstance> | undefined;
async function parser(): Promise<ParserInstance> {
  if (!parserPromise) {
    parserPromise = Promise.all([import("tree-sitter"), import("tree-sitter-c-sharp")]).then(([parserModule, grammarModule]) => {
      const Parser = moduleDefault(parserModule) as ParserConstructor;
      const value = new Parser();
      value.setLanguage(moduleDefault(grammarModule));
      return value;
    });
  }
  try { return await parserPromise; } catch (error) { parserPromise = undefined; throw error; }
}

function line(node: SyntaxNode): number { return node.startPosition.row + 1; }
function name(node: SyntaxNode): string | undefined { return node.childForFieldName("name")?.text; }
const BODY_WRAPPERS = new Set(["Task", "ValueTask", "ActionResult", "Ok", "Created", "ObjectResult"]);
const BODY_COLLECTIONS = new Set(["IEnumerable", "ICollection", "IList", "IReadOnlyCollection", "IReadOnlyList", "List", "Collection", "HashSet", "ISet"]);
const BODY_DICTIONARIES = new Set(["Dictionary", "IDictionary", "IReadOnlyDictionary", "SortedDictionary"]);
const EMPTY_RESULTS = new Set(["NotFound", "NoContent", "UnauthorizedHttpResult", "ForbidHttpResult", "ConflictHttpResult", "StatusCodeHttpResult", "IResult", "IActionResult"]);

function genericParts(value: string): { base: string; args: string[] } | undefined {
  const start = value.indexOf("<");
  if (start < 0 || !value.endsWith(">")) return undefined;
  const args: string[] = [];
  let depth = 0;
  let begin = start + 1;
  for (let index = start + 1; index < value.length - 1; index++) {
    if (value[index] === "<") depth++;
    else if (value[index] === ">") depth--;
    else if (value[index] === "," && depth === 0) {
      args.push(value.slice(begin, index).trim());
      begin = index + 1;
    }
  }
  args.push(value.slice(begin, -1).trim());
  return { base: value.slice(0, start).trim().replace(/^.*\./, ""), args };
}

function bodySchemaCandidates(raw: string): Set<string> {
  let value = raw.trim().replace(/^global::/, "").replace(/\?$/, "");
  while (value.endsWith("[]")) value = value.slice(0, -2).trim();
  const generic = genericParts(value);
  if (generic) {
    if (generic.base === "Results") {
      const candidates = new Set<string>();
      for (const argument of generic.args) for (const candidate of bodySchemaCandidates(argument)) candidates.add(candidate);
      return candidates;
    }
    if ((BODY_WRAPPERS.has(generic.base) || BODY_COLLECTIONS.has(generic.base)) && generic.args.length === 1) {
      return bodySchemaCandidates(generic.args[0]!);
    }
    if (BODY_DICTIONARIES.has(generic.base) && generic.args.length === 2) return bodySchemaCandidates(generic.args[1]!);
    return new Set();
  }
  const simple = value.replace(/^.*\./, "");
  return simple && !EMPTY_RESULTS.has(simple)
    && !/^(?:string|bool|byte|sbyte|short|ushort|int|uint|long|ulong|float|double|decimal|char|object)$/i.test(simple)
    ? new Set([value]) : new Set();
}

function bodySchemaType(raw: string): string | undefined {
  const candidates = [...bodySchemaCandidates(raw)];
  return candidates.length === 1 ? candidates[0] : undefined;
}
function unquote(raw: string): string | undefined {
  if (raw.startsWith("@\"") && raw.endsWith("\"")) return raw.slice(2, -1).replace(/\"\"/g, "\"");
  if (raw.startsWith("\"\"\"") && raw.endsWith("\"\"\"")) return raw.slice(3, -3).trim();
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    try { return JSON.parse(raw) as string; } catch { return undefined; }
  }
  return undefined;
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

function attributes(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child) => child.type === "attribute_list")
    .flatMap((list) => list.namedChildren.filter((child) => child.type === "attribute"));
}

function attributeName(node: SyntaxNode): string {
  const value = node.namedChildren[0]?.text ?? "";
  return value.replace(/^.*\./, "").replace(/Attribute$/, "");
}

function argumentsOf(node: SyntaxNode): SyntaxNode[] {
  const list = node.childForFieldName("arguments")
    ?? node.namedChildren.find((child) => child.type === "argument_list" || child.type === "attribute_argument_list");
  return list?.namedChildren ?? [];
}

function expressionOf(argument: SyntaxNode): SyntaxNode {
  if (argument.type !== "argument" && argument.type !== "attribute_argument") return argument;
  const value = argument.namedChildren.at(-1) ?? argument;
  if (value.type === "assignment_expression" || value.type === "name_equals") return value.namedChildren.at(-1) ?? value;
  return value;
}

function namedArgument(argument: SyntaxNode): string | undefined {
  const match = argument.text.match(/^\s*([A-Za-z_]\w*)\s*[:=]/);
  if (!match) return undefined;
  const first = argument.namedChildren[0];
  if (first?.type === "assignment_expression" || first?.type === "name_equals") return first.namedChildren[0]?.text ?? match[1];
  return first && first !== expressionOf(argument) ? first.text : match[1];
}

function resolveString(node: SyntaxNode | undefined, constants: ConstantTable, use: SyntaxNode = node!): string | undefined {
  if (!node) return undefined;
  const expression = expressionOf(node);
  if (STRING_NODES.has(expression.type)) return unquote(expression.text);
  if (expression.type === "identifier") return constants.resolve(expression.text, use);
  if (expression.type === "parenthesized_expression") return resolveString(expression.namedChildren[0], constants, use);
  if (expression.type === "binary_expression" && expression.text.includes("+")) {
    const left = resolveString(expression.namedChildren[0], constants, use);
    const right = resolveString(expression.namedChildren[1], constants, use);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function normalizePath(path: string, controller?: string, action?: string): string {
  let value = path.trim();
  if (/^https?:\/\//i.test(value)) {
    try { value = new URL(value).pathname; } catch { /* A malformed literal remains a path-like value below. */ }
  }
  value = value.replace(/^~?\//, "/");
  value = value.replace(/\[controller\]/gi, controller?.replace(/Controller$/i, "") ?? "controller")
    .replace(/\[action\]/gi, action ?? "action")
    .replace(/\{([^{}]+)\}/g, (_match, token: string) => {
      const parameter = token.replace(/^\*+/, "").split(/[:?=]/, 1)[0]?.trim();
      return parameter ? `{${parameter}}` : _match;
    })
    .replace(/\/{2,}/g, "/");
  if (!value.startsWith("/")) value = `/${value}`;
  return value.length > 1 ? value.replace(/\/$/, "") : value;
}

function joinRoute(prefix: string, route: string, controller?: string, action?: string): string {
  if (/^~?\//.test(route)) return normalizePath(route, controller, action);
  return normalizePath([prefix, route].filter(Boolean).join("/"), controller, action);
}

function joinGroupRoute(prefix: string, route: string): string {
  return normalizePath(`${prefix.replace(/\/$/, "")}/${route.replace(/^\//, "")}`);
}

function returnType(method: SyntaxNode): string | undefined {
  const methodName = name(method);
  const nameNode = method.childForFieldName("name");
  const candidate = method.namedChildren.find((child) => child !== nameNode && child.type !== "attribute_list" && child.type !== "modifier");
  if (!candidate || candidate.type === "predefined_type" && candidate.text === "void") return undefined;
  let current = candidate;
  while (current.type === "generic_name") {
    const wrapper = current.childForFieldName("name")?.text ?? current.namedChildren[0]?.text;
    if (!wrapper || !["Task", "ValueTask", "ActionResult"].includes(wrapper)) break;
    const typeArguments = current.namedChildren.find((child) => child.type === "type_argument_list");
    const nested = typeArguments?.namedChildren[0];
    if (!nested) return undefined;
    current = nested;
  }
  const value = bodySchemaType(current.text);
  return value && value !== methodName && !["IActionResult", "ActionResult", "Task", "ValueTask", "IResult"].includes(value)
    ? value : undefined;
}

function requestType(method: SyntaxNode): string | undefined {
  const parameters = method.namedChildren.find((child) => child.type === "parameter_list");
  for (const parameter of parameters?.namedChildren ?? []) {
    const parameterAttributes = attributes(parameter).map(attributeName);
    if (parameterAttributes.some((item) => ["FromRoute", "FromQuery", "FromHeader", "FromServices"].includes(item))) continue;
    const type = parameter.namedChildren.find((child) => child.type !== "attribute_list" && child !== parameter.childForFieldName("name"));
    if (type && !/^(?:string|bool|byte|sbyte|short|ushort|int|uint|long|ulong|float|double|decimal|char|Guid|DateTime|CancellationToken|HttpContext|HttpRequest|HttpResponse)$/i.test(type.text)) return bodySchemaType(type.text);
  }
  return undefined;
}

function controllerEndpoints(root: SyntaxNode, constants: ConstantTable): Endpoint[] {
  const result: Endpoint[] = [];
  walk(root, (classNode) => {
    if (classNode.type !== "class_declaration" || classNode.hasError) return;
    const className = name(classNode);
    const classAttributes = attributes(classNode);
    const isController = className?.endsWith("Controller") || classAttributes.some((item) => attributeName(item) === "ApiController");
    if (!isController || !className) return;
    const classRouteAttributes = classAttributes.filter((item) => attributeName(item) === "Route");
    const classRoutes = classRouteAttributes.map((item) => ({ attribute: item, route: resolveString(argumentsOf(item)[0], constants) }))
      .filter((item): item is { attribute: SyntaxNode; route: string } => item.route !== undefined);
    const prefixes = classRouteAttributes.length ? classRoutes : [{ attribute: undefined, route: "" }];
    const body = classNode.namedChildren.find((child) => child.type === "declaration_list");
    for (const methodNode of body?.namedChildren.filter((child) => child.type === "method_declaration") ?? []) {
      const methodName = name(methodNode);
      if (!methodName) continue;
      const actionAttributes = attributes(methodNode);
      const actionRouteAttributes = actionAttributes.filter((item) => attributeName(item) === "Route");
      const actionRoutes = actionRouteAttributes.map((item) => ({ attribute: item, route: resolveString(argumentsOf(item)[0], constants) }))
        .filter((item): item is { attribute: SyntaxNode; route: string } => item.route !== undefined);
      const verbAttributes = actionAttributes.filter((item) => attributeName(item) in CONTROLLER_METHODS || attributeName(item) === "AcceptVerbs");
      const emittedAttributes = verbAttributes.length ? verbAttributes : actionAttributes.filter((item) => attributeName(item) === "Route");
      for (const attribute of emittedAttributes) {
        const attrName = attributeName(attribute);
        const args = argumentsOf(attribute);
        let methods: Array<string | undefined> = [];
        let routes: Array<{ route: string; attribute?: SyntaxNode }> = [];
        if (attrName in CONTROLLER_METHODS) {
          methods = [CONTROLLER_METHODS[attrName]];
          const routeArg = args.find((item) => !namedArgument(item));
          const route = resolveString(routeArg, constants);
          if (routeArg && route === undefined) continue;
          if (!routeArg && actionRouteAttributes.length && !actionRoutes.length) continue;
          routes = routeArg ? [{ route: route! }] : actionRoutes.length ? actionRoutes : [{ route: "" }];
        } else if (attrName === "AcceptVerbs") {
          methods = args.filter((item) => !namedArgument(item)).map((item) => {
            const method = resolveString(item, constants)?.toUpperCase();
            return method && ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(method) ? method : undefined;
          });
          const routeArg = args.find((item) => namedArgument(item)?.toLowerCase() === "route");
          const route = resolveString(routeArg, constants);
          if (routeArg && route === undefined) continue;
          if (!routeArg && actionRouteAttributes.length && !actionRoutes.length) continue;
          routes = routeArg ? [{ route: route! }] : actionRoutes.length ? actionRoutes : [{ route: "" }];
        } else if (attrName === "Route") {
          methods = [undefined];
          const route = resolveString(args[0], constants);
          if (route === undefined) continue;
          routes = [{ route, attribute }];
        } else continue;
        if (!methods.length) methods = [undefined];
        for (const routeValue of routes) {
          const routePrefixes = /^~?\//.test(routeValue.route) ? [{ attribute: undefined, route: "" }] : prefixes;
          for (const prefix of routePrefixes) for (const httpMethod of methods) {
          const evidenceNodes = [prefix.attribute, attribute, routeValue.attribute]
            .filter((item, index, all): item is SyntaxNode => Boolean(item) && all.indexOf(item) === index);
          result.push({ method: httpMethod, rawPath: routeValue.route, path: joinRoute(prefix.route, routeValue.route, className, methodName), role: "producer",
            framework: "aspnet-core-controller", requestBodyType: requestType(methodNode), responseBodyType: returnType(methodNode),
            symbolName: methodName, symbolLine: line(methodNode), evidence: { filePath: "", line: line(evidenceNodes[0] ?? attribute), raw: evidenceNodes.map((item) => item.text).join(" "),
              rule: "aspnet-controller-route", confidence: "exact" } });
          }
        }
      }
    }
  });
  return result;
}

function collectConstants(root: SyntaxNode): ConstantTable {
  const bindings = collectLexicalBindings(root);
  const table: ConstantTable = {
    resolve(identifier, use) { return visibleBinding(bindings, identifier, use)?.constantValue; }
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of bindings) {
      if (binding.constantValue !== undefined || binding.type !== "string" || binding.node.type !== "variable_declarator") continue;
      const statement = binding.node.parent?.parent;
      const isConst = statement?.namedChildren.some((child) => child.type === "modifier" && child.text === "const")
        ?? false;
      if (!isConst) continue;
      const initializer = binding.node.namedChildren.at(-1);
      const value = initializer ? resolveString(initializer, table, initializer) : undefined;
      if (value !== undefined) { binding.constantValue = value; changed = true; }
    }
  }
  return table;
}

function invocationName(node: SyntaxNode): { method: string; receiver?: SyntaxNode } | undefined {
  const fn = node.childForFieldName("function") ?? node.namedChildren[0];
  if (!fn) return undefined;
  if (fn.type === "member_access_expression") {
    const methodNode = fn.childForFieldName("name") ?? fn.namedChildren.at(-1);
    const method = methodNode?.type === "generic_name"
      ? methodNode.childForFieldName("name")?.text ?? methodNode.namedChildren[0]?.text ?? methodNode.text
      : methodNode?.text ?? "";
    return { method, receiver: fn.namedChildren[0] };
  }
  if (fn.type === "generic_name") {
    return { method: fn.childForFieldName("name")?.text ?? fn.namedChildren[0]?.text ?? fn.text };
  }
  return { method: fn.text };
}

function declaredIdentifier(node: SyntaxNode): string | undefined {
  return name(node) ?? node.namedChildren.find((child) => child.type === "identifier")?.text;
}

function declaredType(node: SyntaxNode): string | undefined {
  const nameNode = node.childForFieldName("name");
  return node.namedChildren.find((child) => child.type !== "attribute_list" && child !== nameNode
    && child.type !== "variable_declarator")?.text.replace(/^.*\./, "");
}

type BindingKind = "endpoint-root" | "endpoint-builder" | "http-client" | "other";
type LexicalBinding = {
  name: string;
  node: SyntaxNode;
  scope: SyntaxNode;
  ownerType?: SyntaxNode;
  category: "field" | "parameter" | "local";
  type?: string;
  kind: BindingKind;
  constantValue?: string;
};

const TYPE_NODES = new Set(["class_declaration", "struct_declaration", "record_declaration"]);
const CALLABLE_NODES = new Set(["method_declaration", "constructor_declaration", "local_function_statement", "lambda_expression"]);
const LOCAL_SCOPE_NODES = new Set(["block", "for_statement", "foreach_statement", "using_statement", "switch_section", "compilation_unit"]);

function nearest(node: SyntaxNode | null, types: ReadonlySet<string>): SyntaxNode | undefined {
  let current = node;
  while (current && !types.has(current.type)) current = current.parent;
  return current ?? undefined;
}

function collectLexicalBindings(root: SyntaxNode): LexicalBinding[] {
  const bindings: LexicalBinding[] = [];
  walk(root, (node) => {
    if (node.type === "parameter") {
      const identifier = declaredIdentifier(node);
      const scope = nearest(node.parent, CALLABLE_NODES);
      if (identifier && scope) bindings.push({ name: identifier, node, scope, ownerType: nearest(node.parent, TYPE_NODES),
        category: "parameter", type: declaredType(node), kind: "other" });
      return;
    }
    if (node.type !== "variable_declarator") return;
    const identifier = declaredIdentifier(node);
    const declaration = node.parent;
    if (!identifier || declaration?.type !== "variable_declaration") return;
    const field = declaration.parent?.type === "field_declaration";
    const ownerType = nearest(node.parent, TYPE_NODES);
    const scope = field ? ownerType : nearest(node.parent, LOCAL_SCOPE_NODES);
    if (scope) bindings.push({ name: identifier, node, scope, ownerType, category: field ? "field" : "local",
      type: declaredType(declaration), kind: "other" });
  });
  return bindings;
}

function visibleBinding(bindings: readonly LexicalBinding[], identifier: string, use: SyntaxNode, fieldsOnly = false): LexicalBinding | undefined {
  const useType = nearest(use, TYPE_NODES);
  return bindings.filter((binding) => binding.name === identifier && (!fieldsOnly || binding.category === "field")
    && use.startIndex >= binding.scope.startIndex && use.endIndex <= binding.scope.endIndex
    && (binding.category !== "field" ? binding.node.startIndex <= use.startIndex : binding.ownerType === useType))
    .sort((a, b) => (a.scope.endIndex - a.scope.startIndex) - (b.scope.endIndex - b.scope.startIndex)
      || b.node.startIndex - a.node.startIndex)[0];
}

function collectEndpointBindings(root: SyntaxNode): LexicalBinding[] {
  const bindings = collectLexicalBindings(root);
  for (const binding of bindings) {
    if (binding.type === "WebApplication" || binding.type === "IEndpointRouteBuilder") binding.kind = "endpoint-root";
    if (binding.type === "WebApplicationBuilder") binding.kind = "endpoint-builder";
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of bindings) {
      if (binding.kind !== "other" || binding.node.type !== "variable_declarator") continue;
      const initializer = binding.node.namedChildren.at(-1);
      if (!initializer || initializer.type === "identifier" && initializer.text === binding.name) continue;
      let inferred: BindingKind | undefined;
      if (initializer.type === "identifier") inferred = visibleBinding(bindings, initializer.text, initializer)?.kind;
      if (initializer.type === "invocation_expression") {
        const info = invocationName(initializer);
        if (info?.method === "CreateBuilder" && info.receiver?.text.replace(/^.*\./, "") === "WebApplication") inferred = "endpoint-builder";
        if (info?.method === "Create" && info.receiver?.text.replace(/^.*\./, "") === "WebApplication") inferred = "endpoint-root";
        if (info?.method === "Build" && info.receiver?.type === "identifier"
          && visibleBinding(bindings, info.receiver.text, initializer)?.kind === "endpoint-builder") inferred = "endpoint-root";
        if (info?.method === "Build" && info.receiver?.type === "invocation_expression") {
          const source = invocationName(info.receiver);
          if (source?.method === "CreateBuilder" && source.receiver?.text.replace(/^.*\./, "") === "WebApplication") inferred = "endpoint-root";
        }
      }
      if (inferred && inferred !== "other") { binding.kind = inferred; changed = true; }
    }
  }
  return bindings;
}

function groupPrefix(receiver: SyntaxNode | undefined, use: SyntaxNode, bindings: readonly LexicalBinding[], groups: ReadonlyMap<LexicalBinding, string>, constants: ConstantTable): string | undefined {
  if (!receiver) return "";
  if (receiver.type === "identifier") {
    const binding = visibleBinding(bindings, receiver.text, use);
    return binding ? groups.get(binding) ?? (binding.kind === "endpoint-root" ? "" : undefined) : undefined;
  }
  if (receiver.type === "invocation_expression") {
    const info = invocationName(receiver);
    if (info?.method !== "MapGroup") return undefined;
    const parent = groupPrefix(info.receiver, use, bindings, groups, constants);
    const route = resolveString(argumentsOf(receiver)[0], constants);
    return parent === undefined || route === undefined ? undefined : joinGroupRoute(parent, route);
  }
  return undefined;
}

function minimalEndpoints(root: SyntaxNode, constants: ConstantTable): Endpoint[] {
  const bindings = collectEndpointBindings(root);
  const groups = new Map<LexicalBinding, string>();
  const namedHandlers = new Map<string, SyntaxNode[]>();
  const result: Endpoint[] = [];
  walk(root, (node) => {
    if (node.type !== "method_declaration" && node.type !== "local_function_statement") return;
    const handlerName = name(node);
    if (handlerName) namedHandlers.set(handlerName, [...namedHandlers.get(handlerName) ?? [], node]);
  });
  walk(root, (node) => {
    if (node.type !== "variable_declarator") return;
    const identifier = name(node) ?? node.namedChildren[0]?.text;
    const invocation = node.namedChildren.find((child) => child.type === "invocation_expression");
    const info = invocation && invocationName(invocation);
    if (!identifier || !invocation || info?.method !== "MapGroup") return;
    const binding = bindings.find((item) => item.node === node);
    const prefix = groupPrefix(info.receiver, invocation, bindings, groups, constants);
    const route = resolveString(argumentsOf(invocation)[0], constants);
    if (binding && prefix !== undefined && route !== undefined) groups.set(binding, joinGroupRoute(prefix, route));
  });
  walk(root, (node) => {
    if (node.type !== "invocation_expression" || node.hasError) return;
    const info = invocationName(node);
    if (!info || (!(info.method in MINIMAL_METHODS) && info.method !== "MapMethods")) return;
    const args = argumentsOf(node);
    const route = resolveString(args[0], constants);
    const prefix = groupPrefix(info.receiver, node, bindings, groups, constants);
    if (route === undefined || prefix === undefined) return;
    const methods: Array<string | undefined> = [];
    if (info.method === "MapMethods") {
      if (args[1]) walk(args[1], (item) => {
        const literal = STRING_NODES.has(item.type) ? unquote(item.text)?.toUpperCase() : undefined;
        const member = item.type === "member_access_expression" && item.text.startsWith("HttpMethods.")
          ? item.namedChildren.at(-1)?.text.toUpperCase() : undefined;
        const candidate = literal ?? member;
        if (candidate) methods.push(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(candidate) ? candidate : undefined);
      });
    } else methods.push(MINIMAL_METHODS[info.method]);
    if (!methods.length) methods.push(undefined);
    const handler = args.at(-1);
    const handlerExpression = handler ? expressionOf(handler) : undefined;
    const parameter = handlerExpression?.type === "lambda_expression" ? handlerExpression.namedChildren
      .find((child) => child.type === "parameter_list")?.namedChildren[0] : undefined;
    const type = parameter?.namedChildren.find((child) => child !== parameter.childForFieldName("name"));
    const namedMatches = handlerExpression?.type === "identifier" ? namedHandlers.get(handlerExpression.text) ?? [] : [];
    const namedHandler = namedMatches.length === 1 ? namedMatches[0] : undefined;
    for (const method of methods) result.push({ method, rawPath: route, path: joinGroupRoute(prefix, route), role: "producer",
      framework: "aspnet-core-minimal-api", requestBodyType: type ? bodySchemaType(type.text) : (namedHandler ? requestType(namedHandler) : undefined),
      responseBodyType: namedHandler ? returnType(namedHandler) : undefined,
      symbolName: handlerExpression?.type === "identifier" ? handlerExpression.text : undefined,
      symbolLine: namedHandler ? line(namedHandler) : undefined,
      evidence: { filePath: "", line: line(node), raw: node.text,
        rule: "aspnet-minimal-api", confidence: "exact" } });
  });
  return result;
}

function consumerEndpoints(root: SyntaxNode, constants: ConstantTable): Endpoint[] {
  const bindings = collectLexicalBindings(root);
  for (const binding of bindings) if (binding.type === "HttpClient") binding.kind = "http-client";
  const result: Endpoint[] = [];
  walk(root, (node) => {
    if (node.type !== "invocation_expression" || node.hasError) return;
    const info = invocationName(node);
    const receiverNode = info?.receiver;
    const explicitThisField = receiverNode?.type === "member_access_expression" && receiverNode.namedChildren.length === 1
      && receiverNode.text === `this.${receiverNode.namedChildren[0]?.text}` ? receiverNode.namedChildren[0]?.text : undefined;
    const receiver = explicitThisField
      ? explicitThisField
      : receiverNode?.type === "identifier" ? receiverNode.text : undefined;
    const binding = receiver ? visibleBinding(bindings, receiver, node, Boolean(explicitThisField)) : undefined;
    if (!info || !receiver || binding?.kind !== "http-client") return;
    const args = argumentsOf(node);
    let method: string | undefined = CLIENT_METHODS[info.method];
    let route = method ? resolveString(args[0], constants) : undefined;
    if ((info.method === "SendAsync" || info.method === "Send") && args[0]) {
      const request = expressionOf(args[0]);
      if (request.type === "object_creation_expression" && /\bHttpRequestMessage\b/.test(request.text)) {
        const requestArgs = request.namedChildren.find((child) => child.type === "argument_list")?.namedChildren ?? [];
        const methodNode = expressionOf(requestArgs[0] ?? request);
        const methodName = methodNode.type === "member_access_expression" ? methodNode.namedChildren.at(-1)?.text.toUpperCase() : undefined;
        method = methodName && ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(methodName) ? methodName : undefined;
        route = resolveString(requestArgs[1], constants);
      }
    }
    if (route === undefined) return;
    let owner: SyntaxNode | null = node.parent;
    while (owner && owner.type !== "method_declaration" && owner.type !== "local_function_statement") owner = owner.parent;
    result.push({ method, rawPath: route, path: normalizePath(route), role: "consumer",
      framework: "dotnet-httpclient", symbolName: owner ? name(owner) : undefined, symbolLine: owner ? line(owner) : undefined,
      evidence: { filePath: "", line: line(node), raw: node.text, rule: "dotnet-httpclient-consumer", confidence: "exact" } });
  });
  return result;
}

function symbolId(symbols: readonly PluginSymbolView[], endpoint: Endpoint): string | undefined {
  if (!endpoint.symbolName) return undefined;
  if (endpoint.symbolLine) return symbols.find((item) => item.name === endpoint.symbolName && item.startLine === endpoint.symbolLine)?.id;
  const matches = symbols.filter((item) => item.name === endpoint.symbolName);
  return matches.length === 1 ? matches[0]?.id : undefined;
}

async function analyze(file: PluginFileView): Promise<Endpoint[]> {
  if (!file.source) return [];
  const root = (await parser()).parse(file.source, undefined, { bufferSize: csharpParseBufferSize(file.source) }).rootNode;
  const constants = collectConstants(root);
  return [...controllerEndpoints(root, constants), ...minimalEndpoints(root, constants), ...consumerEndpoints(root, constants)];
}

function key(fact: Omit<PluginHttpEndpointFact, "kind">): string {
  return [fact.repoId, fact.filePath, fact.role, fact.method ?? "", fact.path, fact.framework ?? "", fact.sourceSymbolId ?? "",
    fact.requestBodyType ?? "", fact.responseBodyType ?? ""].join("\0");
}

export const csharpHttpExtractor: FactExtractorPlugin = {
  name: "csharp-aspnet-http",
  languages: ["csharp"],
  frameworks: ["ASP.NET Core"],
  async extract(context: PluginContext): Promise<void> {
    const facts: Array<Omit<PluginHttpEndpointFact, "kind">> = [];
    for (const file of [...context.files.byLanguage("csharp")].sort((a, b) => a.path.localeCompare(b.path))) {
      for (const endpoint of await analyze(file)) {
        const { symbolName: _symbolName, symbolLine: _symbolLine, ...fact } = endpoint;
        facts.push({ repoId: file.repoId, filePath: file.path, ...fact,
          sourceSymbolId: symbolId(file.symbols, endpoint), evidence: { ...fact.evidence, filePath: file.path } });
      }
    }
    const seen = new Set<string>();
    facts.sort((a, b) => key(a).localeCompare(key(b)) || a.evidence.line - b.evidence.line || a.evidence.raw.localeCompare(b.evidence.raw));
    for (const fact of facts) if (!seen.has(key(fact))) { seen.add(key(fact)); context.emit.httpEndpoint(fact); }
  }
};
