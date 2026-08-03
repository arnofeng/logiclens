import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import { writeGraphFactsBatch } from "../src/core/graph-model/batchWriter.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import type { ParsedFile, RepoNode } from "../src/core/parsing/types.js";
import { projectLexicalDocuments } from "../src/core/retrieval/projection.js";
import { createRenderRef, parseRenderRef } from "../src/core/retrieval/renderRef.js";
import {
  LEXICAL_PROJECTION_SCHEMA_VERSION,
  TOKENIZER_VERSION,
  type LexicalDocument,
} from "../src/core/retrieval/types.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { SchemaGenerationStore } from "../src/core/schema/generationStore.js";
import { planQuestion } from "../src/features/ask/planner.js";
import { Neo4jGraphDB } from "../src/adapters/graph-db/neo4j/Neo4jGraphDB.js";
import {
  NEO4J_LEXICAL_ANALYZER,
  NEO4J_WORKSPACE_FTS_INDEX,
  Neo4jWorkspaceLexicalStore,
} from "../src/adapters/graph-db/neo4j/Neo4jWorkspaceLexicalStore.js";
import { createClient, type AppClient } from "../src/interfaces/sdk/client.js";
import { resolveNeo4jTestEnvironment, runNeo4jCleanupSteps } from "./helpers/neo4jTestEnvironment.js";

const integration = resolveNeo4jTestEnvironment();
const sourceFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "workspace-unified-retrieval",
);
const RETRIEVE_OPTIONS = Object.freeze({ semantic: false, topK: 10, graphHops: 1, contextBudget: 16_000 });

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function transactionFixture(suffix: string, marker: string, variant: string): {
  repo: RepoNode;
  file: ParsedFile;
} {
  const repoId = `repo:${variant}:${suffix}`;
  const fileId = `${repoId}:file:src/${variant}.ts`;
  const source = `export class ${variant}Service { value() { return "${marker}"; } }`;
  return {
    repo: {
      id: repoId,
      name: `${variant}-${suffix}`,
      path: `/neo4j-e2e/${variant}-${suffix}`,
      remoteUrl: "",
      branch: "main",
      commitSha: suffix,
      language: "typescript",
      indexedAt: "2026-07-21T00:00:00.000Z",
    },
    file: {
      repoId,
      fileId,
      path: `src/${variant}.ts`,
      language: "typescript",
      hash: hash(source),
      loc: 1,
      source,
      imports: [],
      calls: [],
      symbols: [{
        id: `${repoId}:code:${variant}Service`,
        repoId,
        fileId,
        kind: "class",
        name: `${variant}Service`,
        qualifiedName: `${variant}Service`,
        startLine: 1,
        endLine: 1,
        signature: `class ${variant}Service`,
        summary: marker,
        source,
        hash: hash(source),
      }],
    },
  };
}

async function graphAndDocuments(
  workspaceId: string,
  generation: string,
  systemName: string,
  suffix: string,
  marker: string,
  variant: string,
  batchId: string,
): Promise<{ repo: RepoNode; file: ParsedFile; documents: readonly LexicalDocument[] }> {
  const { repo, file } = transactionFixture(suffix, marker, variant);
  const facts = await buildGraphFactsBatch({
    batchId,
    workspaceId,
    generation,
    systemName,
    indexedAt: "2026-07-21T00:00:00.000Z",
    repos: [repo],
    parsedFiles: [file],
    semantic: false,
  });
  return { repo, file, documents: projectLexicalDocuments(facts, workspaceId) };
}

function nativeFullTextCalls(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(([cypher]) => String(cypher).includes("db.index.fulltext.queryNodes")).length;
}

function rehomeDocument(document: LexicalDocument, workspaceId: string, id: string): LexicalDocument {
  const identity = parseRenderRef(document.renderRef, document.workspaceId);
  return {
    ...document,
    id,
    workspaceId,
    renderRef: createRenderRef({ ...identity, workspaceId }),
  };
}

