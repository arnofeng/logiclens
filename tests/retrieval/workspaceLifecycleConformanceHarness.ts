import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import type { GraphDB } from "../../src/core/graph-model/db.js";
import { writeGraphFactsBatch } from "../../src/core/graph-model/batchWriter.js";
import { buildGraphFactsBatch } from "../../src/core/graph-model/facts.js";
import type { ParsedFile, RepoNode } from "../../src/core/parsing/types.js";
import type { WorkspaceLexicalStore } from "../../src/core/retrieval/provider.js";
import { projectLexicalDocuments } from "../../src/core/retrieval/projection.js";
import type { LexicalDocument } from "../../src/core/retrieval/types.js";
import { pinPublicGraphReadSnapshot } from "../../src/core/graph-model/readSnapshot.js";
import { SchemaGenerationStore } from "../../src/core/schema/generationStore.js";
import { runSchemaSnapshotConformance } from "../helpers/schemaBaselineSnapshot.js";

export interface WorkspaceLifecycleFixture {
  readonly db: GraphDB;
  readonly store: WorkspaceLexicalStore;
  workspaceId: string;
  suffix: string;
  reopen(): Promise<void>;
  assertSingleIndex(): Promise<void>;
}

type LifecycleWorkspaceState = {
  repos: Map<string, RepoNode>;
  files: Map<string, ParsedFile>;
};

const lifecycleStates = new WeakMap<WorkspaceLifecycleFixture, Map<string, LifecycleWorkspaceState>>();

