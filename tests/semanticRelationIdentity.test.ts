import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeGraphFactsWithNeo4jBatch } from "../src/adapters/graph-db/neo4j/Neo4jBatchWriter.js";
import type { GraphDB, GraphValue } from "../src/core/graph-model/db.js";
import { stageGraphFactsAsCsv } from "../src/core/graph-model/csvStaging.js";
import type { GraphFactsBatch } from "../src/core/graph-model/facts.js";
import type { ContractSpecNode, SemanticRelationEdge } from "../src/core/parsing/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function relations(): SemanticRelationEdge[] {
  return [
    {
      fromSpecId: "spec:source",
      toSpecId: "spec:target",
      kind: "USES_SCHEMA",
      evidenceId: "evidence:low",
      reason: "lower confidence path",
      confidence: 0.7
    },
    {
      fromSpecId: "spec:source",
      toSpecId: "spec:target",
      kind: "USES_SCHEMA",
      evidenceId: "evidence:high",
      reason: "higher confidence path",
      confidence: 0.9
    }
  ];
}

function facts(semanticRelations = relations()): GraphFactsBatch {
  const contractSpecs: ContractSpecNode[] = ["source", "target"].map((suffix) => ({
    id: `spec:${suffix}`,
    contractId: `contract:${suffix}`,
    specKind: "schema",
    repoId: "repo:test",
    fileId: `file:${suffix}`,
    evidenceId: `evidence:${suffix}`,
    canonicalKey: suffix,
    specJson: "{}",
    confidence: 1
  }));
  const schemaInternalFacts = {
    declarations: [],
    resolutionContexts: [],
    resolutionScopeDependencies: [],
    roots: [],
    dependencies: [],
    provenance: [],
    diagnostics: [],
    fingerprints: []
  };
  return {
    batchId: "batch:semantic-relation-identity",
    workspaceId: "workspace:test",
    generation: "generation:test",
    systemName: "semantic-relation-identity",
    indexedAt: "2026-08-02T00:00:00.000Z",
    repos: [],
    parsedFiles: [],
    files: [],
    code: [],
    sections: [],
    entities: [],
    operations: [],
    workflows: [],
    contracts: [],
    evidence: [],
    contains: [],
    imports: [],
    calls: [],
    mentions: [],
    sectionDescribesRepos: [],
    sectionDocumentsCode: [],
    sectionReferencesFile: [],
    repoContracts: [],
    packageUsages: [],
    contractEntities: [],
    operationRepos: [],
    workflowOperations: [],
    repoDependencies: [],
    contractSpecs,
    contractSpecEdges: [],
    semanticRelations,
    crossRepo: {
      contracts: [],
      evidence: [],
      entities: [],
      repoContracts: [],
      repoDependencies: [],
      contractEntities: [],
      operations: [],
      workflows: [],
      operationRepos: [],
      workflowOperations: [],
      packageUsages: [],
      contractSpecs,
      contractSpecEdges: [],
      semanticRelations,
      schemaInternalFacts,
      schemaDeclarations: []
    }
  };
}

describe("provider-neutral semantic relation identity", () => {
  it("stages one Kuzu CSV row for multiple evidence records", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-semantic-rel-csv-"));
    directories.push(directory);

    const staged = await stageGraphFactsAsCsv(facts(), directory);

    expect(staged.rowCounts.SEMANTIC_REL).toBe(1);
    const csv = await fs.readFile(staged.files.SEMANTIC_REL!, "utf8");
    expect(csv).toContain("evidence:high");
    expect(csv).not.toContain("evidence:low");
  });

  it("uses the same evidence-independent key in the Neo4j batch writer", async () => {
    const calls: Array<{ cypher: string; params?: Record<string, GraphValue> }> = [];
    const db = {
      async query<T = Record<string, GraphValue>>(cypher: string, params?: Record<string, GraphValue>): Promise<T[]> {
        calls.push({ cypher, params });
        return [];
      }
    } as unknown as GraphDB;

    await writeGraphFactsWithNeo4jBatch(db, facts());

    const semanticWrite = calls.find((call) => call.cypher.includes("[r:SEMANTIC_REL"));
    expect(semanticWrite?.cypher).toContain("MERGE (a)-[r:SEMANTIC_REL{kind: row.kind}]->(b)");
    expect(semanticWrite?.cypher).not.toContain("evidenceId: row.evidenceId");
    const batch = semanticWrite?.params?.batch as Array<Record<string, GraphValue>>;
    expect(batch).toHaveLength(1);
    expect(batch[0]).toEqual(expect.objectContaining({
      evidenceId: "evidence:high",
      reason: "higher confidence path",
      confidence: 0.9
    }));
  });
});
