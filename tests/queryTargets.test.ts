import { describe, expect, it } from "vitest";
import { lexQuery } from "../src/features/ask/queryLexer.js";
import { classifyQueryTargets } from "../src/features/ask/queryTargets.js";
import { createQueryPlanningContext } from "../src/features/ask/planningContext.js";

function classified(question: string) {
  return classifyQueryTargets(lexQuery(question));
}

describe("query target classifier", () => {
  it.each(["Foo.cs", "\"Foo.cs\"", "Open Foo.cs", "打开 Foo.cs", "Foo.CS"])(
    "classifies active plugin files as paths: %s",
    (question) => {
      const context = createQueryPlanningContext({
        activePluginManifests: [{ languages: [{ id: "csharp", extensions: [" .CS "] }] }]
      });
      const targets = classifyQueryTargets(lexQuery(question), context);
      expect(targets.filter((target) => target.type === "path").map((target) => target.value)).toEqual([question.match(/Foo\.cs/i)?.[0] ?? "Foo.cs"]);
      expect(targets.filter((target) => target.type === "identifier")).toEqual([]);
    }
  );

  it.each(["File.ts", "View.tsx", "README.md", "schema.graphql"])("keeps built-in file recognition: %s", (question) => {
    expect(classified(question).filter((target) => target.type === "path")).toHaveLength(1);
  });
  it.each([
    ["api:/orders", { kind: "api", value: "/orders" }],
    ["POST:/orders", { kind: "api", value: "/orders", method: "POST" }],
    ["api:GET:/orders", { kind: "api", value: "/orders", method: "GET" }],
    ["GET：/orders", { kind: "api", value: "/orders", method: "GET" }],
    ["api：/orders", { kind: "api", value: "/orders" }],
    ["event:orders.created", { kind: "event", value: "orders.created" }],
    ["event：orders.created", { kind: "event", value: "orders.created" }],
    ["schema:OrderSchema", { kind: "schema", value: "OrderSchema" }],
    ["dto:OrderDto", { kind: "dto", value: "OrderDto" }],
    ["enum:OrderStatus", { kind: "enum", value: "OrderStatus" }]
  ])("classifies explicit target %s", (question, expected) => {
    const targets = classified(question).filter((target) => target.type === "contract");
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject(expected);
  });

  it.each([
    "https://example.com/docs",
    "Visit example.dev/docs",
    "Visit example.xyz/docs",
    "Visit tools.example.cloud/docs",
    "Visit localhost:3000/docs",
    "Visit 127.0.0.1/docs",
    "Visit [2001:db8::1]/docs",
    "release v1.2.3"
  ])("keeps URL, host, IP, and version lexical-only: %s", (question) => {
    expect(classified(question).filter((target) => target.type !== "ignored")).toEqual([]);
  });

  it("produces exactly one classification per non-empty span", () => {
    const spans = lexQuery("Open /workspace/logiclens and call api:GET:/orders");
    const targets = classifyQueryTargets(spans);
    expect(targets).toHaveLength(spans.length);
    expect(targets.every((target) => target.span.value.length > 0)).toBe(true);
  });
});