function lifecycleState(fixture: WorkspaceLifecycleFixture, workspaceId: string): LifecycleWorkspaceState {
  let workspaces = lifecycleStates.get(fixture);
  if (!workspaces) {
    workspaces = new Map();
    lifecycleStates.set(fixture, workspaces);
  }
  let state = workspaces.get(workspaceId);
  if (!state) {
    state = { repos: new Map(), files: new Map() };
    workspaces.set(workspaceId, state);
  }
  return state;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function repo(id: string, name: string): RepoNode {
  return {
    id,
    name,
    path: `/conformance/${name}`,
    remoteUrl: "",
    branch: "main",
    commitSha: "",
    language: "typescript",
    indexedAt: "2026-01-01T00:00:00.000Z"
  };
}

function sourceFile(repoId: string, relativePath: string, symbolName: string, marker: string): ParsedFile {
  const fileId = `${repoId}:file:${relativePath}`;
  const source = `export class ${symbolName} { lifecycle() { return "${marker}"; } }`;
  return {
    repoId,
    fileId,
    path: relativePath,
    language: "typescript",
    hash: hash(source),
    loc: 1,
    source,
    imports: [],
    calls: [],
    symbols: [{
      id: `${repoId}:code:${symbolName}`,
      repoId,
      fileId,
      kind: "class",
      name: symbolName,
      qualifiedName: symbolName,
      startLine: 1,
      endLine: 1,
      signature: `class ${symbolName}`,
      source,
      hash: hash(source)
    }]
  };
}

async function projectAndWrite(input: {
  fixture: WorkspaceLifecycleFixture;
  repos: RepoNode[];
  files: ParsedFile[];
  batchId: string;
  workspaceId?: string;
}): Promise<LexicalDocument[]> {
  const workspaceId = input.workspaceId ?? input.fixture.workspaceId;
  const state = lifecycleState(input.fixture, workspaceId);
  for (const item of input.repos) {
    state.repos.set(item.id, item);
    for (const [fileId, file] of state.files) {
      if (file.repoId === item.id) state.files.delete(fileId);
    }
  }
  for (const file of input.files) state.files.set(file.fileId, file);
  const repos = [...state.repos.values()].sort((left, right) => left.id.localeCompare(right.id));
  const files = [...state.files.values()].sort((left, right) => left.fileId.localeCompare(right.fileId));
  return withPendingGeneration(input.fixture, workspaceId, input.batchId, async (generation) => {
    const facts = await buildGraphFactsBatch({
      batchId: input.batchId,
      workspaceId,
      generation,
      systemName: `workspace-lifecycle-${input.fixture.suffix}`,
      indexedAt: "2026-01-01T00:00:00.000Z",
      repos,
      parsedFiles: files,
      semantic: false
    });
    const documents = projectLexicalDocuments(facts, workspaceId);
    const scope = { workspaceId, generation };
    for (const item of repos) await input.fixture.db.upsertRepo(item, scope);
    await writeGraphFactsBatch(input.fixture.db, {
      batchId: input.batchId,
      workspaceId,
      generation,
      systemName: `workspace-lifecycle-${input.fixture.suffix}`,
      repos,
      parsedFiles: files
    }, {
      semantic: false,
      workspaceId,
      generation,
      systemName: `workspace-lifecycle-${input.fixture.suffix}`
    });
    await input.fixture.store.upsertDocuments({ workspaceId, generation, documents });
    for (const item of repos) {
      await input.fixture.store.reconcileRepoDocuments({
        workspaceId,
        generation,
        repoId: item.id,
        batchId: input.batchId,
        activeDocumentIds: documents.filter((document) => document.repoId === item.id).map((document) => document.id)
      });
    }
    return documents;
  });
}

async function withPendingGeneration<T>(
  fixture: WorkspaceLifecycleFixture,
  workspaceId: string,
  batchId: string,
  write: (generation: string, parentGeneration: string | undefined) => Promise<T>
): Promise<T> {
  const generation = `schema-generation:${fixture.suffix}:${hash(`${workspaceId}:${batchId}`).slice(0, 20)}`;
  const generations = new SchemaGenerationStore(fixture.db, workspaceId);
  const expectedActiveGeneration = await generations.activeGeneration();
  const parentGeneration = await generations.beginFull({
    generation,
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedActiveGeneration: expectedActiveGeneration ?? null,
    expectedActiveRevision: (await generations.activeRevision()) ?? null
  });
  try {
    await fixture.store.initializeGeneration({ workspaceId, generation });
    const result = await write(generation, parentGeneration);
    const scope = { workspaceId, generation };
    await fixture.db.initializePublicGraphStats(
      scope,
      generation,
      await fixture.db.computePublicGraphStats(scope)
    );
    await generations.validateFull(generation);
    await generations.commitFull(generation);
    return result;
  } catch (error) {
    try {
      await generations.abandonFull(generation);
      await fixture.store.deleteGeneration({ workspaceId, generation });
      await fixture.db.deletePublicGraphGeneration({ workspaceId, generation });
      await generations.rollback(generation);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Pending generation ${generation} failed and cleanup was incomplete.`
      );
    }
    throw error;
  }
}

async function activeGeneration(fixture: WorkspaceLifecycleFixture, workspaceId = fixture.workspaceId): Promise<string> {
  return (await pinPublicGraphReadSnapshot(fixture.db, workspaceId)).generation;
}

async function activeSnapshot(fixture: WorkspaceLifecycleFixture): Promise<string[]> {
  const generation = await activeGeneration(fixture);
  const rows = await fixture.db.query<{ documentId: string; canonicalId: string; sourceHash: string }>(
    "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.active = true RETURN n.documentId AS documentId, n.canonicalId AS canonicalId, n.sourceHash AS sourceHash;",
    { workspaceId: fixture.workspaceId, generation }
  );
  return rows.map((row) => `${row.documentId}|${row.canonicalId}|${row.sourceHash}`).sort();
}

async function ranking(fixture: WorkspaceLifecycleFixture): Promise<string[]> {
  const generation = await activeGeneration(fixture);
  return (await fixture.store.search({ workspaceId: fixture.workspaceId, generation, text: "lifecycle" }, { topK: 50 }))
    .map((hit) => hit.documentId);
}

async function search(
  fixture: WorkspaceLifecycleFixture,
  text: string,
  topK = 50,
  workspaceId = fixture.workspaceId
) {
  const generation = await activeGeneration(fixture, workspaceId);
  return fixture.store.search({ workspaceId, generation, text }, { topK });
}

/** Runs the exact same graph-facts-to-lexical lifecycle against every provider. */
export async function runWorkspaceLifecycleConformance(fixture: WorkspaceLifecycleFixture): Promise<void> {
  const one = repo(`repo:one:${fixture.suffix}`, "LifecycleOne");
  const two = repo(`repo:two:${fixture.suffix}`, "LifecycleTwo");
  const alpha = sourceFile(one.id, "src/Alpha.ts", "AlphaService", "alphamarker");
  const beta = sourceFile(two.id, "src/Beta.ts", "BetaService", "betamarker");

  await fixture.store.ensureSchema();
  await projectAndWrite({ fixture, repos: [one, two], files: [alpha, beta], batchId: `batch:initial:${fixture.suffix}` });
  assert.ok((await fixture.store.health({
    workspaceId: fixture.workspaceId,
    generation: await activeGeneration(fixture)
  })).metrics.documentCount > 2);
  assert.deepEqual(
    new Set((await search(fixture, "lifecycle")).map((hit) => hit.repoId)),
    new Set([one.id, two.id])
  );

  const updatedAlpha = sourceFile(one.id, alpha.path, "AlphaService", "alphaupdatedmarker");
  const expectedAlphaCanonicalId = alpha.symbols[0]?.id;
  assert.ok(expectedAlphaCanonicalId, "Alpha fixture must contain its expected code symbol.");
  const oldAlphaCode = (await projectAndWrite({ fixture, repos: [one], files: [alpha], batchId: `batch:identity:${fixture.suffix}` }))
    .find((document) =>
      document.kind === "code" &&
      document.repoId === one.id &&
      document.canonicalId === expectedAlphaCanonicalId
    );
  assert.ok(oldAlphaCode, `Expected Alpha code document ${expectedAlphaCanonicalId} was not projected.`);
  const updatedDocuments = await projectAndWrite({ fixture, repos: [one], files: [updatedAlpha], batchId: `batch:update:${fixture.suffix}` });
  const updatedAlphaCode = updatedDocuments.find((document) =>
    document.kind === "code" &&
    document.repoId === one.id &&
    document.canonicalId === expectedAlphaCanonicalId
  );
  assert.ok(updatedAlphaCode, `Expected updated Alpha code document ${expectedAlphaCanonicalId} was not projected.`);
  assert.equal(updatedAlphaCode.id, oldAlphaCode.id);
  assert.notEqual(updatedAlphaCode.sourceHash, oldAlphaCode.sourceHash);

  const renamedRepo = { ...one, name: "LifecycleOneRenamed" };
  await projectAndWrite({ fixture, repos: [renamedRepo], files: [updatedAlpha], batchId: `batch:repo-rename:${fixture.suffix}` });
  const renameGeneration = await activeGeneration(fixture);
  assert.equal((await fixture.db.query(
    "MATCH (r:Repo) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.id = $repoId AND r.name = $name RETURN r.id AS id;",
    { workspaceId: fixture.workspaceId, generation: renameGeneration, repoId: one.id, name: renamedRepo.name }
  )).length, 1);

  // Rebuild only from graph facts/projection inputs, never by reloading the
  // old lexical documents. Identity, source hashes, and global order survive.
  const beforeRebuild = await activeSnapshot(fixture);
  const orderBeforeRebuild = await ranking(fixture);
  await withPendingGeneration(
    fixture,
    fixture.workspaceId,
    `batch:clear:${fixture.suffix}`,
    async (generation) => {
      for (const item of [renamedRepo, two]) {
        await fixture.store.reconcileRepoDocuments({
          workspaceId: fixture.workspaceId,
          generation,
          repoId: item.id,
          batchId: `batch:clear:${fixture.suffix}`,
          activeDocumentIds: []
        });
        await fixture.db.clearRepoIndexedArtifacts(item.id, { workspaceId: fixture.workspaceId, generation });
      }
    }
  );
  await projectAndWrite({ fixture, repos: [renamedRepo, two], files: [updatedAlpha, beta], batchId: `batch:rebuild:${fixture.suffix}` });
  assert.deepEqual(await activeSnapshot(fixture), beforeRebuild);
  assert.deepEqual(await ranking(fixture), orderBeforeRebuild);
  await runSchemaSnapshotConformance(fixture.db, fixture.workspaceId);

  const renamedAlpha = sourceFile(one.id, "src/RenamedAlpha.ts", "AlphaService", "alphaupdatedmarker");
  await projectAndWrite({ fixture, repos: [renamedRepo], files: [renamedAlpha], batchId: `batch:file-rename:${fixture.suffix}` });
  const fileRenameGeneration = await activeGeneration(fixture);
  const newPath = await fixture.db.query(
    "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.path = $path AND n.active = true RETURN n.documentId AS id;",
    { workspaceId: fixture.workspaceId, generation: fileRenameGeneration, repoId: one.id, path: renamedAlpha.path }
  );
  assert.ok(newPath.length > 0);
  const oldPath = await fixture.db.query(
    "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.repoId = $repoId AND n.path = $path AND n.active = true RETURN n.documentId AS id;",
    { workspaceId: fixture.workspaceId, generation: fileRenameGeneration, repoId: one.id, path: alpha.path }
  );
  assert.equal(oldPath.length, 0);

  await projectAndWrite({ fixture, repos: [renamedRepo], files: [], batchId: `batch:file-delete:${fixture.suffix}` });
  assert.equal((await search(fixture, "AlphaService")).length, 0);
  assert.equal((await search(fixture, "BetaService"))[0]?.repoId, two.id);
  const afterEmptyReconciliation = await runSchemaSnapshotConformance(fixture.db, fixture.workspaceId);
  assert.equal(afterEmptyReconciliation.lexical
    .filter((document) => document.repoId === one.id)
    .every((document) => document.kind === "repo"), true);

  const currentState = lifecycleState(fixture, fixture.workspaceId);
  currentState.repos.delete(one.id);
  for (const [fileId, file] of currentState.files) {
    if (file.repoId === one.id) currentState.files.delete(fileId);
  }
  await projectAndWrite({
    fixture,
    repos: [],
    files: [],
    batchId: `batch:repo-delete:${fixture.suffix}`
  });
  const repoDeleteGeneration = await activeGeneration(fixture);
  assert.equal((await fixture.db.query(
    "MATCH (r:Repo) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.id = $repoId RETURN r.id AS id;",
    { workspaceId: fixture.workspaceId, generation: repoDeleteGeneration, repoId: one.id }
  )).length, 0);
  assert.equal((await search(fixture, "LifecycleOneRenamed"))
    .some((hit) => hit.repoId === one.id), false);

  const recoveryRepo = repo(`repo:recovery:${fixture.suffix}`, "RecoveryRepo");
  const recoveryFile = sourceFile(recoveryRepo.id, "src/Recovery.ts", "RecoveryService", "recoverymarker");
  const recoveryBatchId = `batch:recover:${fixture.suffix}`;
  const recoveryGeneration = `schema-generation:${fixture.suffix}:${hash(`${fixture.workspaceId}:${recoveryBatchId}`).slice(0, 20)}`;
  const recoveryGenerations = new SchemaGenerationStore(fixture.db, fixture.workspaceId);
  const expectedRecoveryParent = await recoveryGenerations.activeGeneration();
  const recoveryParent = await recoveryGenerations.beginFull({
    generation: recoveryGeneration,
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedActiveGeneration: expectedRecoveryParent ?? null,
    expectedActiveRevision: (await recoveryGenerations.activeRevision()) ?? null
  });
  await fixture.store.initializeGeneration({
    workspaceId: fixture.workspaceId,
    generation: recoveryGeneration
  });
  const recoveryFacts = await buildGraphFactsBatch({
    batchId: recoveryBatchId,
    workspaceId: fixture.workspaceId,
    generation: recoveryGeneration,
    systemName: `workspace-lifecycle-${fixture.suffix}`,
    repos: [recoveryRepo],
    parsedFiles: [recoveryFile],
    semantic: false
  });
  const recoveryDocuments = projectLexicalDocuments(recoveryFacts, fixture.workspaceId);
  await fixture.db.beginGraphWriteBatch({
    batchId: recoveryBatchId,
    generation: recoveryGeneration,
    parentGeneration: recoveryParent,
    repoIds: [recoveryRepo.id],
    repoNames: [recoveryRepo.name],
    writerMode: "merge",
    atomicityMode: "journaled-recoverable",
    workspaceId: fixture.workspaceId,
    startedAt: new Date().toISOString(),
    completedStage: "lexical-written"
  });
  await fixture.store.upsertDocuments({
    workspaceId: fixture.workspaceId,
    generation: recoveryGeneration,
    documents: recoveryDocuments
  });
  await assert.rejects(
    fixture.db.cleanupGraphWriteBatch(recoveryBatchId),
    /reserved pending public graph generation/u
  );
  await assert.rejects(
    fixture.store.deleteGeneration({
      workspaceId: fixture.workspaceId,
      generation: recoveryGeneration
    })
  );
  await recoveryGenerations.abandonFull(recoveryGeneration);
  assert.equal(await recoveryGenerations.reservedGeneration(), undefined);
  assert.equal(await recoveryGenerations.activeGeneration(), recoveryParent);
  const recovered = await fixture.db.recoverIncompleteGraphWriteBatches({
    workspaceId: fixture.workspaceId,
    generation: recoveryGeneration,
    repoIds: [recoveryRepo.id],
    updatedAt: new Date().toISOString(),
    cleanupBatch: async (journal) => {
      await fixture.store.deleteGeneration({ workspaceId: journal.workspaceId, generation: journal.generation });
      await fixture.store.cleanupBatch({ workspaceId: journal.workspaceId, batchId: journal.batchId });
    }
  });
  await recoveryGenerations.rollback(recoveryGeneration);
  assert.ok(recovered.map((journal) => journal.batchId).includes(recoveryBatchId));
  assert.equal(await recoveryGenerations.activeGeneration(), recoveryParent);
  assert.equal((await search(fixture, "RecoveryService", 10)).length, 0);

  // Retry is idempotent, and another workspace cannot affect this corpus.
  await projectAndWrite({ fixture, repos: [two], files: [beta], batchId: `batch:retry:${fixture.suffix}` });
  assert.equal((await search(fixture, "BetaService", 10))[0]?.repoId, two.id);
  const foreignWorkspaceId = `${fixture.workspaceId}:foreign`;
  await projectAndWrite({ fixture, repos: [two], files: [beta], batchId: `batch:foreign:${fixture.suffix}`, workspaceId: foreignWorkspaceId });
  assert.equal((await search(fixture, "BetaService", 10)).every((hit) => hit.repoId === two.id), true);

  await fixture.reopen();
  assert.equal((await search(fixture, "BetaService", 10))[0]?.repoId, two.id);
  await fixture.assertSingleIndex();

  // A failed pending generation is deleted without mutating the active graph
  // or active lexical corpus.
  const rollbackRepo = repo(`repo:rollback:${fixture.suffix}`, "RollbackRepo");
  const rollbackFile = sourceFile(rollbackRepo.id, "src/Rollback.ts", "RollbackService", "rollbackmarker");
  const beforeRollback = await activeSnapshot(fixture);
  await assert.rejects(withPendingGeneration(
    fixture,
    fixture.workspaceId,
    `batch:rollback:${fixture.suffix}`,
    async (generation) => {
      const facts = await buildGraphFactsBatch({
        batchId: `batch:rollback:${fixture.suffix}`,
        workspaceId: fixture.workspaceId,
        generation,
        systemName: `workspace-lifecycle-${fixture.suffix}`,
        repos: [rollbackRepo],
        parsedFiles: [rollbackFile],
        semantic: false
      });
      const documents = projectLexicalDocuments(facts, fixture.workspaceId);
      const scope = { workspaceId: fixture.workspaceId, generation };
      await fixture.db.upsertRepo(rollbackRepo, scope);
      await writeGraphFactsBatch(fixture.db, {
        batchId: `batch:rollback:${fixture.suffix}`,
        ...scope,
        systemName: `workspace-lifecycle-${fixture.suffix}`,
        repos: [rollbackRepo],
        parsedFiles: [rollbackFile]
      }, {
        semantic: false,
        ...scope,
        systemName: `workspace-lifecycle-${fixture.suffix}`
      });
      await fixture.store.upsertDocuments({ ...scope, documents });
      throw new Error("injected graph and lexical rollback");
    }
  ), /injected graph and lexical rollback/);
  assert.deepEqual(await activeSnapshot(fixture), beforeRollback);
  const rollbackGeneration = await activeGeneration(fixture);
  assert.equal((await fixture.db.query(
    "MATCH (r:Repo) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.id = $repoId RETURN r.id AS id;",
    { workspaceId: fixture.workspaceId, generation: rollbackGeneration, repoId: rollbackRepo.id }
  )).length, 0);
  assert.equal((await search(fixture, "RollbackService", 10)).length, 0);
}
