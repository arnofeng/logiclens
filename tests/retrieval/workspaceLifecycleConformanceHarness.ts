import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import type { GraphDB } from "../../src/core/graph-model/db.js";
import { withTransaction } from "../../src/core/graph-model/db.js";
import { writeGraphFactsBatch } from "../../src/core/graph-model/batchWriter.js";
import { buildGraphFactsBatch } from "../../src/core/graph-model/facts.js";
import type { ParsedFile, RepoNode } from "../../src/core/parsing/types.js";
import type { WorkspaceLexicalStore } from "../../src/core/retrieval/provider.js";
import { projectLexicalDocuments } from "../../src/core/retrieval/projection.js";
import { runSchemaSnapshotConformance } from "../helpers/schemaBaselineSnapshot.js";

export interface WorkspaceLifecycleFixture {
  readonly db: GraphDB;
  readonly store: WorkspaceLexicalStore;
  workspaceId: string;
  suffix: string;
  reopen(): Promise<void>;
  assertSingleIndex(): Promise<void>;
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
}): Promise<ReturnType<typeof projectLexicalDocuments>> {
  const workspaceId = input.workspaceId ?? input.fixture.workspaceId;
  const facts = await buildGraphFactsBatch({
    batchId: input.batchId,
    indexedAt: "2026-01-01T00:00:00.000Z",
    repos: input.repos,
    parsedFiles: input.files,
    semantic: false
  });
  const documents = projectLexicalDocuments(facts, workspaceId);
  await withTransaction(input.fixture.db, async () => {
    for (const item of input.repos) await input.fixture.db.upsertRepo(item);
    await writeGraphFactsBatch(input.fixture.db, {
      batchId: input.batchId,
      repos: input.repos,
      parsedFiles: input.files
    }, { semantic: false });
    await input.fixture.store.upsertDocuments(documents);
    for (const item of input.repos) {
      await input.fixture.store.reconcileRepoDocuments({
        workspaceId,
        repoId: item.id,
        batchId: input.batchId,
        activeDocumentIds: documents.filter((document) => document.repoId === item.id).map((document) => document.id)
      });
    }
  });
  return documents;
}

async function activeSnapshot(fixture: WorkspaceLifecycleFixture): Promise<string[]> {
  const rows = await fixture.db.query<{ id: string; canonicalId: string; sourceHash: string }>(
    "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.active = true RETURN n.id AS id, n.canonicalId AS canonicalId, n.sourceHash AS sourceHash;",
    { workspaceId: fixture.workspaceId }
  );
  return rows.map((row) => `${row.id}|${row.canonicalId}|${row.sourceHash}`).sort();
}

async function ranking(fixture: WorkspaceLifecycleFixture): Promise<string[]> {
  return (await fixture.store.search({ workspaceId: fixture.workspaceId, text: "lifecycle" }, { topK: 50 }))
    .map((hit) => hit.documentId);
}

