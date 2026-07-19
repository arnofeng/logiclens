import { describe, expect, it } from "vitest";
import { BUILTIN_PARSER_EXTENSION_METADATA } from "../src/core/parsing/extensionMetadata.js";
import { builtinLanguageForPath } from "../src/core/parsing/parserRegistry.js";
import { MAX_LEXICAL_QUERY_CODE_POINTS, planQuestion, type ContractTarget, type RetrievalRoute } from "../src/features/ask/planner.js";
import { createQueryPlanningContext } from "../src/features/ask/planningContext.js";

type MatrixRow = {
  question: string;
  identifiers?: string[];
  paths?: string[];
  contracts?: ContractTarget[];
};

const MATRIX: MatrixRow[] = [
  { question: "Don't assume it's cached" },
  { question: "What's the user's class?" },
  { question: "Explain \"how orders are created\"" },
  { question: "Explain \"foo'" },
  { question: "Where is class \"parse\" defined?", identifiers: ["parse"] },
  { question: "Find OrderService and pkg.Order", identifiers: ["OrderService", "pkg.Order"] },
  { question: "Find Order class", identifiers: ["Order"] },
  { question: "Find Foo symbol", identifiers: ["Foo"] },
  { question: "base class primary class main function" },
  { question: "显示 主要 类" },
  { question: "显示 默认 架构" },
  { question: "查找 通用 事件" },
  { question: "Who consumes \"order\" event?", contracts: [{ kind: "event", value: "order" }] },
  { question: "Show \"order\" schema", contracts: [{ kind: "schema", value: "order" }] },
  { question: "Find orders.created event", contracts: [{ kind: "event", value: "orders.created" }] },
  { question: "Find order-created event", contracts: [{ kind: "event", value: "order-created" }] },
  { question: "Find order_created event", contracts: [{ kind: "event", value: "order_created" }] },
  { question: "Show OrderSchema", contracts: [{ kind: "schema", value: "OrderSchema" }] },
  { question: "Find dto:OrderDto enum:OrderStatus", contracts: [{ kind: "dto", value: "OrderDto" }, { kind: "enum", value: "OrderStatus" }] },
  { question: "显示 \"订单创建\" 事件", contracts: [{ kind: "event", value: "订单创建" }] },
  { question: "显示 “订单创建” 事件", contracts: [{ kind: "event", value: "订单创建" }] },
  { question: "显示 ‘订单创建’ 事件", contracts: [{ kind: "event", value: "订单创建" }] },
  { question: "显示《订单创建》事件", contracts: [{ kind: "event", value: "订单创建" }] },
  { question: "显示 订单创建 事件" },
  { question: "Open \"docs/My File.md\"", paths: ["docs/My File.md"] },
  { question: "Open \"/workspace/logiclens\"", paths: ["/workspace/logiclens"] },
  { question: "Inspect /custom/project", paths: ["/custom/project"] },
  { question: "Open C:\\work\\logiclens\\src\\main.ts", paths: ["C:\\work\\logiclens\\src\\main.ts"] },
  { question: "Read \\\\server\\share\\项目\\配置.yaml", paths: ["\\\\server\\share\\项目\\配置.yaml"] },
  { question: "Open ../src/index.ts", paths: ["../src/index.ts"] },
  { question: "Open ~/项目/说明.md", paths: ["~/项目/说明.md"] },
  { question: "Open src/components", paths: ["src/components"] },
  { question: "Inspect docs/generated output", paths: ["docs/generated"] },
  { question: "Open \"docs/Generated Output\"", paths: ["docs/Generated Output"] },
  { question: "打开 /workspace/project", paths: ["/workspace/project"] },
  { question: "查看 src/components", paths: ["src/components"] },
  { question: "文件 /workspace/project", paths: ["/workspace/project"] },
  { question: "/workspace/project 路径", paths: ["/workspace/project"] },
  { question: "读取 \"docs/Generated Output\"", paths: ["docs/Generated Output"] },
  { question: "然后打开 /workspace/project", paths: ["/workspace/project"] },
  { question: "Who calls \"/smart/backorder\"", contracts: [{ kind: "api", value: "/smart/backorder" }] },
  { question: "Who calls /data/export", contracts: [{ kind: "api", value: "/data/export" }] },
  { question: "Query /project/status endpoint", contracts: [{ kind: "api", value: "/project/status" }] },
  { question: "GET \"/home/users\"", contracts: [{ kind: "api", value: "/home/users", method: "GET" }] },
  { question: "Send POST to /orders", contracts: [{ kind: "api", value: "/orders", method: "POST" }] },
  { question: "GET request to /orders", contracts: [{ kind: "api", value: "/orders", method: "GET" }] },
  { question: "查询（/orders）", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "谁调用 /orders？", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "endpoint /orders", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "Endpoint /orders", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "route /orders", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "接口 /orders", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "端点 /orders", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "API /orders", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "api /orders", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "API endpoint /orders", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "然后调用 /orders", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "/orders 接口", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "/orders API", contracts: [{ kind: "api", value: "/orders" }] },
  {
    question: "打开 /workspace/project 然后调用 /orders",
    paths: ["/workspace/project"],
    contracts: [{ kind: "api", value: "/orders" }]
  },
  { question: "GET：/orders", contracts: [{ kind: "api", value: "/orders", method: "GET" }] },
  { question: "api：/orders", contracts: [{ kind: "api", value: "/orders" }] },
  { question: "event：orders.created", contracts: [{ kind: "event", value: "orders.created" }] },
  {
    question: "Open /workspace/project and call /orders",
    paths: ["/workspace/project"],
    contracts: [{ kind: "api", value: "/orders" }]
  },
  {
    question: "GET request to /orders and POST request to /users",
    contracts: [
      { kind: "api", value: "/orders", method: "GET" },
      { kind: "api", value: "/users", method: "POST" }
    ]
  },
  {
    question: "Open /workspace/project call /orders",
    paths: ["/workspace/project"],
    contracts: [{ kind: "api", value: "/orders" }]
  },
  { question: "Open /first /second", paths: ["/first"] },
  { question: "GET /first /second", contracts: [{ kind: "api", value: "/first", method: "GET" }] },
  { question: "/first endpoint /second", contracts: [{ kind: "api", value: "/second" }] },
  {
    question: "Open /workspace/project, API /orders",
    paths: ["/workspace/project"],
    contracts: [{ kind: "api", value: "/orders" }]
  },
  {
    question: "Open /workspace/project，接口 /orders",
    paths: ["/workspace/project"],
    contracts: [{ kind: "api", value: "/orders" }]
  },
  {
    question: "API /first API /second",
    contracts: [
      { kind: "api", value: "/first" },
      { kind: "api", value: "/second" }
    ]
  },
  {
    question: "Open /workspace/project endpoint /orders",
    paths: ["/workspace/project"],
    contracts: [{ kind: "api", value: "/orders" }]
  },
  {
    question: "GET /first POST /second",
    contracts: [
      { kind: "api", value: "/first", method: "GET" },
      { kind: "api", value: "/second", method: "POST" }
    ]
  },
  {
    question: "\"order\" event \"customer\" schema",
    contracts: [
      { kind: "event", value: "order" },
      { kind: "schema", value: "customer" }
    ]
  },
  { question: "api:GET:/orders", contracts: [{ kind: "api", value: "/orders", method: "GET" }] },
  { question: "/custom/value" },
  { question: "Visit example.xyz/docs" },
  { question: "Visit tools.example.cloud/docs" },
  { question: "Check schema.graphql", paths: ["schema.graphql"] },
  { question: "Open event.json", paths: ["event.json"] },
  { question: "Open enum.ts", paths: ["enum.ts"] },
  { question: "Open class.ts", paths: ["class.ts"] },
  { question: "Visit localhost:3000/docs" },
  { question: "release v1.2.3" }
];

