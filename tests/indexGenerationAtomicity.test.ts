import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import { KuzuGraphDB, type GraphDB } from "../src/core/graph-model/db.js";
import { pinPublicGraphReadSnapshot } from "../src/core/graph-model/readSnapshot.js";
import { runIndexing } from "../src/core/indexing/run.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { captureSchemaBaselineSnapshot } from "./helpers/schemaBaselineSnapshot.js";
import type { AppConfig } from "../src/config/schema.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

async function cleanFullSnapshot(directory: string, config: AppConfig, sequence: number) {
  const clean = await KuzuGraphDB.open(path.join(directory, `clean-${sequence}`));
  try {
    await clean.initSchema(config.systemName);
    await runIndexing(clean, config, { cwd: directory, writeMode: "auto" });
    return await captureSchemaBaselineSnapshot(clean, deriveWorkspaceId(config.systemName));
  } finally {
    await clean.close();
  }
}

async function activeNodeIds(
  db: GraphDB,
  workspaceId: string,
  label: "Contract" | "Evidence" | "Entity",
  ids: readonly string[]
): Promise<string[]> {
  if (ids.length === 0) return [];
  const scope = await pinPublicGraphReadSnapshot(db, workspaceId);
  const rows = await db.query<{ id: string }>(
    `MATCH (n:${label}) WHERE n.workspaceId=$workspaceId AND n.generation=$generation AND n.id IN $ids RETURN n.id AS id;`,
    { ...scope, ids: [...ids] }
  );
  return [...new Set(rows.map((row) => row.id))].sort();
}

