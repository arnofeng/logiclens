import path from "node:path";
import type { GraphFactsBatch, MentionEdge } from "../graph-model/facts.js";
import type {
  CodeSymbol,
  ContractNode,
  ContractSpecEdge,
  ContractSpecNode,
  DocSection,
  EntityNode,
  EvidenceNode,
  FileNode,
  OperationNode,
  RepoNode,
  WorkflowNode
} from "../parsing/types.js";
import { hashText } from "../../shared/hash.js";
import { createRenderRef } from "./renderRef.js";
import { tokenizeLexicalText } from "./tokenizer.js";
import {
  LEXICAL_DOCUMENT_KINDS,
  LEXICAL_PROJECTION_SCHEMA_VERSION,
  TOKENIZER_VERSION,
  type LexicalDocument,
  type LexicalDocumentKind
} from "./types.js";

type FactLifecycle = {
  batchId?: string;
  active?: boolean;
};

type FileLocation = {
  file: FileNode;
  path: string;
};

export const MAX_LEXICAL_SEARCHABLE_TEXT_LENGTH = 8_192;
export const MAX_SECTION_TEXT_LENGTH = 4_096;
export const MAX_EVIDENCE_RAW_LENGTH = 1_024;
const MAX_SOURCE_CONTEXT_LENGTH = 1_024;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeWhitespace(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function truncateText(value: string, maximum: number): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maximum) return normalized;
  const end = /[\uD800-\uDBFF]/u.test(normalized[maximum - 1] ?? "")
    && /[\uDC00-\uDFFF]/u.test(normalized[maximum] ?? "")
    ? maximum - 1
    : maximum;
  return normalized.slice(0, end);
}

function meaningfulText(values: Array<string | number | undefined>, maximum = MAX_LEXICAL_SEARCHABLE_TEXT_LENGTH): string {
  return truncateText(values
    .map((value) => value === undefined ? "" : String(value))
    .map(normalizeWhitespace)
    .filter(Boolean)
    .join(" "), maximum);
}

function projectionFingerprint(kind: LexicalDocumentKind, fields: unknown[]): string {
  return hashText(JSON.stringify([LEXICAL_PROJECTION_SCHEMA_VERSION, TOKENIZER_VERSION, kind, ...fields]));
}

export function lexicalDocumentId(
  workspaceId: string,
  repoId: string,
  kind: LexicalDocumentKind,
  canonicalId: string,
  sourceDiscriminator?: string
): string {
  const identity = sourceDiscriminator === undefined
    ? [workspaceId, repoId, kind, canonicalId]
    : [workspaceId, repoId, kind, canonicalId, sourceDiscriminator];
  return `lexical:${kind}:${hashText(JSON.stringify(identity))}`;
}

export function normalizeProjectionPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error("Projection path must be a non-empty repository-relative path.");
  if (/^[a-zA-Z]:[\\/]/u.test(input) || /^[\\/]{1,2}/u.test(input) || /^[a-z][a-z0-9+.-]*:/iu.test(input)) {
    throw new Error("Projection path must be repository-relative.");
  }
  const segments = input.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) throw new Error("Projection path must not escape its repository.");
  const normalized = segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
  if (normalized.length === 0) throw new Error("Projection path must identify a file.");
  return normalized;
}

function tryNormalizeProjectionPath(input: string): string | undefined {
  try {
    return normalizeProjectionPath(input);
  } catch {
    return undefined;
  }
}

function factBatchId(fact: FactLifecycle | undefined, batch: GraphFactsBatch): string {
  return fact?.batchId ?? batch.batchId;
}

function firstBatchId(facts: GraphFactsBatch, ...sources: Array<FactLifecycle | undefined>): string {
  return sources.find((source) => source?.batchId !== undefined)?.batchId ?? facts.batchId;
}

function factActive(fact: FactLifecycle | undefined): boolean {
  return fact?.active ?? true;
}

function allActive(...facts: Array<FactLifecycle | undefined>): boolean {
  return facts.every(factActive);
}

function validLineRange(startLine: number, endLine?: number): boolean {
  return Number.isSafeInteger(startLine) && startLine >= 1
    && (endLine === undefined || (Number.isSafeInteger(endLine) && endLine >= startLine));
}

