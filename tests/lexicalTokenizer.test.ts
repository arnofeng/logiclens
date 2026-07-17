import { describe, expect, it } from "vitest";
import { tokenizeLexicalText } from "../src/core/retrieval/tokenizer.js";
import { TOKENIZER_VERSION } from "../src/core/retrieval/types.js";

describe("tokenizeLexicalText", () => {
  it("normalizes compatibility forms and case deterministically", () => {
    expect(tokenizeLexicalText("Ｏｒｄｅｒ Café Cafe\u0301")).toEqual(["café", "order"]);
    expect(tokenizeLexicalText("Straße STRASSE")).toEqual(["strasse", "straße"]);
  });

  it("retains complete identifiers and produces identifier parts", () => {
    const tokens = tokenizeLexicalText("OrderService order_items order-created schema.contract/key");
    expect(tokens).toEqual(expect.arrayContaining([
      "orderservice", "order", "service",
      "order_items", "ident_order_items", "items",
      "order-created", "ident_order_created", "created",
      "schema.contract/key", "ident_schema_contract_key", "schema", "contract", "key"
    ]));
  });

  it("handles source paths, HTTP contracts and mixed Chinese identifiers", () => {
    const tokens = tokenizeLexicalText("GET /src/orders/OrderService.ts POST /\u8ba2\u5355/{orderId} OrderCreatedEvent");
    expect(tokens).toEqual([
      "/orderid", "/orders", "/orderservice.ts", "/src", "/\u8ba2\u5355",
      "cjk_\u5355", "cjk_\u8ba2", "cjk_\u8ba2\u5355", "created", "event", "get", "id",
      "ident_orderid", "ident_orders", "ident_orderservice_ts", "ident_src", "ident_\u8ba2\u5355",
      "order", "ordercreatedevent", "orderid", "orders", "post", "service", "src", "ts", "\u8ba2\u5355"
    ]);

    const relativePaths = tokenizeLexicalText("src/orders/OrderService.ts src\\orders\\OrderService.ts");
    expect(relativePaths).toEqual([
      "/orders", "/orderservice.ts", "ident_orders", "ident_orderservice_ts", "ident_src_orders_orderservice_ts",
      "order", "orders", "service", "src", "src/orders/orderservice.ts", "ts"
    ]);
  });

  it("deduplicates tokens, returns stable ordering and ignores punctuation", () => {
    const first = tokenizeLexicalText("OrderService orderService ORDER service !!!");
    const second = tokenizeLexicalText("OrderService orderService ORDER service !!!");
    expect(first).toEqual([...new Set(first)].sort());
    expect(second).toEqual(first);
    expect(tokenizeLexicalText("")).toEqual([]);
    expect(tokenizeLexicalText("... / \\ !!!")).toEqual([]);
  });

  it("keeps the tokenizer contract version fixed", () => {
    expect(TOKENIZER_VERSION).toBe("1");
  });
});
