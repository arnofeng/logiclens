import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type {
  CodeSymbol,
  ContractKind,
  ContractNode,
  ContractRole,
  ContractSpecKind,
  EntityNode,
  EvidenceNode,
  ParsedFile,
  ParsedGraphFile,
  RepoNode
} from "../../../parsing/types.js";
import { contractId, entityId, evidenceId, fileId, normalizeName } from "../../../../shared/path.js";
import { normalizeApiPath, canonicalHttpContractKey, canonicalGrpcContractKey } from "../../apiPath.js";
import { canonicalEventContractKey, type EventBroker } from "../../event.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { serializeSpec, type ContractSpec, type EventSpec, type HttpEndpointSpec, type GrpcMethodSpec, type GrpcStreaming } from "../../spec.js";
import type { AliasOverride } from "../crossRepoContracts.js";
import type { FactCollector, PackageUsageEntry } from "../factCollector.js";

export type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

export type RepoPackageManifest = {
  repo: RepoNode;
  manifestPath: string;
  fileId: string;
  packageJson?: PackageJson;
  raw: string;
};

export type RepoPackageOwnership = {
  name: string;
  normalizedName: string;
  manifestPath: string;
  fileId: string;
  line: number;
};

export type RepoIdentity = {
  repo: RepoNode;
  packages: Map<string, RepoPackageOwnership>;
  aliases: Set<string>;
};

export type ResolvedPackageOwner = {
  identity: RepoIdentity;
  ownership?: RepoPackageOwnership;
};

// -- Deprecated stubs for test backward compatibility -------------------------

/** @deprecated Use `new ExtractionBuilder()` instead. */
export function createCrossRepoExtraction(): any {
  return {
    contracts: [], evidence: [], entities: [], repoContracts: [],
    repoDependencies: [], contractEntities: [], operations: [], workflows: [],
    operationRepos: [], workflowOperations: [], packageUsages: [],
    contractSpecs: [], contractSpecEdges: [], semanticRelations: []
  };
}

/** @deprecated Use `builder.build()` instead. */
export function toFactBundle(result: any): any {
  return {
    contracts: result.contracts, evidence: result.evidence, entities: result.entities,
    operations: result.operations, workflows: result.workflows,
    relations: [
      ...(result.repoContracts ?? []).map((e: any) => ({ kind: "repo-contract", ...e })),
      ...(result.repoDependencies ?? []).map((e: any) => ({ kind: "repo-dependency", ...e })),
      ...(result.packageUsages ?? []).map((e: any) => ({ kind: "package-usage", ...e })),
      ...(result.contractEntities ?? []).map((e: any) => ({ kind: "contract-entity", ...e })),
      ...(result.operationRepos ?? []).map((e: any) => ({ kind: "operation-repo", ...e })),
      ...(result.workflowOperations ?? []).map((e: any) => ({ kind: "workflow-operation", ...e })),
    ],
    contractSpecs: result.contractSpecs, contractSpecEdges: result.contractSpecEdges,
    semanticRelations: result.semanticRelations
  };
}

export function isParsedCodeFile(file: ParsedGraphFile): file is ParsedFile {
  return file.language !== "markdown";
}

export function canonicalContractKey(kind: ContractKind, value: string, method?: string): string {
  const trimmed = value.trim();
  if (kind === "api") {
    return canonicalHttpContractKey({ method: method?.trim(), path: trimmed });
  }
  if (kind === "package") return trimmed.toLowerCase();
  if (kind === "event") return canonicalEventContractKey(trimmed);
  if (kind === "config") return trimmed.toUpperCase();
  return normalizeName(trimmed);
}

/**
 * Construct identity representation for a contract node.
 * 
 * @remarks
 * Note: When `kind === "api"`, this function will apply HTTP-specific canonicalization.
 * HTTP API contracts should use `httpApiContract()` and gRPC service methods should use `grpcContract()`.
 * Other kinds (event, package, config, schema, etc.) should continue using this function.
 */
export function contract(kind: ContractKind, name: string, description = "", method?: string): ContractNode {
  const key = canonicalContractKey(kind, name, method);
  return { id: contractId(kind, key), kind, key, name, description };
}