function fileLocations(facts: GraphFactsBatch): Map<string, FileLocation> {
  const candidates = deterministicUnique((facts.files ?? []).flatMap((file) => {
    const normalizedPath = tryNormalizeProjectionPath(file.path);
    return normalizedPath ? [{ id: file.id, file, path: normalizedPath }] : [];
  }), "file location");
  const locations = new Map<string, FileLocation>();
  for (const candidate of candidates) locations.set(candidate.id, { file: candidate.file, path: candidate.path });
  return locations;
}

function evidenceLocation(evidence: EvidenceNode, files: Map<string, FileLocation>): FileLocation | undefined {
  const location = files.get(evidence.fileId);
  const evidencePath = tryNormalizeProjectionPath(evidence.filePath);
  if (!location || !evidencePath || evidence.repoId !== location.file.repoId || evidencePath !== location.path || !validLineRange(evidence.line)) return undefined;
  return location;
}

function sorted(documents: LexicalDocument[]): LexicalDocument[] {
  return documents.sort((left, right) => compareText(left.id, right.id));
}

function canonicalFactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFactValue);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "indexedAt")
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, nested]) => [key, canonicalFactValue(nested)]);
  }
  return value;
}

function stableFactFingerprint(value: Record<string, unknown>): string {
  return JSON.stringify(canonicalFactValue(value));
}

function deterministicUnique<T extends { id: string }>(items: T[], label: string): T[] {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const group = grouped.get(item.id) ?? [];
    group.push(item);
    grouped.set(item.id, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, group]) => {
      const ordered = [...group].sort((left, right) => compareText(stableFactFingerprint(left), stableFactFingerprint(right)));
      if (stableFactFingerprint(ordered[0]!) !== stableFactFingerprint(ordered[ordered.length - 1]!)) {
        throw new Error(`Conflicting ${label} facts for id: ${id}.`);
      }
      return ordered[0]!;
    });
}

function deduplicateDocuments(documents: LexicalDocument[]): LexicalDocument[] {
  const grouped = new Map<string, LexicalDocument[]>();
  for (const document of documents) {
    const group = grouped.get(document.id) ?? [];
    group.push(document);
    grouped.set(document.id, group);
  }
  return sorted([...grouped.entries()].map(([id, group]) => {
    const serialized = [...new Set(group.map((document) => JSON.stringify(document)))];
    if (serialized.length !== 1) throw new Error(`Lexical document id collision: ${id}.`);
    return group[0]!;
  }));
}

function projectRepo(repo: RepoNode, facts: GraphFactsBatch, workspaceId: string): LexicalDocument {
  const lifecycle = repo as RepoNode & FactLifecycle;
  const searchableText = meaningfulText([repo.name, repo.summary, repo.language, repo.remoteUrl, repo.branch]);
  const renderRef = createRenderRef({ workspaceId, repoId: repo.id, kind: "repo", canonicalId: repo.id });
  return {
    id: lexicalDocumentId(workspaceId, repo.id, "repo", repo.id),
    canonicalId: repo.id,
    workspaceId,
    repoId: repo.id,
    kind: "repo",
    title: repo.name,
    searchableText,
    tokens: tokenizeLexicalText(searchableText),
    active: factActive(lifecycle),
    sourceHash: projectionFingerprint("repo", [repo.id, repo.name, repo.summary ?? "", repo.language, repo.remoteUrl, repo.branch, renderRef]),
    batchId: factBatchId(lifecycle, facts),
    renderRef
  };
}

function projectFile(file: FileNode, facts: GraphFactsBatch, workspaceId: string): LexicalDocument {
  const normalizedPath = normalizeProjectionPath(file.path);
  const basename = path.posix.basename(normalizedPath);
  const extension = path.posix.extname(normalizedPath).slice(1);
  const searchableText = meaningfulText([normalizedPath, basename, extension, file.language, file.repoId]);
  const renderRef = createRenderRef({ workspaceId, repoId: file.repoId, kind: "file", canonicalId: file.id, fileId: file.id, path: normalizedPath });
  return {
    id: lexicalDocumentId(workspaceId, file.repoId, "file", file.id),
    canonicalId: file.id,
    workspaceId,
    repoId: file.repoId,
    kind: "file",
    title: normalizedPath,
    path: normalizedPath,
    searchableText,
    tokens: tokenizeLexicalText(searchableText),
    active: factActive(file),
    sourceHash: projectionFingerprint("file", [file.id, file.repoId, normalizedPath, file.language, file.hash, renderRef]),
    batchId: factBatchId(file, facts),
    renderRef
  };
}

