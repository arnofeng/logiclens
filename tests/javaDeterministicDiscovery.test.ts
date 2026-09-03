import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/loadConfig.js";
import { javaSchemaCandidatesForFile } from "../src/core/contracts/extraction/builtin/javaSchemaExtractor.js";
import { buildGraphFactsBatch } from "../src/core/graph-model/facts.js";
import { registerBuiltinParsers } from "../src/core/parsing/parserRegistry.js";
import { scanAndParseRepo } from "../src/core/indexing/scanParse.js";
import type { ParsedFile, RepoNode } from "../src/core/parsing/types.js";
import type { SchemaSpec } from "../src/core/contracts/spec.js";
import { canonicalSerialize } from "../src/core/schema/model.js";
import { deriveWorkspaceId } from "../src/core/workspace/identity.js";
import { repoId } from "../src/shared/path.js";

const fixtureRoot = path.resolve("tests/fixtures/java-schema-js001");

describe("JS-006..JS-008 Java deterministic schema discovery", () => {
  it("indexes every Java declaration deterministically without suffix discovery", async () => {
    const { parsedFiles } = await scanFixture();
    const javaFiles = parsedFiles.filter((file): file is ParsedFile => "symbols" in file && file.language === "java");
    const forward = javaFiles.flatMap(javaSchemaCandidatesForFile);
    const reverse = [...javaFiles].reverse().flatMap(javaSchemaCandidatesForFile);
    const normalize = (values: typeof forward) => values
      .map((candidate) => canonicalSerialize(candidate))
      .sort((left, right) => left.localeCompare(right));
    expect(normalize(forward)).toEqual(normalize(reverse));
    expect(forward.map((candidate) => candidate.displayName)).toEqual(expect.arrayContaining([
      "ActivityGoodsQueryVO", "GoodsFilter", "GoodsPriceVO", "MemberTypesDTO", "CurrencyCode", "ActivityView"
    ]));
    const memberTypes = forward.filter((candidate) => candidate.displayName === "MemberTypesDTO" || candidate.enclosingDeclarationId);
    expect(memberTypes.length).toBeGreaterThan(1);
  });

  it("materializes only Spring-reachable business types and retains root/nested relations", async () => {
    const { repo, config, parsedFiles } = await scanFixture();
    const facts = await buildGraphFactsBatch({
      workspaceId: deriveWorkspaceId(config.systemName),
      generation: "generation:test-java-deterministic",
      systemName: config.systemName,
      batchId: "batch:test-java-deterministic",
      indexedAt: "2026-08-03T00:00:00.000Z",
      repos: [repo],
      parsedFiles,
      semantic: true,
      config
    });
    const schemas = facts.contractSpecs.flatMap((node) => {
      if (node.specKind !== "schema") return [];
      return [{ node, spec: JSON.parse(node.specJson) as SchemaSpec }];
    });
    const byName = new Map(schemas.map((item) => [item.spec.displayName, item]));
    expect([...byName.keys()]).toEqual(expect.arrayContaining(["GoodsFilter", "ActivityGoodsQueryVO", "GoodsPriceVO", "ActivityPageDTO"]));
    expect([...byName.keys()]).not.toEqual(expect.arrayContaining(["ActivityService", "ActivityRepository", "ActivityUtil"]));
    const endpointIds = new Set(facts.contractSpecs.filter((node) => node.specKind === "http-endpoint").map((node) => node.id));
    expect(facts.semanticRelations.some((relation) => endpointIds.has(relation.fromSpecId)
      && relation.toSpecId === byName.get("GoodsFilter")?.node.id && relation.kind === "REQUEST_SCHEMA")).toBe(true);
    expect(facts.semanticRelations.some((relation) => endpointIds.has(relation.fromSpecId)
      && relation.toSpecId === byName.get("ActivityGoodsQueryVO")?.node.id && relation.kind === "RESPONSE_SCHEMA")).toBe(true);
    expect(facts.semanticRelations.some((relation) => relation.fromSpecId === byName.get("ActivityGoodsQueryVO")?.node.id
      && relation.toSpecId === byName.get("GoodsPriceVO")?.node.id && relation.kind === "USES_SCHEMA")).toBe(true);
    const transports = schemas.filter((item) => item.spec.displayName === "TransportEnvelope"
      && item.spec.identity.canonicalTypeArguments.length === 1);
    expect(transports).toHaveLength(2);
    for (const transport of transports) {
      expect(transport.spec.shape.kind).toBe("object");
      if (transport.spec.shape.kind === "object") {
        expect(transport.spec.shape.fields.find((field) => field.serializedName === "payload")?.type).toEqual({
          kind: "resolved",
          expression: transport.spec.identity.canonicalTypeArguments[0]
        });
      }
    }
    expect(new Set(transports.map((item) => canonicalSerialize(item.spec.shape))).size).toBe(2);
    const activityPage = byName.get("ActivityPageDTO");
    expect(activityPage?.spec.shape.kind).toBe("object");
    if (activityPage?.spec.shape.kind === "object") {
      expect(activityPage.spec.shape.fields.map((field) => field.serializedName)).toEqual(["values", "total"]);
    }
    const activeSpecIds = new Set(facts.contractSpecs.map((node) => node.id));
    expect(facts.semanticRelations.every((relation) => activeSpecIds.has(relation.fromSpecId) && activeSpecIds.has(relation.toSpecId))).toBe(true);
    expect(facts.crossRepo.schemaInternalFacts.roots.length).toBeGreaterThan(0);
  });
});

async function scanFixture(): Promise<{ repo: RepoNode; config: ReturnType<typeof defaultConfig>; parsedFiles: Awaited<ReturnType<typeof scanAndParseRepo>>["parsedFiles"] }> {
  await registerBuiltinParsers(new Set(["java"]));
  const repo: RepoNode = {
    id: repoId("java-schema-js006-008"), name: "java-schema-js006-008", path: fixtureRoot,
    remoteUrl: "", branch: "main", commitSha: "fixture", language: "java", indexedAt: "fixture"
  };
  const base = defaultConfig();
  const config = { ...base, systemName: "java-schema-js006-008", repos: [{ name: repo.name, path: repo.path }] };
  const scan = await scanAndParseRepo({ repo, config, createProgressBar: () => ({ tick() {}, complete() {} }) });
  return { repo, config, parsedFiles: scan.parsedFiles };
}