/** Runs the exact same graph-facts-to-lexical lifecycle against every provider. */
export async function runWorkspaceLifecycleConformance(fixture: WorkspaceLifecycleFixture): Promise<void> {
  const one = repo(`repo:one:${fixture.suffix}`, "LifecycleOne");
  const two = repo(`repo:two:${fixture.suffix}`, "LifecycleTwo");
  const alpha = sourceFile(one.id, "src/Alpha.ts", "AlphaService", "alphamarker");
  const beta = sourceFile(two.id, "src/Beta.ts", "BetaService", "betamarker");

  await fixture.store.ensureSchema();
  await projectAndWrite({ fixture, repos: [one, two], files: [alpha, beta], batchId: `batch:initial:${fixture.suffix}` });
  assert.ok((await fixture.store.health(fixture.workspaceId)).metrics.documentCount > 2);
  assert.deepEqual(
    new Set((await fixture.store.search({ workspaceId: fixture.workspaceId, text: "lifecycle" }, { topK: 50 })).map((hit) => hit.repoId)),
    new Set([one.id, two.id])
  );

  const updatedAlpha = sourceFile(one.id, alpha.path, "AlphaService", "alphaupdatedmarker");
  const oldAlphaCode = (await projectAndWrite({ fixture, repos: [one], files: [alpha], batchId: `batch:identity:${fixture.suffix}` }))
    .find((document) => document.kind === "code")!;
  const updatedDocuments = await projectAndWrite({ fixture, repos: [one], files: [updatedAlpha], batchId: `batch:update:${fixture.suffix}` });
  const updatedAlphaCode = updatedDocuments.find((document) => document.kind === "code")!;
  assert.equal(updatedAlphaCode.id, oldAlphaCode.id);
  assert.notEqual(updatedAlphaCode.sourceHash, oldAlphaCode.sourceHash);

  const renamedRepo = { ...one, name: "LifecycleOneRenamed" };
  await projectAndWrite({ fixture, repos: [renamedRepo], files: [updatedAlpha], batchId: `batch:repo-rename:${fixture.suffix}` });
  assert.equal((await fixture.db.query(
    "MATCH (r:Repo {id: $repoId}) WHERE r.name = $name RETURN r.id AS id;",
    { repoId: one.id, name: renamedRepo.name }
  )).length, 1);

  // Rebuild only from graph facts/projection inputs, never by reloading the
  // old lexical documents. Identity, source hashes, and global order survive.
  const beforeRebuild = await activeSnapshot(fixture);
  const orderBeforeRebuild = await ranking(fixture);
  for (const item of [renamedRepo, two]) {
    await fixture.store.reconcileRepoDocuments({ workspaceId: fixture.workspaceId, repoId: item.id, batchId: `batch:clear:${fixture.suffix}`, activeDocumentIds: [] });
    await fixture.db.clearRepoIndexedArtifacts(item.id);
  }
  await projectAndWrite({ fixture, repos: [renamedRepo, two], files: [updatedAlpha, beta], batchId: `batch:rebuild:${fixture.suffix}` });
  assert.deepEqual(await activeSnapshot(fixture), beforeRebuild);
  assert.deepEqual(await ranking(fixture), orderBeforeRebuild);
  await runSchemaSnapshotConformance(fixture.db, fixture.workspaceId);

  const renamedAlpha = sourceFile(one.id, "src/RenamedAlpha.ts", "AlphaService", "alphaupdatedmarker");
  await projectAndWrite({ fixture, repos: [renamedRepo], files: [renamedAlpha], batchId: `batch:file-rename:${fixture.suffix}` });
  await fixture.store.reconcileRepoFileDocuments({ workspaceId: fixture.workspaceId, repoId: one.id, batchId: `batch:file-rename:${fixture.suffix}`, activeFileIds: [renamedAlpha.fileId] });
  const newPath = await fixture.db.query(
    "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.repoId = $repoId AND n.path = $path AND n.active = true RETURN n.id AS id;",
    { workspaceId: fixture.workspaceId, repoId: one.id, path: renamedAlpha.path }
  );
  assert.ok(newPath.length > 0);
  const oldPath = await fixture.db.query(
    "MATCH (n:LexicalDocument) WHERE n.workspaceId = $workspaceId AND n.repoId = $repoId AND n.path = $path AND n.active = true RETURN n.id AS id;",
    { workspaceId: fixture.workspaceId, repoId: one.id, path: alpha.path }
  );
  assert.equal(oldPath.length, 0);

  await projectAndWrite({ fixture, repos: [renamedRepo], files: [], batchId: `batch:file-delete:${fixture.suffix}` });
  await fixture.store.reconcileRepoFileDocuments({ workspaceId: fixture.workspaceId, repoId: one.id, batchId: `batch:file-delete:${fixture.suffix}`, activeFileIds: [] });
  assert.equal((await fixture.store.search({ workspaceId: fixture.workspaceId, text: "AlphaService" }, { topK: 50 })).length, 0);
  assert.equal((await fixture.store.search({ workspaceId: fixture.workspaceId, text: "BetaService" }, { topK: 50 }))[0]?.repoId, two.id);
  const afterEmptyReconciliation = await runSchemaSnapshotConformance(fixture.db, fixture.workspaceId);
  assert.equal(afterEmptyReconciliation.lexical
    .filter((document) => document.repoId === one.id)
    .every((document) => document.kind === "repo"), true);

  await fixture.store.reconcileRepoDocuments({ workspaceId: fixture.workspaceId, repoId: one.id, batchId: `batch:repo-delete:${fixture.suffix}`, activeDocumentIds: [] });
  await fixture.db.clearRepoIndexedArtifacts(one.id);
  await fixture.db.query("MATCH (s:System)-[c:CONTAINS]->(r:Repo {id: $repoId}) DELETE c;", { repoId: one.id });
  await fixture.db.query("MATCH (r:Repo {id: $repoId}) DELETE r;", { repoId: one.id });
  assert.equal((await fixture.db.query("MATCH (r:Repo {id: $repoId}) RETURN r.id AS id;", { repoId: one.id })).length, 0);
  assert.equal((await fixture.store.search({ workspaceId: fixture.workspaceId, text: "LifecycleOneRenamed" }, { topK: 50 }))
    .some((hit) => hit.repoId === one.id), false);

  const recoveryRepo = repo(`repo:recovery:${fixture.suffix}`, "RecoveryRepo");
  const recoveryFile = sourceFile(recoveryRepo.id, "src/Recovery.ts", "RecoveryService", "recoverymarker");
  const recoveryFacts = await buildGraphFactsBatch({ batchId: `batch:recover:${fixture.suffix}`, repos: [recoveryRepo], parsedFiles: [recoveryFile], semantic: false });
  const recoveryDocuments = projectLexicalDocuments(recoveryFacts, fixture.workspaceId);
  await fixture.db.beginGraphWriteBatch({
    batchId: `batch:recover:${fixture.suffix}`, repoIds: [recoveryRepo.id], repoNames: [recoveryRepo.name], writerMode: "merge",
    atomicityMode: "transactional", workspaceId: fixture.workspaceId, startedAt: new Date().toISOString(), completedStage: "lexical-written"
  });
  await fixture.store.upsertDocuments(recoveryDocuments);
  const recovered = await fixture.db.recoverIncompleteGraphWriteBatches({
    repoIds: [recoveryRepo.id], updatedAt: new Date().toISOString(),
    cleanupBatch: (journal) => fixture.store.cleanupBatch({ workspaceId: journal.workspaceId ?? fixture.workspaceId, batchId: journal.batchId })
  });
  assert.ok(recovered.map((journal) => journal.batchId).includes(`batch:recover:${fixture.suffix}`));
  assert.equal((await fixture.store.search({ workspaceId: fixture.workspaceId, text: "RecoveryService" }, { topK: 10 })).length, 0);

  // Retry is idempotent, and another workspace cannot affect this corpus.
  const retryDocuments = await projectAndWrite({ fixture, repos: [two], files: [beta], batchId: `batch:retry:${fixture.suffix}` });
  await fixture.store.upsertDocuments(retryDocuments);
  assert.equal((await fixture.store.search({ workspaceId: fixture.workspaceId, text: "BetaService" }, { topK: 10 }))[0]?.repoId, two.id);
  const foreignWorkspaceId = `${fixture.workspaceId}:foreign`;
  await projectAndWrite({ fixture, repos: [two], files: [beta], batchId: `batch:foreign:${fixture.suffix}`, workspaceId: foreignWorkspaceId });
  assert.equal((await fixture.store.search({ workspaceId: fixture.workspaceId, text: "BetaService" }, { topK: 10 })).every((hit) => hit.repoId === two.id), true);

  await fixture.reopen();
  assert.equal((await fixture.store.search({ workspaceId: fixture.workspaceId, text: "BetaService" }, { topK: 10 }))[0]?.repoId, two.id);
  await fixture.assertSingleIndex();

  // Keep rollback last: Kuzu intentionally retains its rolled-back native
  // write set until database shutdown, while reads still observe atomicity.
  const rollbackRepo = repo(`repo:rollback:${fixture.suffix}`, "RollbackRepo");
  const rollbackFile = sourceFile(rollbackRepo.id, "src/Rollback.ts", "RollbackService", "rollbackmarker");
  await assert.rejects(withTransaction(fixture.db, async () => {
    await projectAndWrite({ fixture, repos: [rollbackRepo], files: [rollbackFile], batchId: `batch:rollback:${fixture.suffix}` });
    throw new Error("injected graph and lexical rollback");
  }), /injected graph and lexical rollback/);
  assert.equal((await fixture.db.query("MATCH (r:Repo {id: $repoId}) RETURN r.id AS id;", { repoId: rollbackRepo.id })).length, 0);
  assert.equal((await fixture.store.search({ workspaceId: fixture.workspaceId, text: "RollbackService" }, { topK: 10 })).length, 0);
}
