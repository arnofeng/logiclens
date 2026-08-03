import type { ContractSpecKind } from "../parsing/types.js";
import type { SchemaFieldSpec, TypeDeclarationIdentity, TypeExpression, TypeInstanceIdentity } from "../schema/model.js";
export type {
  CanonicalTypeExpression,
  ExternalTypeSymbolIdentity,
  ResolutionContextFact,
  ResolutionScopeDependencyFact,
  ResolutionScopeIdentity,
  SchemaBehaviorFingerprint,
  SchemaDependencyFact,
  SchemaDiagnosticFact,
  SchemaFieldSpec,
  SchemaFieldType,
  SchemaRelationProvenance,
  SchemaRootReference,
  TypeDeclarationIdentity,
  TypeExpression,
  TypeInstanceIdentity
} from "../schema/model.js";

export type HttpEndpointSpec = {
  kind: "http-endpoint";
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
  path: string;
  pathTemplate: string;
  pathParams: string[];
  queryParams?: { name: string; type?: string; required?: boolean }[];
  requestBodyType?: string;
  requestBodySlots?: { index: number; name?: string; type: string }[];
  responseBodyType?: string;
  declaredResponseType?: string;
  responseBody?: boolean;
  ownerType?: string;
  methodSignature?: string;
  ownerGenericBindings?: { name: string; type: string }[];
  statusCodes?: number[];
  auth?: "unknown" | "none" | "required";
};

export type EventSpec = {
  kind: "event";
  topic: string;
  eventName?: string;
  payloadType?: string;
  payloadSlot?: { index?: number; name?: string };
  payloadInference?: "resolved" | "unresolved" | "ambiguous" | "unsupported";
  topicConfidence?: number;
  keyType?: string;
  broker?: "kafka" | "rabbitmq" | "redis-stream" | "nats" | "unknown";
  version?: string;
};

export type SchemaSpec = {
  id: string;
  kind: "schema";
  identity: TypeInstanceIdentity;
  declaration: TypeDeclarationIdentity;
  displayName: string;
  languageId: string;
  generatedTypeIdentities?: { languageId: string; canonicalName: string }[];
  shape:
    | { kind: "object"; fields: SchemaFieldSpec[]; baseTypes?: TypeExpression[] }
    | { kind: "enum"; values: string[] };
};

export type GrpcStreaming = "unary" | "client-stream" | "server-stream" | "bidi-stream";

export type GrpcMethodSpec = {
  kind: "grpc-method";
  service: string;          // "OrderService"
  method: string;           // "CreateOrder"
  package?: string;         // "acme.order.v1"
  fullName: string;         // "acme.order.v1.OrderService/CreateOrder"  ← Canonical identifier
  requestType?: string;     // "CreateOrderRequest"
  responseType?: string;    // "Order"
  streaming: GrpcStreaming;
  framework?: "proto" | "grpc-go" | "grpc-java" | "grpc-python" | "grpc-js";
  ownerType?: string;
  methodSignature?: string;
  requestProtoType?: string;
  responseProtoType?: string;
  requestGeneratedJavaType?: string;
  responseGeneratedJavaType?: string;
};

export type DubboMethodSpec = {
  kind: "dubbo-method";
  interfaceName: string;
  method: string;
  group?: string;
  version?: string;
  fullName: string;
  requestTypes?: string[];
  requestSlots?: { index: number; name?: string; type: string }[];
  responseType?: string;
  methodSignature?: string;
  ownerType?: string;
  ownerGenericBindings?: { name: string; type: string }[];
  config: "annotation" | "xml";
  framework?: "dubbo-java" | "dubbo-go";
};

export type GraphQLOperationSpec = {
  kind: "graphql-operation";
  requestTypes?: string[];
  operationType: "query" | "mutation" | "subscription";
  field: string;             // 根字段名 "user" / "createOrder"
  operationName?: string;    // 命名 operation（client 侧）
  fullName: string;          // "Query.user"  ← 规范标识来源
  requestType?: string;      // input 类型（参数）
  responseType?: string;     // 返回类型
  source: "sdl" | "code-first" | "client-document";
};

export type ContractSpec = HttpEndpointSpec | EventSpec | SchemaSpec | GrpcMethodSpec | DubboMethodSpec | GraphQLOperationSpec;

// Compile-time assertion: ContractSpec kind union === ContractSpecKind
type _AssertSpecKindsAligned =
  [ContractSpec["kind"]] extends [ContractSpecKind]
    ? ([ContractSpecKind] extends [ContractSpec["kind"]] ? true : never)
    : never;
export const _specKindsAligned: _AssertSpecKindsAligned = true;

export type InteractionStyle = "sync-rpc" | "async-message" | "shared-data";

