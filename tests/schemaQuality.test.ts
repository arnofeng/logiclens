import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KuzuGraphDB } from "../src/core/graph-model/db.js";
import { buildSchemaQualityReport, emptySchemaQualityReport } from "../src/core/schema/quality.js";
import { runSchemaQualityConformance } from "./helpers/schemaQualityConformance.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("schema quality query service", () => {
  it("returns explicit zero structures when no active generation exists", () => {
    expect(emptySchemaQualityReport("workspace:empty", "repo")).toEqual({
      workspaceId: "workspace:empty",
      generation: null,
      groupBy: "repo",
      summary: {
        rootOutcomes: { roots: 0, resolved: 0, unresolved: 0, external: 0, ambiguous: 0, unsupported: 0, truncated: 0 },
        diagnosticEntries: { total: 0, unresolved: 0, external: 0, ambiguous: 0, unsupported: 0, truncated: 0 }
      },
      groups: [],
      details: []
    });
  });

  it("counts each root once while retaining every diagnostic entry and candidate source", () => {
    const generation = "generation:test";
    const root = {
      id: "root:a", repoId: "repo:a", ownerSpecId: "spec:owner", ownerFileId: "file:owner",
      relationKind: "RESPONSE_SCHEMA" as const, languageId: "java", frameworkId: "spring-mvc",
      rawTypeExpression: "Result", resolutionContextId: "context:a", slot: { kind: "return" as const },
      evidenceId: "evidence:a", generation
    };
    const identity = { languageId: "java", repoId: "repo:a", resolutionScopeId: "main", canonicalName: "a.Result" };
    const diagnostic = (id: string, field: string) => ({
      id, generation, repoId: "repo:a", rootReferenceId: root.id, ownerSpecId: root.ownerSpecId,
      scope: { languageId: "java", repoId: "repo:a", resolutionScopeId: "main" }, code: "ambiguous" as const,
      symbol: "Result", fieldPath: [field], candidates: [identity]
    });
    const report = buildSchemaQualityReport({
      workspaceId: "workspace:test",
      generation,
      groupBy: "framework",
      details: ["ambiguous"],
      facts: {
        roots: [root],
        diagnostics: [diagnostic("diagnostic:a", "left"), diagnostic("diagnostic:b", "right")],
        provenance: [],
        declarations: [{
          id: "declaration:a", identity, fileId: "file:result", declarationKind: "class", typeParameters: [], generation,
          candidate: {
            declaration: identity, displayName: "Result", typeParameters: [], shape: { kind: "object", fields: [] },
            fileId: "file:result", filePath: "src/Result.java", sourceSymbolId: "symbol:result", framework: "java-source",
            evidence: { line: 3, raw: "class Result {}", rule: "java.class", confidence: 1 }
          }
        }]
      }
    });
    expect(report.summary.rootOutcomes).toMatchObject({ roots: 1, ambiguous: 1 });
    expect(report.summary.diagnosticEntries).toMatchObject({ total: 2, ambiguous: 2 });
    expect(report.groups).toEqual([expect.objectContaining({ value: "spring-mvc" })]);
    expect(report.details).toHaveLength(2);
    expect(report.details[0]!.candidates).toEqual([expect.objectContaining({
      declarationId: "declaration:a", filePath: "src/Result.java", line: 3, raw: "class Result {}"
    })]);
  });

  it.each([
    ["language", "java"],
    ["framework", "spring-mvc"],
    ["relation-kind", "REQUEST_SCHEMA"],
    ["repo", "repo:grouped"]
  ] as const)("groups deterministic resolved outcomes by %s", (groupBy, value) => {
    const generation = "generation:grouped";
    const root = {
      id: "root:grouped", repoId: "repo:grouped", ownerSpecId: "spec:grouped", ownerFileId: "file:grouped",
      relationKind: "REQUEST_SCHEMA" as const, languageId: "java", frameworkId: "spring-mvc",
      rawTypeExpression: "Input", resolutionContextId: "context:grouped", slot: { kind: "parameter" as const, index: 0 },
      evidenceId: "evidence:grouped", generation
    };
    const report = buildSchemaQualityReport({
      workspaceId: "workspace:grouped",
      generation,
      groupBy,
      facts: {
        roots: [root],
        diagnostics: [],
        declarations: [],
        provenance: [{
          id: "provenance:grouped", relationId: "relation:grouped", rootReferenceId: root.id,
          rawTypeExpression: "Input", typePath: [], fieldPath: [], declarationIds: [], resolution: "resolved", generation
        }]
      }
    });
    expect(report.summary.rootOutcomes).toMatchObject({ roots: 1, resolved: 1 });
    expect(report.groups).toEqual([expect.objectContaining({
      value,
      summary: expect.objectContaining({ rootOutcomes: expect.objectContaining({ roots: 1, resolved: 1 }) })
    })]);
  });

  it("runs the active-generation provider-neutral harness on Kuzu", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-quality-"));
    directories.push(directory);
    const db = await KuzuGraphDB.open(path.join(directory, "graph"));
    try {
      await db.initSchema("schema-quality-test");
      await runSchemaQualityConformance(db, "workspace:schema-quality-kuzu");
    } finally {
      await db.close();
    }
  }, 20_000);
});
