import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/graph/db.js";
import {
  loadContractParticipantsForContracts,
  loadContractParticipantsForRepos,
  rebuildRepoDependencies
} from "../src/graph/rebuildRelations.js";
import { upsertParsedFiles } from "../src/graph/upsert.js";
import { parseSourceFile } from "../src/parsers/parserRegistry.js";
import type { ContractKind, ContractRole, RepoDependencyEdge, RepoNode } from "../src/parsers/types.js";
import { repoId } from "../src/utils/path.js";

function repo(name: string): RepoNode {
  return { id: repoId(name), name, path: path.resolve("tests/fixtures", name), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
}

async function addParticipant(db: KuzuGraphDB, input: { repo: RepoNode; contractId: string; kind: ContractKind; key: string; role: ContractRole; evidenceId: string; rule?: string }): Promise<void> {
  await db.upsertRepo(input.repo);
  await db.upsertContract({
    id: input.contractId,
    kind: input.kind,
    key: input.key,
    name: input.key,
    description: `${input.kind} ${input.key}`
  });
  await db.upsertEvidence({
    id: input.evidenceId,
    repoId: input.repo.id,
    fileId: `file:${input.evidenceId}`,
    filePath: `${input.repo.name}/file.ts`,
    line: 1,
    raw: input.key,
    rule: input.rule ?? `${input.role}-evidence`,
    confidence: 0.9,
    batchId: "batch:test",
    indexedAt: new Date().toISOString(),
    active: true
  });
  await db.addRepoContract({
    repoId: input.repo.id,
    contractId: input.contractId,
    role: input.role,
    evidenceId: input.evidenceId,
    confidence: 0.9,
    batchId: "batch:test",
    active: true
  });
  await db.addContractEvidence(input.contractId, input.evidenceId);
  await db.addRepoEvidence(input.repo.id, input.evidenceId);
}

async function dependencyRows(db: KuzuGraphDB): Promise<{ fromRepo: string; toRepo: string; dependencyType: string; evidenceId: string }[]> {
  return db.query<{ fromRepo: string; toRepo: string; dependencyType: string; evidenceId: string }>(
    `MATCH (from:Repo)-[d:DEPENDS_ON]->(to:Repo)
     RETURN from.name AS fromRepo, to.name AS toRepo, d.dependencyType AS dependencyType, d.evidenceId AS evidenceId
     ORDER BY fromRepo, toRepo, dependencyType, evidenceId;`
  );
}

describe("relation rebuild", () => {
  it("fills cross-repo dependencies after repos are indexed in separate batches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-rebuild-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("rebuild-test");
      const repoA = { id: repoId("service-a"), name: "service-a", path: path.resolve("tests/fixtures/service-a"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      const repoB = { id: repoId("service-b"), name: "service-b", path: path.resolve("tests/fixtures/service-b"), remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: new Date().toISOString() };
      await db.upsertRepo(repoA);
      await db.upsertRepo(repoB);

      const parsedA = await Promise.all([
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderController.ts"), relativePath: "src/OrderController.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoA.id, absolutePath: path.resolve("tests/fixtures/service-a/src/OrderService.ts"), relativePath: "src/OrderService.ts", language: "typescript" })
      ]);
      await upsertParsedFiles(db, parsedA, { semantic: true }, [repoA]);

      const parsedB = await Promise.all([
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/PaymentService.ts"), relativePath: "src/PaymentService.ts", language: "typescript" }),
        parseSourceFile({ repoId: repoB.id, absolutePath: path.resolve("tests/fixtures/service-b/src/events/OrderCreatedEvent.ts"), relativePath: "src/events/OrderCreatedEvent.ts", language: "typescript" })
      ]);
      await upsertParsedFiles(db, parsedB, { semantic: true }, [repoB]);

      const before = await db.query<{ count: number }>("MATCH (:Repo)-[d:DEPENDS_ON]->(:Repo) RETURN count(d) AS count;");
      expect(Number(before[0]?.count ?? 0)).toBe(0);

      const rebuilt = await rebuildRepoDependencies(db, { repoIds: [repoB.id] });
      expect(rebuilt.length).toBeGreaterThan(0);

      const dependencies = await db.query<{ fromRepo: string; toRepo: string; dependencyType: string; evidenceRule: string }>(
        `MATCH (from:Repo)-[d:DEPENDS_ON]->(to:Repo), (e:Evidence)
         WHERE d.evidenceId = e.id
         RETURN from.name AS fromRepo, to.name AS toRepo, d.dependencyType AS dependencyType, e.rule AS evidenceRule;`
      );
      expect(dependencies).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromRepo: "service-b", toRepo: "service-a", dependencyType: "import", evidenceRule: "import-specifier-package-owner" }),
        expect.objectContaining({ fromRepo: "service-b", toRepo: "service-a", dependencyType: "api", evidenceRule: "http-client-api-consumer" }),
        expect.objectContaining({ fromRepo: "service-b", toRepo: "service-a", dependencyType: "event", evidenceRule: "event-consumer" })
      ]));
    } finally {
      await db.close();
    }
  }, 20000);

  it("rebuilds only dependencies touching the targeted repo and keeps unrelated edges", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-targeted-rebuild-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("targeted-rebuild-test");
      const producer = repo("producer");
      const consumer = repo("consumer");
      const unrelatedA = repo("unrelated-a");
      const unrelatedB = repo("unrelated-b");
      await addParticipant(db, { repo: producer, contractId: "contract:api:orders", kind: "api", key: "/api/orders", role: "producer", evidenceId: "evidence:producer-api" });
      await addParticipant(db, { repo: consumer, contractId: "contract:api:orders", kind: "api", key: "/api/orders", role: "consumer", evidenceId: "evidence:consumer-api" });
      await addParticipant(db, { repo: unrelatedA, contractId: "contract:api:unrelated", kind: "api", key: "/api/unrelated", role: "consumer", evidenceId: "evidence:unrelated-consumer" });
      await addParticipant(db, { repo: unrelatedB, contractId: "contract:api:unrelated", kind: "api", key: "/api/unrelated", role: "producer", evidenceId: "evidence:unrelated-producer" });

      const unrelatedDependency: RepoDependencyEdge = {
        fromRepoId: unrelatedA.id,
        toRepoId: unrelatedB.id,
        dependencyType: "api",
        sourceContractId: "contract:api:unrelated",
        targetContractId: "contract:api:unrelated",
        evidenceId: "evidence:unrelated-consumer",
        raw: "/api/unrelated",
        confidence: 0.9,
        batchId: "batch:unrelated",
        active: true
      };
      await db.addRepoDependency(unrelatedDependency);

      const logs: string[] = [];
      const rebuilt = await rebuildRepoDependencies(db, { repoIds: [consumer.id], batchId: "batch:targeted", logger: { log: (message) => logs.push(message) } });
      expect(rebuilt).toHaveLength(1);
      expect(logs[0]).toContain("Targeted dependency rebuild: repos=1 contracts=1 participants=2 dependencies=1");

      expect(await dependencyRows(db)).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromRepo: "consumer", toRepo: "producer", dependencyType: "api", evidenceId: "evidence:consumer-api" }),
        expect.objectContaining({ fromRepo: "unrelated-a", toRepo: "unrelated-b", dependencyType: "api", evidenceId: "evidence:unrelated-consumer" })
      ]));
    } finally {
      await db.close();
    }
  }, 20000);

  it("clears targeted dependencies when the target repo has no active contract participants", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-empty-target-rebuild-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("empty-target-rebuild-test");
      const empty = repo("empty");
      const producer = repo("producer");
      await db.upsertRepo(empty);
      await db.upsertRepo(producer);
      await db.addRepoDependency({
        fromRepoId: empty.id,
        toRepoId: producer.id,
        dependencyType: "api",
        sourceContractId: "contract:api:stale",
        targetContractId: "contract:api:stale",
        evidenceId: "evidence:stale",
        raw: "/api/stale",
        confidence: 0.1,
        batchId: "batch:stale",
        active: true
      });

      const logs: string[] = [];
      const rebuilt = await rebuildRepoDependencies(db, { repoIds: [empty.id], logger: { log: (message) => logs.push(message) } });
      expect(rebuilt).toHaveLength(0);
      expect(logs[0]).toContain("Targeted dependency rebuild: repos=1 contracts=0 participants=0 dependencies=0");
      expect(await dependencyRows(db)).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 20000);

  it("loads only target contracts for targeted rebuild helpers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logiclens-targeted-helper-"));
    const db = await KuzuGraphDB.open(path.join(dir, "graph"));
    try {
      await db.initSchema("targeted-helper-test");
      const target = repo("target");
      const targetPeer = repo("target-peer");
      const unrelatedA = repo("unrelated-a");
      const unrelatedB = repo("unrelated-b");
      await addParticipant(db, { repo: target, contractId: "contract:package:target", kind: "package", key: "target-package", role: "consumer", evidenceId: "evidence:target-consumer" });
      await addParticipant(db, { repo: targetPeer, contractId: "contract:package:target", kind: "package", key: "target-package", role: "owner", evidenceId: "evidence:target-owner" });
      await addParticipant(db, { repo: unrelatedA, contractId: "contract:package:unrelated", kind: "package", key: "unrelated-package", role: "consumer", evidenceId: "evidence:unrelated-consumer" });
      await addParticipant(db, { repo: unrelatedB, contractId: "contract:package:unrelated", kind: "package", key: "unrelated-package", role: "owner", evidenceId: "evidence:unrelated-owner" });

      const targetParticipants = await loadContractParticipantsForRepos(db, [target.id]);
      expect(targetParticipants.map((participant) => participant.contractId)).toEqual(["contract:package:target"]);

      const scopedParticipants = await loadContractParticipantsForContracts(db, [...new Set(targetParticipants.map((participant) => participant.contractId))]);
      expect(scopedParticipants.map((participant) => participant.repoId).sort()).toEqual([target.id, targetPeer.id].sort());

      const rebuilt = await rebuildRepoDependencies(db, { repoIds: [target.id] });
      expect(rebuilt).toEqual([
        expect.objectContaining({ fromRepoId: target.id, toRepoId: targetPeer.id, dependencyType: "package" })
      ]);
    } finally {
      await db.close();
    }
  }, 20000);
});
