import path from "node:path";
import { extractCrossRepoContracts, type AliasOverride, type CrossRepoExtraction } from "../contracts/extraction/crossRepoContracts.js";
import { resolveCalls, resolveImports } from "../extraction/resolveReferences.js";
import type { AppConfig } from "../../config/schema.js";
import type {
  CallEdge,
  CodeSymbol,
  ContractEntityEdge,
  ContractNode,
  ContractSpecEdge,
  ContractSpecNode,
  DocSection,
  EntityNode,
  EvidenceNode,
  FileNode,
  ImportEdge,
  OperationNode,
  OperationRepoEdge,
  PackageUsageEdge,
  ParsedDocument,
  ParsedFile,
  ParsedGraphFile,
  RepoContractEdge,
  RepoDependencyEdge,
  RepoNode,
  SemanticRelationEdge,
  WorkflowNode,
  WorkflowOperationEdge
} from "../parsing/types.js";
import { extractHeuristicEntities, extractHeuristicEntitiesFromSection } from "../semantic/extractEntities.js";
import { ensureBuiltinGrammarsForParsedFiles, registerBuiltinParsers } from "../parsing/parserRegistry.js";
import { registerBuiltinsForParsedFiles } from "../plugins/bootstrap.js";
import { confidenceFor } from "../../shared/confidence.js";
import { getBrandedEnv } from "../../shared/branding.js";
import type { ProgressReporter } from "../../shared/progress.js";

export type ContainsEdge = {
  fromId: string;
  toId: string;
};

export type MentionEdge = {
  fromId: string;
  entityId: string;
  sourceKind: "code" | "section";
  confidence: number;
};

export type SectionDocumentsCodeEdge = {
  sectionId: string;
  codeId: string;
  confidence: number;
};

export type SectionReferencesFileEdge = {
  sectionId: string;
  fileId: string;
  raw: string;
};

export type GraphFactsBatch = {
  batchId: string;
  indexedAt: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  files: FileNode[];
  code: CodeSymbol[];
  sections: DocSection[];
  entities: EntityNode[];
  operations: OperationNode[];
  workflows: WorkflowNode[];
  contracts: ContractNode[];
  evidence: EvidenceNode[];
  contains: ContainsEdge[];
  imports: ImportEdge[];
  calls: CallEdge[];
  mentions: MentionEdge[];
  sectionDescribesRepos: { sectionId: string; repoId: string }[];
  sectionDocumentsCode: SectionDocumentsCodeEdge[];
  sectionReferencesFile: SectionReferencesFileEdge[];
  repoContracts: RepoContractEdge[];
  packageUsages: PackageUsageEdge[];
  contractEntities: ContractEntityEdge[];
  operationRepos: OperationRepoEdge[];
  workflowOperations: WorkflowOperationEdge[];
  repoDependencies: RepoDependencyEdge[];
  contractSpecs: ContractSpecNode[];
  contractSpecEdges: ContractSpecEdge[];
  semanticRelations: SemanticRelationEdge[];
  crossRepo: CrossRepoExtraction;
};

function isParsedDocument(file: ParsedGraphFile): file is ParsedDocument {
  return file.language === "markdown";
}

function resolveMarkdownTarget(documentPath: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return undefined;
  const withoutFragment = target.split("#")[0]?.split("?")[0];
  if (!withoutFragment) return undefined;
  const base = withoutFragment.startsWith("/") ? withoutFragment.slice(1) : path.posix.join(path.posix.dirname(documentPath), withoutFragment);
  return path.posix.normalize(base);
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function uniqueByKey<T>(items: T[], keyFor: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [keyFor(item), item])).values()];
}

function shouldWriteFactTrace(): boolean {
  return getBrandedEnv("FACT_TRACE") === "1" || getBrandedEnv("FACT_TRACE") === "true";
}

function writeFactTrace(message: string): void {
  if (shouldWriteFactTrace()) process.stderr.write(`${message}\n`);
}