describe("query planner classification matrix", () => {
  it.each(MATRIX)("classifies $question without extra targets", ({ question, identifiers = [], paths = [], contracts = [] }) => {
    const plan = planQuestion(question);
    const routes: RetrievalRoute[] = [
      ...(identifiers.length > 0 || paths.length > 0 ? ["exact" as const] : []),
      ...(contracts.length > 0 ? ["contract" as const] : []),
      "entity",
      "lexical",
      "graph",
      "semantic"
    ];
    expect(plan.exactIdentifiers).toEqual(identifiers);
    expect(plan.paths).toEqual(paths);
    expect(plan.contractTargets).toEqual(contracts);
    expect(plan.enabledRoutes).toEqual(routes);
  });

  it("preserves stable ordering and stable deduplication", () => {
    const plan = planQuestion("OrderService api:/orders OrderService api:/orders OtherService");
    expect(plan.exactIdentifiers).toEqual(["OrderService", "OtherService"]);
    expect(plan.contractTargets).toEqual([{ kind: "api", value: "/orders" }]);
    expect(plan.enabledRoutes).toEqual(["exact", "contract", "entity", "lexical", "graph", "semantic"]);
  });

  it("normalizes, bounds, and code-point truncates lexical queries", () => {
    const composed = planQuestion("  Cafe\u0301\n\tOrderService  ");
    expect(composed.normalizedLexicalQuery).toBe("Café OrderService");
    const long = planQuestion(`question ${"😀".repeat(MAX_LEXICAL_QUERY_CODE_POINTS + 20)}`);
    expect([...long.normalizedLexicalQuery]).toHaveLength(MAX_LEXICAL_QUERY_CODE_POINTS);
    expect(/^[\s\S]*$/u.test(long.normalizedLexicalQuery)).toBe(true);
    expect(long.normalizedLexicalQuery.codePointAt(long.normalizedLexicalQuery.length - 2)).toBe(0x1f600);
  });

  it("enables no route for blank input and keeps budgets bounded", () => {
    const plan = planQuestion(" \n\t ");
    expect(plan.enabledRoutes).toEqual([]);
    expect(plan.terms).toEqual([]);
    expect(plan.budgets).toEqual({
      exact: { limit: 20 },
      contract: { limit: 20 },
      entity: { limit: 30 },
      lexical: { limit: 20 },
      graph: { limit: 40 },
      semantic: { limit: 10 }
    });
    expect(Object.values(plan.budgets).every(({ limit }) => Number.isInteger(limit) && limit > 0 && limit <= 100)).toBe(true);
  });

  it("is deterministic and does not mutate its input-derived output", () => {
    const first = planQuestion("Who calls /orders?");
    const second = planQuestion("Who calls /orders?");
    expect(first).toEqual(second);
    first.exactIdentifiers.push("mutation");
    expect(second.exactIdentifiers).toEqual([]);
  });
});

