import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalContractKey, extractCrossRepoContracts } from "../src/core/contracts/extraction/crossRepoContracts.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { findImpactSections, listContracts, listDependencies, listUnresolvedEvidence, sectionsDocumentingCode, traceContract, traceEntity } from "../src/core/graph-model/queries.js";
import { upsertParsedFiles } from "../src/core/graph-model/upsert.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import type { ParsedFile, RepoNode } from "../src/core/parsing/types.js";
import { retrieveForQuestion } from "../src/features/ask/retrieve.js";
import { fileId, repoId } from "../src/shared/path.js";

describe("graph", () => {
  function parsedFile(repo: RepoNode, relativePath: string): ParsedFile {
    return {
      repoId: repo.id,
      fileId: fileId(repo.id, relativePath),
      path: relativePath,
      language: "typescript",
      hash: `${repo.id}:${relativePath}:hash`,
      loc: 1,
      imports: [],
      symbols: [],
      calls: []
    };
  }

  it("clears repo indexed artifacts through the graph layer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-clear-repo-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("clear-repo-test");
      const repo: RepoNode = {
        id: repoId("clear-repo"),
        name: "clear-repo",
        path: dir,
        remoteUrl: "",
        branch: "",
        commitSha: "",
        language: "typescript",
        indexedAt: "now"
      };
      const file = {
        id: fileId(repo.id, "src/app.ts"),
        repoId: repo.id,
        path: "src/app.ts",
        language: "typescript",
        hash: "file-hash",
        loc: 3,
        batchId: "batch:clear",
        indexedAt: "now",
        active: true
      };
      const code = {
        id: "code:clear-repo:src/app.ts:handler",
        repoId: repo.id,
        fileId: file.id,
        kind: "function" as const,
        name: "handler",
        qualifiedName: "handler",
        startLine: 1,
        endLine: 3,
        signature: "function handler()",
        source: "function handler() {}",
        hash: "code-hash",
        batchId: "batch:clear",
        indexedAt: "now",
        active: true
      };
      const contract = {
        id: "contract:api:/clear",
        kind: "api" as const,
        key: "/clear",
        name: "/clear",
        description: "clear repo test contract"
      };
      const evidence = {
        id: "evidence:clear-repo:1",
        repoId: repo.id,
        fileId: file.id,
        filePath: file.path,
        line: 1,
        raw: "GET /clear",
        rule: "test-rule",
        confidence: 0.9,
        batchId: "batch:clear",
        indexedAt: "now",
        active: true
      };

      await db.upsertRepo(repo);
      await db.upsertFile(file);
      await db.upsertCode(code);
      await db.upsertContract(contract);
      await db.upsertEvidence(evidence);
      await db.addContains(repo.id, file.id);
      await db.addContains(file.id, code.id);
      await db.addRepoContract({ repoId: repo.id, contractId: contract.id, role: "producer", evidenceId: evidence.id, confidence: 0.9, batchId: "batch:clear", active: true });
      await db.addContractEvidence(contract.id, evidence.id);
      await db.addRepoEvidence(repo.id, evidence.id);

      await db.clearRepoIndexedArtifacts(repo.id);

      expect(await db.query("MATCH (f:File) WHERE f.repoId = $repoId RETURN f.id AS id;", { repoId: repo.id })).toEqual([]);
      expect(await db.query("MATCH (c:Code) WHERE c.repoId = $repoId RETURN c.id AS id;", { repoId: repo.id })).toEqual([]);
      expect(await db.query("MATCH (e:Evidence) WHERE e.repoId = $repoId RETURN e.id AS id;", { repoId: repo.id })).toEqual([]);
      const contractEdges = await db.query<{ count: number | bigint }>("MATCH (:Repo {id: $repoId})-[r:PRODUCES]->(:Contract) RETURN count(r) AS count;", { repoId: repo.id });
      const containmentEdges = await db.query<{ count: number | bigint }>("MATCH (:Repo {id: $repoId})-[r:CONTAINS]->(:File) RETURN count(r) AS count;", { repoId: repo.id });
      expect(Number(contractEdges[0]?.count ?? -1)).toBe(0);
      expect(Number(containmentEdges[0]?.count ?? -1)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("stores parsed files and resolves call edges", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const repoC = { id: repoId("service-c"), name: "service-c", path: path.resolve("tests/fixtures/service-c"), remoteUrl: "", branch: "", commitSha: "", language: "javascript", indexedAt: new Date().toISOString() };
      await db.upsertRepo(repoA);
      await db.upsertRepo(repoB);
      await db.upsertRepo(repoC);
      const parsed = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderService.ts"), relativePath: "src/OrderService.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/events/OrderCreatedEvent.ts"), relativePath: "src/events/OrderCreatedEvent.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/README.md"), relativePath: "README.md", language: "markdown" }),
        parseSourceFile({ repoId: repoC.id, absolutePath: path.resolve("tests/fixtures/service-c/src/InventoryService.js"), relativePath: "src/InventoryService.js", language: "javascript" }),
        parseSourceFile({ repoId: repoC.id, absolutePath: path.resolve("tests/fixtures/service-c/src/InventoryPanel.jsx"), relativePath: "src/InventoryPanel.jsx", language: "jsx" })
      ]);
      await upsertParsedFiles(db, parsed, true, [repoA, repoB, repoC]);
      const stats = await db.stats();
      expect(stats.repos).toBe(3);
      expect(stats.files).toBe(7);
      expect(stats.codeNodes).toBeGreaterThanOrEqual(10);
      expect(stats.sectionNodes).toBeGreaterThanOrEqual(2);
      expect(stats.callEdges).toBeGreaterThanOrEqual(2);
      expect(stats.entities).toBeGreaterThan(0);
      const markdownFiles = await db.query<{ language: string }>("MATCH (f:File) WHERE f.path = 'README.md' RETURN f.language AS language;");
      expect(markdownFiles[0]?.language).toBe("markdown");
      const references = await db.query<{ count: number }>("MATCH (:Section)-[r:REFERENCES]->(:File) RETURN count(r) AS count;");
      expect(Number(references[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
      const retrieval = await retrieveForQuestion(db, "OrderCreatedEvent");
      expect(retrieval.sections.some((section) => section.filePath === "README.md" && section.heading === "Events")).toBe(true);
      expect(retrieval.semantic).toBeDefined();
      expect(retrieval.edges.every((edge) => ["exact", "probable", "heuristic"].includes(edge.resolution))).toBe(true);
      const workflowRetrieval = await retrieveForQuestion(db, "Order workflow");
      expect(workflowRetrieval.entities.some((entity) => entity.sourceKind === "contract" || entity.sourceKind === "operation")).toBe(true);
      expect(workflowRetrieval.dependencies.some((dependency) => dependency.contractKey === "/api/order/{id}")).toBe(true);
      const impactSections = await findImpactSections(db, "OrderCreatedEvent");
      expect(impactSections.some((section) => section.heading === "Events")).toBe(true);
      const documented = await sectionsDocumentingCode(db, retrieval.code.map((row) => row.codeId));
      expect(documented.some((section) => section.heading === "Events")).toBe(true);
      const repoDependencies = await db.query<{ fromRepo: string; toRepo: string; dependencyType: string; evidenceRule: string; raw: string }>(
        `MATCH (from:Repo)-[d:DEPENDS_ON]->(to:Repo), (e:Evidence)
         WHERE d.evidenceId = e.id
         RETURN from.name AS fromRepo, to.name AS toRepo, d.dependencyType AS dependencyType, e.rule AS evidenceRule, e.raw AS raw;`
      );
      expect(repoDependencies).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromRepo: "service-a", toRepo: "service-b", dependencyType: "package", evidenceRule: "package-json-dependency" }),
        expect.objectContaining({ fromRepo: "service-c", toRepo: "service-a", dependencyType: "package", evidenceRule: "package-json-dependency" }),
        expect.objectContaining({ fromRepo: "service-b", toRepo: "service-a", dependencyType: "api", evidenceRule: "http-client-api-consumer" }),
        expect.objectContaining({ fromRepo: "service-b", toRepo: "service-a", dependencyType: "event", evidenceRule: "event-consumer" })
      ]));
      const dependencyRows = await listDependencies(db);
      expect(dependencyRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromRepo: "service-b", toRepo: "service-a", dependencyType: "api", contractKind: "api", contractKey: "/api/order/{id}" })
      ]));
      expect(dependencyRows.every((row) => ["exact", "probable", "heuristic"].includes(row.resolution))).toBe(true);
      const contractRows = await listContracts(db);
      expect(contractRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "api", key: "/api/order/{id}" }),
        expect.objectContaining({ kind: "event", key: "order.created" })
      ]));
      const sharedContracts = await db.query<{ kind: string; key: string; repoCount: number }>(
        `MATCH (r:Repo)-[:SHARES_CONTRACT]->(c:Contract)
         RETURN c.kind AS kind, c.key AS key, count(DISTINCT r) AS repoCount;`
      );
      expect(sharedContracts).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "dto", key: "orderdto" }),
        expect.objectContaining({ kind: "schema", key: "orderschema" }),
        expect.objectContaining({ kind: "enum", key: "orderstatus" }),
        expect.objectContaining({ kind: "config", key: "ORDER_SHARED_CONFIG" })
      ]));
      expect(sharedContracts.some((row) => row.key === "ORDER_SHARED_CONFIG" && Number(row.repoCount) >= 2)).toBe(true);
      expect(canonicalContractKey("api", "/api/order/${id}")).toBe("/api/order/{id}");
      expect(canonicalContractKey("api", "/api/order/:id")).toBe("/api/order/{id}");
      expect(canonicalContractKey("api", "/api/order/{id}")).toBe("/api/order/{id}");
      expect(canonicalContractKey("event", "Order.Created")).toBe("order.created");
      expect(canonicalContractKey("config", "order_shared_config")).toBe("ORDER_SHARED_CONFIG");
      const apiProducers = await db.query<{ count: number }>(
        `MATCH (:Repo)-[p:PRODUCES]->(c:Contract)
         WHERE c.kind = 'api' AND c.key = '/api/order/{id}'
         RETURN count(p) AS count;`
      );
      const apiConsumers = await db.query<{ count: number }>(
        `MATCH (:Repo)-[u:CONSUMES]->(c:Contract)
         WHERE c.kind = 'api' AND c.key = '/api/order/{id}'
         RETURN count(u) AS count;`
      );
      expect(Number(apiProducers[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
      expect(Number(apiConsumers[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
      const packageUsages = await db.query<{ repoName: string; packageName: string; rule: string }>(
        `MATCH (r:Repo)-[u:USES_PACKAGE]->(:Contract), (e:Evidence)
         WHERE u.evidenceId = e.id
         RETURN r.name AS repoName, u.packageName AS packageName, e.rule AS rule;`
      );
      expect(packageUsages).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-b", packageName: "@fixture/service-a", rule: "import-specifier-package-owner" })
      ]));
      const apiTrace = await traceContract(db, "api", "/api/order/:id");
      expect(apiTrace).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a", role: "producer", filePath: "src/OrderController.ts", rule: "api-path-producer" })
      ]));
      expect(apiTrace.every((row) => ["exact", "probable", "heuristic"].includes(row.resolution))).toBe(true);
      expect(apiTrace.every((row) => row.line > 0 && row.raw.length > 0 && row.confidence > 0)).toBe(true);
      const methodConsumers = await db.query<{ repoName: string; key: string }>(
        "MATCH (r:Repo)-[:CONSUMES]->(c:Contract) WHERE c.kind = 'api' AND c.key = $key RETURN r.name AS repoName, c.key AS key;",
        { key: "GET:/api/order/{id}" }
      );
      expect(methodConsumers).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-b", key: "GET:/api/order/{id}" })
      ]));
      const unresolvedEvidence = await listUnresolvedEvidence(db);
      expect(unresolvedEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          repoName: "service-b",
          filePath: "src/PaymentService.ts",
          rule: "dynamic-unresolved",
          resolution: "dynamic-unresolved",
          reason: "HTTP call argument is not a resolvable static path"
        })
      ]));
      // HttpEndpointSpec nodes + HAS_SPEC edges are written to the graph end-to-end.
      const httpSpecs = await db.query<{ httpMethod: string; pathTemplate: string; specKind: string }>(
        "MATCH (c:Contract)-[:HAS_SPEC]->(s:ContractSpec) WHERE s.specKind = 'http-endpoint' AND s.httpMethod = 'GET' AND s.pathTemplate = '/api/order/{id}' RETURN s.httpMethod AS httpMethod, s.pathTemplate AS pathTemplate, s.specKind AS specKind;"
      );
      expect(httpSpecs).toEqual(expect.arrayContaining([
        expect.objectContaining({ httpMethod: "GET", pathTemplate: "/api/order/{id}", specKind: "http-endpoint" })
      ]));
      const eventTrace = await traceContract(db, "event", "ORDER.CREATED");
      expect(eventTrace).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a", role: "producer", rule: "event-publisher" }),
        expect.objectContaining({ repoName: "service-b", role: "consumer", rule: "event-consumer" })
      ]));
      const dtoTrace = await traceContract(db, "dto", "OrderDTO");
      expect(dtoTrace.filter((row) => row.role === "shared").map((row) => row.repoName)).toEqual(expect.arrayContaining(["service-a", "service-b"]));
      const schemaTrace = await traceContract(db, "schema", "OrderSchema");
      expect(schemaTrace.filter((row) => row.role === "shared").map((row) => row.repoName)).toEqual(expect.arrayContaining(["service-a", "service-b"]));
      const enumTrace = await traceContract(db, "enum", "OrderStatus");
      expect(enumTrace.filter((row) => row.role === "shared").map((row) => row.repoName)).toEqual(expect.arrayContaining(["service-a", "service-b"]));
      const configTrace = await traceContract(db, "config", "ORDER_SHARED_CONFIG");
      expect(configTrace.filter((row) => row.role === "shared").map((row) => row.repoName)).toEqual(expect.arrayContaining(["service-a", "service-b"]));
      const entityTrace = await traceEntity(db, "Order");
      expect(entityTrace).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a", sourceKind: "contract" }),
        expect.objectContaining({ repoName: "service-b", sourceKind: "operation" })
      ]));
      const workflows = await db.query<{ name: string; repoName: string; operation: string }>(
        `MATCH (w:Workflow)-[:WORKFLOW_STEP]->(o:Operation)<-[:PARTICIPATES_IN]-(r:Repo)
         RETURN w.name AS name, r.name AS repoName, o.verb AS operation;`
      );
      expect(workflows).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "service-a" }),
        expect.objectContaining({ repoName: "service-b" })
      ]));
      const result = await extractCrossRepoContracts([repoA, repoB, repoC], parsed);
      expect(result.repoContracts.length).toBeGreaterThan(0);
      expect(result.contractEntities.length).toBeGreaterThan(0);
      const dependencyEvidence = await db.query<{ count: number }>(
        `MATCH (:Repo)-[d:DEPENDS_ON]->(:Repo), (e:Evidence)
         WHERE d.evidenceId = e.id AND e.filePath <> '' AND e.line > 0 AND e.raw <> '' AND e.rule <> '' AND e.confidence > 0
         RETURN count(d) AS count;`
      );
      expect(Number(dependencyEvidence[0]?.count ?? 0)).toBeGreaterThanOrEqual(repoDependencies.length);
      const repoSummaries = await db.query<{ name: string; summary: string }>(
        "MATCH (r:Repo) RETURN r.name AS name, r.summary AS summary;"
      );
      expect(repoSummaries).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "service-a" }),
        expect.objectContaining({ name: "service-b" }),
        expect.objectContaining({ name: "service-c" })
      ]));
      expect(repoSummaries.every((row) => row.summary.length > 0)).toBe(true);
      expect(repoSummaries.find((row) => row.name === "service-a")?.summary).toContain("api:/api/order/{id}");
      const systemSummary = await db.query<{ summary: string }>("MATCH (s:System) RETURN s.summary AS summary;");
      expect(systemSummary[0]?.summary).toContain("System contains 3 indexed repositories");
      expect(systemSummary[0]?.summary).toContain("Cross-repo dependencies");
    } finally {
      await db.close();
    }
  }, 20000);

  it("counts package owners as producers in contract summaries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-monorepo-graph-"));
    const monorepoPath = path.join(dir, "common");
    const consumerPath = path.join(dir, "consumer");
    await fs.mkdir(path.join(monorepoPath, "packages", "widget"), { recursive: true });
    await fs.mkdir(consumerPath, { recursive: true });
    await fs.writeFile(path.join(monorepoPath, "package.json"), JSON.stringify({
      private: true,
      workspaces: ["packages/*"]
    }, null, 2), "utf8");
    await fs.writeFile(path.join(monorepoPath, "packages", "widget", "package.json"), JSON.stringify({
      name: "@scope/widget",
      version: "1.0.0"
    }, null, 2), "utf8");
    await fs.writeFile(path.join(consumerPath, "package.json"), JSON.stringify({
      name: "consumer",
      dependencies: {
        "@scope/widget": "1.0.0"
      }
    }, null, 2), "utf8");

    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("monorepo-test");
      const monorepo: RepoNode = { id: repoId("common"), name: "common", path: monorepoPath, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      const consumer: RepoNode = { id: repoId("consumer"), name: "consumer", path: consumerPath, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now" };
      await db.upsertRepo(monorepo);
      await db.upsertRepo(consumer);
      await upsertParsedFiles(db, [
        parsedFile(monorepo, "packages/widget/src/index.ts"),
        parsedFile(consumer, "src/app.ts")
      ], { semantic: true, batchId: "batch:monorepo-graph" }, [monorepo, consumer]);

      const trace = await traceContract(db, "package", "@scope/widget");
      expect(trace).toEqual(expect.arrayContaining([
        expect.objectContaining({ repoName: "common", role: "owner", filePath: "packages/widget/package.json", rule: "package-json-name" }),
        expect.objectContaining({ repoName: "consumer", role: "consumer", filePath: "package.json", rule: "package-json-dependency" })
      ]));
      const contracts = await listContracts(db, { kind: "package" });
      expect(contracts).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "@scope/widget", producers: 1, consumers: 1 })
      ]));
    } finally {
      await db.close();
    }
  }, 20000);
});