function projectCode(symbol: CodeSymbol, location: FileLocation, facts: GraphFactsBatch, workspaceId: string): LexicalDocument {
  const title = truncateText(symbol.name || symbol.qualifiedName, MAX_SOURCE_CONTEXT_LENGTH);
  const searchableText = meaningfulText([symbol.name, symbol.qualifiedName, symbol.kind, symbol.signature, symbol.summary, location.path, symbol.repoId, symbol.fileId]);
  const renderRef = createRenderRef({
    workspaceId,
    repoId: symbol.repoId,
    kind: "code",
    canonicalId: symbol.id,
    fileId: symbol.fileId,
    path: location.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine
  });
  return {
    id: lexicalDocumentId(workspaceId, symbol.repoId, "code", symbol.id),
    canonicalId: symbol.id,
    workspaceId,
    repoId: symbol.repoId,
    kind: "code",
    title,
    qualifiedName: truncateText(symbol.qualifiedName, MAX_SOURCE_CONTEXT_LENGTH),
    path: location.path,
    searchableText,
    tokens: tokenizeLexicalText(searchableText),
    active: allActive(symbol, location.file),
    sourceHash: projectionFingerprint("code", [symbol.id, symbol.repoId, symbol.fileId, symbol.kind, symbol.name, symbol.qualifiedName, symbol.signature, symbol.summary ?? "", symbol.hash, location.path, renderRef]),
    batchId: firstBatchId(facts, symbol, location.file),
    renderRef
  };
}

function projectSection(section: DocSection, location: FileLocation, facts: GraphFactsBatch, workspaceId: string): LexicalDocument {
  const controlledText = truncateText(section.text, MAX_SECTION_TEXT_LENGTH);
  const searchableText = meaningfulText([section.heading, section.summary, controlledText, location.path]);
  const renderRef = createRenderRef({
    workspaceId,
    repoId: section.repoId,
    kind: "section",
    canonicalId: section.id,
    fileId: section.fileId,
    path: location.path,
    startLine: section.startLine,
    endLine: section.endLine
  });
  return {
    id: lexicalDocumentId(workspaceId, section.repoId, "section", section.id),
    canonicalId: section.id,
    workspaceId,
    repoId: section.repoId,
    kind: "section",
    title: truncateText(section.heading, MAX_SOURCE_CONTEXT_LENGTH),
    path: location.path,
    searchableText,
    tokens: tokenizeLexicalText(searchableText),
    active: allActive(section, location.file),
    sourceHash: projectionFingerprint("section", [section.id, section.repoId, section.fileId, section.heading, section.summary ?? "", controlledText, section.hash, location.path, renderRef]),
    batchId: firstBatchId(facts, section, location.file),
    renderRef
  };
}

function evidenceById(facts: GraphFactsBatch, files: Map<string, FileLocation>): Map<string, EvidenceNode> {
  return new Map(deterministicUnique((facts.evidence ?? []).filter((evidence) => evidenceLocation(evidence, files) !== undefined), "evidence")
    .map((evidence) => [evidence.id, evidence]));
}

function contractById(facts: GraphFactsBatch): Map<string, ContractNode> {
  return new Map(deterministicUnique(facts.contracts ?? [], "contract").map((contract) => [contract.id, contract]));
}