export function httpApiContract(method: string | undefined, path: string, description = ""): ContractNode {
  const key = canonicalHttpContractKey({ method: method?.trim(), path });
  return { id: contractId("api", key), kind: "api", key, name: path, description };
}

export function grpcContract(fullName: string, description = ""): ContractNode {
  const key = canonicalGrpcContractKey(fullName);
  return { id: contractId("api", key), kind: "api", key, name: fullName, description };
}

export function evidence(input: {
  repoId: string;
  fileId: string;
  filePath: string;
  line: number;
  raw: string;
  rule: string;
  confidence: number;
}): EvidenceNode {
  return {
    id: evidenceId([input.repoId, input.filePath, String(input.line), input.rule, input.raw.slice(0, 80)]),
    ...input
  };
}

export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export function sourceLine(source: string, offset: number, startLine: number): number {
  return startLine + source.slice(0, offset).split(/\r?\n/).length - 1;
}

export function toBusinessEntityName(contractNode: ContractNode): string | undefined {
  if (contractNode.kind === "package" || contractNode.kind === "config") return undefined;
  const source = contractNode.name || contractNode.key;
  const lastSegment = source.split(/[/.:-]+/).filter(Boolean).at(-1) ?? source;
  const cleaned = lastSegment.replace(/\{[^}]+\}/g, "").replace(/(DTO|Dto|Schema|Event|Created|Updated|Deleted)$/g, "");
  return cleaned.length >= 3 ? cleaned[0]!.toUpperCase() + cleaned.slice(1) : undefined;
}

export function operationVerb(contractNode: ContractNode, role: ContractRole): string {
  if (contractNode.kind === "api") return role === "producer" ? "serve-api" : "call-api";
  if (contractNode.kind === "event") return role === "producer" ? "publish-event" : "consume-event";
  if (contractNode.kind === "package") return role === "owner" ? "own-package" : "use-package";
  return "share-contract";
}

export function pushContractEvidence(collector: FactCollector, repoId: string, contractNode: ContractNode, role: ContractRole, evidenceNode: EvidenceNode): void {
  collector.addContract(contractNode);
  collector.addEvidence(evidenceNode);
  collector.addRepoContract({ repoId, contractId: contractNode.id, role, evidenceId: evidenceNode.id, confidence: evidenceNode.confidence });
}

function pushApiOperation(input: {
  collector: FactCollector;
  file: ParsedFile;
  apiContract: ContractNode;
  role: ContractRole;
  evidenceNode: EvidenceNode;
}): void {
  const entityName = toBusinessEntityName(input.apiContract);
  if (!entityName) return;
  input.collector.addContractEntity({
    contractId: input.apiContract.id,
    entityId: entityId(entityName),
    evidenceId: input.evidenceNode.id,
    confidence: input.evidenceNode.confidence
  });
  const operationId = `operation:${normalizeName(`${operationVerb(input.apiContract, input.role)}:${entityName}:${input.apiContract.key}:${input.file.repoId}`)}`;
  input.collector.addOperation({
    id: operationId,
    verb: operationVerb(input.apiContract, input.role),
    entityName,
    description: `${input.role} ${input.apiContract.kind} ${input.apiContract.key}`
  });
  input.collector.addOperationRepo({
    operationId,
    repoId: input.file.repoId,
    role: input.role,
    evidenceId: input.evidenceNode.id,
    confidence: input.evidenceNode.confidence
  });
}

/**
 * Emits a ContractSpec node + HAS_SPEC edge for a contract. The spec carries
 * the structured, reasoning-ready representation (e.g. HttpEndpointSpec) while
 * the high-frequency query columns (httpMethod/pathTemplate/eventTopic) are
 * lifted out of specJson for backend indexing.
 */
