import { describe, expect, it, vi } from "vitest";
import type { GraphDB, GraphValue } from "../src/core/graph-model/db.js";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import {
  applyIncrementalSchemaSupportGc,
  prepareIncrementalSchemaSupportGc
} from "../src/core/schema/publicGraphGc.js";

const scope = { workspaceId: "workspace:support-gc", generation: "generation:support-gc" };

function emptyFacts(): GraphFactsBatch {
  return {
    batchId: "batch:support-gc",
    workspaceId: scope.workspaceId,
    generation: scope.generation,
    systemName: "support-gc",
    indexedAt: "2026-01-01T00:00:00.000Z",
    repos: [], parsedFiles: [], files: [], code: [], sections: [], entities: [],
    operations: [], workflows: [], contracts: [], evidence: [], contains: [],
    imports: [], calls: [], mentions: [], sectionDescribesRepos: [],
    sectionDocumentsCode: [], sectionReferencesFile: [], repoContracts: [],
    packageUsages: [], contractEntities: [], operationRepos: [],
    workflowOperations: [], repoDependencies: [], contractSpecs: [],
    contractSpecEdges: [], semanticRelations: [],
    crossRepo: {
      contracts: [], evidence: [], entities: [], repoContracts: [], repoDependencies: [],
      contractEntities: [], operations: [], workflows: [], operationRepos: [],
      workflowOperations: [], packageUsages: [], contractSpecs: [], contractSpecEdges: [],
      semanticRelations: [], schemaDeclarations: [],
      schemaInternalFacts: {
        declarations: [], resolutionContexts: [], resolutionScopeDependencies: [],
        roots: [], dependencies: [], provenance: [], diagnostics: [], fingerprints: []
      }
    }
  };
}

function discoveryDb() {
  const query = vi.fn(async (statement: string): Promise<Array<Record<string, GraphValue>>> => {
    if (statement.includes("RETURN n.id AS id, n.contractId AS contractId")) {
      return [{ id: "spec:removed", contractId: "contract:schema:shared", evidenceId: "evidence:schema:shared" }];
    }
    if (statement.includes("n.evidenceId IN $candidateEvidenceIds")) return [];
    if (statement.includes("$candidateEvidenceIds")) return [];
    if (statement.includes("$deletedEvidenceIds")) return [];
    if (statement.includes("[r:HAS_SPEC]")) return [];
    if (statement.includes("source.id IN $contractIds")) return [{ id: "entity:shared" }];
    if (statement.includes("$candidateEntityIds")) return [];
    throw new Error(`Unexpected support GC query: ${statement}`);
  });
  return { db: { query } as unknown as GraphDB, query };
}

const schemaDelta = {
  upsertSpecs: [],
  deleteSpecIds: ["spec:removed"],
  upsertRelations: [],
  deleteRelations: []
};

describe("incremental schema public support GC", () => {
  it("keeps contract and evidence shared by a surviving schema spec", async () => {
    const query = vi.fn(async (statement: string): Promise<Array<Record<string, GraphValue>>> => {
      if (statement.includes("RETURN n.id AS id, n.contractId AS contractId")) {
        return [{ id: "spec:removed", contractId: "contract:schema:shared", evidenceId: "evidence:schema:shared" }];
      }
      if (statement.includes("n.evidenceId IN $candidateEvidenceIds")) {
        return [{ id: "evidence:schema:shared" }];
      }
      if (statement.includes("[r:HAS_SPEC]")) return [{ id: "contract:schema:shared" }];
      if (statement.includes("$candidateEvidenceIds")) return [];
      throw new Error(`Unexpected shared support GC query: ${statement}`);
    });
    const db = { query } as unknown as GraphDB;

    const plan = await prepareIncrementalSchemaSupportGc({ db, scope, schemaDelta, graphFacts: [] });

    expect(plan).toEqual({
      deletedSpecIds: ["spec:removed"],
      evidenceIds: [],
      contractIds: [],
      entityIds: []
    });
  });

  it("retains a candidate entity referenced by pending graph facts", async () => {
    const { db } = discoveryDb();
    const facts = emptyFacts();
    facts.entities.push({ id: "entity:shared", name: "Shared", kind: "domain", description: "pending" });
    facts.mentions.push({ fromId: "code:changed", entityId: "entity:shared", sourceKind: "code", confidence: 1 });

    const plan = await prepareIncrementalSchemaSupportGc({ db, scope, schemaDelta, graphFacts: [facts] });

    expect(plan).toEqual({
      deletedSpecIds: ["spec:removed"],
      evidenceIds: ["evidence:schema:shared"],
      contractIds: ["contract:schema:shared"],
      entityIds: []
    });
  });

  it("retains candidate evidence and contract identities upserted by the pending overlay", async () => {
    const { db } = discoveryDb();
    const facts = emptyFacts();
    facts.evidence.push({
      id: "evidence:schema:shared",
      repoId: "repo:shared",
      fileId: "file:shared",
      filePath: "shared.ts",
      line: 1,
      raw: "Shared",
      rule: "test",
      confidence: 1
    });
    facts.contracts.push({
      id: "contract:schema:shared",
      kind: "schema",
      key: "shared",
      name: "Shared",
      description: "pending"
    });

    const plan = await prepareIncrementalSchemaSupportGc({ db, scope, schemaDelta, graphFacts: [facts] });

    expect(plan.evidenceIds).toEqual([]);
    expect(plan.contractIds).toEqual([]);
    expect(plan.entityIds).toEqual([]);
  });

  it("applies only precomputed stable-ID deletes", async () => {
    const calls: string[] = [];
    const db = {
      query: async (statement: string) => {
        calls.push(statement);
        return [];
      }
    } as unknown as GraphDB;

    await applyIncrementalSchemaSupportGc({
      db,
      scope,
      plan: {
        deletedSpecIds: ["spec:removed"],
        evidenceIds: ["evidence:schema:shared"],
        contractIds: ["contract:schema:shared"],
        entityIds: ["entity:shared"]
      }
    });

    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((statement) => !/\bRETURN\b/u.test(statement))).toBe(true);
    expect(calls.some((statement) => statement.includes("DETACH DELETE"))).toBe(true);
  });
});