export function interactionStyleOfSpecKind(kind: ContractSpecKind): InteractionStyle {
  switch (kind) {
    case "http-endpoint":
      return "sync-rpc";
    case "grpc-method":
      return "sync-rpc";
    case "dubbo-method":
      return "sync-rpc";
    case "graphql-operation":
      return "sync-rpc";
    case "event":
      return "async-message";
    case "schema":
      return "shared-data";
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled ContractSpecKind: ${exhaustive as string}`);
    }
  }
}

export function serializeSpec(spec: ContractSpec): string {
  return JSON.stringify(spec);
}

export function deserializeSpec(json: string): ContractSpec {
  return JSON.parse(json) as ContractSpec;
}

export function schemaFields(spec: SchemaSpec): SchemaFieldSpec[] {
  return spec.shape.kind === "object" ? spec.shape.fields : [];
}

export function schemaFieldTypeName(field: SchemaFieldSpec): string {
  const fieldType = field.type;
  if (fieldType.kind === "resolved") return canonicalTypeDisplay(fieldType.expression);
  if (fieldType.kind === "external-symbol") return fieldType.symbol.canonicalName;
  return typeExpressionDisplay(fieldType.normalizedExpression);
}

function canonicalTypeDisplay(expression: import("../schema/model.js").CanonicalTypeExpression): string {
  switch (expression.kind) {
    case "scalar": return expression.name;
    case "type-instance": return expression.declarationId;
    case "array": return `array<${canonicalTypeDisplay(expression.element)}>`;
    case "map": return `map<${canonicalTypeDisplay(expression.key)},${canonicalTypeDisplay(expression.value)}>`;
    case "union": return expression.members.map(canonicalTypeDisplay).join(" | ");
    case "intersection": return expression.members.map(canonicalTypeDisplay).join(" & ");
    case "nullable": return `${canonicalTypeDisplay(expression.inner)}?`;
    case "literal": return expression.value;
    case "wildcard": return expression.type ? `? ${expression.bound ?? ""} ${canonicalTypeDisplay(expression.type)}`.trim() : "?";
  }
}

function typeExpressionDisplay(expression: import("../schema/model.js").TypeExpression): string {
  switch (expression.kind) {
    case "reference":
    case "variable": return expression.name;
    case "application": return `${typeExpressionDisplay(expression.target)}<${expression.arguments.map(typeExpressionDisplay).join(",")}>`;
    case "array": return `array<${typeExpressionDisplay(expression.element)}>`;
    case "map": return `map<${typeExpressionDisplay(expression.key)},${typeExpressionDisplay(expression.value)}>`;
    case "union": return expression.members.map(typeExpressionDisplay).join(" | ");
    case "intersection": return expression.members.map(typeExpressionDisplay).join(" & ");
    case "nullable": return `${typeExpressionDisplay(expression.inner)}?`;
    case "literal": return expression.value;
    case "opaque": return expression.canonicalText;
    case "wildcard": return expression.type ? `? ${expression.bound ?? ""} ${typeExpressionDisplay(expression.type)}`.trim() : "?";
  }
}

// ---------------------------------------------------------------------------
// Primitive type normalization — maps language-specific primitive types to a
// unified cross-language vocabulary so semantic matching (schema compatibility,
// impact analysis) can reason about types without per-language branching.
// ---------------------------------------------------------------------------

/** Source language identifier for the normalization table. */
export type SupportedLanguage = "typescript" | "java" | "go" | "python" | "proto" | "graphql";

/**
 * Normalized primitive type vocabulary shared across languages.
 * Complex / user-defined types are returned as-is (the original name).
 */
export type NormalizedPrimitive =
  | "string"
  | "number"
  | "boolean"
  | "void"
  | "null"
  | "undefined"
  | "any"
  | "unknown"
  | "array"
  | "map"
  | "date"
  | "uuid"
  | "bigint";

// -- TypeScript primitive map ------------------------------------------------

const TS_PRIMITIVE_MAP: Record<string, NormalizedPrimitive> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  void: "void",
  undefined: "undefined",
  null: "null",
  any: "any",
  unknown: "unknown",
  never: "void",
  bigint: "bigint",
  Date: "date",
  String: "string",
  Number: "number",
  Boolean: "boolean"
};

// -- Java primitive / boxed / common JDK map ---------------------------------

const JAVA_PRIMITIVE_MAP: Record<string, NormalizedPrimitive> = {
  // primitives
  int: "number",
  long: "number",
  short: "number",
  byte: "number",
  double: "number",
  float: "number",
  boolean: "boolean",
  char: "string",
  void: "void",
  // boxed
  Integer: "number",
  Long: "number",
  Short: "number",
  Byte: "number",
  Double: "number",
  Float: "number",
  Boolean: "boolean",
  Character: "string",
  // common JDK
  String: "string",
  BigDecimal: "number",
  BigInteger: "bigint",
  LocalDate: "date",
  LocalDateTime: "date",
  Instant: "date",
  Date: "date",
  UUID: "uuid",
  Object: "any"
};

// -- Go primitive map --------------------------------------------------------

const GO_PRIMITIVE_MAP: Record<string, NormalizedPrimitive> = {
  string: "string",
  bool: "boolean",
  // signed ints
  int: "number",
  int8: "number",
  int16: "number",
  int32: "number",
  int64: "number",
  // unsigned ints
  uint: "number",
  uint8: "number",
  uint16: "number",
  uint32: "number",
  uint64: "number",
  uintptr: "number",
  // floats
  float32: "number",
  float64: "number",
  // complex (treated as any — no arithmetic semantics in schema matching)
  complex64: "any",
  complex128: "any",
  // other built-ins
  byte: "number",
  rune: "number",
  error: "string",
  any: "any",
  "interface{}": "any",
  // common stdlib
  "time.Time": "date"
};

// -- Python primitive map ----------------------------------------------------

const PYTHON_PRIMITIVE_MAP: Record<string, NormalizedPrimitive> = {
  str: "string",
  int: "number",
  float: "number",
  bool: "boolean",
  None: "null",
  bytes: "string",
  bytearray: "string",
  list: "array",
  dict: "map",
  tuple: "array",
  set: "array",
  frozenset: "array",
  complex: "any",
  // typing module aliases
  List: "array",
  Dict: "map",
  Tuple: "array",
  Set: "array",
  FrozenSet: "array",
  Any: "any",
  Optional: "null", // Optional[T] is handled by unwrapping below
  Union: "any",     // Union[T, None] is handled by unwrapping below
  // common stdlib / third-party
  datetime: "date",
  "datetime.date": "date",
  "datetime.datetime": "date",
  Decimal: "number",
  UUID: "uuid"
};

// -- Proto primitive map -----------------------------------------------------

const PROTO_PRIMITIVE_MAP: Record<string, NormalizedPrimitive> = {
  double: "number",
  float: "number",
  int32: "number",
  int64: "number",
  uint32: "number",
  uint64: "number",
  sint32: "number",
  sint64: "number",
  fixed32: "number",
  fixed64: "number",
  sfixed32: "number",
  sfixed64: "number",
  bool: "boolean",
  string: "string",
  bytes: "string",
  "google.protobuf.Timestamp": "date"
};

// -- GraphQL primitive map ---------------------------------------------------

const GRAPHQL_PRIMITIVE_MAP: Record<string, NormalizedPrimitive> = {
  Int: "number",
  Float: "number",
  String: "string",
  ID: "string",
  Boolean: "boolean"
};

// -- Normalization entry point -----------------------------------------------

/**
 * Normalizes a raw type string to the cross-language primitive vocabulary.
 *
 * Language-specific primitives (e.g. `int`, `float64`, `String`) are mapped
 * to a unified name.  Complex / user-defined types are returned as-is so
 * downstream code can detect them as `!== normalized` when needed.
 *
 * Nullable wrappers (Java `Optional<T>`, TS `T | null`, Go `*T`) are
 * **unwrapped before lookup** — the inner type is returned with a trailing
 * `?` marker appended to signal nullability.
 */
export function normalizePrimitiveType(
  language: SupportedLanguage,
  rawType: string
): string {
  const trimmed = rawType.trim();
  if (!trimmed) return "any";

  // -- unwrap GraphQL list and nullability -----------------------------------
  if (language === "graphql") {
    const isNonNull = trimmed.endsWith("!");
    const inner = isNonNull ? trimmed.slice(0, -1).trim() : trimmed;
    if (inner.startsWith("[") && inner.endsWith("]")) {
      const listInner = inner.slice(1, -1).trim();
      const base = normalizePrimitiveType(language, listInner);
      return `array<${base}>` + (isNonNull ? "" : "?");
    }
    const mapped = GRAPHQL_PRIMITIVE_MAP[inner] || inner;
    return mapped + (isNonNull ? "" : "?");
  }

  // -- unwrap nullable wrappers ----------------------------------------------
  // TS  T | null  /  T | undefined
  if (language === "typescript") {
    const inner = unwrapTsUnionNull(trimmed);
    if (inner !== null) return normalizePrimitiveType(language, inner) + "?";
  }

  // -- unwrap slice / array --------------------------------------------------
  // Go  []T
  if (language === "go") {
    const inner = unwrapGoSlice(trimmed);
    if (inner !== null) {
      const base = normalizePrimitiveType(language, inner);
      return base.endsWith("?") ? `array<${base.slice(0, -1)}>?` : `array<${base}>`;
    }
  }

  // -- unwrap proto repeated / map -------------------------------------------
  if (language === "proto") {
    const repeatedMatch = trimmed.match(/^repeated\s+(.+)$/);
    if (repeatedMatch) {
      const inner = repeatedMatch[1]!.trim();
      const base = normalizePrimitiveType(language, inner);
      return base.endsWith("?") ? `array<${base.slice(0, -1)}>?` : `array<${base}>`;
    }
    const protoMap = unwrapGenericType(trimmed, ["map"]);
    if (protoMap?.typeArgs.length === 2) {
      return `map<${normalizePrimitiveType(language, protoMap.typeArgs[0]!)},${normalizePrimitiveType(language, protoMap.typeArgs[1]!)}>`;
    }
  }

  // -- unwrap Python Optional[T] / Union[T, None] ----------------------------
  if (language === "python") {
    const inner = unwrapPythonOptional(trimmed);
    if (inner !== null) return normalizePrimitiveType(language, inner) + "?";

    // unwrap list[X] / List[X] → array<X>
    const listMatch = trimmed.match(/^(?:list|List|Sequence)\[(.+)\]$/);
    if (listMatch) {
      const innerType = listMatch[1]!.trim();
      return `array<${normalizePrimitiveType(language, innerType)}>`;
    }

    // dict[K,V] / Dict[K,V] → map
    const dictMatch = trimmed.match(/^(?:dict|Dict)\[(.+)\]$/);
    if (dictMatch) {
      const arguments_ = splitTopLevelTypeArgs(dictMatch[1]!);
      if (arguments_.length === 2) {
        return `map<${normalizePrimitiveType(language, arguments_[0]!)},${normalizePrimitiveType(language, arguments_[1]!)}>`;
      }
    }
  }

  // -- lookup in language-specific map ---------------------------------------
  const map = language === "typescript" ? TS_PRIMITIVE_MAP
    : language === "java" ? JAVA_PRIMITIVE_MAP
    : language === "go" ? GO_PRIMITIVE_MAP
    : language === "proto" ? PROTO_PRIMITIVE_MAP
    : PYTHON_PRIMITIVE_MAP;

  const hit = map[trimmed];
  if (hit) return hit;

  // -- Go map: map[K]V → map ------------------------------------------------
  if (language === "go") {
    const goMap = trimmed.match(/^map\[([^\]]+)\](.+)$/);
    if (goMap) {
      return `map<${normalizePrimitiveType(language, goMap[1]!)},${normalizePrimitiveType(language, goMap[2]!)}>`;
    }
  }

  // -- Go pointer deref: *T → T? (nullable) -----------------------------------
  if (language === "go" && trimmed.startsWith("*")) {
    return normalizePrimitiveType(language, trimmed.slice(1)) + "?";
  }

  // -- array shorthand: T[] (TS/Java) ----------------------------------------
  const arrayMatch = trimmed.match(/^(.+)\[\]$/);
  if (arrayMatch) {
    const base = normalizePrimitiveType(language, arrayMatch[1]!);
    return `array<${base}>`;
  }


  // Return the original name for complex / user-defined types
  return trimmed;
}

// -- Internal helpers --------------------------------------------------------

function unwrapTsUnionNull(raw: string): string | null {
  // Match "T | null", "T | undefined", "null | T", etc.
  const parts = raw.split("|").map((s) => s.trim());
  const nullish = new Set(["null", "undefined"]);
  const nonNull = parts.filter((p) => !nullish.has(p));
  if (nonNull.length === 1 && parts.length > nonNull.length) {
    return nonNull[0]!;
  }
  return null;
}

function unwrapPythonOptional(raw: string): string | null {
  // Optional[T] → T
  const m = raw.match(/^Optional\[(.+)\]$/);
  if (m) return m[1]!.trim();
  // Union[T, None] → T (single non-None type)
  const u = raw.match(/^Union\[(.+)\]$/);
  if (u) {
    const parts = splitTopLevelTypeArgs(u[1]!);
    const nonNone = parts.filter((p) => p !== "None");
    if (nonNone.length === 1) return nonNone[0]!;
  }
  return null;
}

function unwrapGoSlice(raw: string): string | null {
  const m = raw.match(/^\[\](.+)$/);
  return m ? m[1]!.trim() : null;
}

function unwrapGenericType(
  raw: string,
  wrappers: string[]
): { name: string; typeArgs: string[] } | null {
  const m = raw.match(/^(\w+)<(.+)>$/);
  if (!m) return null;
  const name = m[1]!;
  if (!wrappers.includes(name)) return null;
  const argsStr = m[2]!;
  const typeArgs = splitTopLevelTypeArgs(argsStr);
  return { name, typeArgs };
}

/** Splits "T, U" in a generic type argument list, respecting nested angle-brackets. */
function splitTopLevelTypeArgs(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "<" || ch === "[" || ch === "(") depth++;
    else if (ch === ">" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