export function pushContractSpec(input: {
  collector: FactCollector;
  contractNode: ContractNode;
  spec: ContractSpec;
  repoId: string;
  fileId: string;
  evidenceNode: EvidenceNode;
  sourceSymbolId?: string;
  framework?: string;
  httpMethod?: string;
  pathTemplate?: string;
  eventTopic?: string;
  version?: string;
}): string {
  const specId = `spec:${normalizeName(`${input.contractNode.id}:${input.evidenceNode.id}`)}`;
  const specKind: ContractSpecKind = input.spec.kind;
  input.collector.addContractSpec({
    id: specId,
    contractId: input.contractNode.id,
    specKind,
    repoId: input.repoId,
    fileId: input.fileId,
    evidenceId: input.evidenceNode.id,
    sourceSymbolId: input.sourceSymbolId,
    canonicalKey: input.contractNode.key,
    httpMethod: input.httpMethod,
    pathTemplate: input.pathTemplate,
    eventTopic: input.eventTopic,
    framework: input.framework,
    version: input.version,
    specJson: serializeSpec(input.spec),
    confidence: input.evidenceNode.confidence
  });
  input.collector.addContractSpecEdge({
    contractId: input.contractNode.id,
    specId,
    evidenceId: input.evidenceNode.id,
    confidence: input.evidenceNode.confidence
  });
  return specId;
}

/** Extracts the path template (method-prefix stripped) from a canonical api key. */
export function apiPathTemplate(canonicalKey: string): string {
  return canonicalKey.replace(/^[A-Z]+:/, "");
}

