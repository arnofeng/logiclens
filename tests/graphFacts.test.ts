import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraphFactsBatch } from "../src/graph/facts.js";
import { stageGraphFactsAsCsv } from "../src/graph/csvStaging.js";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import type { ParsedFile, RepoNode } from "../src/parsers/types.js";
import { fileId, repoId } from "../src/shared/path.js";

describe("graph facts batch", () => {
  function parsedFile(repo: RepoNode, relativePath: string, imports: ParsedFile["imports"] = []): ParsedFile {
    return {
      repoId: repo.id,
      fileId: fileId(repo.id, relativePath),
      path: relativePath,
      language: "typescript",
      hash: `${repo.id}:${relativePath}:hash`,
      loc: 1,
      imports,
      symbols: [],
      calls: []
    };
  }

  it("builds stable facts before writing to a graph database", async () => {
    const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
    const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
    const parsed = await Promise.all([
      parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
      parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" })
    ]);

    const facts = await buildGraphFactsBatch({ batchId: "batch:test", indexedAt: "indexed", repos: [repoA, repoB], parsedFiles: parsed, semantic: true });

    expect(facts.files).toHaveLength(2);
    expect(facts.code.length).toBeGreaterThan(0);
    expect(facts.evidence.every((evidence) => evidence.batchId === "batch:test" && evidence.active === true)).toBe(true);
    expect(facts.repoContracts.some((edge) => edge.batchId === "batch:test")).toBe(true);
    expect(facts.repoDependencies.some((edge) => edge.dependencyType === "api")).toBe(true);
    expect(facts.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "api", key: "POST:/mall/mgr/entireorder/list" }),
      expect.objectContaining({ kind: "api", key: "POST:/mall/mgr/entireorder/{userid}/getdetail" }),
      expect.objectContaining({ kind: "api", key: "POST:/wechatassistant/public/sid/v2/getappconfigstatus" }),
      expect.objectContaining({ kind: "api", key: "POST:/api3/merchant/backstage/service/clientapplication/querycappbybosid" }),
      expect.objectContaining({ kind: "api", key: "POST:/mall/mgr/exact/querypagepromotionlist" })
    ]));
    expect(facts.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "http-client-api-consumer", raw: 'request.post("/mall/mgr/entireOrder/list", { userId })' })
    ]));
    expect(facts.contains).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromId: repoA.id, toId: parsed[0].fileId })
    ]));
  });

  it("treats workspace package manifests as packages owned by the outer repo", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-monorepo-facts-"));
    const monorepoPath = path.join(dir, "saas-fe-react-mall-common");
    const consumerPath = path.join(dir, "saas-fe-react-mall");
    await fs.mkdir(path.join(monorepoPath, "packages", "ec-browse-not-buy"), { recursive: true });
    await fs.mkdir(consumerPath, { recursive: true });
    await fs.writeFile(path.join(monorepoPath, "package.json"), JSON.stringify({
      private: true,
      workspaces: { packages: ["packages/*"] }
    }, null, 2), "utf8");
    await fs.writeFile(path.join(monorepoPath, "packages", "ec-browse-not-buy", "package.json"), JSON.stringify({
      name: "@weimobfe/ec-browse-not-buy",
      version: "1.0.9",
      dependencies: {
        "@weimobfe/ec-utils": "1.0.172"
      }
    }, null, 2), "utf8");
    await fs.writeFile(path.join(consumerPath, "package.json"), JSON.stringify({
      name: "saas-fe-react-mall",
      dependencies: {
        "@weimobfe/ec-browse-not-buy": "1.0.9"
      }
    }, null, 2), "utf8");

    const monorepo: RepoNode = { id: repoId("saas-fe-react-mall-common"), name: "saas-fe-react-mall-common", path: monorepoPath, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
    const consumer: RepoNode = { id: repoId("saas-fe-react-mall"), name: "saas-fe-react-mall", path: consumerPath, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
    const importedFile = parsedFile(consumer, "src/goods.ts", [{
      fileId: fileId(consumer.id, "src/goods.ts"),
      module: "@weimobfe/ec-browse-not-buy",
      raw: 'import { BrowseNotBuy } from "@weimobfe/ec-browse-not-buy";',
      line: 3
    }]);
    const facts = await buildGraphFactsBatch({
      batchId: "batch:monorepo",
      indexedAt: "indexed",
      repos: [monorepo, consumer],
      parsedFiles: [
        parsedFile(monorepo, "packages/ec-browse-not-buy/src/index.ts"),
        importedFile
      ],
      semantic: true
    });

    const packageContract = facts.contracts.find((contract) => contract.kind === "package" && contract.key === "@weimobfe/ec-browse-not-buy");
    expect(packageContract).toBeTruthy();
    const ownerEdge = facts.repoContracts.find((edge) => edge.repoId === monorepo.id && edge.contractId === packageContract?.id && edge.role === "owner");
    expect(ownerEdge).toBeTruthy();
    expect(facts.evidence.find((item) => item.id === ownerEdge?.evidenceId)).toEqual(expect.objectContaining({
      repoId: monorepo.id,
      filePath: "packages/ec-browse-not-buy/package.json",
      raw: "@weimobfe/ec-browse-not-buy",
      rule: "package-json-name"
    }));
    expect(facts.repoDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromRepoId: consumer.id, toRepoId: monorepo.id, dependencyType: "package" }),
      expect.objectContaining({ fromRepoId: consumer.id, toRepoId: monorepo.id, dependencyType: "import" })
    ]));
    expect(facts.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repoId: monorepo.id,
        filePath: "packages/ec-browse-not-buy/package.json",
        raw: '"@weimobfe/ec-utils": "1.0.172"',
        rule: "package-json-dependency"
      }),
      expect.objectContaining({
        repoId: consumer.id,
        filePath: "package.json",
        raw: '"@weimobfe/ec-browse-not-buy": "1.0.9"',
        rule: "package-json-dependency"
      })
    ]));
  });

  it("normalizes Java imports to package contracts and owns Java source packages", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-java-packages-"));
    const repo: RepoNode = { id: repoId("java-service"), name: "java-service", path: cwd, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" };
    const javaFileId = fileId(repo.id, "service/src/main/java/com/example/orders/OrderService.java");
    const parsed: ParsedFile = {
      repoId: repo.id,
      fileId: javaFileId,
      path: "service/src/main/java/com/example/orders/OrderService.java",
      language: "java",
      hash: "hash",
      loc: 8,
      imports: [
        {
          fileId: javaFileId,
          module: "com.example.payments.PaymentService",
          raw: "import com.example.payments.PaymentService;",
          line: 3
        },
        {
          fileId: javaFileId,
          module: "java.util.List",
          raw: "import java.util.List;",
          line: 4
        }
      ],
      symbols: [],
      calls: []
    };

    const facts = await buildGraphFactsBatch({ batchId: "batch:java-packages", indexedAt: "indexed", repos: [repo], parsedFiles: [parsed], semantic: true });

    expect(facts.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "package", key: "com.example.orders" }),
      expect.objectContaining({ kind: "package", key: "com.example.payments" }),
      expect.objectContaining({ kind: "package", key: "java.util" })
    ]));
    expect(facts.contracts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "package", key: "com.example.payments.paymentservice" }),
      expect.objectContaining({ kind: "package", key: "java.util.list" })
    ]));

    const ownerContract = facts.contracts.find((contract) => contract.kind === "package" && contract.key === "com.example.orders");
    const consumerContract = facts.contracts.find((contract) => contract.kind === "package" && contract.key === "com.example.payments");
    expect(facts.repoContracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ repoId: repo.id, contractId: ownerContract?.id, role: "owner" }),
      expect.objectContaining({ repoId: repo.id, contractId: consumerContract?.id, role: "consumer" })
    ]));
    expect(facts.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: parsed.path, rule: "java-package-path", raw: "package com.example.orders" }),
      expect.objectContaining({ filePath: parsed.path, rule: "import-specifier-package-owner", raw: "import com.example.payments.PaymentService;" })
    ]));
  });

  it("extracts Spring MVC mappings as API producers", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-spring-api-"));
    const repo: RepoNode = { id: repoId("his-backend"), name: "his-backend", path: cwd, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" };
    const relativePath = "ruoyi-admin/src/main/java/com/ruoyi/web/controller/smart/SmartBackorderController.java";
    const absolutePath = path.join(cwd, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const classSource = `@RestController
@RequestMapping("/smart/backorder")
public class SmartBackorderController {
  @GetMapping("/list")
  public TableDataInfo list() { return null; }

  @PostMapping
  public AjaxResult add() { return null; }
}`;
    await fs.writeFile(absolutePath, classSource, "utf8");
    const parsed = await parseSourceFile({ repoId: repo.id, absolutePath, relativePath, language: "java" });

    const facts = await buildGraphFactsBatch({ batchId: "batch:spring-api", indexedAt: "indexed", repos: [repo], parsedFiles: [parsed], semantic: true });

    expect(facts.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "api", key: "/smart/backorder" }),
      expect.objectContaining({ kind: "api", key: "GET:/smart/backorder/list" }),
      expect.objectContaining({ kind: "api", key: "POST:/smart/backorder" })
    ]));
    const baseContract = facts.contracts.find((contract) => contract.kind === "api" && contract.key === "/smart/backorder");
    expect(facts.repoContracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ repoId: repo.id, contractId: baseContract?.id, role: "producer" })
    ]));
    expect(facts.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: parsed.path, rule: "spring-request-mapping-producer", raw: '@RequestMapping("/smart/backorder")' }),
      expect.objectContaining({ filePath: parsed.path, rule: "spring-mapping-producer", raw: "@PostMapping" })
    ]));

    // ContractSpec layer is populated end-to-end through buildGraphFactsBatch.
    const listSpec = facts.contractSpecs.find((s) => s.canonicalKey === "GET:/smart/backorder/list");
    expect(listSpec).toBeDefined();
    expect(listSpec!.specKind).toBe("http-endpoint");
    expect(listSpec!.httpMethod).toBe("GET");
    expect(listSpec!.pathTemplate).toBe("/smart/backorder/list");
    expect(listSpec!.batchId).toBe("batch:spring-api");
    expect(listSpec!.active).toBe(true);
    expect(facts.contractSpecEdges.some((e) => e.specId === listSpec!.id && e.contractId === listSpec!.contractId)).toBe(true);
  });

  it("keeps Spring MVC postExtract prefixes scoped to their owning class", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-spring-post-"));
    const repo: RepoNode = { id: repoId("his-backend"), name: "his-backend", path: cwd, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" };
    const relativePath = "src/main/java/com/example/Controllers.java";
    const absolutePath = path.join(cwd, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const source = `@RestController
@RequestMapping("/orders")
public class OrderController {
  @GetMapping("/list")
  public Object listOrders() { return null; }
}

@RestController
@RequestMapping("/users")
class UserController {
  @GetMapping("/profile")
  public Object listUsers() { return null; }
}`;
    await fs.writeFile(absolutePath, source, "utf8");
    const parsed = await parseSourceFile({ repoId: repo.id, absolutePath, relativePath, language: "java" });

    const facts = await buildGraphFactsBatch({ batchId: "batch:spring-post", indexedAt: "indexed", repos: [repo], parsedFiles: [parsed], semantic: true });
    const apiKeys = facts.contracts.filter((contract) => contract.kind === "api").map((contract) => contract.key);

    expect(apiKeys).toEqual(expect.arrayContaining(["GET:/orders/list", "GET:/users/profile"]));
    expect(apiKeys).not.toContain("GET:/orders/profile");
    expect(apiKeys).not.toContain("GET:/users/list");
  });

  it("extracts config contracts from file-level config files", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-config-file-"));
    await fs.writeFile(path.join(cwd, "application.yml"), "server:\n  port: 8080\nspring:\n  application:\n    name: demo\n", "utf8");
    const repo: RepoNode = { id: repoId("config-repo"), name: "config-repo", path: cwd, remoteUrl: "", branch: "", commitSha: "", language: "yaml", indexedAt: "now" };
    const parsed: ParsedFile = {
      repoId: repo.id,
      fileId: fileId(repo.id, "application.yml"),
      path: "application.yml",
      language: "yaml",
      hash: "yaml-hash",
      loc: 5,
      imports: [],
      symbols: [],
      calls: []
    };

    const facts = await buildGraphFactsBatch({ batchId: "batch:config-file", indexedAt: "indexed", repos: [repo], parsedFiles: [parsed], semantic: true });

    expect(facts.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "application.yml", language: "yaml" })
    ]));
    expect(facts.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "config", key: "SERVER.PORT" }),
      expect.objectContaining({ kind: "config", key: "SPRING.APPLICATION.NAME" })
    ]));
    expect(facts.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: "application.yml", rule: "config-file-key", raw: "port: 8080" })
    ]));
  });

  it("extracts request object URLs as API consumers", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-request-object-api-"));
    const backend: RepoNode = { id: repoId("his-backend"), name: "his-backend", path: cwd, remoteUrl: "", branch: "", commitSha: "", language: "java", indexedAt: "now" };
    const frontend: RepoNode = { id: repoId("his-fontend"), name: "his-fontend", path: cwd, remoteUrl: "", branch: "", commitSha: "", language: "javascript", indexedAt: "now" };
    const backendRelativePath = "src/main/java/com/ruoyi/web/controller/smart/SmartBackorderController.java";
    const backendAbsolutePath = path.join(cwd, backendRelativePath);
    await fs.mkdir(path.dirname(backendAbsolutePath), { recursive: true });
    await fs.writeFile(backendAbsolutePath, '@RestController\n@RequestMapping("/smart/backorder")\npublic class SmartBackorderController {}', "utf8");
    const frontendFileId = fileId(frontend.id, "src/api/smart/back_order.js");
    const backendFile = await parseSourceFile({ repoId: backend.id, absolutePath: backendAbsolutePath, relativePath: backendRelativePath, language: "java" });
    const frontendFile: ParsedFile = {
      repoId: frontend.id,
      fileId: frontendFileId,
      path: "src/api/smart/back_order.js",
      language: "javascript",
      hash: "frontend-hash",
      loc: 16,
      imports: [],
      symbols: [{
        id: "code:frontend-function",
        repoId: frontend.id,
        fileId: frontendFileId,
        kind: "function",
        name: "addBackorder",
        qualifiedName: "addBackorder",
        startLine: 1,
        endLine: 8,
        signature: "export function addBackorder(data)",
        source: `export function addBackorder(data) {
  return request({
    url: '/smart/backorder',
    method: 'post',
    data: data
  })
}`,
        hash: "frontend-function-hash"
      }],
      calls: []
    };

    const facts = await buildGraphFactsBatch({ batchId: "batch:request-object-api", indexedAt: "indexed", repos: [backend, frontend], parsedFiles: [backendFile, frontendFile], semantic: true });
    const producerContract = facts.contracts.find((contract) => contract.kind === "api" && contract.key === "/smart/backorder");
    const consumerContract = facts.contracts.find((contract) => contract.kind === "api" && contract.key === "POST:/smart/backorder");

    expect(producerContract).toBeTruthy();
    expect(consumerContract).toBeTruthy();
    expect(facts.repoContracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ repoId: backend.id, contractId: producerContract?.id, role: "producer" }),
      expect.objectContaining({ repoId: frontend.id, contractId: consumerContract?.id, role: "consumer" })
    ]));
    expect(facts.repoDependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromRepoId: frontend.id, toRepoId: backend.id, dependencyType: "api" })
    ]));
    expect(facts.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: "src/api/smart/back_order.js", rule: "http-client-object-url-consumer", raw: expect.stringContaining("url: '/smart/backorder'") })
    ]));
  });

  it("stages graph facts as escaped csv files", async () => {
    const repo = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
    const parsed = [
      await parseSourceFile({ repoId: repo.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" })
    ];
    const facts = await buildGraphFactsBatch({ batchId: "batch:csv", indexedAt: "indexed", repos: [repo], parsedFiles: parsed, semantic: true });
    facts.evidence.push({
      id: "evidence:csv-special",
      repoId: repo.id,
      fileId: parsed[0].fileId,
      filePath: parsed[0].path,
      line: 1,
      raw: "Chinese \"quote\"\nnext line",
      rule: "csv-special",
      confidence: 0.5,
      batchId: "batch:csv",
      indexedAt: "indexed",
      active: true
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-csv-stage-"));
    const staged = await stageGraphFactsAsCsv(facts, dir);
    expect(staged.files.File).toBeTruthy();
    expect(staged.files.Evidence).toBeTruthy();
    const evidenceCsv = await fs.readFile(staged.files.Evidence!, "utf8");
    expect(evidenceCsv).toContain('Chinese ""quote""');
    expect(evidenceCsv).toContain("next line");
    expect(staged.rowCounts.Evidence).toBe(facts.evidence.length);
  });
});
