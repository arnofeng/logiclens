import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createGraphDB: vi.fn(),
  auditRelationQuality: vi.fn(),
  querySchemaQuality: vi.fn(),
}));

vi.mock("../src/config/loadConfig.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../src/core/graph-model/factory.js", () => ({ createGraphDB: mocks.createGraphDB }));
vi.mock("../src/features/quality/quality.js", () => ({
  auditRelationQuality: mocks.auditRelationQuality,
  rejectEvidence: vi.fn(),
  upsertAliasOverride: vi.fn(),
}));
vi.mock("../src/features/quality/qualityRules.js", () => ({ auditContractQuality: vi.fn() }));
vi.mock("../src/core/schema/quality.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/schema/quality.js")>();
  return { ...actual, querySchemaQuality: mocks.querySchemaQuality };
});

import { formatSchemaQualityText, qualityCommand } from "../src/interfaces/cli/quality.js";

describe("quality command graph profile", () => {
  const db = {
    initSchema: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createGraphDB.mockResolvedValue(db);
    mocks.auditRelationQuality.mockResolvedValue({ lowConfidence: [], conflicts: [] });
    mocks.querySchemaQuality.mockResolvedValue(schemaReport());
  });

  it("forwards the complete Neo4j graph configuration including database", async () => {
    const cwd = path.resolve("quality-command-workspace");
    mocks.loadConfig.mockResolvedValue({
      systemName: "quality-system",
      graph: {
        provider: "neo4j",
        path: ".repohelix/graph",
        url: "neo4j+s://example.invalid",
        username: "test-user",
        password: "test-password",
        database: "repohelix-test",
      },
    });

    await qualityCommand(undefined, undefined, cwd);

    expect(mocks.createGraphDB).toHaveBeenCalledWith("neo4j", {
      path: path.resolve(cwd, ".repohelix/graph"),
      url: "neo4j+s://example.invalid",
      username: "test-user",
      password: "test-password",
      database: "repohelix-test",
    });
    expect(db.initSchema).toHaveBeenCalledWith("quality-system");
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("renders grouped schema quality and structured ambiguous/truncated evidence", () => {
    const output = formatSchemaQualityText(schemaReport());
    expect(output).toContain("Root outcomes: roots=2 resolved=0 unresolved=0 external=0 ambiguous=1 unsupported=0 truncated=1");
    expect(output).toContain("Diagnostic entries: total=3");
    expect(output).toContain("Grouped by language:");
    expect(output).toContain("candidate=java/repo:a/main/a.Result source=src/Result.java:3:symbol:result:java.class");
    expect(output).toContain("root=root:truncated");
    expect(output).toContain("field=items.child");
    expect(output).toContain("limit=depth:12");
    expect(output).toContain("schema contracts exist, but one or more schema chains are incomplete");
  });

  it("emits the query report unchanged as stable JSON", async () => {
    const cwd = path.resolve("quality-schema-command-workspace");
    mocks.loadConfig.mockResolvedValue({
      systemName: "quality-system",
      graph: { provider: "kuzu", path: ".repohelix/graph" }
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await qualityCommand("schemas", { groupBy: "language", details: "truncated,ambiguous", json: true }, cwd);
    expect(mocks.querySchemaQuality).toHaveBeenCalledWith(db, expect.any(String), {
      groupBy: "language",
      details: ["ambiguous", "truncated"]
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(schemaReport());
    log.mockRestore();
  });
});

function schemaReport() {
  return {
    workspaceId: "workspace:quality",
    generation: "generation:active",
    groupBy: "language" as const,
    summary: {
      rootOutcomes: { roots: 2, resolved: 0, unresolved: 0, external: 0, ambiguous: 1, unsupported: 0, truncated: 1 },
      diagnosticEntries: { total: 3, unresolved: 0, external: 0, ambiguous: 2, unsupported: 0, truncated: 1 }
    },
    groups: [{
      value: "java",
      summary: {
        rootOutcomes: { roots: 2, resolved: 0, unresolved: 0, external: 0, ambiguous: 1, unsupported: 0, truncated: 1 },
        diagnosticEntries: { total: 3, unresolved: 0, external: 0, ambiguous: 2, unsupported: 0, truncated: 1 }
      }
    }],
    details: [
      {
        outcome: "ambiguous" as const,
        diagnosticId: "diagnostic:ambiguous",
        diagnosticCode: "ambiguous" as const,
        repoId: "repo:a",
        languageId: "java",
        frameworkId: "spring-mvc",
        relationKind: "RESPONSE_SCHEMA" as const,
        rootReferenceId: "root:ambiguous",
        ownerSpecId: "spec:owner",
        sourceFileId: "file:owner",
        symbol: "Result",
        rawTypeExpression: "Result",
        typePath: [{ kind: "reference" as const, name: "Result" }],
        fieldPath: [],
        candidates: [{
          identity: { languageId: "java", repoId: "repo:a", resolutionScopeId: "main", canonicalName: "a.Result" },
          declarationId: "declaration:result",
          fileId: "file:result",
          filePath: "src/Result.java",
          sourceSymbolId: "symbol:result",
          line: 3,
          raw: "class Result {}",
          rule: "java.class"
        }]
      },
      {
        outcome: "truncated" as const,
        diagnosticId: "diagnostic:truncated",
        diagnosticCode: "truncated" as const,
        repoId: "repo:a",
        languageId: "java",
        frameworkId: "spring-mvc",
        relationKind: "RESPONSE_SCHEMA" as const,
        rootReferenceId: "root:truncated",
        ownerSpecId: "spec:owner",
        sourceFileId: "file:owner",
        symbol: "Child",
        rawTypeExpression: "Result",
        typePath: [{ kind: "reference" as const, name: "Result" }, { kind: "reference" as const, name: "Child" }],
        fieldPath: ["items", "child"],
        candidates: [],
        limit: { kind: "depth" as const, value: 12 }
      }
    ]
  };
}