describe("Neo4j workspace unified retrieval cloud release", () => {
  it.skipIf(!integration.enabled)(integration.testName, async () => {
    const configuration = integration.requireConfiguration();
    const suffix = randomUUID().replace(/-/gu, "");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-neo4j-e2e-"));
    const reposDirectory = path.join(directory, "repos");
    await fs.cp(sourceFixture, reposDirectory, { recursive: true });

    const systemName = `neo4j-unified-${suffix}`;
    const workspaceId = deriveWorkspaceId(systemName);
    const transactionWorkspaceId = `workspace:transaction:${suffix}`;
    const transactionGeneration = `schema-generation:${transactionWorkspaceId}:committed`;
    const transactionSystemName = `neo4j-transaction-${suffix}`;
    const foreignWorkspaceId = `${transactionWorkspaceId}:foreign`;
    const foreignGeneration = `schema-generation:${foreignWorkspaceId}:fixture`;
    const rollbackWorkspaceId = `workspace:rollback:${suffix}`;
    const rollbackGeneration = `schema-generation:${rollbackWorkspaceId}:fixture`;
    const rollbackSystemName = `neo4j-rollback-${suffix}`;
    const guardWorkspaceId = `workspace:cleanup-guard:${randomUUID()}`;
    const guardGeneration = `schema-generation:${guardWorkspaceId}:fixture`;
    const querySpy = vi.spyOn(Neo4jGraphDB.prototype, "query");
    let client: AppClient | undefined;
    let writer: Neo4jGraphDB | undefined;
    let observer: Neo4jGraphDB | undefined;
    let baselineCaptured = false;
    let initializationStarted = false;
    let providerIndexExistedBefore = false;
    let providerIndexOwnedByTest = false;
    let previousSystem: { name: string; summary: string } | null = null;
    let guardCreated = false;
    let testFailure: unknown;

    const openDb = () => Neo4jGraphDB.open(configuration.url, {
      username: configuration.username,
      password: configuration.password,
      database: configuration.database,
    });

    try {
      observer = await openDb();
      const databaseRows = await observer.query<{ name: string }>(
        "CALL db.info() YIELD name RETURN name",
      );
      expect(databaseRows[0]?.name).toBe(configuration.database);
      previousSystem = (await observer.query<{ name: string; summary: string }>(
        "MATCH (s:System {id: 'system:default'}) RETURN s.name AS name, s.summary AS summary",
      ))[0] ?? null;
      const baselineLexicalIndexes = await observer.query<{
        name: string;
        type: string;
        state: string;
        labelsOrTypes: string[];
        properties: string[];
        options: { indexConfig: Record<string, unknown> };
      }>(
        "SHOW INDEXES YIELD name, type, state, labelsOrTypes, properties, options " +
        "WHERE type = 'FULLTEXT' AND 'LexicalDocument' IN labelsOrTypes " +
        "RETURN name, type, state, labelsOrTypes, properties, options ORDER BY name",
      );
      providerIndexExistedBefore = baselineLexicalIndexes.some(({ name }) => name === NEO4J_WORKSPACE_FTS_INDEX);
      providerIndexOwnedByTest = !providerIndexExistedBefore;
      if (!configuration.ephemeral && baselineLexicalIndexes.length > 0) {
        expect(baselineLexicalIndexes).toHaveLength(1);
        expect(baselineLexicalIndexes[0]).toMatchObject({
          name: NEO4J_WORKSPACE_FTS_INDEX,
          type: "FULLTEXT",
          labelsOrTypes: ["LexicalDocument"],
          properties: ["ftsText"],
        });
        expect(baselineLexicalIndexes[0]?.options.indexConfig["fulltext.analyzer"]).toBe(NEO4J_LEXICAL_ANALYZER);
        expect(baselineLexicalIndexes[0]?.options.indexConfig["fulltext.eventually_consistent"]).toBe(false);
      }
      baselineCaptured = true;

      const base = defaultConfig();
      const config = {
        ...base,
        systemName,
        repos: ["api", "catalog", "worker"].map((fixtureName) => ({
          name: `${fixtureName}-${suffix}`,
          path: path.join(reposDirectory, fixtureName),
        })),
        include: [...base.include, "**/*.json"],
        graph: {
          ...base.graph,
          provider: "neo4j",
          url: configuration.url,
          username: configuration.username,
          password: configuration.password,
          database: configuration.database,
        },
        retrieval: { lexical: { provider: "auto", scope: "workspace" as const } },
        embedding: { ...base.embedding, provider: "off", level: "off" as const },
        indexing: { ...base.indexing, concurrency: 1, llmSummaryLevel: "off" as const },
      };
      client = await createClient({ cwd: directory, config, logger: { log() {}, warn() {}, error() {} } });
      initializationStarted = true;
      const indexed = await client.index({ changedOnly: false, writeMode: "merge" });
      expect(indexed.lexicalIndexStatus).toBe("healthy");
      expect(indexed.lexicalDocumentCount).toBeGreaterThan(0);

      writer = await openDb();
      const store = new Neo4jWorkspaceLexicalStore(writer);
      const observerStore = new Neo4jWorkspaceLexicalStore(observer);
      await store.ensureSchema();
      await store.ensureSchema();

      const fullTextIndexes = await observer.query<{
        name: string;
        state: string;
        labelsOrTypes: string[];
        properties: string[];
        options: { indexConfig: Record<string, unknown> };
      }>(
        "SHOW FULLTEXT INDEXES YIELD name, state, labelsOrTypes, properties, options " +
        "WHERE 'LexicalDocument' IN labelsOrTypes RETURN name, state, labelsOrTypes, properties, options ORDER BY name",
      );
      expect(fullTextIndexes).toHaveLength(1);
      expect(fullTextIndexes[0]).toMatchObject({
        name: NEO4J_WORKSPACE_FTS_INDEX,
        state: "ONLINE",
        labelsOrTypes: ["LexicalDocument"],
        properties: ["ftsText"],
      });
      expect(fullTextIndexes[0]?.options.indexConfig["fulltext.analyzer"]).toBe(NEO4J_LEXICAL_ANALYZER);
      expect(fullTextIndexes[0]?.options.indexConfig["fulltext.eventually_consistent"]).toBe(false);
      const constraints = await observer.query<{ name: string }>(
        "SHOW CONSTRAINTS YIELD name WHERE name IN $names RETURN name ORDER BY name",
        {
          names: [
            "lexical_document_storage_id",
            "lexical_generation_batch_id",
            "lexical_generation_stats_id",
            "lexical_metadata_key"
          ]
        },
      );
      expect(constraints.map(({ name }) => name)).toEqual([
        "lexical_document_storage_id",
        "lexical_generation_batch_id",
        "lexical_generation_stats_id",
        "lexical_metadata_key",
      ]);

      const committed = await graphAndDocuments(
        transactionWorkspaceId,
        transactionGeneration,
        transactionSystemName,
        suffix,
        `committedmarker${suffix}`,
        "Committed",
        `batch:committed:${suffix}`,
      );
      await writer.beginTransaction();
      await writer.upsertRepo(committed.repo, {
        workspaceId: transactionWorkspaceId,
        generation: transactionGeneration
      });
      await writeGraphFactsBatch(writer, {
        batchId: `batch:committed:${suffix}`,
        workspaceId: transactionWorkspaceId,
        generation: transactionGeneration,
        systemName: transactionSystemName,
        repos: [committed.repo],
        parsedFiles: [committed.file],
      }, {
        semantic: false,
        workspaceId: transactionWorkspaceId,
        generation: transactionGeneration,
        systemName: transactionSystemName
      });
      await store.upsertDocuments({
        workspaceId: transactionWorkspaceId,
        generation: transactionGeneration,
        documents: committed.documents
      });
      expect(await observer.query("MATCH (r:Repo {id: $repoId}) RETURN r.id", { repoId: committed.repo.id })).toEqual([]);
      let callsBefore = nativeFullTextCalls(querySpy);
      expect(await observerStore.search({ workspaceId: transactionWorkspaceId, generation: transactionGeneration, text: `committedmarker${suffix}` }, { topK: 10 })).toEqual([]);
      expect(nativeFullTextCalls(querySpy) - callsBefore).toBe(1);
      await writer.commitTransaction();

      expect(await observer.query("MATCH (r:Repo {id: $repoId}) RETURN r.id", { repoId: committed.repo.id })).toHaveLength(1);
      callsBefore = nativeFullTextCalls(querySpy);
      const committedHits = await observerStore.search(
        { workspaceId: transactionWorkspaceId, generation: transactionGeneration, text: `committedmarker${suffix}` },
        { topK: 10 },
      );
      expect(nativeFullTextCalls(querySpy) - callsBefore).toBe(1);
      expect(committedHits.length).toBeGreaterThan(0);
      expect(committedHits.every((hit) => hit.repoId === committed.repo.id)).toBe(true);

      const inactive = { ...committed.documents[0]!, id: `lexical:inactive:${suffix}`, active: false };
      const foreign = rehomeDocument(
        committed.documents[0]!,
        foreignWorkspaceId,
        `lexical:foreign:${suffix}`,
      );
      await store.upsertDocuments({
        workspaceId: transactionWorkspaceId,
        generation: transactionGeneration,
        documents: [inactive]
      });
      await store.upsertDocuments({
        workspaceId: foreignWorkspaceId,
        generation: foreignGeneration,
        documents: [foreign]
      });
      const filtered = await observerStore.search(
        { workspaceId: transactionWorkspaceId, generation: transactionGeneration, text: `committedmarker${suffix}` },
        { topK: 50 },
      );
      expect(filtered.some((hit) => hit.documentId === inactive.id || hit.documentId === foreign.id)).toBe(false);

      const beforeRollbackIds = committedHits.map((hit) => hit.documentId).sort();
      const rolledBack = await graphAndDocuments(
        rollbackWorkspaceId,
        rollbackGeneration,
        rollbackSystemName,
        suffix,
        `rollbackmarker${suffix}`,
        "RolledBack",
        `batch:rollback:${suffix}`,
      );
      await writer.beginTransaction();
      try {
        await writer.upsertRepo(rolledBack.repo, {
          workspaceId: rollbackWorkspaceId,
          generation: rollbackGeneration
        });
        await writeGraphFactsBatch(writer, {
          batchId: `batch:rollback:${suffix}`,
          workspaceId: rollbackWorkspaceId,
          generation: rollbackGeneration,
          systemName: rollbackSystemName,
          repos: [rolledBack.repo],
          parsedFiles: [rolledBack.file],
        }, {
          semantic: false,
          workspaceId: rollbackWorkspaceId,
          generation: rollbackGeneration,
          systemName: rollbackSystemName
        });
        await store.upsertDocuments({
          workspaceId: rollbackWorkspaceId,
          generation: rollbackGeneration,
          documents: rolledBack.documents
        });
        throw new Error("injected transaction failure");
      } catch (error) {
        await writer.rollbackTransaction();
        expect(error).toEqual(new Error("injected transaction failure"));
      }
      expect(await observer.query("MATCH (r:Repo {id: $repoId}) RETURN r.id", { repoId: rolledBack.repo.id })).toEqual([]);
      callsBefore = nativeFullTextCalls(querySpy);
      expect(await observerStore.search({ workspaceId: rollbackWorkspaceId, generation: rollbackGeneration, text: `rollbackmarker${suffix}` }, { topK: 10 })).toEqual([]);
      expect(nativeFullTextCalls(querySpy) - callsBefore).toBe(1);
      expect((await observerStore.search(
        { workspaceId: transactionWorkspaceId, generation: transactionGeneration, text: `committedmarker${suffix}` },
        { topK: 10 },
      )).map((hit) => hit.documentId).sort()).toEqual(beforeRollbackIds);

      const questions = [
        "Which HTTP endpoint serves /orders?",
        "库存契约中的稳定标识是什么？",
        "哪个 worker 消费 orders.created event？",
      ];
      for (const question of questions) {
        const plan = planQuestion(question);
        const strictApiTarget = plan.contractTargets.length > 0 &&
          plan.contractTargets.every(({ kind }) => kind === "api");
        callsBefore = nativeFullTextCalls(querySpy);
        const result = await client.retrieve(question, RETRIEVE_OPTIONS);
        expect(
          nativeFullTextCalls(querySpy) - callsBefore,
          `${question}: lexical=${JSON.stringify(result.diagnostics.routes.lexical)}`,
        ).toBe(strictApiTarget ? 0 : 1);
        expect(result.diagnostics.routes.lexical).toMatchObject(strictApiTarget
          ? { status: "disabled", queryCount: 0 }
          : { status: "succeeded", queryCount: 1 });
        expect(result.loadedEvidence.length).toBeGreaterThan(0);
        for (const { candidate, document } of result.loadedEvidence) {
          expect(document).toMatchObject({ workspaceId, repoId: expect.stringContaining(suffix), active: true });
          expect(document.path).toBeTruthy();
          const identity = parseRenderRef(document.renderRef, workspaceId);
          expect(identity).toMatchObject({
            repoId: document.repoId,
            path: document.path,
            canonicalId: candidate.canonicalId,
          });
        }
      }
      const stableQuestion = "Where is CreateOrderRequest declared?";
      callsBefore = nativeFullTextCalls(querySpy);
      const first = (await client.retrieve(stableQuestion, RETRIEVE_OPTIONS)).loadedEvidence
        .map(({ candidate }) => candidate.canonicalId);
      expect(nativeFullTextCalls(querySpy) - callsBefore).toBe(1);
      callsBefore = nativeFullTextCalls(querySpy);
      const second = (await client.retrieve(stableQuestion, RETRIEVE_OPTIONS)).loadedEvidence
        .map(({ candidate }) => candidate.canonicalId);
      expect(nativeFullTextCalls(querySpy) - callsBefore).toBe(1);
      expect(second).toEqual(first);

      const activeGeneration = await new SchemaGenerationStore(observer, workspaceId).activeGeneration();
      expect(activeGeneration).toBeDefined();
      if (!activeGeneration) throw new Error(`No active generation was committed for ${workspaceId}.`);
      const health = await observerStore.health({ workspaceId, generation: activeGeneration });
      expect(health).toMatchObject({
        providerVersion: expect.stringMatching(/^\d+\.\d+/u),
        projectionSchemaVersion: LEXICAL_PROJECTION_SCHEMA_VERSION,
        tokenizerVersion: TOKENIZER_VERSION,
        status: "healthy",
        metrics: { documentCount: indexed.lexicalDocumentCount },
      });
      expect(health.metrics.indexSizeBytes).toBeGreaterThan(0);

      const guard = rehomeDocument(committed.documents[0]!, guardWorkspaceId, `lexical:guard:${suffix}`);
      await store.upsertDocuments({
        workspaceId: guardWorkspaceId,
        generation: guardGeneration,
        documents: [guard]
      });
      guardCreated = true;
    } catch (error) {
      testFailure = error;
    }

    const scopedWorkspaces = [workspaceId, transactionWorkspaceId, foreignWorkspaceId, rollbackWorkspaceId];
    const cleanupSteps = [
      ...(client ? [{ name: "close public client", run: () => client!.close() }] : []),
      ...(observer && initializationStarted ? [
        {
          name: "delete scoped lexical documents",
          run: () => observer!.query(
            "MATCH (n:LexicalDocument) WHERE n.workspaceId IN $workspaceIds DETACH DELETE n",
            { workspaceIds: scopedWorkspaces },
          ),
        },
        {
          name: "delete scoped lexical stats",
          run: () => observer!.query(
            "MATCH (s:LexicalWorkspaceStats) WHERE s.workspaceId IN $workspaceIds DETACH DELETE s",
            { workspaceIds: scopedWorkspaces },
          ),
        },
        {
          name: "delete scoped graph journals",
          run: () => observer!.query(
            "MATCH (b:GraphWriteBatch) WHERE b.workspaceId IN $workspaceIds DETACH DELETE b",
            { workspaceIds: scopedWorkspaces },
          ),
        },
        {
          name: "delete UUID-scoped graph facts",
          run: () => observer!.query(
            "MATCH (n) WHERE NOT n:LexicalDocument AND ((n.repoId IS NOT NULL AND n.repoId ENDS WITH $suffix) " +
            "OR (n:Repo AND n.id ENDS WITH $suffix)) DETACH DELETE n",
            { suffix },
          ),
        },
      ] : []),
      ...(observer && baselineCaptured && initializationStarted ? [{
        name: "restore System baseline",
        run: () => previousSystem === null
          ? observer!.query("MATCH (s:System {id: 'system:default'}) DETACH DELETE s")
          : observer!.query(
            "MERGE (s:System {id: 'system:default'}) SET s.name = $name, s.summary = $summary",
            previousSystem,
          ),
      }] : []),
      ...(observer && initializationStarted ? [{
        name: "verify scoped cleanup",
        run: async () => {
          const remaining = await observer!.query<{ graphCount: number; lexicalCount: number }>(
            "OPTIONAL MATCH (g) WHERE NOT g:LexicalDocument AND ((g.repoId IS NOT NULL AND g.repoId ENDS WITH $suffix) " +
            "OR (g:Repo AND g.id ENDS WITH $suffix)) " +
            "WITH count(g) AS graphCount OPTIONAL MATCH (l:LexicalDocument) WHERE l.workspaceId IN $workspaceIds " +
            "RETURN graphCount, count(l) AS lexicalCount",
            { suffix, workspaceIds: scopedWorkspaces },
          );
          expect(remaining).toEqual([{ graphCount: 0, lexicalCount: 0 }]);
        },
      }] : []),
      ...(observer && guardCreated ? [
        {
          name: "verify cleanup guard isolation",
          run: async () => {
            expect(await observer!.query<{ count: number }>(
              "MATCH (n:LexicalDocument {workspaceId: $workspaceId}) RETURN count(n) AS count",
              { workspaceId: guardWorkspaceId },
            )).toEqual([{ count: 1 }]);
          },
        },
        {
          name: "delete cleanup guard document",
          run: () => observer!.query(
            "MATCH (n:LexicalDocument {workspaceId: $workspaceId}) DETACH DELETE n",
            { workspaceId: guardWorkspaceId },
          ),
        },
        {
          name: "delete cleanup guard stats",
          run: () => observer!.query(
            "MATCH (s:LexicalWorkspaceStats {workspaceId: $workspaceId}) DETACH DELETE s",
            { workspaceId: guardWorkspaceId },
          ),
        },
      ] : []),
      ...(observer && baselineCaptured && initializationStarted && providerIndexOwnedByTest ? [{
        name: "drop provider index created by test",
        run: () => observer!.query(`DROP INDEX ${NEO4J_WORKSPACE_FTS_INDEX} IF EXISTS`),
      }] : []),
      ...(writer ? [{ name: "close writer", run: () => writer!.close() }] : []),
      ...(observer ? [{ name: "close observer", run: () => observer!.close() }] : []),
      { name: "restore query spy", run: () => querySpy.mockRestore() },
      { name: "remove fixture directory", run: () => fs.rm(directory, { recursive: true, force: true }) },
    ];
    let cleanupFailure: unknown;
    try {
      await runNeo4jCleanupSteps(cleanupSteps);
    } catch (error) {
      cleanupFailure = error;
    }
    if (testFailure && cleanupFailure) {
      throw new AggregateError([testFailure, cleanupFailure], "Neo4j E2E and cleanup both failed.");
    }
    if (testFailure) throw testFailure;
    if (cleanupFailure) throw cleanupFailure;
  }, 240_000);
});
