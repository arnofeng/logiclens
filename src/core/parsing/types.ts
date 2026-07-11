import type Parser from "tree-sitter";
import type { ParsedSourceFacts } from "./facts.js";

export type CodeKind = "function" | "method" | "class" | "struct" | "interface" | "type" | "enum" | "variable";
export type SourceLanguage = "typescript" | "tsx" | "javascript" | "jsx" | "java" | "python" | "go";
export type DocumentLanguage = "markdown";
export type FileLanguage = SourceLanguage | DocumentLanguage;

export interface LanguageExtractorConfig {
  language: string;
  extensions: string[];
  grammar: any;
  queries: {
    symbols: string;
    imports: string;
    calls: string;
  };
  helpers: {
    getQualifiedPrefix(node: Parser.SyntaxNode): string;
    getSignature?(node: Parser.SyntaxNode): string;
  };
}

export type RepoNode = {
  id: string;
  name: string;
  path: string;
  remoteUrl: string;
  branch: string;
  commitSha: string;
  language: string;
  indexedAt: string;
  summary?: string;
};

export type FileNode = {
  id: string;
  repoId: string;
  path: string;
  language: FileLanguage | string;
  hash: string;
  loc: number;
  batchId?: string;
  indexedAt?: string;
  active?: boolean;
};

export type CodeSymbol = {
  id: string;
  repoId: string;
  fileId: string;
  kind: CodeKind;
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  signature: string;
  source: string;
  hash: string;
  summary?: string;
  batchId?: string;
  indexedAt?: string;
  active?: boolean;
};

export type ImportRef = {
  fileId: string;
  module: string;
  raw: string;
  line: number;
  resolvedFileId?: string;
  bindings?: ImportBinding[];
};

export type ImportBinding = {
  localName: string;
  importedName?: string;
  kind: "default" | "named" | "namespace" | "side-effect";
};

export type CallRef = {
  callerSymbolId?: string;
  calleeName: string;
  receiver?: string;
  argsCount?: number;
  raw: string;
  fileId: string;
  line: number;
};

export type ParsedFile = {
  repoId: string;
  fileId: string;
  path: string;
  absolutePath?: string;
  language: SourceLanguage | string;
  parseLanguage?: SourceLanguage;
  hash: string;
  loc: number;
  source?: string;
  imports: ImportRef[];
  symbols: CodeSymbol[];
  calls: CallRef[];
  facts?: ParsedSourceFacts;
};

export type DocLink = {
  text: string;
  target: string;
  line: number;
  resolvedFileId?: string;
};

export type MarkdownCodeBlock = {
  language: string;
  startLine: number;
  endLine: number;
  text: string;
};

export type DocSection = {
  id: string;
  repoId: string;
  fileId: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  text: string;
  summary?: string;
  hash: string;
  links: DocLink[];
  codeBlocks: MarkdownCodeBlock[];
  batchId?: string;
  indexedAt?: string;
  active?: boolean;
};

export type ParsedDocument = {
  repoId: string;
  fileId: string;
  path: string;
  language: DocumentLanguage;
  hash: string;
  loc: number;
  sections: DocSection[];
  links: DocLink[];
  codeBlocks: MarkdownCodeBlock[];
};

export type ParsedGraphFile = ParsedFile | ParsedDocument;

export type EntityNode = {
  id: string;
  name: string;
  kind: string;
  description: string;
};

export type OperationNode = {
  id: string;
  verb: string;
  entityName: string;
  description: string;
};

export type WorkflowNode = {
  id: string;
  name: string;
  description: string;
};

export type ContractKind = "package" | "api" | "event" | "dto" | "schema" | "enum" | "config";

export type ContractRole = "owner" | "producer" | "consumer" | "shared";

export type ContractNode = {
  id: string;
  kind: ContractKind;
  key: string;
  name: string;
  description: string;
};

