import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import { repoId } from "../src/shared/path.js";

describe("parser", () => {
  it("extracts TypeScript classes, methods, imports, and calls", async () => {
    const repo = repoId("service-a");
    const parsed = await parseSourceFile({
      repoId: repo,
      absolutePath: path.resolve("tests/fixtures/service-a/src/OrderService.ts"),
      relativePath: "src/OrderService.ts",
      language: "typescript"
    });
    expect(parsed.imports.map((item) => item.module)).toContain("../../service-b/src/PaymentService");
    expect(parsed.symbols.map((item) => item.qualifiedName)).toContain("OrderService");
    expect(parsed.symbols.map((item) => item.qualifiedName)).toContain("OrderService.createOrder");
    expect(parsed.calls.map((item) => item.calleeName)).toContain("charge");
  });

  it("extracts JavaScript classes, functions, and calls", async () => {
    const repo = repoId("service-c");
    const parsed = await parseSourceFile({
      repoId: repo,
      absolutePath: path.resolve("tests/fixtures/service-c/src/InventoryService.js"),
      relativePath: "src/InventoryService.js",
      language: "javascript"
    });
    expect(parsed.symbols.map((item) => item.qualifiedName)).toContain("InventoryService");
    expect(parsed.symbols.map((item) => item.qualifiedName)).toContain("InventoryService.reserve");
    expect(parsed.symbols.map((item) => item.qualifiedName)).toContain("reserveInventory");
    expect(parsed.calls.map((item) => item.calleeName)).toContain("reserveInventory");
  });

  it("extracts JSX imports, components, and calls", async () => {
    const repo = repoId("service-c");
    const parsed = await parseSourceFile({
      repoId: repo,
      absolutePath: path.resolve("tests/fixtures/service-c/src/InventoryPanel.jsx"),
      relativePath: "src/InventoryPanel.jsx",
      language: "jsx"
    });
    expect(parsed.imports.map((item) => item.module)).toContain("./InventoryService");
    expect(parsed.symbols.map((item) => item.qualifiedName)).toContain("InventoryPanel");
    expect(parsed.calls.map((item) => item.calleeName)).toContain("reserve");
  });

  it("extracts Java classes, methods, imports, and calls", async () => {
    const repo = repoId("service-d");
    const parsed = await parseSourceFile({
      repoId: repo,
      absolutePath: path.resolve("tests/fixtures/service-d/src/OrderService.java"),
      relativePath: "src/OrderService.java",
      language: "java"
    });
    expect(parsed.imports.map((item) => item.module)).toContain("java.util.List");
    expect(parsed.imports.map((item) => item.module)).toContain("java.util.*");
    expect(parsed.imports.map((item) => item.module)).toContain("com.example.payments.PaymentService");
    // Since P0-3: qualifiedName now includes the Java package prefix
    expect(parsed.symbols.map((item) => item.qualifiedName)).toContain("com.example.orders.OrderService");
    expect(parsed.symbols.map((item) => item.qualifiedName)).toContain("com.example.orders.OrderService.createOrder");
    expect(parsed.symbols.map((item) => item.qualifiedName)).toContain("com.example.orders.Handler");
    expect(parsed.symbols.map((item) => item.qualifiedName)).toContain("com.example.orders.Status");
    expect(parsed.symbols.find((item) => item.name === "OrderService")?.id).toContain(":class:com.example.orders.OrderService:");
    expect(parsed.symbols.find((item) => item.name === "createOrder")?.id).toContain(":method:com.example.orders.OrderService.createOrder:");
    expect(parsed.calls.map((item) => item.calleeName)).toContain("charge");
    expect(parsed.calls.map((item) => item.calleeName)).toContain("Order");
    expect(parsed.facts?.packageName).toBe("com.example.orders");
    expect(parsed.facts?.imports.map((item) => item.module)).toContain("java.util.List");

  });

  it("extracts language facts for Java annotations", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-java-facts-"));
    const sourcePath = path.join(dir, "OrderController.java");
    await fs.writeFile(sourcePath, `package com.example.api;
 
 @RestController
 @RequestMapping(value = {"/orders", "/api/orders"}, method = RequestMethod.GET, headers = "key=val")
 public class OrderController {
   @GetMapping(value = "/{id}")
   public Order getOrder() { return null; }
 }
 `, "utf8");
 
    const parsed = await parseSourceFile({
      repoId: repoId("java-facts"),
      absolutePath: sourcePath,
      relativePath: "src/main/java/com/example/api/OrderController.java",
      language: "java"
    });
 
    expect(parsed.facts?.packageName).toBe("com.example.api");
    expect(parsed.facts?.annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ownerKind: "class",
        name: "RequestMapping",
        arguments: expect.arrayContaining([
          expect.objectContaining({ name: "value", value: '["/orders","/api/orders"]' }),
          expect.objectContaining({ name: "method", value: "RequestMethod.GET" }),
          expect.objectContaining({ name: "headers", value: "key=val" })
        ])
      }),
      expect.objectContaining({ ownerKind: "method", name: "GetMapping", arguments: [expect.objectContaining({ name: "value", value: "/{id}" })] })
    ]));
    const symbolIds = new Set(parsed.symbols.map((symbol) => symbol.id));
    expect(parsed.facts?.annotations.every((annotation) => !annotation.ownerSymbolId || symbolIds.has(annotation.ownerSymbolId))).toBe(true);
  });
 
  it("extracts language facts for TypeScript decorators and literals", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-ts-facts-"));
    const sourcePath = path.join(dir, "controller.ts");
    await fs.writeFile(sourcePath, `@Controller({ path: "/orders", version: ["v1", "v2"], count: 123, enabled: true })
 export class OrderController {
   @Get(":id")
   load() {
     return request("/orders/" + id, { retry: 3 });
   }
 }
 `, "utf8");
 
    const parsed = await parseSourceFile({
      repoId: repoId("ts-facts"),
      absolutePath: sourcePath,
      relativePath: "src/controller.ts",
      language: "typescript"
    });
 
    expect(parsed.facts?.decorators).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ownerKind: "class",
        name: "Controller",
        arguments: [{ path: "/orders", version: ["v1", "v2"], count: 123, enabled: true }]
      }),
      expect.objectContaining({ ownerKind: "method", name: "Get", arguments: [":id"] })
    ]));
    expect(parsed.facts?.literals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "string", value: "/orders/" }),
      expect.objectContaining({ kind: "number", value: "3" })
    ]));
  });

  it("extracts Markdown sections, links, and fenced code blocks as document data", async () => {
    const repo = repoId("service-b");
    const parsed = await parseSourceFile({
      repoId: repo,
      absolutePath: path.resolve("tests/fixtures/service-b/README.md"),
      relativePath: "README.md",
      language: "markdown"
    });
    expect(parsed.language).toBe("markdown");
    if (parsed.language !== "markdown") throw new Error("expected markdown document");
    expect(parsed.sections.map((section) => section.heading)).toContain("Events");
    const events = parsed.sections.find((section) => section.heading === "Events");
    expect(events?.text).toContain("OrderCreatedEvent");
    expect(events?.links[0]).toMatchObject({ text: "event source", target: "src/events/OrderCreatedEvent.ts" });
    expect(events?.codeBlocks[0]).toMatchObject({ language: "ts", text: "new OrderCreatedEvent(orderId)" });
  });

  it("extracts various import and export bindings via AST", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-import-ast-"));
    const sourcePath = path.join(dir, "imports.ts");
    await fs.writeFile(sourcePath, `
import { foo, bar as baz } from "mod-a";
import defaultName, * as ns from "mod-b";
import defaultName2, { named as alias } from "mod-c";
import "side-effect-mod";
import type { TypeA, TypeB as AliasB } from "mod-d";
import {
  multiLineA,
  // inline comment
  multiLineB as aliasB
} from "mod-e";
export { foo, bar as baz } from "mod-f";
export * from "mod-g";
export * as nsExport from "mod-h";
`, "utf8");

    const parsed = await parseSourceFile({
      repoId: repoId("import-ast"),
      absolutePath: sourcePath,
      relativePath: "src/imports.ts",
      language: "typescript"
    });

    const modA = parsed.imports.find(i => i.module === "mod-a");
    expect(modA?.bindings).toEqual([
      { localName: "foo", importedName: "foo", kind: "named" },
      { localName: "baz", importedName: "bar", kind: "named" }
    ]);

    const modB = parsed.imports.find(i => i.module === "mod-b");
    expect(modB?.bindings).toEqual([
      { localName: "defaultName", importedName: "default", kind: "default" },
      { localName: "ns", kind: "namespace" }
    ]);

    const modC = parsed.imports.find(i => i.module === "mod-c");
    expect(modC?.bindings).toEqual([
      { localName: "defaultName2", importedName: "default", kind: "default" },
      { localName: "alias", importedName: "named", kind: "named" }
    ]);

    const sideEffect = parsed.imports.find(i => i.module === "side-effect-mod");
    expect(sideEffect?.bindings).toEqual([]);

    const modD = parsed.imports.find(i => i.module === "mod-d");
    expect(modD?.bindings).toEqual([
      { localName: "TypeA", importedName: "TypeA", kind: "named" },
      { localName: "AliasB", importedName: "TypeB", kind: "named" }
    ]);

    const modE = parsed.imports.find(i => i.module === "mod-e");
    expect(modE?.bindings).toEqual([
      { localName: "multiLineA", importedName: "multiLineA", kind: "named" },
      { localName: "aliasB", importedName: "multiLineB", kind: "named" }
    ]);

    const modF = parsed.imports.find(i => i.module === "mod-f");
    expect(modF?.bindings).toEqual([
      { localName: "foo", importedName: "foo", kind: "named" },
      { localName: "baz", importedName: "bar", kind: "named" }
    ]);

    const modG = parsed.imports.find(i => i.module === "mod-g");
    expect(modG?.bindings).toEqual([
      { localName: "*", kind: "namespace" }
    ]);

    const modH = parsed.imports.find(i => i.module === "mod-h");
    expect(modH?.bindings).toEqual([
      { localName: "nsExport", kind: "namespace" }
    ]);
  });

  it("extracts structured receiver and argsCount details for JS/TS, Python, Java, and Go calls", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-call-ast-"));
    try {
      const repo = repoId("call-ast-test");
      
      // 1. TypeScript / JS
      const tsPath = path.join(tmpDir, "app.ts");
      await fs.writeFile(tsPath, `
        const result = logger.info("hello", 123);
        new Client().send(data);
      `, "utf8");
      
      const tsParsed = await parseSourceFile({
        repoId: repo,
        absolutePath: tsPath,
        relativePath: "app.ts",
        language: "typescript"
      });
      
      expect(tsParsed.calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ calleeName: "info", receiver: "logger", argsCount: 2 }),
        expect.objectContaining({ calleeName: "send", receiver: "new Client()", argsCount: 1 }),
        expect.objectContaining({ calleeName: "Client", receiver: undefined, argsCount: 0 })
      ]));

      // 2. Java
      const javaPath = path.join(tmpDir, "App.java");
      await fs.writeFile(javaPath, `
        package com.example;
        public class App {
          public void run() {
            paymentService.charge(orderId, amount);
            new Order(id);
          }
        }
      `, "utf8");
      
      const javaParsed = await parseSourceFile({
        repoId: repo,
        absolutePath: javaPath,
        relativePath: "App.java",
        language: "java"
      });
      
      expect(javaParsed.calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ calleeName: "charge", receiver: "paymentService", argsCount: 2 }),
        expect.objectContaining({ calleeName: "Order", receiver: undefined, argsCount: 1 })
      ]));

      // 3. Python
      const pyPath = path.join(tmpDir, "app.py");
      await fs.writeFile(pyPath, `
client.send_message("hello", topic="news")
math.ceil(3.5)
      `, "utf8");
      
      const pyParsed = await parseSourceFile({
        repoId: repo,
        absolutePath: pyPath,
        relativePath: "app.py",
        language: "python"
      });
      
      expect(pyParsed.calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ calleeName: "send_message", receiver: "client", argsCount: 2 }),
        expect.objectContaining({ calleeName: "ceil", receiver: "math", argsCount: 1 })
      ]));

      // 4. Go
      const goPath = path.join(tmpDir, "app.go");
      await fs.writeFile(goPath, `
        package main
        func main() {
          logger.Printf("error: %v", err)
          doSomething()
        }
      `, "utf8");
      
      const goParsed = await parseSourceFile({
        repoId: repo,
        absolutePath: goPath,
        relativePath: "app.go",
        language: "go"
      });
      
      expect(goParsed.calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ calleeName: "Printf", receiver: "logger", argsCount: 2 }),
        expect.objectContaining({ calleeName: "doSomething", receiver: undefined, argsCount: 0 })
      ]));

    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