function makeLocatedDocument(input: {
  facts: GraphFactsBatch;
  workspaceId: string;
  kind: LexicalDocumentKind;
  canonicalId: string;
  repoId: string;
  title: string;
  path: string;
  fileId: string;
  line: number;
  searchableText: string;
  sourceDiscriminator?: string;
  qualifiedName?: string;
  active: boolean;
  batchId: string;
  fingerprintFields: unknown[];
}): LexicalDocument {
  const renderRef = createRenderRef({
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    kind: input.kind,
    canonicalId: input.canonicalId,
    fileId: input.fileId,
    path: input.path,
    startLine: input.line
  });
  const searchableText = truncateText(input.searchableText, MAX_LEXICAL_SEARCHABLE_TEXT_LENGTH);
  return {
    id: lexicalDocumentId(input.workspaceId, input.repoId, input.kind, input.canonicalId, input.sourceDiscriminator),
    canonicalId: input.canonicalId,
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    kind: input.kind,
    title: truncateText(input.title, MAX_SOURCE_CONTEXT_LENGTH),
    ...(input.qualifiedName === undefined ? {} : { qualifiedName: truncateText(input.qualifiedName, MAX_SOURCE_CONTEXT_LENGTH) }),
    path: input.path,
    searchableText,
    tokens: tokenizeLexicalText(searchableText),
    active: input.active,
    sourceHash: projectionFingerprint(input.kind, [...input.fingerprintFields, renderRef]),
    batchId: input.batchId,
    renderRef
  };
}

export function projectRepoDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  return deduplicateDocuments(deterministicUnique(facts.repos ?? [], "repository").map((repo) => projectRepo(repo, facts, workspaceId)));
}

export function projectFileDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  return deduplicateDocuments(deterministicUnique(facts.files ?? [], "file").map((file) => projectFile(file, facts, workspaceId)));
}

export function projectCodeDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  const files = fileLocations(facts);
  return deduplicateDocuments((facts.code ?? []).flatMap((symbol) => {
    const location = files.get(symbol.fileId);
    if (!location || location.file.repoId !== symbol.repoId || !validLineRange(symbol.startLine, symbol.endLine)) return [];
    return [projectCode(symbol, location, facts, workspaceId)];
  }));
}

export function projectSectionDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  const files = fileLocations(facts);
  return deduplicateDocuments((facts.sections ?? []).flatMap((section) => {
    const location = files.get(section.fileId);
    if (!location || location.file.repoId !== section.repoId || !validLineRange(section.startLine, section.endLine)) return [];
    return [projectSection(section, location, facts, workspaceId)];
  }));
}

export function projectEvidenceDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  const files = fileLocations(facts);
  const evidence = evidenceById(facts, files);
  return deduplicateDocuments([...evidence.values()].flatMap((item) => {
    const location = evidenceLocation(item, files);
    if (!location) return [];
    const raw = truncateText(item.raw, MAX_EVIDENCE_RAW_LENGTH);
    const searchableText = meaningfulText([item.rule, raw, item.confidence, location.path]);
    return [makeLocatedDocument({
      facts,
      workspaceId,
      kind: "evidence",
      canonicalId: item.id,
      repoId: item.repoId,
      title: item.rule,
      path: location.path,
      fileId: item.fileId,
      line: item.line,
      searchableText,
      active: allActive(item, location.file),
      batchId: firstBatchId(facts, item, location.file),
      fingerprintFields: [item.id, item.repoId, item.fileId, location.path, item.line, item.rule, raw, item.confidence]
    })];
  }));
}

export function projectContractDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  const contracts = contractById(facts);
  const files = fileLocations(facts);
  const evidence = evidenceById(facts, files);
  const sources = new Map<string, { contract: ContractNode; repoId: string; evidence: EvidenceNode; location: FileLocation; roles: string[]; edges: FactLifecycle[] }>();
  for (const edge of facts.repoContracts ?? []) {
    const contract = contracts.get(edge.contractId);
    const proof = evidence.get(edge.evidenceId);
    const location = proof ? evidenceLocation(proof, files) : undefined;
    if (!contract || !proof || !location || edge.repoId !== proof.repoId) continue;
    const key = `${contract.id}\u0000${edge.repoId}\u0000${proof.id}`;
    const current = sources.get(key) ?? { contract, repoId: edge.repoId, evidence: proof, location, roles: [], edges: [] };
    current.roles.push(edge.role);
    current.edges.push(edge);
    sources.set(key, current);
  }
  return sorted([...sources.values()].map((source) => {
    const roles = [...new Set(source.roles)].sort();
    const raw = truncateText(source.evidence.raw, MAX_EVIDENCE_RAW_LENGTH);
    const searchableText = meaningfulText([source.contract.kind, source.contract.key, source.contract.name, source.contract.description, ...roles, source.evidence.rule, raw, source.location.path]);
    return makeLocatedDocument({
      facts,
      workspaceId,
      kind: "contract",
      canonicalId: source.contract.id,
      repoId: source.repoId,
      title: source.contract.name || source.contract.key,
      path: source.location.path,
      fileId: source.evidence.fileId,
      line: source.evidence.line,
      searchableText,
      sourceDiscriminator: source.evidence.id,
      active: allActive(source.contract as ContractNode & FactLifecycle, source.evidence, source.location.file, ...source.edges),
      batchId: firstBatchId(facts, source.evidence, ...source.edges, source.location.file),
      fingerprintFields: [source.contract.id, source.contract.kind, source.contract.key, source.contract.name, source.contract.description, source.repoId, source.evidence.id, source.evidence.rule, raw, source.evidence.confidence, roles, source.location.path]
    });
  }));
}

