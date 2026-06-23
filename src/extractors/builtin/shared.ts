import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type {
  CodeSymbol,
  ContractKind,
  ContractNode,
  ContractRole,
  EntityNode,
  EvidenceNode,
  ParsedFile,
  ParsedGraphFile,
  RepoNode
} from "../../parsers/types.js";
import { contractId, entityId, evidenceId, fileId, normalizeName } from "../../utils/path.js";
import { normalizeApiPath } from "../../contracts/apiPath.js";
import { confidenceFor } from "../../confidence.js";
import type { AliasOverride, CrossRepoExtraction, ExtractorFactBundle } from "../crossRepoContracts.js";

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

export function createCrossRepoExtraction(): CrossRepoExtraction {
  return {
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
    packageUsages: []
  };
}

export function isParsedCodeFile(file: ParsedGraphFile): file is ParsedFile {
  return file.language !== "markdown";
}

export function canonicalContractKey(kind: ContractKind, value: string): string {
  const trimmed = value.trim();
  if (kind === "api") {
    if (trimmed.startsWith("/") || /^https?:\/\//i.test(trimmed)) return normalizeApiPath(trimmed).toLowerCase();
    return trimmed
      .replace(/\?.*$/, "")
      .replace(/\/+/g, "/")
      .replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, "/{$1}")
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "{$1}")
      .replace(/\$\{[^}]+\}/g, "{param}")
      .replace(/\/$/, "")
      .toLowerCase();
  }
  if (kind === "package") return trimmed.toLowerCase();
  if (kind === "event") return trimmed.toLowerCase();
  if (kind === "config") return trimmed.toUpperCase();
  return normalizeName(trimmed);
}

export function contract(kind: ContractKind, name: string, description = ""): ContractNode {
  const key = canonicalContractKey(kind, name);
  return { id: contractId(kind, key), kind, key, name, description };
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

export function toFactBundle(result: CrossRepoExtraction): ExtractorFactBundle {
  return {
    contracts: result.contracts,
    evidence: result.evidence,
    entities: result.entities,
    operations: result.operations,
    workflows: result.workflows,
    relations: [
      ...result.repoContracts.map((edge) => ({ kind: "repo-contract" as const, ...edge })),
      ...result.repoDependencies.map((edge) => ({ kind: "repo-dependency" as const, ...edge })),
      ...result.packageUsages.map((edge) => ({ kind: "package-usage" as const, ...edge })),
      ...result.contractEntities.map((edge) => ({ kind: "contract-entity" as const, ...edge })),
      ...result.operationRepos.map((edge) => ({ kind: "operation-repo" as const, ...edge })),
      ...result.workflowOperations.map((edge) => ({ kind: "workflow-operation" as const, ...edge }))
    ]
  };
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

export function pushContractEvidence(result: CrossRepoExtraction, repoId: string, contractNode: ContractNode, role: ContractRole, evidenceNode: EvidenceNode): void {
  result.contracts.push(contractNode);
  result.evidence.push(evidenceNode);
  result.repoContracts.push({ repoId, contractId: contractNode.id, role, evidenceId: evidenceNode.id, confidence: evidenceNode.confidence });
}

function pushApiOperation(input: {
  result: CrossRepoExtraction;
  file: ParsedFile;
  apiContract: ContractNode;
  role: ContractRole;
  evidenceNode: EvidenceNode;
}): void {
  const entityName = toBusinessEntityName(input.apiContract);
  if (!entityName) return;
  input.result.contractEntities.push({
    contractId: input.apiContract.id,
    entityId: entityId(entityName),
    evidenceId: input.evidenceNode.id,
    confidence: input.evidenceNode.confidence
  });
  const operationId = `operation:${normalizeName(`${operationVerb(input.apiContract, input.role)}:${entityName}:${input.apiContract.key}:${input.file.repoId}`)}`;
  input.result.operations.push({
    id: operationId,
    verb: operationVerb(input.apiContract, input.role),
    entityName,
    description: `${input.role} ${input.apiContract.kind} ${input.apiContract.key}`
  });
  input.result.operationRepos.push({
    operationId,
    repoId: input.file.repoId,
    role: input.role,
    evidenceId: input.evidenceNode.id,
    confidence: input.evidenceNode.confidence
  });
}

export function pushApiContractFromMatch(input: {
  result: CrossRepoExtraction;
  file: ParsedFile;
  symbol: CodeSymbol;
  match: RegExpMatchArray;
  role: ContractRole;
  rule: string;
  confidence: number;
}): void {
  const apiPath = input.match[1] ?? "";
  const apiContract = contract("api", apiPath, `HTTP API ${apiPath}`);
  const evidenceNode = evidence({
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    filePath: input.file.path,
    line: sourceLine(input.symbol.source, input.match.index ?? 0, input.symbol.startLine),
    raw: input.match[0],
    rule: input.rule,
    confidence: input.confidence
  });
  pushContractEvidence(input.result, input.file.repoId, apiContract, input.role, evidenceNode);
  pushApiOperation({ result: input.result, file: input.file, apiContract, role: input.role, evidenceNode });
}

export function pushApiContractFromPath(input: {
  result: CrossRepoExtraction;
  file: ParsedFile;
  symbol: CodeSymbol;
  apiPath: string;
  role: ContractRole;
  offset: number;
  raw: string;
  rule: string;
  confidence: number;
}): void {
  const apiContract = contract("api", input.apiPath, `HTTP API ${input.apiPath}`);
  const evidenceNode = evidence({
    repoId: input.file.repoId,
    fileId: input.file.fileId,
    filePath: input.file.path,
    line: sourceLine(input.symbol.source, input.offset, input.symbol.startLine),
    raw: input.raw,
    rule: input.rule,
    confidence: input.confidence
  });
  pushContractEvidence(input.result, input.file.repoId, apiContract, input.role, evidenceNode);
  pushApiOperation({ result: input.result, file: input.file, apiContract, role: input.role, evidenceNode });
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

export function pushResolvedPackageOwner(result: CrossRepoExtraction, packageName: string, identities: RepoIdentity[]): void {
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
  pushContractEvidence(result, owner.identity.repo.id, packageContract, "owner", evidenceNode);
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
