import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import type { AppConfig } from "../src/config/schema.js";
import { analyzeImpact } from "../src/core/contracts/impact/impactEngine.js";
import { javaSchemaExtractor } from "../src/core/contracts/extraction/builtin/javaSchemaExtractor.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { KuzuWorkspaceLexicalStore } from "../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { runIndexing } from "../src/core/indexing/run.js";
import { scanAndParseRepo } from "../src/core/indexing/scanParse.js";
import type { RepoNode } from "../src/core/parsing/types.js";
import { registerBuiltinParsers } from "../src/core/parsing/parserRegistry.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { normalizeName, repoId } from "../src/shared/path.js";
import { assertNormalizedSchemaSnapshot, captureSchemaBaselineSnapshot, runSchemaSnapshotConformance } from "./helpers/schemaBaselineSnapshot.js";
import { pinPublicGraphReadSnapshot } from "../src/core/graph-model/readSnapshot.js";

type BaselineTarget = {
  currentCharacterization: {
    missingSchemaNames: string[];
    missingRelationKinds: string[];
    impactTargetMatches: number;
    pendingRefsBeforeWriteMinimum: number;
    pendingRefsAfterWrite: number;
  };
  targetGroundTruth: {
    schemaNames: string[];
    relationKinds: string[];
    impactTargetMatchesMinimum: number;
    pendingRefsBeforeWrite: number;
    pendingRefsAfterWrite: number;
  };
};

type ResolutionScopeIdentityFixture = {
  languageId: string;
  repoId: string;
  resolutionScopeId: string;
};

type WorkspaceFixtureManifest = {
  repositories: string[];
  resolutionScopeDependencies: Array<{
    from: ResolutionScopeIdentityFixture;
    to: ResolutionScopeIdentityFixture;
    kind: "repository";
    order: number;
  }>;
  sameSimpleNameWithoutDependency: {
    consumer: string;
    dependency: string;
    unrelated: string;
    simpleName: string;
  };
};

const fixtureRoot = path.resolve("tests/fixtures/java-schema-js001");
const workspaceRoot = path.resolve("tests/fixtures/java-schema-js001-workspace");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function configFor(repos: Array<{ name: string; path: string }>, batchSize = 0): AppConfig {
  const base = defaultConfig();
  return {
    ...base,
    systemName: "java-schema-js001",
    repos,
    indexing: { ...base.indexing, batchSize }
  };
}

function fixtureRepo(name: string, repoPath: string): RepoNode {
  return {
    id: repoId(name),
    name,
    path: repoPath,
    remoteUrl: "",
    branch: "main",
    commitSha: "fixture",
    language: "java",
    indexedAt: "fixture"
  };
}

async function openKuzu(prefix: string): Promise<{ db: KuzuGraphDB; directory: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const db = await KuzuGraphDB.open(path.join(directory, "graph"));
  await db.initSchema("java-schema-js001");
  return { db, directory };
}

function schemaNames(specs: Array<{ specKind: string; specJson: string }>): string[] {
  return specs.filter((spec) => spec.specKind === "schema").flatMap((spec) => {
    const parsed = JSON.parse(spec.specJson) as { displayName?: string };
    return parsed.displayName ? [parsed.displayName] : [];
  }).sort();
}

