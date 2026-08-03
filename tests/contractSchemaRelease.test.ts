import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { captureSchemaBaselineSnapshot } from "./helpers/schemaBaselineSnapshot.js";
import { applyReleaseFinalMutation, prepareContractSchemaReleaseCorpus, runContractSchemaReleaseConformance } from "./helpers/contractSchemaReleaseHarness.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { runIndexing } from "../src/core/indexing/run.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("contract-schema-release Kuzu hard gate", () => {
  it("matches fixed ground truth and converges across full, changed-only, rename, deletion, GC, and batch sizes", async () => {
    const corpus = await prepareContractSchemaReleaseCorpus();
    directories.push(corpus.directory);
    const graphDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-release-kuzu-"));
    directories.push(graphDirectory);
    const db = await KuzuGraphDB.open(path.join(graphDirectory, "graph"));
    try {
      await db.initSchema(corpus.config.systemName);
      const result = await runContractSchemaReleaseConformance({ db, corpusDirectory: corpus.directory, config: corpus.config, groundTruth: corpus.groundTruth, manifest: corpus.manifest });
      expect(result.logical.schemaCanonicalNames.length).toBeGreaterThan(0);

      const batchCorpus = await prepareContractSchemaReleaseCorpus();
      directories.push(batchCorpus.directory);
      const batchDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-release-batch-"));
      directories.push(batchDirectory);
      const batchDb = await KuzuGraphDB.open(path.join(batchDirectory, "graph"));
      try {
        await batchDb.initSchema(batchCorpus.config.systemName);
        await runIndexing(batchDb, { ...batchCorpus.config, indexing: { ...batchCorpus.config.indexing, batchSize: 2 } }, { cwd: batchCorpus.directory, writeMode: "auto" });
        expect(await captureSchemaBaselineSnapshot(batchDb, deriveWorkspaceId(batchCorpus.config.systemName))).toEqual(result.initial);
      } finally {
        await batchDb.close();
      }

      const cleanCorpus = await prepareContractSchemaReleaseCorpus();
      directories.push(cleanCorpus.directory);
      await applyReleaseFinalMutation(cleanCorpus.directory, cleanCorpus.manifest);
      const cleanDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-release-clean-final-"));
      directories.push(cleanDirectory);
      const cleanDb = await KuzuGraphDB.open(path.join(cleanDirectory, "graph"));
      try {
        await cleanDb.initSchema(cleanCorpus.config.systemName);
        await runIndexing(cleanDb, { ...cleanCorpus.config, indexing: { ...cleanCorpus.config.indexing, batchSize: 4 } }, { cwd: cleanCorpus.directory, writeMode: "auto" });
        expect(await captureSchemaBaselineSnapshot(cleanDb, deriveWorkspaceId(cleanCorpus.config.systemName))).toEqual(result.final);
      } finally {
        await cleanDb.close();
      }
    } finally {
      await db.close();
    }
  }, 180_000);
});
