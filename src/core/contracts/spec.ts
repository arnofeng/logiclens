import type { ContractSpecKind } from "../parsing/types.js";

export type HttpEndpointSpec = {
  kind: "http-endpoint";
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
  path: string;
  pathTemplate: string;
  pathParams: string[];
  queryParams?: { name: string; type?: string; required?: boolean }[];
  requestBodyType?: string;
  responseBodyType?: string;
  statusCodes?: number[];
  auth?: "unknown" | "none" | "required";
};

export type EventSpec = {
  kind: "event";
  topic: string;
  eventName?: string;
  payloadType?: string;
  keyType?: string;
  broker?: "kafka" | "rabbitmq" | "redis-stream" | "nats" | "unknown";
  version?: string;
};

export type SchemaFieldSpec = {
  name: string;
  type: string;
  optional: boolean;
  nullable?: boolean;
  sourceLine?: number;
};

export type SchemaSpec = {
  kind: "schema";
  name: string;
  language: string;
  fields: SchemaFieldSpec[];
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
};

export type ContractSpec = HttpEndpointSpec | EventSpec | SchemaSpec | GrpcMethodSpec;

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

// ---------------------------------------------------------------------------
// Primitive type normalization — maps language-specific primitive types to a
// unified cross-language vocabulary so semantic matching (schema compatibility,
// impact analysis) can reason about types without per-language branching.
// ---------------------------------------------------------------------------

/** Source language identifier for the normalization table. */
export type SupportedLanguage = "typescript" | "java" | "go" | "python" | "proto";

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

  // -- unwrap nullable wrappers ----------------------------------------------
  // Java Optional<T>
  if (language === "java") {
    const opt = unwrapJavaOptional(trimmed);
    if (opt !== null) return normalizePrimitiveType(language, opt) + "?";
  }
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
    // unwrap proto map
    if (/^map<.+>$/.test(trimmed)) {
      return "map";
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
    if (/^(?:dict|Dict)\[.+\]$/.test(trimmed)) return "map";
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
  if (language === "go" && /^map\[/.test(trimmed)) return "map";

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

  // -- generic array / list / map: Array<T>, List<T>, Map<K,V> ---------------
  const genericArray = unwrapGenericType(trimmed, ["Array", "List", "Set", "ArrayList", "LinkedList", "HashSet", "TreeSet"]);
  if (genericArray) {
    const inner = genericArray.typeArgs[0];
    if (inner) {
      const base = normalizePrimitiveType(language, inner);
      return `array<${base}>`;
    }
  }
  // Map<K,V>, Record<K,V>, HashMap<>, Dictionary<>
  const genericMap = unwrapGenericType(trimmed, ["Map", "Record", "HashMap", "Dictionary", "ConcurrentHashMap", "TreeMap", "LinkedHashMap"]);
  if (genericMap) {
    return `map`;
  }

  // Return the original name for complex / user-defined types
  return trimmed;
}

// -- Internal helpers --------------------------------------------------------

function unwrapJavaOptional(raw: string): string | null {
  const m = raw.match(/^Optional<(.+)>$/);
  return m ? m[1]!.trim() : null;
}

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
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
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
