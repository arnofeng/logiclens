import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KuzuGraphDB } from "../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import {
  applyIncrementalDependencyMutation,
  prepareIncrementalDependencyMutation,
  rebuildRepoDependencies
} from "../src/core/graph-model/rebuildRelations.js";
import type { ContractKind, ContractRole, RepoNode } from "../src/core/parsing/types.js";
import type { PublicGraphGenerationScope } from "../src/core/graph-model/publicGraphGeneration.js";

const scope: PublicGraphGenerationScope = {
  workspaceId: "workspace:incremental-dependencies",
  generation: "generation:active"
};

const opened: KuzuGraphDB[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
});

function repo(name: string): RepoNode {
  return {
    id: `repo:${name}`,
    name,
    path: `/workspace/${name}`,
    remoteUrl: "",
    branch: "main",
    commitSha: "commit",
    language: "typescript",
    indexedAt: "2026-01-01T00:00:00.000Z"
  };
}

async function openDb(): Promise<KuzuGraphDB> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-incremental-deps-"));
  const db = await KuzuGraphDB.open(path.join(directory, "graph"));
  opened.push(db);
  await db.initSchema("incremental-dependency-test");
  return db;
}

async function addParticipant(input: {
  db: KuzuGraphDB;
  repo: RepoNode;
  contractId: string;
  kind: ContractKind;
  key: string;
  role: ContractRole;
  evidenceId: string;
  fileId: string;
}): Promise<void> {
  await input.db.upsertRepo(input.repo, scope);
  await input.db.upsertContract({
    id: input.contractId,
    kind: input.kind,
    key: input.key,
    name: input.key,
    description: input.key
  }, scope);
  await input.db.upsertEvidence({
    id: input.evidenceId,
    repoId: input.repo.id,
    fileId: input.fileId,
    filePath: `${input.repo.name}/source.ts`,
    line: 1,
    raw: input.key,
    rule: input.role === "consumer" ? "http-client-api-consumer" : "api-path-producer",
    confidence: 0.9,
    batchId: "batch:initial",
    indexedAt: "2026-01-01T00:00:00.000Z",
    active: true
  }, scope);
  await input.db.addRepoContract({
    repoId: input.repo.id,
    contractId: input.contractId,
    role: input.role,
    evidenceId: input.evidenceId,
    confidence: 0.9,
    batchId: "batch:initial",
    active: true
  }, scope);
  await input.db.addContractEvidence(input.contractId, input.evidenceId, scope);
}

async function addHttpPair(input: {
  db: KuzuGraphDB;
  name: string;
  producer: RepoNode;
  consumer: RepoNode;
}): Promise<{ contractId: string; consumerFileId: string; consumerSpecId: string }> {
  const contractId = `contract:api:${input.name}`;
  const pathTemplate = `/api/${input.name}`;
  const producerFileId = `file:${input.name}:producer`;
  const consumerFileId = `file:${input.name}:consumer`;
  const producerEvidenceId = `evidence:${input.name}:producer`;
  const consumerEvidenceId = `evidence:${input.name}:consumer`;
  await addParticipant({
    db: input.db,
    repo: input.producer,
    contractId,
    kind: "api",
    key: pathTemplate,
    role: "producer",
    evidenceId: producerEvidenceId,
    fileId: producerFileId
  });
  await addParticipant({
    db: input.db,
    repo: input.consumer,
    contractId,
    kind: "api",
    key: pathTemplate,
    role: "consumer",
    evidenceId: consumerEvidenceId,
    fileId: consumerFileId
  });
  const producerSpecId = `spec:${input.name}:producer`;
  const consumerSpecId = `spec:${input.name}:consumer`;
  for (const spec of [
    { id: producerSpecId, repoId: input.producer.id, fileId: producerFileId, evidenceId: producerEvidenceId },
    { id: consumerSpecId, repoId: input.consumer.id, fileId: consumerFileId, evidenceId: consumerEvidenceId }
  ]) {
    await input.db.upsertContractSpec({
      ...spec,
      contractId,
      specKind: "http-endpoint",
      canonicalKey: `GET:${pathTemplate}`,
      httpMethod: "GET",
      pathTemplate,
      specJson: JSON.stringify({
        kind: "http-endpoint",
        method: "GET",
        path: pathTemplate,
        pathTemplate,
        pathParams: [],
        auth: "unknown"
      }),
      confidence: 0.9,
      batchId: "batch:initial",
      indexedAt: "2026-01-01T00:00:00.000Z",
      active: true
    }, scope);
  }
  return { contractId, consumerFileId, consumerSpecId };
}