describe("parser extension metadata", () => {
  it.each(BUILTIN_PARSER_EXTENSION_METADATA.flatMap((entry) => entry.extensions.map((extension) => [entry.language, extension] as const)))(
    "keeps %s %s wired into parser path detection",
    (language, extension) => {
      expect(builtinLanguageForPath(`fixture${extension}`)).toBe(language);
    }
  );

  it("uses an immutable and deterministic active plugin extension snapshot", () => {
    const manifestExtensions = [" CS ", "bad/path", "", ".CS"];
    const parserExtensions = [".razor", " cshtml "];
    const context = createQueryPlanningContext({
      activePluginManifests: [{ languages: [{ id: "csharp", extensions: manifestExtensions }] }],
      activeParsers: [{ extensions: parserExtensions, scopeRepoId: "repo:active" }],
      repoIds: ["repo:active"]
    });
    const serialized = JSON.stringify(context);
    manifestExtensions.push(".foreign");
    parserExtensions.push(".mutated");

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.fileExtensions)).toBe(true);
    expect(context.fileExtensions).toContain(".cs");
    expect(context.fileExtensions).toContain(".razor");
    expect(context.fileExtensions).toContain(".cshtml");
    expect(context.fileExtensions).not.toContain("bad/path");
    expect(JSON.stringify(context)).toBe(serialized);
    expect(createQueryPlanningContext({ activePluginManifests: [{ languages: [{ id: "csharp", extensions: [".CS"] }] }] })).toEqual(
      createQueryPlanningContext({ activePluginManifests: [{ languages: [{ id: "csharp", extensions: ["cs"] }] }] })
    );
  });

  it("does not include foreign scoped parsers", () => {
    const context = createQueryPlanningContext({
      activeParsers: [
        { extensions: [".owned"], scopeRepoId: "repo:owned" },
        { extensions: [".foreign"], scopeRepoId: "repo:foreign" }
      ],
      repoIds: ["repo:owned"]
    });
    expect(context.fileExtensions).toContain(".owned");
    expect(context.fileExtensions).not.toContain(".foreign");
  });
});