export function projectContractSpecDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  const files = fileLocations(facts);
  const evidence = evidenceById(facts, files);
  const edgesBySpec = new Map<string, ContractSpecEdge[]>();
  for (const edge of facts.contractSpecEdges ?? []) {
    const rows = edgesBySpec.get(edge.specId) ?? [];
    rows.push(edge);
    edgesBySpec.set(edge.specId, rows);
  }
  return deduplicateDocuments(deterministicUnique(facts.contractSpecs ?? [], "contract spec").flatMap((spec: ContractSpecNode) => {
    const proof = evidence.get(spec.evidenceId);
    const location = proof ? evidenceLocation(proof, files) : undefined;
    if (!proof || !location || spec.repoId !== proof.repoId || spec.fileId !== proof.fileId) return [];
    const edges = (edgesBySpec.get(spec.id) ?? []).filter((edge) => edge.contractId === spec.contractId && edge.evidenceId === spec.evidenceId);
    const searchableText = meaningfulText([spec.specKind, spec.canonicalKey, spec.httpMethod, spec.pathTemplate, spec.eventTopic, spec.framework, spec.version, location.path]);
    return [makeLocatedDocument({
      facts,
      workspaceId,
      kind: "contractSpec",
      canonicalId: spec.id,
      repoId: spec.repoId,
      title: spec.canonicalKey,
      path: location.path,
      fileId: spec.fileId,
      line: proof.line,
      searchableText,
      active: allActive(spec, proof, location.file, ...edges),
      batchId: firstBatchId(facts, spec, proof, ...edges, location.file),
      fingerprintFields: [spec.id, spec.contractId, spec.specKind, spec.repoId, spec.fileId, spec.evidenceId, spec.canonicalKey, spec.httpMethod ?? "", spec.pathTemplate ?? "", spec.eventTopic ?? "", spec.framework ?? "", spec.version ?? "", location.path]
    })];
  }));
}

function entityDocumentsFromMentions(facts: GraphFactsBatch, workspaceId: string, entities: Map<string, EntityNode>, files: Map<string, FileLocation>): LexicalDocument[] {
  const code = new Map(deterministicUnique(facts.code ?? [], "code symbol").map((symbol) => [symbol.id, symbol]));
  const sections = new Map(deterministicUnique(facts.sections ?? [], "section").map((section) => [section.id, section]));
  return (facts.mentions ?? []).flatMap((mention: MentionEdge) => {
    const entity = entities.get(mention.entityId);
    const source = mention.sourceKind === "code" ? code.get(mention.fromId) : sections.get(mention.fromId);
    const location = source ? files.get(source.fileId) : undefined;
    if (!entity || !source || !location || source.repoId !== location.file.repoId || !validLineRange(source.startLine, source.endLine)) return [];
    const sourceText = mention.sourceKind === "code"
      ? meaningfulText([(source as CodeSymbol).name, (source as CodeSymbol).qualifiedName, (source as CodeSymbol).signature], MAX_SOURCE_CONTEXT_LENGTH)
      : meaningfulText([(source as DocSection).heading, truncateText((source as DocSection).text, MAX_SOURCE_CONTEXT_LENGTH)], MAX_SOURCE_CONTEXT_LENGTH);
    const searchableText = meaningfulText([entity.name, entity.kind, entity.description, sourceText, location.path]);
    return [makeLocatedDocument({
      facts,
      workspaceId,
      kind: "entity",
      canonicalId: entity.id,
      repoId: source.repoId,
      title: entity.name,
      path: location.path,
      fileId: source.fileId,
      line: source.startLine,
      searchableText,
      sourceDiscriminator: `${mention.sourceKind}:${mention.fromId}`,
      active: allActive(entity as EntityNode & FactLifecycle, source, location.file),
      batchId: firstBatchId(facts, source, location.file, entity as EntityNode & FactLifecycle),
      fingerprintFields: [entity.id, entity.name, entity.kind, entity.description, mention.sourceKind, mention.fromId, mention.confidence, sourceText, location.path]
    })];
  });
}

