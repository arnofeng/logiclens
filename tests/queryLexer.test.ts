import { describe, expect, it } from "vitest";
import { lexQuery } from "../src/features/ask/queryLexer.js";

describe("query lexer", () => {
  it.each([
    { question: "Don't assume it's cached", quoted: [], values: ["Don't", "assume", "it's", "cached"] },
    { question: "What's the user's class?", quoted: [], values: ["What's", "the", "user's", "class"] },
    { question: "Explain \"how orders are created\"", quoted: ["how orders are created"], values: ["Explain", "how orders are created"] },
    { question: "Explain \"foo'", quoted: [], values: ["Explain", "foo"] },
    { question: "Use 'alpha' and `beta`", quoted: ["alpha", "beta"], values: ["Use", "alpha", "and", "beta"] },
    { question: "显示 “订单创建” 事件", quoted: ["订单创建"], values: ["显示", "订单创建", "事件"] },
    { question: "显示 ‘订单创建’ 事件", quoted: ["订单创建"], values: ["显示", "订单创建", "事件"] },
    { question: "显示《订单创建》事件", quoted: ["订单创建"], values: ["显示", "订单创建", "事件"] }
  ])("pairs quotes without treating apostrophes as delimiters: $question", ({ question, quoted, values }) => {
    const spans = lexQuery(question);
    expect(spans.map((span) => span.value)).toEqual(values);
    expect(spans.filter((span) => span.quoted).map((span) => span.value)).toEqual(quoted);
    expect(spans.every((span) => span.raw === question.slice(span.start, span.end))).toBe(true);
  });

  it.each([
    ["GET /orders", ["http-method", "slash-target"]],
    ["api:GET:/orders", ["prefixed-target"]],
    ["GET：/orders", ["prefixed-target"]],
    ["event：orders.created", ["prefixed-target"]],
    ["C:\\Users\\Arno\\repo.ts", ["symbolic"]],
    ["https://example.xyz/docs?q=1#api", ["url"]],
    ["orders.created event", ["symbolic", "word"]],
    ["打开 路径/混合-value.ts", ["word", "symbolic"]]
  ])("preserves structured tokens in %s", (question, kinds) => {
    const spans = lexQuery(question);
    expect(spans.map((span) => span.kind)).toEqual(kinds);
    expect(spans.map((span) => span.raw).join(" ")).toContain(spans[0]!.raw);
  });
});