export async function buildGraphFactsBatch(input: {
  batchId: string;
  indexedAt?: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  semantic: boolean;
  aliasOverrides?: AliasOverride[];
  config?: AppConfig;
  progress?: ProgressReporter;
  frameworkProgress?: ProgressReporter;
  resolveCallsProgress?: ProgressReporter;
}): Promise<GraphFactsBatch> {
  const indexedAt = input.indexedAt ?? new Date().toISOString();
  const codeFiles = input.parsedFiles.filter((file): file is ParsedFile => !isParsedDocument(file));
  await registerBuiltinParsers(new Set(codeFiles.map((file) => file.language)));
  await ensureBuiltinGrammarsForParsedFiles(input.parsedFiles);
  registerBuiltinsForParsedFiles(input.parsedFiles);
  const files: FileNode[] = [];
  const code: CodeSymbol[] = [];
  const sections: DocSection[] = [];
  const entities: EntityNode[] = [];
  const contains: ContainsEdge[] = [];
  const mentions: MentionEdge[] = [];
  const sectionDescribesRepos: { sectionId: string; repoId: string }[] = [];
  const sectionDocumentsCode: SectionDocumentsCodeEdge[] = [];
  const sectionReferencesFile: SectionReferencesFileEdge[] = [];

  const baseFactsStarted = Date.now();
  writeFactTrace(`Facts base start: files=${input.parsedFiles.length} codeFiles=${codeFiles.length}`);
  for (const file of input.parsedFiles) {
    files.push({ id: file.fileId, repoId: file.repoId, path: file.path, language: file.language, hash: file.hash, loc: file.loc, batchId: input.batchId, indexedAt, active: true });
    contains.push({ fromId: file.repoId, toId: file.fileId });
    if (isParsedDocument(file)) {
      for (const section of file.sections) {
        sections.push({ ...section, batchId: input.batchId, indexedAt, active: true });
        contains.push({ fromId: file.fileId, toId: section.id });
        sectionDescribesRepos.push({ sectionId: section.id, repoId: section.repoId });
        if (input.semantic) {
          for (const entity of extractHeuristicEntitiesFromSection(section)) {
            entities.push(entity);
            mentions.push({ fromId: section.id, entityId: entity.id, sourceKind: "section", confidence: confidenceFor("heuristic-entity-mention") });
          }
        }
      }
      continue;
    }
    for (const symbol of file.symbols) {
      code.push({ ...symbol, batchId: input.batchId, indexedAt, active: true });
      contains.push({ fromId: file.fileId, toId: symbol.id });
      if (input.semantic) {
        for (const entity of extractHeuristicEntities(symbol)) {
          entities.push(entity);
          mentions.push({ fromId: symbol.id, entityId: entity.id, sourceKind: "code", confidence: confidenceFor("heuristic-entity-mention") });
        }
      }
    }
  }
  writeFactTrace(`Facts base complete: files=${files.length} code=${code.length} sections=${sections.length} entities=${entities.length} duration=${Date.now() - baseFactsStarted}ms`);

  const importsStarted = Date.now();
  writeFactTrace(`Facts resolve imports start: codeFiles=${codeFiles.length}`);
  const imports = resolveImports(codeFiles).map((edge) => ({ ...edge, batchId: input.batchId, active: true }));
  writeFactTrace(`Facts resolve imports complete: imports=${imports.length} duration=${Date.now() - importsStarted}ms`);

  const callsStarted = Date.now();
  writeFactTrace(`Facts resolve calls start: codeFiles=${codeFiles.length}`);
  const calls = resolveCalls(codeFiles, input.resolveCallsProgress).map((edge) => ({ ...edge, batchId: input.batchId, active: true }));
  writeFactTrace(`Facts resolve calls complete: calls=${calls.length} duration=${Date.now() - callsStarted}ms`);

  const repoIds = new Set(input.parsedFiles.map((file) => file.repoId));
  writeFactTrace(`Facts cross-repo extraction start: repos=${input.repos.filter((repo) => repoIds.has(repo.id)).length} files=${input.parsedFiles.length}`);
  const crossRepo = await extractCrossRepoContracts(input.repos.filter((repo) => repoIds.has(repo.id)), input.parsedFiles, {
    aliasOverrides: input.aliasOverrides ?? [],
    config: input.config,
    progress: input.progress,
    frameworkProgress: input.frameworkProgress
  });

  for (const edge of crossRepo.contractEntities) {
    const name = edge.entityId.replace(/^entity:/, "");
    entities.push({ id: edge.entityId, name, kind: "domain", description: "Domain entity inferred from cross-repo contracts" });
  }
  entities.push(...crossRepo.entities);

  const fileIdsByRepoPath = new Map(input.parsedFiles.map((file) => [`${file.repoId}:${file.path}`, file.fileId]));
  const codeByRepo = new Map<string, { id: string; name: string; qualifiedName: string }[]>();
  for (const symbol of code) {
    const rows = codeByRepo.get(symbol.repoId) ?? [];
    rows.push({ id: symbol.id, name: symbol.name, qualifiedName: symbol.qualifiedName });
    codeByRepo.set(symbol.repoId, rows);
  }
  for (const document of input.parsedFiles.filter(isParsedDocument)) {
    const codeRows = codeByRepo.get(document.repoId) ?? [];
    for (const section of document.sections) {
      for (const link of section.links) {
        const targetPath = resolveMarkdownTarget(document.path, link.target);
        const targetFileId = targetPath ? fileIdsByRepoPath.get(`${document.repoId}:${targetPath}`) : undefined;
        if (targetFileId) sectionReferencesFile.push({ sectionId: section.id, fileId: targetFileId, raw: link.target });
      }
      const text = section.text.toLowerCase();
      for (const codeRow of codeRows) {
        const names = [codeRow.name, codeRow.qualifiedName].filter(Boolean).map((name) => name.toLowerCase());
        if (names.some((name) => name.length > 2 && text.includes(name))) {
          sectionDocumentsCode.push({ sectionId: section.id, codeId: codeRow.id, confidence: confidenceFor("heuristic-section-documents-code") });
        }
      }
    }
  }

  return {
    batchId: input.batchId,
    indexedAt,
    repos: input.repos,
    parsedFiles: input.parsedFiles,
    files: uniqueById(files),
    code: uniqueById(code),
    sections: uniqueById(sections),
    entities: uniqueById(entities),
    operations: uniqueById(crossRepo.operations),
    workflows: uniqueById(crossRepo.workflows),
    contracts: uniqueById(crossRepo.contracts),
    evidence: uniqueById(crossRepo.evidence.map((item) => ({ ...item, batchId: input.batchId, indexedAt, active: true }))),
    contains: uniqueByKey(contains, (edge) => `${edge.fromId}:${edge.toId}`),
    imports: uniqueByKey(imports, (edge) => `${edge.fromFileId}:${edge.toFileId}:${edge.module}:${edge.raw}`),
    calls: uniqueByKey(calls, (edge) => `${edge.fromCodeId}:${edge.toCodeId}:${edge.raw}`),
    mentions: uniqueByKey(mentions, (edge) => `${edge.sourceKind}:${edge.fromId}:${edge.entityId}`),
    sectionDescribesRepos: uniqueByKey(sectionDescribesRepos, (edge) => `${edge.sectionId}:${edge.repoId}`),
    sectionDocumentsCode: uniqueByKey(sectionDocumentsCode, (edge) => `${edge.sectionId}:${edge.codeId}`),
    sectionReferencesFile: uniqueByKey(sectionReferencesFile, (edge) => `${edge.sectionId}:${edge.fileId}:${edge.raw}`),
    repoContracts: uniqueByKey(crossRepo.repoContracts.map((edge) => ({ ...edge, batchId: input.batchId, active: true })), (edge) => `${edge.repoId}:${edge.contractId}:${edge.role}:${edge.evidenceId}`),
    packageUsages: uniqueByKey(crossRepo.packageUsages.map((edge) => ({ ...edge, batchId: input.batchId, active: true })), (edge) => `${edge.repoId}:${edge.packageContractId}:${edge.evidenceId}`),
    contractEntities: uniqueByKey(crossRepo.contractEntities.map((edge) => ({ ...edge, batchId: input.batchId, active: true })), (edge) => `${edge.contractId}:${edge.entityId}:${edge.evidenceId}`),
    operationRepos: uniqueByKey(crossRepo.operationRepos.map((edge) => ({ ...edge, batchId: input.batchId, active: true })), (edge) => `${edge.repoId}:${edge.operationId}:${edge.role}:${edge.evidenceId}`),
    workflowOperations: uniqueByKey(crossRepo.workflowOperations.map((edge) => ({ ...edge, batchId: input.batchId, active: true })), (edge) => `${edge.workflowId}:${edge.operationId}:${edge.step}:${edge.evidenceId}`),
    repoDependencies: uniqueByKey(crossRepo.repoDependencies.map((edge) => ({ ...edge, batchId: input.batchId, active: true })), (edge) => `${edge.fromRepoId}:${edge.toRepoId}:${edge.dependencyType}:${edge.evidenceId}`),
    contractSpecs: uniqueById(crossRepo.contractSpecs.map((spec) => ({ ...spec, batchId: input.batchId, indexedAt, active: true }))),
    contractSpecEdges: uniqueByKey(crossRepo.contractSpecEdges.map((edge) => ({ ...edge, batchId: input.batchId, active: true })), (edge) => `${edge.contractId}:${edge.specId}:${edge.evidenceId}`),
    semanticRelations: uniqueByKey(crossRepo.semanticRelations.map((edge) => ({ ...edge, batchId: input.batchId, active: true })), (edge) => `${edge.fromSpecId}:${edge.toSpecId}:${edge.kind}:${edge.evidenceId}`),
    crossRepo
  };
}