export type EvidenceNode = {
  id: string;
  repoId: string;
  fileId: string;
  filePath: string;
  line: number;
  raw: string;
  rule: string;
  confidence: number;
  batchId?: string;
  indexedAt?: string;
  active?: boolean;
};

export type RepoContractEdge = {
  repoId: string;
  contractId: string;
  role: ContractRole;
  evidenceId: string;
  confidence: number;
  batchId?: string;
  active?: boolean;
};

export type RepoDependencyEdge = {
  fromRepoId: string;
  toRepoId: string;
  dependencyType: "package" | "import" | "api" | "event" | "shared-contract";
  sourceContractId: string;
  targetContractId: string;
  evidenceId: string;
  raw: string;
  confidence: number;
  batchId?: string;
  active?: boolean;
};

export type PackageUsageEdge = {
  repoId: string;
  packageContractId: string;
  packageName: string;
  evidenceId: string;
  raw: string;
  confidence: number;
  batchId?: string;
  active?: boolean;
};

export type ContractEntityEdge = {
  contractId: string;
  entityId: string;
  evidenceId: string;
  confidence: number;
  batchId?: string;
  active?: boolean;
};

export type OperationRepoEdge = {
  operationId: string;
  repoId: string;
  role: string;
  evidenceId: string;
  confidence: number;
  batchId?: string;
  active?: boolean;
};

export type WorkflowOperationEdge = {
  workflowId: string;
  operationId: string;
  step: number;
  evidenceId: string;
  confidence: number;
  batchId?: string;
  active?: boolean;
};

export type ImportEdge = {
  fromFileId: string;
  toFileId: string;
  module: string;
  raw: string;
  batchId?: string;
  active?: boolean;
};

export type CallEdge = {
  fromCodeId: string;
  toCodeId: string;
  confidence: number;
  resolution: "exact" | "probable" | "heuristic";
  raw: string;
  batchId?: string;
  active?: boolean;
};

export const CONTRACT_SPEC_KINDS = ["http-endpoint", "event", "schema", "grpc-method", "dubbo-method", "graphql-operation"] as const;

export type ContractSpecKind = (typeof CONTRACT_SPEC_KINDS)[number];

export function isKnownSpecKind(value: string): value is ContractSpecKind {
  return (CONTRACT_SPEC_KINDS as readonly string[]).includes(value);
}

export type ContractSpecNode = {
  id: string;
  contractId: string;
  specKind: ContractSpecKind;
  repoId: string;
  fileId: string;
  evidenceId: string;
  sourceSymbolId?: string;
  canonicalKey: string;
  httpMethod?: string;
  pathTemplate?: string;
  eventTopic?: string;
  framework?: string;
  version?: string;
  specJson: string;
  confidence: number;
  batchId?: string;
  indexedAt?: string;
  active?: boolean;
};

export type OpaqueContractSpecNode = Omit<ContractSpecNode, "specKind"> & {
  specKind: string;
  opaque: true;
  warning: string;
};

export type ReadableContractSpecNode = ContractSpecNode | OpaqueContractSpecNode;

export function isKnownContractSpecNode(node: ReadableContractSpecNode): node is ContractSpecNode {
  return isKnownSpecKind(node.specKind);
}

export type ContractSpecEdge = {
  contractId: string;
  specId: string;
  evidenceId: string;
  confidence: number;
  batchId?: string;
  active?: boolean;
};

export type SemanticRelationKind =
  | "IMPLEMENTS"
  | "CALLS_ENDPOINT"
  | "PUBLISHES_EVENT"
  | "SUBSCRIBES_EVENT"
  | "USES_SCHEMA"
  | "REQUEST_SCHEMA"
  | "RESPONSE_SCHEMA"
  | "EVENT_PAYLOAD"
  | "COMPATIBLE_WITH"
  | "BREAKS"
  | "IMPACTS";

export type SemanticRelationEdge = {
  fromSpecId: string;
  toSpecId: string;
  kind: SemanticRelationKind;
  evidenceId: string;
  reason: string;
  confidence: number;
  batchId?: string;
  active?: boolean;
};
