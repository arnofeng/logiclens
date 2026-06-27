import { describe, expect, it } from "vitest";
import { normalizePrimitiveType } from "../src/contracts/spec.js";

// ---------------------------------------------------------------------------
// 3-A: Primitive type normalization
// ---------------------------------------------------------------------------

describe("normalizePrimitiveType", () => {
  // -- TypeScript ----------------------------------------------------------

  describe("TypeScript", () => {
    it("maps string primitives", () => {
      expect(normalizePrimitiveType("typescript", "string")).toBe("string");
      expect(normalizePrimitiveType("typescript", "String")).toBe("string");
    });

    it("maps number primitives", () => {
      expect(normalizePrimitiveType("typescript", "number")).toBe("number");
      expect(normalizePrimitiveType("typescript", "Number")).toBe("number");
    });

    it("maps boolean primitives", () => {
      expect(normalizePrimitiveType("typescript", "boolean")).toBe("boolean");
      expect(normalizePrimitiveType("typescript", "Boolean")).toBe("boolean");
    });

    it("maps void / undefined / null / any / unknown", () => {
      expect(normalizePrimitiveType("typescript", "void")).toBe("void");
      expect(normalizePrimitiveType("typescript", "undefined")).toBe("undefined");
      expect(normalizePrimitiveType("typescript", "null")).toBe("null");
      expect(normalizePrimitiveType("typescript", "any")).toBe("any");
      expect(normalizePrimitiveType("typescript", "unknown")).toBe("unknown");
      expect(normalizePrimitiveType("typescript", "never")).toBe("void");
    });

    it("maps bigint and Date", () => {
      expect(normalizePrimitiveType("typescript", "bigint")).toBe("bigint");
      expect(normalizePrimitiveType("typescript", "Date")).toBe("date");
    });

    it("returns complex types as-is", () => {
      expect(normalizePrimitiveType("typescript", "OrderDTO")).toBe("OrderDTO");
      expect(normalizePrimitiveType("typescript", "CreateOrderRequest")).toBe("CreateOrderRequest");
    });

    it("handles nullable union T | null", () => {
      expect(normalizePrimitiveType("typescript", "string | null")).toBe("string?");
      expect(normalizePrimitiveType("typescript", "number | null")).toBe("number?");
    });

    it("handles nullable union T | undefined", () => {
      expect(normalizePrimitiveType("typescript", "string | undefined")).toBe("string?");
    });

    it("handles null | T (reverse order)", () => {
      expect(normalizePrimitiveType("typescript", "null | string")).toBe("string?");
    });

    it("does not append ? when multiple non-null types", () => {
      const result = normalizePrimitiveType("typescript", "string | number");
      // With multiple non-null types, the union is returned as-is
      expect(result).toBe("string | number");
    });

    it("handles Array<T> generic", () => {
      expect(normalizePrimitiveType("typescript", "Array<string>")).toBe("array<string>");
      expect(normalizePrimitiveType("typescript", "Array<OrderItem>")).toBe("array<OrderItem>");
    });

    it("handles T[] array shorthand", () => {
      expect(normalizePrimitiveType("typescript", "string[]")).toBe("array<string>");
    });

    it("handles List<T> generic (cross-language)", () => {
      expect(normalizePrimitiveType("typescript", "List<string>")).toBe("array<string>");
    });

    it("handles empty string as any", () => {
      expect(normalizePrimitiveType("typescript", "")).toBe("any");
      expect(normalizePrimitiveType("typescript", "  ")).toBe("any");
    });

    it("handles Record<K,V> as map", () => {
      expect(normalizePrimitiveType("typescript", "Record<string, any>")).toBe("map");
    });
  });

  // -- Java ----------------------------------------------------------------

  describe("Java", () => {
    it("maps primitive int/long/short/byte", () => {
      expect(normalizePrimitiveType("java", "int")).toBe("number");
      expect(normalizePrimitiveType("java", "long")).toBe("number");
      expect(normalizePrimitiveType("java", "short")).toBe("number");
      expect(normalizePrimitiveType("java", "byte")).toBe("number");
    });

    it("maps primitive double/float", () => {
      expect(normalizePrimitiveType("java", "double")).toBe("number");
      expect(normalizePrimitiveType("java", "float")).toBe("number");
    });

    it("maps primitive boolean and char", () => {
      expect(normalizePrimitiveType("java", "boolean")).toBe("boolean");
      expect(normalizePrimitiveType("java", "char")).toBe("string");
    });

    it("maps boxed types", () => {
      expect(normalizePrimitiveType("java", "Integer")).toBe("number");
      expect(normalizePrimitiveType("java", "Long")).toBe("number");
      expect(normalizePrimitiveType("java", "Double")).toBe("number");
      expect(normalizePrimitiveType("java", "Boolean")).toBe("boolean");
      expect(normalizePrimitiveType("java", "Character")).toBe("string");
    });

    it("maps String", () => {
      expect(normalizePrimitiveType("java", "String")).toBe("string");
    });

    it("maps BigDecimal / BigInteger", () => {
      expect(normalizePrimitiveType("java", "BigDecimal")).toBe("number");
      expect(normalizePrimitiveType("java", "BigInteger")).toBe("bigint");
    });

    it("maps date/time types", () => {
      expect(normalizePrimitiveType("java", "LocalDate")).toBe("date");
      expect(normalizePrimitiveType("java", "LocalDateTime")).toBe("date");
      expect(normalizePrimitiveType("java", "Instant")).toBe("date");
      expect(normalizePrimitiveType("java", "Date")).toBe("date");
    });

    it("maps UUID", () => {
      expect(normalizePrimitiveType("java", "UUID")).toBe("uuid");
    });

    it("handles Optional<T> nullable wrapper", () => {
      expect(normalizePrimitiveType("java", "Optional<String>")).toBe("string?");
      expect(normalizePrimitiveType("java", "Optional<Integer>")).toBe("number?");
      // Nested Optional is unwrapped to the inner type
      expect(normalizePrimitiveType("java", "Optional<OrderDTO>")).toBe("OrderDTO?");
    });

    it("handles List<T> as array", () => {
      expect(normalizePrimitiveType("java", "List<String>")).toBe("array<string>");
      expect(normalizePrimitiveType("java", "List<OrderItem>")).toBe("array<OrderItem>");
    });

    it("handles ArrayList<T> as array", () => {
      expect(normalizePrimitiveType("java", "ArrayList<Integer>")).toBe("array<number>");
    });

    it("handles Set<T> as array", () => {
      expect(normalizePrimitiveType("java", "Set<String>")).toBe("array<string>");
    });

    it("handles Map<K,V> as map", () => {
      expect(normalizePrimitiveType("java", "Map<String, Object>")).toBe("map");
      expect(normalizePrimitiveType("java", "HashMap<String, String>")).toBe("map");
    });

    it("returns complex types as-is", () => {
      expect(normalizePrimitiveType("java", "CreateOrderRequest")).toBe("CreateOrderRequest");
    });

    it("handles array shorthand T[]", () => {
      expect(normalizePrimitiveType("java", "String[]")).toBe("array<string>");
    });
  });

  // -- Go ------------------------------------------------------------------

  describe("Go", () => {
    it("maps string", () => {
      expect(normalizePrimitiveType("go", "string")).toBe("string");
    });

    it("maps bool", () => {
      expect(normalizePrimitiveType("go", "bool")).toBe("boolean");
    });

    it("maps signed ints", () => {
      expect(normalizePrimitiveType("go", "int")).toBe("number");
      expect(normalizePrimitiveType("go", "int8")).toBe("number");
      expect(normalizePrimitiveType("go", "int16")).toBe("number");
      expect(normalizePrimitiveType("go", "int32")).toBe("number");
      expect(normalizePrimitiveType("go", "int64")).toBe("number");
    });

    it("maps unsigned ints", () => {
      expect(normalizePrimitiveType("go", "uint")).toBe("number");
      expect(normalizePrimitiveType("go", "uint8")).toBe("number");
      expect(normalizePrimitiveType("go", "uint16")).toBe("number");
      expect(normalizePrimitiveType("go", "uint32")).toBe("number");
      expect(normalizePrimitiveType("go", "uint64")).toBe("number");
      expect(normalizePrimitiveType("go", "uintptr")).toBe("number");
    });

    it("maps floats", () => {
      expect(normalizePrimitiveType("go", "float32")).toBe("number");
      expect(normalizePrimitiveType("go", "float64")).toBe("number");
    });

    it("maps complex types to any", () => {
      expect(normalizePrimitiveType("go", "complex64")).toBe("any");
      expect(normalizePrimitiveType("go", "complex128")).toBe("any");
    });

    it("maps byte / rune / error", () => {
      expect(normalizePrimitiveType("go", "byte")).toBe("number");
      expect(normalizePrimitiveType("go", "rune")).toBe("number");
      expect(normalizePrimitiveType("go", "error")).toBe("string");
    });

    it("maps time.Time to date", () => {
      expect(normalizePrimitiveType("go", "time.Time")).toBe("date");
    });

    it("handles pointer deref *T", () => {
      expect(normalizePrimitiveType("go", "*string")).toBe("string?");
      expect(normalizePrimitiveType("go", "*int")).toBe("number?");
      expect(normalizePrimitiveType("go", "*MyStruct")).toBe("MyStruct?");
    });

    it("handles []T slice", () => {
      expect(normalizePrimitiveType("go", "[]string")).toBe("array<string>");
      expect(normalizePrimitiveType("go", "[]int")).toBe("array<number>");
      expect(normalizePrimitiveType("go", "[]MyStruct")).toBe("array<MyStruct>");
    });

    it("returns complex types as-is", () => {
      expect(normalizePrimitiveType("go", "MyStruct")).toBe("MyStruct");
    });
  });

  // -- Python --------------------------------------------------------------

  describe("Python", () => {
    it("maps str", () => {
      expect(normalizePrimitiveType("python", "str")).toBe("string");
    });

    it("maps int", () => {
      expect(normalizePrimitiveType("python", "int")).toBe("number");
    });

    it("maps float", () => {
      expect(normalizePrimitiveType("python", "float")).toBe("number");
    });

    it("maps bool", () => {
      expect(normalizePrimitiveType("python", "bool")).toBe("boolean");
    });

    it("maps None", () => {
      expect(normalizePrimitiveType("python", "None")).toBe("null");
    });

    it("maps bytes and bytearray", () => {
      expect(normalizePrimitiveType("python", "bytes")).toBe("string");
      expect(normalizePrimitiveType("python", "bytearray")).toBe("string");
    });

    it("maps list/dict/tuple/set", () => {
      expect(normalizePrimitiveType("python", "list")).toBe("array");
      expect(normalizePrimitiveType("python", "dict")).toBe("map");
      expect(normalizePrimitiveType("python", "tuple")).toBe("array");
      expect(normalizePrimitiveType("python", "set")).toBe("array");
    });

    it("maps typing module aliases", () => {
      expect(normalizePrimitiveType("python", "List")).toBe("array");
      expect(normalizePrimitiveType("python", "Dict")).toBe("map");
      expect(normalizePrimitiveType("python", "Tuple")).toBe("array");
      expect(normalizePrimitiveType("python", "Any")).toBe("any");
    });

    it("handles Optional[T]", () => {
      expect(normalizePrimitiveType("python", "Optional[str]")).toBe("string?");
      expect(normalizePrimitiveType("python", "Optional[int]")).toBe("number?");
    });

    it("handles Union[T, None]", () => {
      expect(normalizePrimitiveType("python", "Union[str, None]")).toBe("string?");
    });

    it("maps datetime types", () => {
      expect(normalizePrimitiveType("python", "datetime")).toBe("date");
      expect(normalizePrimitiveType("python", "datetime.date")).toBe("date");
      expect(normalizePrimitiveType("python", "datetime.datetime")).toBe("date");
    });

    it("maps Decimal and UUID", () => {
      expect(normalizePrimitiveType("python", "Decimal")).toBe("number");
      expect(normalizePrimitiveType("python", "UUID")).toBe("uuid");
    });

    it("returns complex types as-is", () => {
      expect(normalizePrimitiveType("python", "CreateOrderDTO")).toBe("CreateOrderDTO");
      expect(normalizePrimitiveType("python", "OrderSchema")).toBe("OrderSchema");
    });
  });

  // -- Edge cases -----------------------------------------------------------

  describe("edge cases", () => {
    it("trims whitespace", () => {
      expect(normalizePrimitiveType("typescript", " string ")).toBe("string");
      expect(normalizePrimitiveType("java", " String ")).toBe("string");
    });

    it("handles unknown type names gracefully", () => {
      expect(normalizePrimitiveType("typescript", "SomeUnknownType")).toBe("SomeUnknownType");
      expect(normalizePrimitiveType("java", "com.example.Foo")).toBe("com.example.Foo");
    });
  });
});
