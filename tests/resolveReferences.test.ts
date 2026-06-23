import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCalls, resolveImports } from "../src/extractors/resolveReferences.js";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import type { CodeSymbol, ParsedFile } from "../src/parsers/types.js";
import { fileId, repoId } from "../src/utils/path.js";

describe("resolveReferences", () => {
  function parsedFile(repoIdValue: string, relativePath: string, imports: ParsedFile["imports"] = []): ParsedFile {
    return {
      repoId: repoIdValue,
      fileId: fileId(repoIdValue, relativePath),
      path: relativePath,
      language: "typescript",
      hash: `${repoIdValue}:${relativePath}:hash`,
      loc: 1,
      imports,
      symbols: [],
      calls: []
    };
  }

  function symbol(repoIdValue: string, relativePath: string, kind: CodeSymbol["kind"], name: string, startLine: number, endLine: number): CodeSymbol {
    return {
      id: `code:${repoIdValue}:${relativePath}:${kind}:${name}:${startLine}`,
      repoId: repoIdValue,
      fileId: fileId(repoIdValue, relativePath),
      kind,
      name,
      qualifiedName: kind === "method" ? `Owner.${name}` : name,
      startLine,
      endLine,
      signature: `${name}()`,
      source: "",
      hash: `${name}:hash`
    };
  }

  it("resolves relative imports only within the importing repository", () => {
    const repoA = repoId("his-fontend");
    const repoB = repoId("other-frontend");
    const appFile = parsedFile(repoA, "src/app.ts", [{
      fileId: fileId(repoA, "src/app.ts"),
      module: "./router",
      raw: 'import router from "./router";',
      line: 1
    }]);
    const samePathInAnotherRepo = parsedFile(repoB, "src/router.tsx");

    expect(resolveImports([appFile, samePathInAnotherRepo])).toEqual([]);
  });

  it("keeps same-repository relative import resolution", () => {
    const repo = repoId("his-fontend");
    const appFile = parsedFile(repo, "src/app.ts", [{
      fileId: fileId(repo, "src/app.ts"),
      module: "./router",
      raw: 'import router from "./router";',
      line: 1
    }]);
    const routerFile = parsedFile(repo, "src/router.tsx");

    expect(resolveImports([appFile, routerFile])).toEqual([{
      fromFileId: appFile.fileId,
      toFileId: routerFile.fileId,
      module: "./router",
      raw: 'import router from "./router";'
    }]);
  });

  it("marks same-file lexical calls as exact", () => {
    const repo = repoId("service-a");
    const file = parsedFile(repo, "src/orders.ts");
    const caller = symbol(repo, "src/orders.ts", "function", "submitOrder", 1, 10);
    const callee = symbol(repo, "src/orders.ts", "function", "validateOrder", 12, 16);
    file.symbols = [caller, callee];
    file.calls = [{
      callerSymbolId: caller.id,
      calleeName: "validateOrder",
      raw: "validateOrder(order)",
      fileId: file.fileId,
      line: 4
    }];

    expect(resolveCalls([file])).toEqual([expect.objectContaining({
      fromCodeId: caller.id,
      toCodeId: callee.id,
      confidence: 0.9,
      resolution: "exact"
    })]);
  });

  it("uses relative import evidence for probable cross-file calls", () => {
    const repo = repoId("service-a");
    const appFile = parsedFile(repo, "src/app.ts", [{
      fileId: fileId(repo, "src/app.ts"),
      module: "./payment",
      raw: 'import { charge } from "./payment";',
      line: 1,
      bindings: [{ localName: "charge", importedName: "charge", kind: "named" }]
    }]);
    const paymentFile = parsedFile(repo, "src/payment.ts");
    const caller = symbol(repo, "src/app.ts", "function", "checkout", 1, 8);
    const callee = symbol(repo, "src/payment.ts", "function", "charge", 1, 3);
    appFile.symbols = [caller];
    paymentFile.symbols = [callee];
    appFile.calls = [{ callerSymbolId: caller.id, calleeName: "charge", raw: "charge(order)", fileId: appFile.fileId, line: 4 }];

    expect(resolveCalls([appFile, paymentFile])).toEqual([expect.objectContaining({
      toCodeId: callee.id,
      confidence: 0.8,
      resolution: "probable"
    })]);
  });

  it("resolves named import aliases without treating same-name unrelated symbols as exact", () => {
    const repo = repoId("service-a");
    const appFile = parsedFile(repo, "src/app.ts", [{
      fileId: fileId(repo, "src/app.ts"),
      module: "./payment",
      raw: 'import { charge as pay } from "./payment";',
      line: 1,
      bindings: [{ localName: "pay", importedName: "charge", kind: "named" }]
    }]);
    const paymentFile = parsedFile(repo, "src/payment.ts");
    const localUtilityFile = parsedFile(repo, "src/local.ts");
    const caller = symbol(repo, "src/app.ts", "function", "checkout", 1, 8);
    const importedCharge = symbol(repo, "src/payment.ts", "function", "charge", 1, 3);
    const unrelatedPay = symbol(repo, "src/local.ts", "function", "pay", 1, 3);
    appFile.symbols = [caller];
    paymentFile.symbols = [importedCharge];
    localUtilityFile.symbols = [unrelatedPay];
    appFile.calls = [{ callerSymbolId: caller.id, calleeName: "pay", raw: "pay(order)", fileId: appFile.fileId, line: 4 }];

    expect(resolveCalls([appFile, paymentFile, localUtilityFile])).toEqual([expect.objectContaining({
      toCodeId: importedCharge.id,
      confidence: 0.8,
      resolution: "probable"
    })]);
  });

  it("follows one-hop barrel re-exports for probable call resolution", () => {
    const repo = repoId("service-a");
    const appFile = parsedFile(repo, "src/app.ts", [{
      fileId: fileId(repo, "src/app.ts"),
      module: "./api",
      raw: 'import { charge } from "./api";',
      line: 1,
      bindings: [{ localName: "charge", importedName: "charge", kind: "named" }]
    }]);
    const barrelFile = parsedFile(repo, "src/api.ts", [{
      fileId: fileId(repo, "src/api.ts"),
      module: "./payment",
      raw: 'export { charge } from "./payment";',
      line: 1,
      bindings: [{ localName: "charge", importedName: "charge", kind: "named" }]
    }]);
    const paymentFile = parsedFile(repo, "src/payment.ts");
    const caller = symbol(repo, "src/app.ts", "function", "checkout", 1, 8);
    const callee = symbol(repo, "src/payment.ts", "function", "charge", 1, 3);
    appFile.symbols = [caller];
    paymentFile.symbols = [callee];
    appFile.calls = [{ callerSymbolId: caller.id, calleeName: "charge", raw: "charge(order)", fileId: appFile.fileId, line: 4 }];

    expect(resolveCalls([appFile, barrelFile, paymentFile])).toEqual([expect.objectContaining({
      toCodeId: callee.id,
      confidence: 0.8,
      resolution: "probable"
    })]);
  });

  it("prefers imported same-name classes over unrelated same-repository classes", () => {
    const repo = repoId("service-a");
    const appFile = parsedFile(repo, "src/app.ts", [{
      fileId: fileId(repo, "src/app.ts"),
      module: "./clients/payment",
      raw: 'import { PaymentClient } from "./clients/payment";',
      line: 1,
      bindings: [{ localName: "PaymentClient", importedName: "PaymentClient", kind: "named" }]
    }]);
    const paymentClientFile = parsedFile(repo, "src/clients/payment.ts");
    const legacyClientFile = parsedFile(repo, "src/legacy/payment.ts");
    const caller = symbol(repo, "src/app.ts", "function", "checkout", 1, 8);
    const importedClient = symbol(repo, "src/clients/payment.ts", "class", "PaymentClient", 1, 20);
    const unrelatedClient = symbol(repo, "src/legacy/payment.ts", "class", "PaymentClient", 1, 20);
    appFile.symbols = [caller];
    paymentClientFile.symbols = [importedClient];
    legacyClientFile.symbols = [unrelatedClient];
    appFile.calls = [{ callerSymbolId: caller.id, calleeName: "PaymentClient", raw: "new PaymentClient()", fileId: appFile.fileId, line: 4 }];

    expect(resolveCalls([appFile, legacyClientFile, paymentClientFile])).toEqual([expect.objectContaining({
      toCodeId: importedClient.id,
      confidence: 0.8,
      resolution: "probable"
    })]);
  });

  it("keeps name-only cross-file calls heuristic", () => {
    const repoA = repoId("service-a");
    const repoB = repoId("service-b");
    const callerFile = parsedFile(repoA, "src/app.ts");
    const calleeFile = parsedFile(repoB, "src/payment.ts");
    const caller = symbol(repoA, "src/app.ts", "function", "checkout", 1, 8);
    const callee = symbol(repoB, "src/payment.ts", "function", "charge", 1, 3);
    callerFile.symbols = [caller];
    calleeFile.symbols = [callee];
    callerFile.calls = [{ callerSymbolId: caller.id, calleeName: "charge", raw: "charge(order)", fileId: callerFile.fileId, line: 4 }];

    expect(resolveCalls([callerFile, calleeFile])).toEqual([expect.objectContaining({
      toCodeId: callee.id,
      confidence: 0.4,
      resolution: "heuristic"
    })]);
  });

  it("uses TypeScript compiler API when source files are available", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-ts-compiler-"));
    try {
      const repo = repoId("service-a");
      const srcDir = path.join(tmpDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "payment.ts"), "export function charge() { return true; }\n", "utf8");
      await fs.writeFile(path.join(srcDir, "app.ts"), "import { charge as pay } from \"./payment\";\nexport function checkout() { return pay(); }\n", "utf8");

      const appFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(srcDir, "app.ts"),
        relativePath: "src/app.ts",
        language: "typescript"
      });
      const paymentFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(srcDir, "payment.ts"),
        relativePath: "src/payment.ts",
        language: "typescript"
      });

      expect(resolveCalls([appFile as ParsedFile, paymentFile as ParsedFile])).toEqual([expect.objectContaining({
        confidence: 0.95,
        resolution: "exact",
        raw: "pay()"
      })]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses Java package/import/class and method signature signals", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-java-resolve-"));
    try {
      const repo = repoId("service-java");
      const ordersDir = path.join(tmpDir, "src", "main", "java", "com", "example", "orders");
      const paymentsDir = path.join(tmpDir, "src", "main", "java", "com", "example", "payments");
      await fs.mkdir(ordersDir, { recursive: true });
      await fs.mkdir(paymentsDir, { recursive: true });
      await fs.writeFile(path.join(paymentsDir, "PaymentService.java"), [
        "package com.example.payments;",
        "public class PaymentService {",
        "  public boolean charge(String orderId, int cents) { return true; }",
        "  public boolean charge(String orderId) { return true; }",
        "}"
      ].join("\n"), "utf8");
      await fs.writeFile(path.join(ordersDir, "OrderService.java"), [
        "package com.example.orders;",
        "import com.example.payments.PaymentService;",
        "public class OrderService {",
        "  private final PaymentService paymentService = new PaymentService();",
        "  public boolean createOrder(String orderId) {",
        "    return paymentService.charge(orderId);",
        "  }",
        "}"
      ].join("\n"), "utf8");

      const orderFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(ordersDir, "OrderService.java"),
        relativePath: "src/main/java/com/example/orders/OrderService.java",
        language: "java"
      }) as ParsedFile;
      const paymentFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(paymentsDir, "PaymentService.java"),
        relativePath: "src/main/java/com/example/payments/PaymentService.java",
        language: "java"
      }) as ParsedFile;
      const oneArgCharge = paymentFile.symbols.find((symbol) => symbol.name === "charge" && symbol.signature.includes("String orderId)"));

      expect(resolveCalls([orderFile, paymentFile])).toEqual(expect.arrayContaining([expect.objectContaining({
        toCodeId: oneArgCharge?.id,
        confidence: 0.95,
        resolution: "exact",
        raw: "paymentService.charge(orderId)"
      })]));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses Python module imports for exact module-level function calls", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-python-resolve-"));
    try {
      const repo = repoId("service-python");
      const pkgDir = path.join(tmpDir, "orders");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(path.join(pkgDir, "payment.py"), "def charge(order_id):\n    return True\n", "utf8");
      await fs.writeFile(path.join(pkgDir, "app.py"), "from .payment import charge as pay\n\ndef checkout(order_id):\n    return pay(order_id)\n", "utf8");

      const appFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(pkgDir, "app.py"),
        relativePath: "orders/app.py",
        language: "python"
      }) as ParsedFile;
      const paymentFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(pkgDir, "payment.py"),
        relativePath: "orders/payment.py",
        language: "python"
      }) as ParsedFile;
      const charge = paymentFile.symbols.find((symbol) => symbol.name === "charge");

      expect(resolveCalls([appFile, paymentFile])).toEqual(expect.arrayContaining([expect.objectContaining({
        toCodeId: charge?.id,
        confidence: 0.95,
        resolution: "exact",
        raw: "pay(order_id)"
      })]));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves various Python AST import types (multi-imports, aliased imports, relative imports, wildcard)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-python-ast-resolve-"));
    try {
      const repo = repoId("service-python-ast");
      const pkgDir = path.join(tmpDir, "app");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(path.join(pkgDir, "math_utils.py"), "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n", "utf8");
      await fs.writeFile(path.join(pkgDir, "main.py"), "import math_utils as mu\nfrom .math_utils import add, sub\nfrom .math_utils import *\n\ndef run():\n    mu.add(1, 2)\n    sub(3, 4)\n", "utf8");

      const utilsFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(pkgDir, "math_utils.py"),
        relativePath: "app/math_utils.py",
        language: "python"
      }) as ParsedFile;
      
      const mainFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(pkgDir, "main.py"),
        relativePath: "app/main.py",
        language: "python"
      }) as ParsedFile;

      const addSymbol = utilsFile.symbols.find((symbol) => symbol.name === "add");
      const subSymbol = utilsFile.symbols.find((symbol) => symbol.name === "sub");

      const resolved = resolveCalls([mainFile, utilsFile]);

      // Check aliased import resolve (mu.add)
      expect(resolved).toEqual(expect.arrayContaining([expect.objectContaining({
        toCodeId: addSymbol?.id,
        confidence: 0.95,
        resolution: "exact",
        raw: "mu.add(1, 2)"
      })]));

      // Check named relative import resolve (sub)
      expect(resolved).toEqual(expect.arrayContaining([expect.objectContaining({
        toCodeId: subSymbol?.id,
        confidence: 0.95,
        resolution: "exact",
        raw: "sub(3, 4)"
      })]));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses Go import packages for exact package-level function calls", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-go-resolve-"));
    try {
      const repo = repoId("service-go");
      const appDir = path.join(tmpDir, "cmd", "app");
      const paymentDir = path.join(tmpDir, "pkg", "payment");
      await fs.mkdir(appDir, { recursive: true });
      await fs.mkdir(paymentDir, { recursive: true });
      await fs.writeFile(path.join(paymentDir, "payment.go"), "package payment\n\nfunc Charge(orderID string) bool { return true }\n", "utf8");
      await fs.writeFile(path.join(appDir, "main.go"), "package main\n\nimport \"example.com/service/pkg/payment\"\n\nfunc Checkout(orderID string) bool {\n    return payment.Charge(orderID)\n}\n", "utf8");

      const appFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(appDir, "main.go"),
        relativePath: "cmd/app/main.go",
        language: "go"
      }) as ParsedFile;
      const paymentFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(paymentDir, "payment.go"),
        relativePath: "pkg/payment/payment.go",
        language: "go"
      }) as ParsedFile;
      const charge = paymentFile.symbols.find((symbol) => symbol.name === "Charge");

      expect(resolveCalls([appFile, paymentFile])).toEqual(expect.arrayContaining([expect.objectContaining({
        toCodeId: charge?.id,
        confidence: 0.95,
        resolution: "exact",
        raw: "payment.Charge(orderID)"
      })]));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves Java variables using AST with block-scoped shadowing, multi-declarations, and comment safety", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-java-variables-"));
    try {
      const repo = repoId("java-variables-test");
      const srcDir = path.join(tmpDir, "src", "main", "java", "com", "example");
      await fs.mkdir(srcDir, { recursive: true });

      // Create PaymentService and other services to resolve to
      await fs.writeFile(path.join(srcDir, "PaymentService.java"), [
        "package com.example;",
        "public class PaymentService {",
        "  public void charge() {}",
        "}"
      ].join("\n"), "utf8");

      await fs.writeFile(path.join(srcDir, "MockService.java"), [
        "package com.example;",
        "public class MockService {",
        "  public void charge() {}",
        "}"
      ].join("\n"), "utf8");

      // Main Service under test
      await fs.writeFile(path.join(srcDir, "OrderService.java"), [
        "package com.example;",
        "public class OrderService {",
        "  // 1. Field declaration",
        "  private PaymentService paymentService = new PaymentService();",
        "  private MockService mock1, mock2;",
        "",
        "  public void runShadow() {",
        "    // 2. Local variable shadowing",
        "    MockService paymentService = new MockService();",
        "    paymentService.charge();",
        "  }",
        "",
        "  public void runField() {",
        "    // 3. Using class field (no shadow)",
        "    paymentService.charge();",
        "  }",
        "  ",
        "  public void runComments() {",
        "    // MockService paymentService = new MockService();",
        "    /*",
        "      MockService paymentService = new MockService();",
        "    */",
        "    paymentService.charge();",
        "  }",
        "}"
      ].join("\n"), "utf8");

      const paymentFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(srcDir, "PaymentService.java"),
        relativePath: "src/main/java/com/example/PaymentService.java",
        language: "java"
      }) as ParsedFile;

      const mockFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(srcDir, "MockService.java"),
        relativePath: "src/main/java/com/example/MockService.java",
        language: "java"
      }) as ParsedFile;

      const orderFile = await parseSourceFile({
        repoId: repo,
        absolutePath: path.join(srcDir, "OrderService.java"),
        relativePath: "src/main/java/com/example/OrderService.java",
        language: "java"
      }) as ParsedFile;

      const paymentCharge = paymentFile.symbols.find((s) => s.name === "charge");
      const mockCharge = mockFile.symbols.find((s) => s.name === "charge");

      const resolved = resolveCalls([paymentFile, mockFile, orderFile]);

      // Assertions:
      // - runShadow()'s call to paymentService.charge() resolves to MockService's charge method
      const shadowCall = resolved.find((r) => r.fromCodeId.includes("runShadow") && r.raw.includes("paymentService.charge()"));
      expect(shadowCall?.toCodeId).toBe(mockCharge?.id);

      // - runField()'s call to paymentService.charge() resolves to PaymentService's charge method (uses class field)
      const fieldCall = resolved.find((r) => r.fromCodeId.includes("runField") && r.raw.includes("paymentService.charge()"));
      expect(fieldCall?.toCodeId).toBe(paymentCharge?.id);

      // - runComments()'s call to paymentService.charge() resolves to PaymentService's charge method (ensures commented-out variables are ignored)
      const commentCall = resolved.find((r) => r.fromCodeId.includes("runComments") && r.raw.includes("paymentService.charge()"));
      expect(commentCall?.toCodeId).toBe(paymentCharge?.id);

    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