describe("index generation atomicity", () => {
  it("rolls back graph and internal state when final validation fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-generation-atomicity-"));
    directories.push(directory);
    const repoPath = path.join(directory, "repo");
    await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
    const sourcePath = path.join(repoPath, "src", "models.ts");
    const untouchedPath = path.join(repoPath, "src", "untouched.ts");
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "atomic-repo", version: "1.0.0" }), "utf8");
    await fs.writeFile(
      sourcePath,
      "export interface User { id: string; }\neventBus.publish<User>(\"users.old\", user);\n",
      "utf8"
    );
    await fs.writeFile(untouchedPath, "export interface Account { id: string; }\n", "utf8");
    const config = {
      ...defaultConfig(),
      systemName: `atomic-${path.basename(directory)}`,
      repos: [{ name: "atomic-repo", path: repoPath }]
    };
    const db = await KuzuGraphDB.open(path.join(directory, "graph"));
    try {
      await db.initSchema(config.systemName);
      await runIndexing(db, config, { cwd: directory, writeMode: "auto" });
      const workspaceId = deriveWorkspaceId(config.systemName);
      const generationBefore = await db.query<{ activeGeneration: string; activeRevision: string }>(
        "MATCH (n:SchemaGenerationState {id: $id}) RETURN n.activeGeneration AS activeGeneration, n.activeRevision AS activeRevision;",
        { id: `schema-generation-state:${workspaceId}` }
      );
      const before = await captureSchemaBaselineSnapshot(db, workspaceId);
      expect(before.publicGraph.contracts.some((contract) => contract.key === "users.old")).toBe(true);
      expect(before.publicGraph.contractSpecs).toHaveLength(2);
      expect(before.publicGraph.hasSpec).toHaveLength(2);
      expect(before.publicGraph.semanticRelations).toHaveLength(1);
      expect(before.publicGraph.provenance).toHaveLength(2);
      await fs.writeFile(
        sourcePath,
        "export interface User { id: string; changed: string; }\neventBus.publish<User>(\"users.new\", user);\n",
        "utf8"
      );
      const originalStatsUpdate = db.applyPublicGraphStatsDelta.bind(db);
      db.applyPublicGraphStatsDelta = async (scope, update) => {
        await originalStatsUpdate(scope, update);
        throw new Error("final validation failed");
      };
      try {
        await expect(runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true })).rejects.toThrow("final validation failed");
      } finally {
        db.applyPublicGraphStatsDelta = originalStatsUpdate;
      }
      const after = await captureSchemaBaselineSnapshot(db, workspaceId);
      expect(after).toEqual(before);
      const generationAfterFailure = await db.query<{ activeGeneration: string }>(
        "MATCH (n:SchemaGenerationState {id: $id}) RETURN n.activeGeneration AS activeGeneration;",
        { id: `schema-generation-state:${workspaceId}` }
      );
      expect(generationAfterFailure[0]?.activeGeneration).toBe(generationBefore[0]?.activeGeneration);

      await fs.writeFile(sourcePath, "export const noSchema = true;\n", "utf8");
      await runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true });
      const replaced = await captureSchemaBaselineSnapshot(db, workspaceId);
      const generationAfter = await db.query<{ activeGeneration: string; activeRevision: string }>(
        "MATCH (n:SchemaGenerationState {id: $id}) RETURN n.activeGeneration AS activeGeneration, n.activeRevision AS activeRevision;",
        { id: `schema-generation-state:${workspaceId}` }
      );
      expect(generationAfter[0]?.activeGeneration).toBe(generationBefore[0]?.activeGeneration);
      expect(generationAfter[0]?.activeRevision).not.toBe(generationBefore[0]?.activeRevision);
      expect(replaced.internalIndex.declarations.items).toHaveLength(1);
      expect(JSON.stringify(replaced.internalIndex.declarations.items)).toContain("Account");
      expect(JSON.stringify(replaced.internalIndex.declarations.items)).not.toContain("User");
      expect(replaced).toEqual(await cleanFullSnapshot(directory, config, 1));

      await fs.writeFile(sourcePath, "export interface Customer { id: string; }\n", "utf8");
      await runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true });
      const renamed = await captureSchemaBaselineSnapshot(db, workspaceId);
      expect(JSON.stringify(renamed.internalIndex.declarations.items)).toContain("Customer");
      expect(JSON.stringify(renamed.internalIndex.declarations.items)).not.toContain('"displayName":"User"');
      expect(renamed).toEqual(await cleanFullSnapshot(directory, config, 2));

      const movedPath = path.join(repoPath, "src", "domain", "models.ts");
      await fs.mkdir(path.dirname(movedPath), { recursive: true });
      await fs.rename(sourcePath, movedPath);
      await runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true });
      const moved = await captureSchemaBaselineSnapshot(db, workspaceId);
      expect(JSON.stringify(moved.internalIndex.declarations.items)).toContain("src/domain/models.ts");
      expect(JSON.stringify(moved.internalIndex.declarations.items)).not.toContain("src/models.ts");
      expect(moved).toEqual(await cleanFullSnapshot(directory, config, 3));
    } finally {
      await db.close();
    }
  }, 60000);

  it("keeps shared reachable schemas until the final root disappears and converges to clean full state", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-generation-contributions-"));
    directories.push(directory);
    const repoPath = path.join(directory, "repo");
    const sourcePath = path.join(repoPath, "src", "events.ts");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "contribution-repo", version: "1.0.0" }), "utf8");
    const declarations = [
      "export interface User { id: string; }",
      "export interface Order { user: User; }"
    ];
    const source = (...topics: string[]) => `${[
      ...declarations,
      ...topics.map((topic) => `broker.publish<Order>(\"${topic}\", order);`)
    ].join("\n")}\n`;
    await fs.writeFile(sourcePath, source("orders.created", "orders.updated"), "utf8");
    const config = {
      ...defaultConfig(),
      systemName: `contributions-${path.basename(directory)}`,
      repos: [{ name: "contribution-repo", path: repoPath }]
    };
    const db = await KuzuGraphDB.open(path.join(directory, "graph"));
    try {
      await db.initSchema(config.systemName);
      await runIndexing(db, config, { cwd: directory, writeMode: "auto" });
      const workspaceId = deriveWorkspaceId(config.systemName);
      const initial = await captureSchemaBaselineSnapshot(db, workspaceId);
      const initialSchemaSpecs = initial.publicGraph.contractSpecs.filter((spec) => spec.specKind === "schema");
      const initialSchemaContractIds = new Set(initialSchemaSpecs.map((spec) => String(spec.contractId)));
      const initialSchemaEvidenceIds = new Set(initialSchemaSpecs.map((spec) => String(spec.evidenceId)));
      const initialScope = await pinPublicGraphReadSnapshot(db, workspaceId);
      const initialSchemaEntityIds = new Set((await db.query<{ id: string }>(
        "MATCH (source:Contract)-[r:CONTRACT_MENTIONS]->(n:Entity) " +
        "WHERE source.workspaceId=$workspaceId AND source.generation=$generation AND source.id IN $contractIds " +
        "AND r.workspaceId=$workspaceId AND r.generation=$generation " +
        "AND n.workspaceId=$workspaceId AND n.generation=$generation RETURN n.id AS id;",
        { ...initialScope, contractIds: [...initialSchemaContractIds] }
      )).map((row) => row.id));
      expect(initialSchemaSpecs).toHaveLength(2);
      expect(initialSchemaContractIds.size).toBe(2);
      expect(initialSchemaEvidenceIds.size).toBe(2);
      expect(initialSchemaEntityIds.size).toBe(2);
      expect(initial.internalIndex.roots.items).toHaveLength(2);

      await fs.writeFile(sourcePath, source("orders.updated"), "utf8");
      await runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true });
      const oneRoot = await captureSchemaBaselineSnapshot(db, workspaceId);
      const activeSchemaIds = new Set(oneRoot.publicGraph.contractSpecs
        .filter((spec) => spec.specKind === "schema")
        .map((spec) => spec.id));
      expect(activeSchemaIds).toHaveLength(2);
      expect(await activeNodeIds(db, workspaceId, "Contract", [...initialSchemaContractIds])).toHaveLength(2);
      expect(await activeNodeIds(db, workspaceId, "Evidence", [...initialSchemaEvidenceIds])).toHaveLength(2);
      expect(await activeNodeIds(db, workspaceId, "Entity", [...initialSchemaEntityIds])).toHaveLength(2);
      expect(oneRoot.internalIndex.roots.items).toHaveLength(1);
      expect(oneRoot).toEqual(await cleanFullSnapshot(directory, config, 4));

      await fs.writeFile(sourcePath, source(), "utf8");
      await runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true });
      const noRoots = await captureSchemaBaselineSnapshot(db, workspaceId);
      expect(noRoots.publicGraph.contractSpecs.filter((spec) => spec.specKind === "schema")).toHaveLength(0);
      expect(await activeNodeIds(db, workspaceId, "Contract", [...initialSchemaContractIds])).toHaveLength(0);
      expect(await activeNodeIds(db, workspaceId, "Evidence", [...initialSchemaEvidenceIds])).toHaveLength(0);
      expect(noRoots.internalIndex.declarations.items).toHaveLength(2);
      expect(noRoots.internalIndex.roots.items).toHaveLength(0);
      expect(noRoots).toEqual(await cleanFullSnapshot(directory, config, 5));
    } finally {
      await db.close();
    }
  }, 60000);

  it("resolves a changed TypeScript root through an unchanged imported declaration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-generation-import-overlay-"));
    directories.push(directory);
    const repoPath = path.join(directory, "repo");
    const modelsPath = path.join(repoPath, "src", "models.ts");
    const publisherPath = path.join(repoPath, "src", "publisher.ts");
    await fs.mkdir(path.dirname(modelsPath), { recursive: true });
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "import-overlay-repo", version: "1.0.0" }), "utf8");
    await fs.writeFile(modelsPath, "export interface Payload { id: string; }\n", "utf8");
    await fs.writeFile(publisherPath, "import { Payload } from './models'; broker.publish<Payload>('topic.created', payload);\n", "utf8");
    const config = {
      ...defaultConfig(),
      systemName: `import-overlay-${path.basename(directory)}`,
      repos: [{ name: "import-overlay-repo", path: repoPath }]
    };
    const db = await KuzuGraphDB.open(path.join(directory, "graph"));
    try {
      await db.initSchema(config.systemName);
      await runIndexing(db, config, { cwd: directory, writeMode: "auto" });
      await fs.writeFile(publisherPath, "import { Payload as EventPayload } from './models'; broker.publish<EventPayload>('topic.updated', payload);\n", "utf8");
      await runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true });
      const workspaceId = deriveWorkspaceId(config.systemName);
      const changedOnly = await captureSchemaBaselineSnapshot(db, workspaceId);
      expect(changedOnly.publicGraph.contractSpecs.filter((spec) => spec.specKind === "schema")).toHaveLength(1);
      expect(changedOnly.internalIndex.roots.items).toHaveLength(1);
      expect(JSON.stringify(changedOnly.internalIndex.resolutionContexts.items)).toContain("EventPayload");
      expect(changedOnly).toEqual(await cleanFullSnapshot(directory, config, 6));
    } finally {
      await db.close();
    }
  }, 60000);

  it("replaces an unchanged root owner's facts when a referenced declaration changes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-generation-affected-root-"));
    directories.push(directory);
    const repoPath = path.join(directory, "repo");
    const modelsPath = path.join(repoPath, "src", "models.ts");
    const publisherPath = path.join(repoPath, "src", "publisher.ts");
    await fs.mkdir(path.dirname(modelsPath), { recursive: true });
    await fs.writeFile(path.join(repoPath, "package.json"), JSON.stringify({ name: "affected-root-repo", version: "1.0.0" }), "utf8");
    await fs.writeFile(modelsPath, [
      "export interface Nested { id: string; }",
      "export interface Payload { nested: Nested; }"
    ].join("\n"), "utf8");
    await fs.writeFile(publisherPath, "import { Payload } from './models'; eventBus.publish<Payload>('topic.created', payload);\n", "utf8");
    const config = {
      ...defaultConfig(),
      systemName: `affected-root-${path.basename(directory)}`,
      repos: [{ name: "affected-root-repo", path: repoPath }]
    };
    const db = await KuzuGraphDB.open(path.join(directory, "graph"));
    try {
      await db.initSchema(config.systemName);
      await runIndexing(db, config, { cwd: directory, writeMode: "auto" });
      const workspaceId = deriveWorkspaceId(config.systemName);
      const initial = await captureSchemaBaselineSnapshot(db, workspaceId);
      expect(JSON.stringify(initial.publicGraph.contractSpecs)).toContain("Nested");

      await fs.writeFile(modelsPath, "export interface Payload { missing: Missing; }\n", "utf8");
      await runIndexing(db, config, { cwd: directory, writeMode: "auto", changedOnly: true });
      const changedOnly = await captureSchemaBaselineSnapshot(db, workspaceId);
      expect(JSON.stringify(changedOnly.publicGraph.contractSpecs)).not.toContain("Nested");
      expect(JSON.stringify(changedOnly.internalIndex.diagnostics.items)).toContain("Missing");
      expect(changedOnly).toEqual(await cleanFullSnapshot(directory, config, 6));
    } finally {
      await db.close();
    }
  }, 60000);
});