describe("incremental dependency mutation", () => {
  it("prepares targeted reads outside publication and preserves unrelated dependencies", async () => {
    const db = await openDb();
    const affected = await addHttpPair({
      db,
      name: "orders",
      producer: repo("orders-api"),
      consumer: repo("orders-client")
    });
    await addHttpPair({
      db,
      name: "health",
      producer: repo("health-api"),
      consumer: repo("health-client")
    });
    await rebuildRepoDependencies(db, { scope, batchId: "batch:full" });

    const querySpy = vi.spyOn(db, "query");
    const semanticDeleteSpy = vi.spyOn(db, "clearSemanticRelationsForSpecs");
    const dependencyDeleteSpy = vi.spyOn(db, "clearRepoDependenciesForContracts");
    const repoWideDeleteSpy = vi.spyOn(db, "clearRepoDependencies");
    const mutation = await prepareIncrementalDependencyMutation(db, {
      scope,
      batchId: "batch:incremental",
      affectedFileIds: [affected.consumerFileId],
      graphFacts: [],
      schema: {
        upsertSpecs: [],
        deleteSpecIds: [],
        upsertRelations: [],
        deleteRelations: []
      }
    });

    expect(semanticDeleteSpy).not.toHaveBeenCalled();
    expect(dependencyDeleteSpy).not.toHaveBeenCalled();
    expect(repoWideDeleteSpy).not.toHaveBeenCalled();
    expect(mutation.affectedSpecIds).toContain(affected.consumerSpecId);
    expect(mutation.affectedContractIds).toContain(affected.contractId);
    expect(mutation.upsertRepoDependencies.every((edge) =>
      edge.sourceContractId !== affected.contractId && edge.targetContractId !== affected.contractId)).toBe(true);

    const specReads = querySpy.mock.calls
      .map(([statement]) => String(statement))
      .filter((statement) => statement.includes("MATCH (s:ContractSpec)"));
    expect(specReads.length).toBeGreaterThan(0);
    expect(specReads.every((statement) =>
      statement.includes("$fileIds")
      || statement.includes("$specIds")
      || statement.includes("pathTemplate")
      || statement.includes("eventTopic")
      || statement.includes("canonicalKey")
      || statement.includes("sourceSymbolId"))).toBe(true);
    expect(specReads.some((statement) => statement.includes("s.specKind = 'schema'"))).toBe(false);

    querySpy.mockClear();
    await applyIncrementalDependencyMutation(db, { scope, mutation });
    expect(semanticDeleteSpy).toHaveBeenCalledWith(mutation.affectedSpecIds, scope);
    expect(dependencyDeleteSpy).toHaveBeenCalledWith(mutation.affectedContractIds, scope);
    expect(repoWideDeleteSpy).not.toHaveBeenCalled();

    const dependencies = await db.query<{
      sourceContractId: string;
      targetContractId: string;
    }>(
      `MATCH (:Repo)-[r:DEPENDS_ON]->(:Repo)
       WHERE r.workspaceId = $workspaceId AND r.generation = $generation
       RETURN r.sourceContractId AS sourceContractId, r.targetContractId AS targetContractId`,
      scope
    );
    expect(dependencies.some((edge) =>
      edge.sourceContractId === affected.contractId || edge.targetContractId === affected.contractId)).toBe(false);
    expect(dependencies.some((edge) =>
      edge.sourceContractId === "contract:api:health" || edge.targetContractId === "contract:api:health")).toBe(true);
  }, 30000);
});