export function projectEntityDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  const entities = new Map(deterministicUnique(facts.entities ?? [], "entity").map((entity) => [entity.id, entity]));
  const files = fileLocations(facts);
  const evidence = evidenceById(facts, files);
  const documents = entityDocumentsFromMentions(facts, workspaceId, entities, files);
  for (const edge of facts.contractEntities ?? []) {
    const entity = entities.get(edge.entityId);
    const proof = evidence.get(edge.evidenceId);
    const location = proof ? evidenceLocation(proof, files) : undefined;
    if (!entity || !proof || !location) continue;
    const raw = truncateText(proof.raw, MAX_EVIDENCE_RAW_LENGTH);
    const contract = (facts.contracts ?? []).find((candidate) => candidate.id === edge.contractId);
    const searchableText = meaningfulText([entity.name, entity.kind, entity.description, contract?.kind, contract?.key, proof.rule, raw, location.path]);
    documents.push(makeLocatedDocument({
      facts,
      workspaceId,
      kind: "entity",
      canonicalId: entity.id,
      repoId: proof.repoId,
      title: entity.name,
      path: location.path,
      fileId: proof.fileId,
      line: proof.line,
      searchableText,
      sourceDiscriminator: `evidence:${proof.id}:${edge.contractId}`,
      active: allActive(entity as EntityNode & FactLifecycle, edge, proof, location.file),
      batchId: firstBatchId(facts, proof, edge, location.file, entity as EntityNode & FactLifecycle),
      fingerprintFields: [entity.id, entity.name, entity.kind, entity.description, edge.contractId, proof.id, proof.rule, raw, edge.confidence, location.path]
    }));
  }
  return deduplicateDocuments(documents);
}

export function projectOperationDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  const operations = new Map(deterministicUnique(facts.operations ?? [], "operation").map((operation) => [operation.id, operation]));
  const files = fileLocations(facts);
  const evidence = evidenceById(facts, files);
  return deduplicateDocuments((facts.operationRepos ?? []).flatMap((edge) => {
    const operation = operations.get(edge.operationId);
    const proof = evidence.get(edge.evidenceId);
    const location = proof ? evidenceLocation(proof, files) : undefined;
    if (!operation || !proof || !location || edge.repoId !== proof.repoId) return [];
    const raw = truncateText(proof.raw, MAX_EVIDENCE_RAW_LENGTH);
    const searchableText = meaningfulText([operation.verb, operation.entityName, operation.description, edge.role, proof.rule, raw, location.path]);
    return [makeLocatedDocument({
      facts,
      workspaceId,
      kind: "operation",
      canonicalId: operation.id,
      repoId: edge.repoId,
      title: `${operation.verb} ${operation.entityName}`,
      path: location.path,
      fileId: proof.fileId,
      line: proof.line,
      searchableText,
      sourceDiscriminator: `${edge.role}:${proof.id}`,
      active: allActive(operation as OperationNode & FactLifecycle, edge, proof, location.file),
      batchId: firstBatchId(facts, proof, edge, location.file, operation as OperationNode & FactLifecycle),
      fingerprintFields: [operation.id, operation.verb, operation.entityName, operation.description, edge.repoId, edge.role, proof.id, proof.rule, raw, edge.confidence, location.path]
    })];
  }));
}

