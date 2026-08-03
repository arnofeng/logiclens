import { extractFacts } from "./helpers/extractFacts.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractCrossRepoContracts } from "../src/core/contracts/extraction/crossRepoContracts.js";
import type { SchemaSpec } from "../src/core/contracts/spec.js";
import { parseSourceFile } from "../src/core/parsing/parserRegistry.js";
import { repoId } from "../src/shared/path.js";
import { goSchemaExtractor } from "../src/core/contracts/extraction/builtin/goSchemaExtractor.js";
import { reconcileNonJavaSchemaFacts } from "../src/core/contracts/extraction/nonJavaSchemaReconciler.js";
import type { ContractSpecNode, ParsedGraphFile } from "../src/core/parsing/types.js";
import type { ResolutionContextFact, SchemaDeclarationCandidate } from "../src/core/schema/model.js";
import { createSchemaSpec, stableFactId, typeDeclarationIdentityId } from "../src/core/schema/model.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("non-Java schema reconciliation", () => {
  it("resolves declared nested and array references and persists unresolved diagnostics instead of guessed edges", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-reconcile-"));
    directories.push(directory);
    const filePath = path.join(directory, "models.ts");
    await fs.writeFile(filePath, `
      export interface User { id: string; }
      export interface Order { user: User; users: User[]; metadata: Record<string, string>; missing: MissingType; }
      broker.publish<Order>("orders", order);
    `, "utf8");
    const id = repoId("schema-reconcile");
    const parsed = await parseSourceFile({ repoId: id, absolutePath: filePath, relativePath: "models.ts", language: "typescript" });
    const facts = await extractCrossRepoContracts([{
      id, name: "schema-reconcile", path: directory, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now"
    }], [parsed]);
    const schemas = facts.contractSpecs.filter((spec) => spec.specKind === "schema").map((node) => JSON.parse(node.specJson) as SchemaSpec);
    const order = schemas.find((schema) => schema.displayName === "Order");
    expect(order?.shape.kind).toBe("object");
    if (!order || order.shape.kind !== "object") throw new Error("Order schema missing");
    expect(order.shape.fields.find((field) => field.sourceName === "user")?.type.kind).toBe("resolved");
    const users = order.shape.fields.find((field) => field.sourceName === "users")?.type;
    expect(users?.kind).toBe("resolved");
    if (users?.kind === "resolved") {
      expect(users.expression.kind).toBe("array");
      expect(JSON.stringify(users.expression)).toContain("declaration:");
    }
    const metadata = order.shape.fields.find((field) => field.sourceName === "metadata")?.type;
    expect(metadata).toMatchObject({ kind: "resolved", expression: { kind: "map" } });
    expect(order.shape.fields.find((field) => field.sourceName === "missing")?.type.kind).toBe("unresolved");
    expect(facts.schemaInternalFacts.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unresolved", ownerSpecId: order.id, fieldPath: ["missing"] })
    ]));
    expect(facts.semanticRelations.filter((relation) => relation.fromSpecId === order.id && relation.kind === "USES_SCHEMA")).toHaveLength(1);
    const rootIds = new Set(facts.schemaInternalFacts.roots.map((root) => root.id));
    expect(facts.schemaInternalFacts.dependencies.every((fact) => rootIds.has(fact.rootReferenceId))).toBe(true);
    expect(facts.schemaInternalFacts.provenance.every((fact) => rootIds.has(fact.rootReferenceId))).toBe(true);
    expect(facts.schemaInternalFacts.dependencies.some((fact) => fact.fromInstanceId?.startsWith("type-instance:"))).toBe(true);
  });

  it("resolves an imported event payload and its imported nested field across TypeScript modules", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-cross-file-"));
    directories.push(directory);
    const sources = new Map([
      ["src/meta.ts", "export interface Meta { id: string; }"],
      ["src/models.ts", "import { Meta } from './meta'; export interface Payload { meta: Meta; }"],
      ["src/publisher.ts", "import { Payload } from './models'; eventBus.publish<Payload>('topic.created', payload);" ]
    ]);
    const id = repoId("schema-cross-file");
    const parsed = [];
    for (const [relativePath, source] of sources) {
      const absolutePath = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, source, "utf8");
      parsed.push(await parseSourceFile({ repoId: id, absolutePath, relativePath, language: "typescript" }));
    }
    const facts = await extractCrossRepoContracts([{
      id, name: "schema-cross-file", path: directory, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now"
    }], parsed);
    const schemas = facts.contractSpecs.filter((spec) => spec.specKind === "schema").map((node) => JSON.parse(node.specJson) as SchemaSpec);
    const payload = schemas.find((schema) => schema.displayName === "Payload");
    const meta = schemas.find((schema) => schema.displayName === "Meta");
    expect(payload).toBeDefined();
    expect(meta).toBeDefined();
    expect(facts.schemaInternalFacts.roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerFileId: expect.stringContaining("publisher.ts"), relationKind: "EVENT_PAYLOAD" })
    ]));
    expect(facts.semanticRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ toSpecId: payload?.id, kind: "EVENT_PAYLOAD" }),
      expect.objectContaining({ fromSpecId: payload?.id, toSpecId: meta?.id, kind: "USES_SCHEMA" })
    ]));
    expect(facts.schemaInternalFacts.resolutionContexts.find((context) => context.fileId.includes("publisher.ts"))?.imports)
      .toEqual(expect.arrayContaining([expect.objectContaining({ localName: "Payload", declarationId: payload?.identity.declarationId })]));
    expect(facts.schemaInternalFacts.resolutionScopeDependencies.length).toBeGreaterThanOrEqual(2);
  });

  it("persists typed roots and diagnostics even when a source has no declarations yet", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-root-only-"));
    directories.push(directory);
    const filePath = path.join(directory, "publisher.ts");
    await fs.writeFile(filePath, `
      eventBus.publish<Missing>("missing.created", missing);
      eventBus.publish<string>("scalar.created", value);
    `, "utf8");
    const id = repoId("schema-root-only");
    const parsed = await parseSourceFile({ repoId: id, absolutePath: filePath, relativePath: "publisher.ts", language: "typescript" });
    const event = (suffix: string, payloadType: string): ContractSpecNode => ({
      id: `spec:${suffix}`,
      contractId: `contract:${suffix}`,
      specKind: "event",
      repoId: id,
      fileId: parsed.fileId,
      evidenceId: `evidence:${suffix}`,
      canonicalKey: suffix,
      specJson: JSON.stringify({ kind: "event", topic: suffix, payloadType }),
      confidence: 1
    });
    const facts = reconcileNonJavaSchemaFacts([
      event("missing", "Missing"),
      event("scalar", "string")
    ], [], [], { sourceFiles: [parsed] });
    const roots = facts.internal.roots.filter((root) => root.ownerFileId === parsed.fileId);
    expect(roots).toHaveLength(2);
    expect(facts.internal.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unresolved", symbol: "Missing", rootReferenceId: expect.any(String) })
    ]));
    expect(facts.internal.diagnostics.some((diagnostic) => diagnostic.symbol === "string")).toBe(false);
    expect(facts.semanticRelations.filter((relation) => relation.kind === "EVENT_PAYLOAD")).toEqual([]);
  });

  it("resolves an empty object declaration when it becomes reachable", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-empty-object-"));
    directories.push(directory);
    const filePath = path.join(directory, "events.ts");
    await fs.writeFile(filePath, `
      export interface Empty {}
      eventBus.publish<Empty>("empty.created", value);
    `, "utf8");
    const id = repoId("schema-empty-object");
    const parsed = await parseSourceFile({ repoId: id, absolutePath: filePath, relativePath: "events.ts", language: "typescript" });
    const facts = await extractCrossRepoContracts([{
      id, name: "schema-empty-object", path: directory, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now"
    }], [parsed]);
    const empty = facts.contractSpecs
      .filter((spec) => spec.specKind === "schema")
      .map((spec) => JSON.parse(spec.specJson) as SchemaSpec)
      .find((schema) => schema.displayName === "Empty");
    expect(empty?.shape).toMatchObject({ kind: "object", fields: [] });
    expect(facts.semanticRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ toSpecId: empty?.id, kind: "EVENT_PAYLOAD" })
    ]));
    expect(facts.schemaInternalFacts.diagnostics.some((diagnostic) => diagnostic.symbol === "Empty")).toBe(false);
  });

  it("lets an existing proven typed relation seed declaration reachability", () => {
    const candidate: SchemaDeclarationCandidate = {
      declaration: { languageId: "typescript", repoId: "repo:existing-relation", resolutionScopeId: "module:models", canonicalName: "Payload" },
      displayName: "Payload",
      typeParameters: [],
      shape: { kind: "object", fields: [] },
      fileId: "file:payload",
      filePath: "payload.ts",
      framework: "ts-schema",
      evidence: { line: 1, raw: "interface Payload {}", rule: "fixture", confidence: 1 }
    };
    const payloadId = createSchemaSpec(candidate).id;
    const owner: ContractSpecNode = {
      id: "spec:endpoint",
      contractId: "contract:endpoint",
      specKind: "http-endpoint",
      repoId: candidate.declaration.repoId,
      fileId: "file:endpoint",
      evidenceId: "evidence:endpoint",
      canonicalKey: "GET /payload",
      specJson: JSON.stringify({ kind: "http-endpoint", method: "GET", pathTemplate: "/payload" }),
      confidence: 1
    };
    const reconciled = reconcileNonJavaSchemaFacts([owner], [{
      fromSpecId: owner.id,
      toSpecId: payloadId,
      kind: "RESPONSE_SCHEMA",
      evidenceId: owner.evidenceId,
      reason: "Previously proven typed relation",
      confidence: 1
    }], [candidate]);
    expect(reconciled.contractSpecs.map((spec) => spec.id)).toEqual(expect.arrayContaining([owner.id, payloadId]));
    expect(reconciled.semanticRelations).toEqual([expect.objectContaining({ fromSpecId: owner.id, toSpecId: payloadId, kind: "RESPONSE_SCHEMA" })]);
  });

  it("lets an imported user generic shadow a builtin wrapper alias", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-wrapper-shadow-"));
    directories.push(directory);
    const sources = new Map([
      ["src/array.ts", "export interface Array<T> { value: T; }"],
      ["src/item.ts", "export interface Item { id: string; }"],
      ["src/models.ts", "import { Array } from './array'; import { Item } from './item'; export interface Payload { items: Array<Item>; }"],
      ["src/publisher.ts", "import { Payload } from './models'; eventBus.publish<Payload>('topic.created', payload);" ]
    ]);
    const id = repoId("schema-wrapper-shadow");
    const parsed = [];
    for (const [relativePath, source] of sources) {
      const absolutePath = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, source, "utf8");
      parsed.push(await parseSourceFile({ repoId: id, absolutePath, relativePath, language: "typescript" }));
    }
    const facts = await extractCrossRepoContracts([{
      id, name: "schema-wrapper-shadow", path: directory, remoteUrl: "", branch: "", commitSha: "", language: "typescript", indexedAt: "now"
    }], parsed);
    const schemas = facts.contractSpecs.filter((spec) => spec.specKind === "schema").map((node) => JSON.parse(node.specJson) as SchemaSpec);
    expect(schemas.map((schema) => schema.displayName)).toEqual(expect.arrayContaining(["Payload", "Array", "Item"]));
    const payload = schemas.find((schema) => schema.displayName === "Payload")!;
    const array = schemas.find((schema) => schema.displayName === "Array")!;
    expect(facts.semanticRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromSpecId: payload.id, toSpecId: array.id, kind: "USES_SCHEMA" })
    ]));
  });

  it("resolves Go declarations across files in the same package scope", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-go-package-"));
    directories.push(directory);
    const id = repoId("schema-go-package");
    const sources = new Map([
      ["orders/payload.go", "package orders\ntype Payload struct { ID string }"],
      ["orders/order.go", "package orders\ntype Order struct { Payload Payload }"],
      ["orders/publisher.go", "package orders\nfunc Publish(order Order) {}"]
    ]);
    const parsed = [];
    for (const [relativePath, source] of sources) {
      const absolutePath = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, source, "utf8");
      parsed.push(await parseSourceFile({ repoId: id, absolutePath, relativePath, language: "go" }));
    }
    const repo = { id, name: "schema-go-package", path: directory, remoteUrl: "", branch: "", commitSha: "", language: "go", indexedAt: "now" };
    const extracted = await extractFacts(goSchemaExtractor, { repos: [repo], parsedFiles: parsed, repoResolver: () => repo });
    const publisher = parsed.find((file) => file.path.endsWith("publisher.go"))!;
    const event = {
      id: "spec:event:go-package",
      contractId: "contract:event:go-package",
      specKind: "event" as const,
      repoId: id,
      fileId: publisher.fileId,
      evidenceId: "evidence:event:go-package",
      canonicalKey: "topic.created",
      specJson: JSON.stringify({ kind: "event", topic: "topic.created", payloadType: "Order" }),
      confidence: 1
    };
    const reconciled = reconcileNonJavaSchemaFacts([event], [], extracted.schemaDeclarations, { sourceFiles: parsed });
    const schemas = reconciled.contractSpecs.filter((spec) => spec.specKind === "schema").map((node) => JSON.parse(node.specJson) as SchemaSpec);
    const order = schemas.find((schema) => schema.displayName === "Order");
    const payload = schemas.find((schema) => schema.displayName === "Payload");
    expect(order?.declaration.resolutionScopeId).toBe("package:orders:orders");
    expect(payload?.declaration.resolutionScopeId).toBe(order?.declaration.resolutionScopeId);
    expect(reconciled.semanticRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromSpecId: event.id, toSpecId: order?.id, kind: "EVENT_PAYLOAD" }),
      expect.objectContaining({ fromSpecId: order?.id, toSpecId: payload?.id, kind: "USES_SCHEMA" })
    ]));
  });

  it("resolves Go imports by exact module path and diagnoses an unowned same-suffix import", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-go-import-"));
    directories.push(directory);
    await fs.writeFile(path.join(directory, "go.mod"), "module example.com/service\n\ngo 1.22\n", "utf8");
    const id = repoId("schema-go-import");
    const sources = new Map([
      ["pkg/payment/payload.go", "package payment\ntype Payload struct { Correct string }"],
      ["shadow/payment/payload.go", "package payment\ntype Payload struct { Wrong string }"],
      ["cmd/valid.go", "package main\nimport \"example.com/service/pkg/payment\"\nfunc valid(value payment.Payload) {}"],
      ["cmd/invalid.go", "package main\nimport foreign \"example.net/foreign/pkg/payment\"\nfunc invalid(value foreign.Payload) {}"]
    ]);
    const parsed = [];
    for (const [relativePath, source] of sources) {
      const absolutePath = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, source, "utf8");
      parsed.push(await parseSourceFile({ repoId: id, absolutePath, relativePath, language: "go" }));
    }
    const repo = { id, name: "schema-go-import", path: directory, remoteUrl: "", branch: "", commitSha: "", language: "go", indexedAt: "now" };
    const extracted = await extractFacts(goSchemaExtractor, { repos: [repo], parsedFiles: parsed, repoResolver: () => repo });
    const validFile = parsed.find((file) => file.path === "cmd/valid.go")!;
    const invalidFile = parsed.find((file) => file.path === "cmd/invalid.go")!;
    const validEvent = {
      id: "spec:event:go-valid",
      contractId: "contract:event:go-valid",
      specKind: "event" as const,
      repoId: id,
      fileId: validFile.fileId,
      evidenceId: "evidence:event:go-valid",
      canonicalKey: "go.valid",
      specJson: JSON.stringify({ kind: "event", topic: "go.valid", payloadType: "payment.Payload" }),
      confidence: 1
    };
    const invalidEvent = {
      ...validEvent,
      id: "spec:event:go-invalid",
      contractId: "contract:event:go-invalid",
      fileId: invalidFile.fileId,
      evidenceId: "evidence:event:go-invalid",
      canonicalKey: "go.invalid",
      specJson: JSON.stringify({ kind: "event", topic: "go.invalid", payloadType: "foreign.Payload" })
    };
    const reconciled = reconcileNonJavaSchemaFacts([validEvent, invalidEvent], [], extracted.schemaDeclarations, { sourceFiles: parsed });
    const schemas = reconciled.contractSpecs.filter((spec) => spec.specKind === "schema").map((node) => JSON.parse(node.specJson) as SchemaSpec);
    const payload = schemas.find((schema) => schema.declaration.resolutionScopeId === "package:example.com/service/pkg/payment:payment");
    expect(payload).toBeDefined();
    expect(schemas.some((schema) => schema.declaration.resolutionScopeId === "package:example.com/service/shadow/payment:payment")).toBe(false);
    expect(reconciled.semanticRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromSpecId: validEvent.id, toSpecId: payload?.id, kind: "EVENT_PAYLOAD" })
    ]));
    expect(reconciled.semanticRelations.some((relation) => relation.fromSpecId === invalidEvent.id)).toBe(false);
    expect(reconciled.internal.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerSpecId: invalidEvent.id, code: "unresolved", symbol: "foreign.Payload" })
    ]));
    const invalidContext = reconciled.internal.resolutionContexts.find((context) => context.fileId === invalidFile.fileId);
    expect(invalidContext?.imports).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalName: "Payload" })
    ]));
  });

  it("uses the declared Go package name as the default qualifier for a versioned import path", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repohelix-schema-go-versioned-import-"));
    directories.push(directory);
    await fs.writeFile(path.join(directory, "go.mod"), "module example.com/service\n\ngo 1.22\n", "utf8");
    const id = repoId("schema-go-versioned-import");
    const sources = new Map([
      ["pkg/contracts/v2/payload.go", "package contracts\ntype Payload struct { ID string }"],
      ["cmd/publisher.go", "package main\nimport \"example.com/service/pkg/contracts/v2\"\nfunc publish(value contracts.Payload) {}"]
    ]);
    const parsed = [];
    for (const [relativePath, source] of sources) {
      const absolutePath = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, source, "utf8");
      parsed.push(await parseSourceFile({ repoId: id, absolutePath, relativePath, language: "go" }));
    }
    const repo = { id, name: "schema-go-versioned-import", path: directory, remoteUrl: "", branch: "", commitSha: "", language: "go", indexedAt: "now" };
    const extracted = await extractFacts(goSchemaExtractor, { repos: [repo], parsedFiles: parsed, repoResolver: () => repo });
    const publisher = parsed.find((file) => file.path === "cmd/publisher.go")!;
    const event = (suffix: string, payloadType: string) => ({
      id: `spec:event:${suffix}`,
      contractId: `contract:event:${suffix}`,
      specKind: "event" as const,
      repoId: id,
      fileId: publisher.fileId,
      evidenceId: `evidence:event:${suffix}`,
      canonicalKey: suffix,
      specJson: JSON.stringify({ kind: "event", topic: suffix, payloadType }),
      confidence: 1
    });
    const valid = event("go-versioned-valid", "contracts.Payload");
    const invalid = event("go-versioned-invalid", "v2.Payload");
    const reconciled = reconcileNonJavaSchemaFacts([valid, invalid], [], extracted.schemaDeclarations, { sourceFiles: parsed });
    expect(reconciled.semanticRelations).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromSpecId: valid.id, kind: "EVENT_PAYLOAD" })
    ]));
    expect(reconciled.semanticRelations.some((relation) => relation.fromSpecId === invalid.id)).toBe(false);
    expect(reconciled.internal.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerSpecId: invalid.id, code: "unresolved", symbol: "v2.Payload" })
    ]));
    expect(reconciled.internal.resolutionContexts.find((context) => context.fileId === publisher.fileId)?.imports)
      .toEqual(expect.arrayContaining([expect.objectContaining({ localName: "contracts.Payload" })]));
  });

  it("retains scalar, external, ambiguous, unsupported, and unresolved root outcomes with stable logical provenance", () => {
    const repo = "repo:root-outcomes";
    const candidate = (canonicalName: string, resolutionScopeId: string): SchemaDeclarationCandidate => ({
      declaration: { languageId: "csharp", repoId: repo, resolutionScopeId, canonicalName },
      displayName: canonicalName,
      typeParameters: [],
      shape: { kind: "object", fields: [] },
      fileId: `file:${canonicalName}`, filePath: `${canonicalName}.cs`, framework: "csharp",
      evidence: { line: 1, raw: canonicalName, rule: "fixture", confidence: 1 }
    });
    const declarations = [candidate("Models.Anchor", "models"), candidate("Models.First", "first"), candidate("Models.Second", "second")];
    const declarationIds = declarations.map((item) => typeDeclarationIdentityId(item.declaration));
    const context: ResolutionContextFact = {
      id: "context:endpoint", languageId: "csharp", repoId: repo, resolutionScopeId: "endpoint", fileId: "file:endpoint",
      imports: [
        { localName: "Anchor", canonicalName: "Models.Anchor", declarationId: declarationIds[0]!, resolutionScopeId: "models", kind: "named" },
        { localName: "Alias", canonicalName: "Models.First", declarationId: declarationIds[1]!, resolutionScopeId: "first", kind: "named" },
        { localName: "Alias", canonicalName: "Models.Second", declarationId: declarationIds[2]!, resolutionScopeId: "second", kind: "named" }
      ],
      enclosingDeclarationIds: [], genericBindings: [], generation: ""
    };
    const event = (id: string, payloadType: string, evidenceId = `evidence:${id}`): ContractSpecNode => ({
      id: `spec:${id}`, contractId: `contract:${id}`, specKind: "event", repoId: repo, fileId: context.fileId,
      evidenceId, canonicalKey: id, specJson: JSON.stringify({ kind: "event", topic: id, payloadType }), confidence: 1
    });
    const nodes = [
      event("resolved", "Anchor"), event("scalar", "string"), event("external", "System.Clock"),
      event("ambiguous", "Alias"), event("unsupported", "Dictionary<>"), event("unresolved", "Missing")
    ];
    const first = reconcileNonJavaSchemaFacts(nodes, [], declarations, { resolutionContexts: [context] });
    const rootIds = new Set(first.internal.roots.map((root) => root.id));
    expect(first.internal.roots).toHaveLength(nodes.length);
    expect(new Set(first.internal.diagnostics.map((fact) => fact.code))).toEqual(new Set(["external", "ambiguous", "unsupported", "unresolved"]));
    expect(first.internal.diagnostics.every((fact) => fact.rootReferenceId !== undefined && rootIds.has(fact.rootReferenceId))).toBe(true);
    expect(first.internal.diagnostics.some((fact) => fact.ownerSpecId === "spec:scalar")).toBe(false);
    const relation = first.semanticRelations.find((item) => item.fromSpecId === "spec:resolved")!;
    const provenance = first.internal.provenance.find((fact) => fact.rootReferenceId === first.internal.roots.find((root) => root.ownerSpecId === "spec:resolved")?.id)!;
    expect(provenance.relationId).toBe(stableFactId("schema-relation", {
      fromSpecId: relation.fromSpecId, toSpecId: relation.toSpecId, kind: relation.kind
    }));
    const second = reconcileNonJavaSchemaFacts(nodes.map((node) => node.id === "spec:resolved" ? { ...node, evidenceId: "evidence:changed" } : node), [], declarations, { resolutionContexts: [context] });
    const repeated = second.internal.provenance.find((fact) => fact.rootReferenceId === second.internal.roots.find((root) => root.ownerSpecId === "spec:resolved")?.id)!;
    expect([repeated.id, repeated.relationId]).toEqual([provenance.id, provenance.relationId]);
  });

  it("owns behavior fingerprints by repo/language/scope and hashes only resolution behavior inputs", () => {
    const declaration = {
      languageId: "typescript",
      repoId: "repo:fingerprint",
      resolutionScopeId: "module:models",
      canonicalName: "Payload"
    };
    const candidate = (optional: boolean): SchemaDeclarationCandidate => ({
      declaration,
      displayName: "Payload",
      typeParameters: [],
      shape: {
        kind: "object",
        fields: [{
          sourceName: "id",
          serializedName: "id",
          type: { kind: "resolved", expression: { kind: "scalar", name: "string" } },
          optional,
          nullable: false,
          sourceLocation: { fileId: "file:repo:fingerprint:models.ts", line: 9 }
        }]
      },
      fileId: "file:repo:fingerprint:models.ts",
      filePath: "models.ts",
      framework: "ts-schema",
      evidence: { line: 1, raw: "interface Payload", rule: "fixture", confidence: 1 }
    });
    const sourceFile = (hash: string): ParsedGraphFile => ({
      repoId: declaration.repoId,
      fileId: "file:repo:fingerprint:models.ts",
      path: "models.ts",
      language: "typescript",
      hash,
      loc: 1,
      source: "export interface Payload { id: string }",
      imports: [],
      symbols: [],
      calls: []
    });
    const context = (withImport: boolean): ResolutionContextFact => ({
      id: "context:consumer",
      languageId: declaration.languageId,
      repoId: declaration.repoId,
      resolutionScopeId: declaration.resolutionScopeId,
      fileId: "file:repo:fingerprint:consumer.ts",
      imports: withImport ? [{
        localName: "Payload",
        canonicalName: declaration.canonicalName,
        declarationId: typeDeclarationIdentityId(declaration),
        resolutionScopeId: declaration.resolutionScopeId,
        kind: "named"
      }] : [],
      enclosingDeclarationIds: [],
      genericBindings: [],
      generation: ""
    });
    const event: ContractSpecNode = {
      id: "spec:fingerprint-event",
      contractId: "contract:fingerprint-event",
      specKind: "event",
      repoId: declaration.repoId,
      fileId: "file:repo:fingerprint:consumer.ts",
      evidenceId: "evidence:fingerprint-event",
      canonicalKey: "fingerprint.event",
      specJson: JSON.stringify({ kind: "event", topic: "fingerprint.event", payloadType: "Payload" }),
      confidence: 1
    };
    const reconcile = (optional: boolean, withImport: boolean) => reconcileNonJavaSchemaFacts(
      [event],
      [],
      [candidate(optional)],
      { sourceFiles: [sourceFile("hash:a")], resolutionContexts: [context(withImport)] }
    );
    const initial = reconcile(false, false);
    const shapeChanged = reconcile(true, false);
    const inputsChanged = reconcile(false, true);
    const fingerprint = initial.internal.fingerprints[0]!;
    expect(fingerprint).toMatchObject({
      repoId: declaration.repoId,
      languageId: declaration.languageId,
      resolutionScopeId: declaration.resolutionScopeId
    });
    expect(initial.internal.declarations[0]?.id).toBe(shapeChanged.internal.declarations[0]?.id);
    // Ordinary declaration edits affect the declaration/dependency catalog,
    // not adapter behavior. Treating them as behavior changes would force a
    // full reconciliation on every changed-only source update.
    expect(shapeChanged.internal.fingerprints[0]?.id).toBe(fingerprint.id);
    expect(inputsChanged.internal.fingerprints[0]?.id).toBe(fingerprint.id);
    expect(initial.internal.fingerprints[0]).not.toHaveProperty("sourceFileId");
  });

  it("normalizes empty source symbols across persisted contract-spec round trips", () => {
    const declaration = {
      languageId: "typescript",
      repoId: "repo:source-symbol-roundtrip",
      resolutionScopeId: "module:payload",
      canonicalName: "Payload"
    };
    const declarationId = typeDeclarationIdentityId(declaration);
    const payload: SchemaDeclarationCandidate = {
      declaration,
      displayName: "Payload",
      typeParameters: [],
      shape: { kind: "object", fields: [] },
      fileId: "file:payload",
      filePath: "payload.ts",
      framework: "ts-schema",
      evidence: { line: 1, raw: "interface Payload", rule: "fixture", confidence: 1 }
    };
    const context: ResolutionContextFact = {
      id: "context:event",
      languageId: declaration.languageId,
      repoId: declaration.repoId,
      resolutionScopeId: "module:event",
      fileId: "file:event",
      imports: [{
        localName: "Payload",
        canonicalName: declaration.canonicalName,
        declarationId,
        resolutionScopeId: declaration.resolutionScopeId,
        kind: "named"
      }],
      enclosingDeclarationIds: [],
      genericBindings: [],
      generation: ""
    };
    const event = (sourceSymbolId: string | undefined): ContractSpecNode => ({
      id: "spec:event-roundtrip",
      contractId: "contract:event-roundtrip",
      specKind: "event",
      repoId: declaration.repoId,
      fileId: context.fileId,
      sourceSymbolId,
      evidenceId: "evidence:event-roundtrip",
      canonicalKey: "payload.updated",
      specJson: JSON.stringify({ kind: "event", topic: "payload.updated", payloadType: "Payload" }),
      confidence: 1
    });
    const clean = reconcileNonJavaSchemaFacts([event(undefined)], [], [payload], { resolutionContexts: [context] });
    const restored = reconcileNonJavaSchemaFacts([event("  ")], [], [payload], { resolutionContexts: [context] });
    expect(restored.internal.resolutionContexts).toEqual(clean.internal.resolutionContexts);
    expect(restored.internal.roots).toEqual(clean.internal.roots);
    expect(restored.internal.resolutionContexts.some((value) => value.sourceSymbolId === "")).toBe(false);
  });
});