describe("Java schema deterministic discovery lifecycle", () => {
  it("closes the suffix/pending baseline through graph, impact, and lexical projection", async () => {
    const target = JSON.parse(await fs.readFile(path.join(fixtureRoot, "baseline-target.json"), "utf8")) as BaselineTarget;
    const coverage = JSON.parse(await fs.readFile(path.join(fixtureRoot, "coverage-matrix.json"), "utf8")) as Record<string, string[]>;
    expect(Object.keys(coverage)).toHaveLength(13);
    for (const fixtureFiles of Object.values(coverage)) {
      for (const fixtureFile of fixtureFiles) await expect(fs.stat(path.join(fixtureRoot, fixtureFile))).resolves.toMatchObject({});
    }
    const [rootPom, activityPom, shadowPom] = await Promise.all([
      fs.readFile(path.join(fixtureRoot, "pom.xml"), "utf8"),
      fs.readFile(path.join(fixtureRoot, "activity-api/pom.xml"), "utf8"),
      fs.readFile(path.join(fixtureRoot, "shadow-module/pom.xml"), "utf8")
    ]);
    expect(rootPom).toMatch(/<packaging>pom<\/packaging>[\s\S]*<module>activity-api<\/module>[\s\S]*<module>shadow-module<\/module>/u);
    expect(activityPom).toMatch(/<parent>[\s\S]*<artifactId>java-schema-js001<\/artifactId>[\s\S]*<artifactId>activity-api<\/artifactId>/u);
    expect(shadowPom).toMatch(/<parent>[\s\S]*<artifactId>java-schema-js001<\/artifactId>[\s\S]*<artifactId>shadow-module<\/artifactId>/u);
    const repo = fixtureRepo("java-schema-js001", fixtureRoot);
    const config = configFor([{ name: repo.name, path: repo.path }]);
    await registerBuiltinParsers(new Set(["java"]));
    const scan = await scanAndParseRepo({
      repo,
      config,
      createProgressBar: () => ({ tick() {}, complete() {} })
    });
    expect(scan.parsedFiles.flatMap((file) => "symbols" in file ? file.symbols.map((symbol) => symbol.name) : []))
      .toEqual(expect.arrayContaining(["ActivityGoodsQueryVO", "LegacyChildDTO"]));
    const rawJava = await javaSchemaExtractor.extract({ repos: [repo], parsedFiles: scan.parsedFiles, repoResolver: () => repo });
    expect(rawJava.semanticRelations).toHaveLength(0);
    expect(rawJava.schemaDeclarations.map((candidate) => candidate.displayName)).toEqual(expect.arrayContaining(target.targetGroundTruth.schemaNames));

    const facts = await buildGraphFactsBatch({
      workspaceId: deriveWorkspaceId(config.systemName),
      generation: "generation:java-schema-js001",
      systemName: config.systemName,
      batchId: "batch:java-schema-js001",
      indexedAt: "2026-01-01T00:00:00.000Z",
      repos: [repo],
      parsedFiles: scan.parsedFiles,
      semantic: true,
      config
    });
    const currentSchemaNames = schemaNames(facts.contractSpecs);
    expect(currentSchemaNames).toEqual(expect.arrayContaining(target.targetGroundTruth.schemaNames));
    expect(facts.contractSpecs.some((spec) => spec.specKind === "http-endpoint")).toBe(true);

    const specIds = new Set(facts.contractSpecs.map((spec) => spec.id));
    expect(facts.semanticRelations.every((relation) => specIds.has(relation.fromSpecId) && specIds.has(relation.toSpecId))).toBe(true);
    const targetRelations = facts.semanticRelations.filter((relation) => {
      const from = facts.contractSpecs.find((spec) => spec.id === relation.fromSpecId);
      const to = facts.contractSpecs.find((spec) => spec.id === relation.toSpecId);
      return `${from?.specJson ?? ""}${to?.specJson ?? ""}`.includes("ActivityGoodsQueryVO");
    });
    expect(target.targetGroundTruth.relationKinds.every((kind) => targetRelations.some((relation) => relation.kind === kind))).toBe(true);

    const report = analyzeImpact(
      { target: "schema:ActivityGoodsQueryVO", changeType: "field-removed", detail: "activityId" },
      facts.contractSpecs,
      facts.semanticRelations
    );
    expect(report.impacts.length).toBeGreaterThanOrEqual(target.targetGroundTruth.impactTargetMatchesMinimum);
    const baselineVsTargetDiff = {
      missingSchemas: target.targetGroundTruth.schemaNames.filter((name) => !currentSchemaNames.includes(name)),
      missingRelations: target.targetGroundTruth.relationKinds.filter((kind) =>
        !targetRelations.some((relation) => relation.kind === kind)
      ),
      impactMatchDeficit: target.targetGroundTruth.impactTargetMatchesMinimum - report.impacts.length,
      pendingRefExcessBeforeWrite: rawJava.semanticRelations.length - target.targetGroundTruth.pendingRefsBeforeWrite,
      pendingRefExcessAfterWrite: facts.semanticRelations.filter((relation) => !specIds.has(relation.fromSpecId) || !specIds.has(relation.toSpecId)).length
    };
    expect(baselineVsTargetDiff.missingSchemas).toEqual([]);
    expect(baselineVsTargetDiff.missingRelations).toEqual([]);
    expect(baselineVsTargetDiff.impactMatchDeficit).toBeLessThanOrEqual(0);
    expect(baselineVsTargetDiff.pendingRefExcessBeforeWrite).toBe(0);
    expect(baselineVsTargetDiff.pendingRefExcessAfterWrite).toBe(0);

    const { db } = await openKuzu("test-java-schema-baseline-");
    try {
      await runIndexing(db, config, { cwd: fixtureRoot, writeMode: "auto" });
      const snapshot = await runSchemaSnapshotConformance(db, deriveWorkspaceId(config.systemName));
      expect(schemaNames(snapshot.publicGraph.contractSpecs as Array<{ specKind: string; specJson: string }>)).toEqual(
        expect.arrayContaining(target.targetGroundTruth.schemaNames)
      );
      const activeSpecIds = new Set(snapshot.publicGraph.contractSpecs.map((spec) => spec.id));
      expect(snapshot.publicGraph.semanticRelations.every((relation) => activeSpecIds.has(String(relation.fromSpecId)) && activeSpecIds.has(String(relation.toSpecId)))).toBe(true);

      const activityCode = snapshot.lexical.filter((document) =>
        document.kind === "code" && String(document.searchableText).includes("ActivityGoodsQueryVO")
      );
      const activityContractSpecs = snapshot.lexical.filter((document) =>
        document.kind === "contractSpec" && String(document.searchableText).includes("ActivityGoodsQueryVO")
      );
      expect(activityCode.length).toBeGreaterThan(0);
      expect(activityContractSpecs.length).toBeGreaterThan(0);
      expect(snapshot.lexical.every((document) => typeof document.sourceHash === "string" && document.sourceHash.length > 0)).toBe(true);
      const readSnapshot = await pinPublicGraphReadSnapshot(db, deriveWorkspaceId(config.systemName));
      const activityHits = await new KuzuWorkspaceLexicalStore(db).search(
        { workspaceId: readSnapshot.workspaceId, generation: readSnapshot.generation, text: "ActivityGoodsQueryVO" },
        { topK: 50 }
      );
      expect(activityHits.some((hit) => hit.kind === "code" && activityCode.some((document) => document.canonicalId === hit.canonicalId))).toBe(true);
      const documentsById = new Map(snapshot.lexical.map((document) => [document.id, document]));
      const targetContractSpecHits = activityHits.filter((hit) => {
        if (hit.kind !== "contractSpec") return false;
        const document = documentsById.get(hit.documentId);
        return document?.canonicalId === "ActivityGoodsQueryVO" ||
          String(document?.searchableText ?? "").includes("ActivityGoodsQueryVO");
      });
      expect(targetContractSpecHits.length).toBeGreaterThan(0);
      const lexicalKinds = new Set(snapshot.lexical.map((document) => document.kind));
      expect(["code", "file", "contract", "contractSpec"].every((kind) => lexicalKinds.has(kind))).toBe(true);

      const schemaSpec = snapshot.publicGraph.contractSpecs.find((spec) => spec.specKind === "schema");
      const schemaDocument = snapshot.lexical.find((document) => document.kind === "contractSpec" && document.canonicalId === schemaSpec?.id);
      expect(schemaSpec?.id).not.toContain(normalizeName(String(schemaSpec?.evidenceId)));
      expect(schemaSpec?.id).toMatch(/^spec:schema:[a-f0-9]{64}$/u);
      expect(schemaDocument).toMatchObject({ canonicalId: schemaSpec?.id, active: true });
      expect(String(schemaDocument?.id)).not.toBe(schemaSpec?.id);
    } finally {
      await db.close();
    }
  }, 60000);

  it("uses the real 11-repo auto-batch path and normalizes repo order and batch-size differences", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(workspaceRoot, "manifest.json"), "utf8")) as WorkspaceFixtureManifest;
    expect(manifest.repositories.length).toBeGreaterThanOrEqual(11);
    expect(manifest.resolutionScopeDependencies).toEqual([{
      from: { languageId: "java", repoId: "repo:repo-a", resolutionScopeId: "main" },
      to: { languageId: "java", repoId: "repo:repo-b", resolutionScopeId: "main" },
      kind: "repository",
      order: 0
    }]);
    expect(manifest.sameSimpleNameWithoutDependency).toEqual({
      consumer: "repo-a",
      dependency: "repo-b",
      unrelated: "repo-c",
      simpleName: "SharedOrderDTO"
    });
    const [repoAPom, repoAConsumer, repoBType, repoCBuild, repoCType] = await Promise.all([
      fs.readFile(path.join(workspaceRoot, "repo-a/pom.xml"), "utf8"),
      fs.readFile(path.join(workspaceRoot, "repo-a/src/main/java/fixture/a/ConsumerController.java"), "utf8"),
      fs.readFile(path.join(workspaceRoot, "repo-b/src/main/java/fixture/b/SharedOrderDTO.java"), "utf8"),
      fs.readFile(path.join(workspaceRoot, "repo-c/build.gradle"), "utf8"),
      fs.readFile(path.join(workspaceRoot, "repo-c/src/main/java/fixture/c/SharedOrderDTO.java"), "utf8")
    ]);
    expect(repoAPom).toMatch(/<artifactId>repo-b<\/artifactId>/u);
    expect(repoAConsumer).toContain("import fixture.b.SharedOrderDTO;");
    expect(repoBType).toMatch(/package fixture\.b;[\s\S]*class SharedOrderDTO/u);
    expect(repoCType).toMatch(/package fixture\.c;[\s\S]*class SharedOrderDTO/u);
    expect(repoCBuild).not.toContain("repo-b");
    const repos = manifest.repositories.map((name) => ({ name, path: path.join(workspaceRoot, name) }));

    const capture = async (orderedRepos: typeof repos, batchSize: number) => {
      const { db } = await openKuzu("test-java-schema-workspace-");
      const logs: string[] = [];
      const config = configFor(orderedRepos, batchSize);
      try {
        await runIndexing(db, config, { cwd: workspaceRoot, writeMode: "auto", batchSize, logger: { log: (message) => logs.push(message) } });
        return { snapshot: await captureSchemaBaselineSnapshot(db, deriveWorkspaceId(config.systemName)), logs };
      } finally {
        await db.close();
      }
    };

    const automatic = await capture(repos, 0);
    const reordered = await capture([...repos].reverse(), 4);
    expect(automatic.logs.some((message) => message.includes("Batched indexing: batches=2 batchSize=10"))).toBe(true);
    expect(reordered.logs.some((message) => message.includes("Batched indexing: batches=3 batchSize=4"))).toBe(true);
    assertNormalizedSchemaSnapshot(automatic.snapshot);
    expect(automatic.snapshot.internalIndex.resolutionScopeDependencies).toEqual({ status: "available", items: [] });
    expect(reordered.snapshot).toEqual(automatic.snapshot);
  }, 120000);

  it("keeps changed-only graph/internal/lexical output equal to a clean reindex after source replacement", async () => {
    const workingCopy = await fs.mkdtemp(path.join(os.tmpdir(), "test-java-schema-changed-copy-"));
    temporaryDirectories.push(workingCopy);
    await fs.cp(fixtureRoot, workingCopy, { recursive: true });
    const config = configFor([{ name: "java-schema-js001", path: workingCopy }]);
    const workspaceId = deriveWorkspaceId(config.systemName);
    const changedFile = path.join(workingCopy, "activity-api/src/main/java/com/example/activity/model/LegacyChildDTO.java");

    const incrementalDb = await openKuzu("test-java-schema-changed-incremental-");
    try {
      await runIndexing(incrementalDb.db, config, { cwd: workingCopy, writeMode: "auto" });
      await fs.writeFile(changedFile, "package com.example.activity.model;\npublic class LegacyChildDTO extends LegacyBaseDTO { private String changedValue; }\n", "utf8");
      await runIndexing(incrementalDb.db, config, { cwd: workingCopy, writeMode: "auto", changedOnly: true });
      const incremental = await captureSchemaBaselineSnapshot(incrementalDb.db, workspaceId);

      const cleanDb = await openKuzu("test-java-schema-changed-clean-");
      try {
        await runIndexing(cleanDb.db, config, { cwd: workingCopy, writeMode: "auto" });
        const clean = await captureSchemaBaselineSnapshot(cleanDb.db, workspaceId);
        assertNormalizedSchemaSnapshot(incremental);
        assertNormalizedSchemaSnapshot(clean);
        // JS-003 replaces source-owned public and lexical facts atomically, so
        // the JS-001 characterization divergence is intentionally eliminated.
        expect(incremental).toEqual(clean);
        expect(clean.lexical.some((document) => document.active === false)).toBe(false);
      } finally {
        await cleanDb.db.close();
      }
    } finally {
      await incrementalDb.db.close();
    }
  }, 120000);

  it("rebuilds unchanged sources when the active behavior fingerprint is stale", async () => {
    const config = configFor([{ name: "java-schema-js001", path: fixtureRoot }]);
    const workspaceId = deriveWorkspaceId(config.systemName);
    const { db } = await openKuzu("test-java-schema-behavior-change-");
    try {
      await runIndexing(db, config, { cwd: fixtureRoot, writeMode: "auto" });
      const clean = await captureSchemaBaselineSnapshot(db, workspaceId);
      const rows = await db.query<{ id?: string; payload?: string }>(
        "MATCH (f:SchemaBehaviorFingerprintFact) RETURN f.id AS id, f.payload AS payload;"
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const fingerprint = JSON.parse(String(row.payload)) as Record<string, unknown>;
        await db.query(
          "MATCH (f:SchemaBehaviorFingerprintFact {id: $id}) SET f.payload=$payload;",
          { id: String(row.id), payload: JSON.stringify({ ...fingerprint, adapterVersion: "java-type-system-outdated" }) }
        );
      }
      const logs: string[] = [];
      const result = await runIndexing(db, config, {
        cwd: fixtureRoot,
        writeMode: "auto",
        changedOnly: true,
        logger: { log: (message) => logs.push(message) }
      });
      const rebuilt = await captureSchemaBaselineSnapshot(db, workspaceId);

      expect(result.filesChanged).toBeGreaterThan(0);
      expect(logs.some((message) => message.includes("forcing a clean workspace rebuild"))).toBe(true);
      expect(rebuilt.publicGraph).toEqual(clean.publicGraph);
      expect(rebuilt.internalIndex).toEqual(clean.internalIndex);
      expect(rebuilt.lexical).toEqual(clean.lexical);
    } finally {
      await db.close();
    }
  }, 120000);
});