export function projectWorkflowDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  const workflows = new Map(deterministicUnique(facts.workflows ?? [], "workflow").map((workflow) => [workflow.id, workflow]));
  const operations = new Map(deterministicUnique(facts.operations ?? [], "operation").map((operation) => [operation.id, operation]));
  const files = fileLocations(facts);
  const evidence = evidenceById(facts, files);
  return deduplicateDocuments((facts.workflowOperations ?? []).flatMap((edge) => {
    const workflow = workflows.get(edge.workflowId);
    const operation = operations.get(edge.operationId);
    const proof = evidence.get(edge.evidenceId);
    const location = proof ? evidenceLocation(proof, files) : undefined;
    if (!workflow || !operation || !proof || !location) return [];
    const raw = truncateText(proof.raw, MAX_EVIDENCE_RAW_LENGTH);
    const searchableText = meaningfulText([workflow.name, workflow.description, edge.step, operation.verb, operation.entityName, operation.description, proof.rule, raw, location.path]);
    return [makeLocatedDocument({
      facts,
      workspaceId,
      kind: "workflow",
      canonicalId: workflow.id,
      repoId: proof.repoId,
      title: workflow.name,
      path: location.path,
      fileId: proof.fileId,
      line: proof.line,
      searchableText,
      sourceDiscriminator: `${edge.step}:${edge.operationId}:${proof.id}`,
      active: allActive(workflow as WorkflowNode & FactLifecycle, operation as OperationNode & FactLifecycle, edge, proof, location.file),
      batchId: firstBatchId(facts, proof, edge, location.file, workflow as WorkflowNode & FactLifecycle),
      fingerprintFields: [workflow.id, workflow.name, workflow.description, edge.step, operation.id, operation.verb, operation.entityName, operation.description, proof.id, proof.rule, raw, edge.confidence, location.path]
    })];
  }));
}

export function projectPackageDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  const files = fileLocations(facts);
  const evidence = evidenceById(facts, files);
  return deduplicateDocuments((facts.packageUsages ?? []).flatMap((usage) => {
    const proof = evidence.get(usage.evidenceId);
    const location = proof ? evidenceLocation(proof, files) : undefined;
    if (!proof || !location || usage.repoId !== proof.repoId) return [];
    const raw = truncateText(usage.raw, MAX_EVIDENCE_RAW_LENGTH);
    const searchableText = meaningfulText([usage.packageName, usage.packageContractId, raw, proof.rule, location.path]);
    return [makeLocatedDocument({
      facts,
      workspaceId,
      kind: "package",
      canonicalId: usage.packageContractId,
      repoId: usage.repoId,
      title: usage.packageName,
      path: location.path,
      fileId: proof.fileId,
      line: proof.line,
      searchableText,
      sourceDiscriminator: proof.id,
      active: allActive(usage, proof, location.file),
      batchId: firstBatchId(facts, proof, usage, location.file),
      fingerprintFields: [usage.packageContractId, usage.packageName, usage.repoId, proof.id, raw, proof.rule, usage.confidence, location.path]
    })];
  }));
}

export function projectLexicalDocuments(facts: GraphFactsBatch, workspaceId: string): LexicalDocument[] {
  const documents = [
    ...projectRepoDocuments(facts, workspaceId),
    ...projectFileDocuments(facts, workspaceId),
    ...projectCodeDocuments(facts, workspaceId),
    ...projectSectionDocuments(facts, workspaceId),
    ...projectContractDocuments(facts, workspaceId),
    ...projectContractSpecDocuments(facts, workspaceId),
    ...projectEvidenceDocuments(facts, workspaceId),
    ...projectEntityDocuments(facts, workspaceId),
    ...projectOperationDocuments(facts, workspaceId),
    ...projectWorkflowDocuments(facts, workspaceId),
    ...projectPackageDocuments(facts, workspaceId)
  ];
  const byId = new Map<string, LexicalDocument>();
  for (const document of documents) {
    const previous = byId.get(document.id);
    if (previous) throw new Error(`Lexical document id collision: ${document.id} (${previous.canonicalId}, ${document.canonicalId}).`);
    byId.set(document.id, document);
  }
  const presentKinds = new Set(documents.map((document) => document.kind));
  for (const kind of presentKinds) {
    if (!(LEXICAL_DOCUMENT_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown lexical document kind: ${kind}.`);
  }
  return sorted(documents);
}