/** Extracts `{param}` path-parameter names from a path template. */
export function apiPathParams(pathTemplate: string): string[] {
  return [...pathTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

function buildHttpEndpointSpec(
  apiContract: ContractNode,
  apiPath: string,
  method?: string,
  requestBodyType?: string,
  responseBodyType?: string
): HttpEndpointSpec {
  const pathTemplate = apiPathTemplate(apiContract.key);
  return {
    kind: "http-endpoint",
    method: method ? (method.trim().toUpperCase() as HttpEndpointSpec["method"]) : undefined,
    path: apiPath,
    pathTemplate,
    pathParams: apiPathParams(pathTemplate),
    requestBodyType,
    responseBodyType,
    auth: "unknown"
  };
}

export function pushApiContractFromMatch(input: {
  collector: FactCollector;
  file: ParsedFile;
  symbol: CodeSymbol;
  match: RegExpMatchArray;
  role: ContractRole;
  rule: string;
  confidence: number;
}): void {
  const apiPath = input.match[1] ?? "";
  const apiContract = httpApiContract(undefined, apiPath, `HTTP API ${apiPath}`);
  const evidenceNode = evidence({
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    filePath: input.file.path,
    line: sourceLine(input.symbol.source, input.match.index ?? 0, input.symbol.startLine),
    raw: input.match[0],
    rule: input.rule,
    confidence: input.confidence
  });
  pushContractEvidence(input.collector, input.file.repoId, apiContract, input.role, evidenceNode);
  pushApiOperation({ collector: input.collector, file: input.file, apiContract, role: input.role, evidenceNode });
}

export function pushApiContractFromPath(input: {
  collector: FactCollector;
  file: ParsedFile;
  symbol: CodeSymbol;
  apiPath: string;
  role: ContractRole;
  offset: number;
  raw: string;
  rule: string;
  confidence: number;
  method?: string;
  framework?: string;
  requestBodyType?: string;
  responseBodyType?: string;
}): void {
  const apiContract = httpApiContract(input.method, input.apiPath, `HTTP API ${input.apiPath}`);
  const evidenceNode = evidence({
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    filePath: input.file.path,
    line: sourceLine(input.symbol.source, input.offset, input.symbol.startLine),
    raw: input.raw,
    rule: input.rule,
    confidence: input.confidence
  });
  pushContractEvidence(input.collector, input.file.repoId, apiContract, input.role, evidenceNode);
  pushApiOperation({ collector: input.collector, file: input.file, apiContract, role: input.role, evidenceNode });
  pushContractSpec({
    collector: input.collector,
    contractNode: apiContract,
    spec: buildHttpEndpointSpec(apiContract, input.apiPath, input.method, input.requestBodyType, input.responseBodyType),
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    evidenceNode,
    sourceSymbolId: input.symbol.id,
    framework: input.framework,
    httpMethod: input.method ? input.method.trim().toUpperCase() : undefined,
    pathTemplate: apiPathTemplate(apiContract.key)
  });
}

/**
 * Emits a full event contract: Contract + repo-contract edge + EventSpec
 * ContractSpec + HAS_SPEC edge + business entity/operation. Shared by every
 * language's event extractor so producer/consumer specs stay symmetric and the
 * spec/entity/operation wiring lives in one place (mirrors `pushApiContractFromPath`).
 *
 * Returns the created contract + evidence so callers can attach a degradation
 * audit (e.g. `payload-type-unresolvable`) referencing the same site.
 */
export function pushEventContract(input: {
  collector: FactCollector;
  file: ParsedFile;
  topic: string;
  role: ContractRole;
  broker: EventBroker;
  framework?: string;
  payloadType?: string;
  line: number;
  raw: string;
  rule: string;
  confidence: number;
  sourceSymbolId?: string;
}): { contractNode: ContractNode; evidenceNode: EvidenceNode } {
  const eventContract = contract("event", input.topic, `Event topic ${input.topic}`);
  const evidenceNode = evidence({
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    filePath: input.file.path,
    line: input.line,
    raw: input.raw,
    rule: input.rule,
    confidence: input.confidence
  });
  pushContractEvidence(input.collector, input.file.repoId, eventContract, input.role, evidenceNode);

  const eventSpec: EventSpec = {
    kind: "event",
    // Use the canonical key so specJson.topic matches the indexed
    // eventTopic/canonicalKey columns; the original-cased text stays in the raw.
    topic: eventContract.key,
    payloadType: input.payloadType,
    broker: input.broker
  };
  pushContractSpec({
    collector: input.collector,
    contractNode: eventContract,
    spec: eventSpec,
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    evidenceNode,
    sourceSymbolId: input.sourceSymbolId,
    framework: input.framework,
    eventTopic: eventContract.key
  });

  const entityName = toBusinessEntityName(eventContract);
  if (entityName) {
    input.collector.addEntity({ id: entityId(entityName), name: entityName, kind: "domain", description: "Domain entity inferred from cross-repo contracts" });
    input.collector.addContractEntity({ contractId: eventContract.id, entityId: entityId(entityName), evidenceId: evidenceNode.id, confidence: evidenceNode.confidence });
    const operationId = `operation:${normalizeName(`${operationVerb(eventContract, input.role)}:${entityName}:${eventContract.key}:${input.file.repoId}`)}`;
    input.collector.addOperation({ id: operationId, verb: operationVerb(eventContract, input.role), entityName, description: `${input.role} ${eventContract.kind} ${eventContract.key}` });
    input.collector.addOperationRepo({ operationId, repoId: input.file.repoId, role: input.role, evidenceId: evidenceNode.id, confidence: evidenceNode.confidence });
  }

  return { contractNode: eventContract, evidenceNode };
}

export function pushGrpcContract(input: {
  collector: FactCollector;
  file: ParsedFile;
  symbol: CodeSymbol;
  fullName: string;
  role: ContractRole;
  offset: number;
  raw: string;
  rule: string;
  confidence: number;
  service: string;
  method: string;
  package?: string;
  requestType?: string;
  responseType?: string;
  streaming: GrpcStreaming;
  framework?: "proto" | "grpc-go" | "grpc-java" | "grpc-python" | "grpc-js";
}): { contractNode: ContractNode; evidenceNode: EvidenceNode } {
  const contractNode = grpcContract(input.fullName, `gRPC ${input.fullName}`);
  const evidenceNode = evidence({
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    filePath: input.file.path,
    line: sourceLine(input.symbol.source, input.offset, input.symbol.startLine),
    raw: input.raw,
    rule: input.rule,
    confidence: input.confidence
  });

  pushContractEvidence(input.collector, input.file.repoId, contractNode, input.role, evidenceNode);

  const grpcSpec: GrpcMethodSpec = {
    kind: "grpc-method",
    service: input.service,
    method: input.method,
    package: input.package,
    fullName: input.fullName,
    requestType: input.requestType,
    responseType: input.responseType,
    streaming: input.streaming,
    framework: input.framework
  };

  pushContractSpec({
    collector: input.collector,
    contractNode,
    spec: grpcSpec,
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    evidenceNode,
    sourceSymbolId: input.symbol.id,
    framework: input.framework
  });

  // Minimum characters required for an inferred business entity name
  const MIN_ENTITY_NAME_LENGTH = 3;

  // entity derivation: service name without "Service" suffix, fallback to message names
  const serviceName = input.service;
  let entityName = serviceName.endsWith("Service") ? serviceName.slice(0, -7) : serviceName;
  if (!entityName || entityName.length < MIN_ENTITY_NAME_LENGTH) {
    const fallback = input.requestType || input.responseType;
    if (fallback) {
      entityName = fallback.replace(/(Request|Response|DTO|Dto|Schema)$/g, "");
    }
  }

  if (entityName && entityName.length >= MIN_ENTITY_NAME_LENGTH) {
    entityName = entityName[0]!.toUpperCase() + entityName.slice(1);

    input.collector.addEntity({
      id: entityId(entityName),
      name: entityName,
      kind: "domain",
      description: "Domain entity inferred from cross-repo contracts"
    });

    input.collector.addContractEntity({
      contractId: contractNode.id,
      entityId: entityId(entityName),
      evidenceId: evidenceNode.id,
      confidence: evidenceNode.confidence
    });

    const opVerb = operationVerb(contractNode, input.role);
    const operationId = `operation:${normalizeName(`${opVerb}:${entityName}:${contractNode.key}:${input.file.repoId}`)}`;
    input.collector.addOperation({
      id: operationId,
      verb: opVerb,
      entityName,
      description: `${input.role} ${contractNode.kind} ${contractNode.key}`
    });
    input.collector.addOperationRepo({
      operationId,
      repoId: input.file.repoId,
      role: input.role,
      evidenceId: evidenceNode.id,
      confidence: evidenceNode.confidence
    });
  }

  return { contractNode, evidenceNode };
}

async function readPackageManifest(repo: RepoNode, manifestPath: string): Promise<RepoPackageManifest | undefined> {
  const packagePath = path.join(repo.path, manifestPath);
  try {
    const raw = await fs.readFile(packagePath, "utf8");
    return { repo, manifestPath, fileId: fileId(repo.id, manifestPath), packageJson: JSON.parse(raw) as PackageJson, raw };
  } catch {
    return undefined;
  }
}

function workspacePatterns(packageJson: PackageJson | undefined): string[] {
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) return workspaces;
  return workspaces?.packages ?? [];
}

function workspaceManifestPattern(pattern: string): string {
  const normalized = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.endsWith("package.json") ? normalized : `${normalized}/package.json`;
}

export async function readRepoPackageManifests(repo: RepoNode): Promise<RepoPackageManifest[]> {
  const root = await readPackageManifest(repo, "package.json");
  if (!root) return [];

  const workspaceManifestPaths = await fg(workspacePatterns(root.packageJson).map(workspaceManifestPattern), {
    cwd: repo.path,
    absolute: false,
    onlyFiles: true,
    dot: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/coverage/**"]
  });

  const manifestPaths = [...new Set([
    root.manifestPath,
    ...workspaceManifestPaths.map((entry) => entry.replace(/\\/g, "/"))
  ])].sort();

  const manifests = await Promise.all(manifestPaths.map((manifestPath) => readPackageManifest(repo, manifestPath)));
  return manifests.filter((manifest): manifest is RepoPackageManifest => Boolean(manifest));
}

function addIdentityAlias(identity: RepoIdentity, alias: string | undefined): void {
  if (!alias) return;
  identity.aliases.add(alias.toLowerCase());
  identity.aliases.add(normalizeName(alias));
  identity.aliases.add(alias.replace(/^@[^/]+\//, "").toLowerCase());
}

export function packageNameLine(raw: string, packageName: string): number {
  return Math.max(1, raw.split(/\r?\n/).findIndex((line) => line.includes(`"name"`) && line.includes(`"${packageName}"`)) + 1);
}

export function dependencyLine(raw: string, packageName: string): number {
  return Math.max(1, raw.split(/\r?\n/).findIndex((line) => line.includes(`"${packageName}"`)) + 1);
}

export function buildOwnership(repos: RepoNode[], manifests: RepoPackageManifest[], aliasOverrides: AliasOverride[] = []): RepoIdentity[] {
  const manifestsByRepoId = new Map<string, RepoPackageManifest[]>();
  for (const manifest of manifests) {
    const rows = manifestsByRepoId.get(manifest.repo.id) ?? [];
    rows.push(manifest);
    manifestsByRepoId.set(manifest.repo.id, rows);
  }

  const identities = repos.map((repo) => {
    const identity: RepoIdentity = { repo, packages: new Map(), aliases: new Set() };
    addIdentityAlias(identity, repo.name);
    addIdentityAlias(identity, repo.remoteUrl);
    for (const manifest of manifestsByRepoId.get(repo.id) ?? []) {
      if (manifest.packageJson?.name) {
        const normalizedName = manifest.packageJson.name.toLowerCase();
        identity.packages.set(normalizedName, {
          name: manifest.packageJson.name,
          normalizedName,
          manifestPath: manifest.manifestPath,
          fileId: manifest.fileId,
          line: packageNameLine(manifest.raw, manifest.packageJson.name)
        });
        addIdentityAlias(identity, manifest.packageJson.name);
      }
    }
    return identity;
  });
  for (const override of aliasOverrides) {
    const target = identities.find((identity) => identity.repo.id === override.targetRepoId || identity.repo.name === override.targetRepoId);
    if (target) addIdentityAlias(target, override.alias);
  }
  return identities;
}

export function resolvePackageOwner(packageName: string, identities: RepoIdentity[]): ResolvedPackageOwner | undefined {
  const normalizedPackage = packageName.toLowerCase();
  const normalizedAlias = normalizeName(packageName);
  for (const identity of identities) {
    const ownership = identity.packages.get(normalizedPackage);
    if (ownership) return { identity, ownership };
    if (identity.aliases.has(normalizedPackage) || identity.aliases.has(normalizedAlias)) return { identity };
  }
  return undefined;
}

export function pushResolvedPackageOwner(collector: FactCollector, packageName: string, identities: RepoIdentity[]): void {
  const owner = resolvePackageOwner(packageName, identities);
  if (!owner) return;
  const packageContract = contract("package", packageName, `Package ${packageName} resolved to ${owner.identity.repo.name}`);
  const ownership = owner.ownership;
  const evidenceNode = evidence({
    repoId: owner.identity.repo.id,
    fileId: ownership?.fileId ?? fileId(owner.identity.repo.id, "package.json"),
    filePath: ownership?.manifestPath ?? "package.json",
    line: ownership?.line ?? 1,
    raw: packageName,
    rule: ownership ? "package-json-name" : "package-owner-alias",
    confidence: ownership ? confidenceFor("exact-manifest") : confidenceFor("heuristic-package-owner-alias")
  });
  pushContractEvidence(collector, owner.identity.repo.id, packageContract, "owner", evidenceNode);
}

export function dependencyEntries(packageJson: PackageJson | undefined): [string, string][] {
  if (!packageJson) return [];
  return [
    ...Object.entries(packageJson.dependencies ?? {}),
    ...Object.entries(packageJson.devDependencies ?? {}),
    ...Object.entries(packageJson.peerDependencies ?? {})
  ];
}

export function javaPackageFromPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)src\/(?:main|test)\/java\/(.+)\/[^/]+\.java$/);
  if (!match?.[1]) return undefined;
  return match[1].split("/").filter(Boolean).join(".");
}

function javaPackageFromImport(moduleName: string): string | undefined {
  if (!moduleName.includes(".")) return undefined;
  const parts = moduleName.split(".").filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.at(-1) === "*") parts.pop();
  const last = parts.at(-1);
  if (last && /^[A-Z_$]/.test(last)) parts.pop();
  return parts.length > 0 ? parts.join(".") : undefined;
}

function javaPackageFromStaticImport(moduleName: string): string | undefined {
  const parts = moduleName.split(".").filter(Boolean);
  if (parts.at(-1) === "*") parts.pop();
  const member = parts.pop();
  const typeName = parts.at(-1);
  if (member && typeName && /^[A-Z_$]/.test(typeName)) parts.pop();
  return parts.length > 0 ? parts.join(".") : undefined;
}

export function packageContractKeyForImport(file: ParsedFile, importRef: { module: string; raw: string }): string {
  const moduleName = importRef.module;
  if (file.language !== "java") return moduleName;
  if (/^import\s+static\s+/.test(importRef.raw)) return javaPackageFromStaticImport(moduleName) ?? moduleName;
  return javaPackageFromImport(moduleName) ?? moduleName;
}

export function classifySharedContract(name: string, codeKind: string): ContractKind | undefined {
  if (codeKind === "enum" || /Enum$/.test(name)) return "enum";
  if (/Schema$/.test(name)) return "schema";
  if (/Config$/.test(name)) return "config";
  if (/(DTO|Dto|Payload)$/.test(name)) return "dto";
  return undefined;
}
