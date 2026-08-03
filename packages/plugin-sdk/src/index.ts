export const PLUGIN_API_VERSION = "2.0.0";

export type PluginCapability =
  | "language"
  | "fact-extractor"
  | "framework-detector"
  | "resolver";

export type ConfidenceInput = "exact" | "probable" | "heuristic" | number;

export type PluginManifest = {
  name: string;
  version: string;
  pluginApiVersion: string;
  capabilities: PluginCapability[];
  entry?: string;
  languages?: PluginManifestLanguage[];
};

export type PluginLanguageDetect = {
  extensions?: string[];
  markers?: string[];
  globs?: string[];
};

export type PluginManifestLanguage = {
  id: string;
  extensions: string[];
  requiresLanguages?: string[];
  detect?: PluginLanguageDetect;
};

export type PluginEvidenceInput = {
  filePath: string;
  line: number;
  raw: string;
  rule: string;
  confidence: ConfidenceInput;
};

export type PluginTreeSitterQueryMap = {
  symbols?: string;
  imports?: string;
  calls?: string;
  annotations?: string;
  decorators?: string;
  literals?: string;
  packageName?: string;
};

export type PluginExtractedAnnotation = {
  ownerSymbolId?: string;
  ownerKind: "class" | "method" | "field" | "file";
  name: string;
  arguments?: Array<{ name?: string; value: string; raw: string }>;
  raw: string;
  line: number;
};

export type PluginExtractedLiteral = {
  ownerSymbolId?: string;
  kind: "string" | "template" | "number" | "object";
  value: string;
  raw: string;
  line: number;
};

export type PluginAstFactInput = {
  repoId: string;
  filePath: string;
  language: string;
  source: string;
};

export type PluginAstFacts = {
  packageName?: string;
  annotations?: PluginExtractedAnnotation[];
  literals?: PluginExtractedLiteral[];
};

export type PluginAstFactExtractor = (input: PluginAstFactInput) => Promise<PluginAstFacts> | PluginAstFacts;

export type PluginTypeExpression =
  | { kind: "reference"; name: string }
  | { kind: "application"; target: PluginTypeExpression; arguments: PluginTypeExpression[] }
  | { kind: "array"; element: PluginTypeExpression }
  | { kind: "map"; key: PluginTypeExpression; value: PluginTypeExpression }
  | { kind: "union"; members: PluginTypeExpression[] }
  | { kind: "intersection"; members: PluginTypeExpression[] }
  | { kind: "variable"; name: string }
  | { kind: "wildcard"; bound?: "extends" | "super"; type?: PluginTypeExpression }
  | { kind: "nullable"; inner: PluginTypeExpression }
  | { kind: "literal"; value: string }
  | { kind: "opaque"; languageId: string; canonicalText: string };

export type PluginCanonicalTypeExpression =
  | { kind: "type-instance"; declarationId: string; arguments: PluginCanonicalTypeExpression[] }
  | { kind: "scalar"; name: string }
  | { kind: "array"; element: PluginCanonicalTypeExpression }
  | { kind: "map"; key: PluginCanonicalTypeExpression; value: PluginCanonicalTypeExpression }
  | { kind: "union"; members: PluginCanonicalTypeExpression[] }
  | { kind: "intersection"; members: PluginCanonicalTypeExpression[] }
  | { kind: "wildcard"; bound?: "extends" | "super"; type?: PluginCanonicalTypeExpression }
  | { kind: "nullable"; inner: PluginCanonicalTypeExpression }
  | { kind: "literal"; value: string };

export type PluginSchemaFieldType =
  | { kind: "resolved"; expression: PluginCanonicalTypeExpression }
  | { kind: "external-symbol"; symbol: { languageId: string; canonicalName: string }; normalizedExpression: PluginTypeExpression; diagnosticId: string }
  | { kind: "unresolved" | "ambiguous" | "unsupported"; normalizedExpression: PluginTypeExpression; diagnosticId: string };

export type PluginSchemaField = {
  sourceName: string;
  serializedName: string;
  type: PluginSchemaFieldType;
  optional: boolean;
  nullable: boolean;
  sourceLocation: { fileId: string; line?: number; column?: number };
};

export type PluginHttpEndpointFact = {
  kind: "httpEndpoint";
  repoId: string;
  filePath: string;
  method?: string;
  rawPath?: string;
  path: string;
  role: "producer" | "consumer";
  framework?: string;
  sourceSymbolId?: string;
  requestBodyType?: string;
  responseBodyType?: string;
  declaredResponseType?: string;
  evidence: PluginEvidenceInput;
};

export type PluginSchemaFact = {
  kind: "schema";
  repoId: string;
  filePath: string;
  declaration: {
    languageId: string;
    repoId: string;
    resolutionScopeId: string;
    canonicalName: string;
  };
  displayName: string;
  shape: { kind: "object"; fields: PluginSchemaField[]; baseTypes?: PluginTypeExpression[] } | { kind: "enum"; values: string[] };
  sourceSymbolId?: string;
  evidence: PluginEvidenceInput;
};

export type PluginEventFact = {
  kind: "event";
  repoId: string;
  filePath: string;
  topic: string;
  role: "producer" | "consumer";
  broker?: "kafka" | "rabbitmq" | "redis-stream" | "nats" | "unknown";
  framework?: string;
  payloadType?: string;
  sourceSymbolId?: string;
  evidence: PluginEvidenceInput;
};

export type PluginGrpcMethodFact = {
  kind: "grpcMethod";
  repoId: string;
  filePath: string;
  service: string;
  method: string;
  fullName: string;
  role: "producer" | "consumer";
  package?: string;
  requestType?: string;
  responseType?: string;
  streaming?: "unary" | "client-stream" | "server-stream" | "bidi-stream";
  framework?: string;
  sourceSymbolId?: string;
  evidence: PluginEvidenceInput;
};

export type PluginPackageUsageFact = {
  kind: "packageUsage";
  repoId: string;
  filePath: string;
  packageName: string;
  role?: "owner" | "consumer";
  evidence: PluginEvidenceInput;
};

export type PluginFrameworkFact = {
  kind: "framework";
  repoId: string;
  name: string;
  language: string;
  evidence: PluginEvidenceInput[];
};

export type PluginSemanticRelationFact = {
  kind: "semanticRelation";
  repoId: string;
  fromSpecKey: string;
  toSpecKey: string;
  relation:
    | "IMPLEMENTS"
    | "CALLS_HTTP"
    | "CALLS_DUBBO"
    | "CALLS_GRPC"
    | "CALLS_GRAPHQL"
    | "INTERNAL_CALL"
    | "PUBLISHES_EVENT"
    | "SUBSCRIBES_EVENT"
    | "USES_SCHEMA"
    | "REQUEST_SCHEMA"
    | "RESPONSE_SCHEMA"
    | "EVENT_PAYLOAD"
    | "COMPATIBLE_WITH"
    | "BREAKS"
    | "IMPACTS";
  reason: string;
  evidence: PluginEvidenceInput;
};

export type PluginContractFact =
  | PluginHttpEndpointFact
  | PluginSchemaFact
  | PluginEventFact
  | PluginGrpcMethodFact
  | PluginPackageUsageFact
  | PluginFrameworkFact
  | PluginSemanticRelationFact;

export type PluginRepoView = {
  id: string;
  name: string;
  path: string;
  language?: string;
};

export type PluginSymbolView = {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  signature: string;
};

export type PluginImportView = {
  filePath: string;
  module: string;
  raw: string;
  line: number;
  importKind?: "module" | "namespace" | "alias" | "static";
  alias?: string;
};

export type PluginCallView = {
  filePath: string;
  calleeName: string;
  receiver?: string;
  raw: string;
  line: number;
};

export type PluginParsedSymbol = {
  kind: "function" | "method" | "class" | "struct" | "interface" | "type" | "enum" | "variable";
  name: string;
  qualifiedName?: string;
  startLine: number;
  endLine: number;
  signature?: string;
  source?: string;
};

export type PluginParsedImport = {
  module: string;
  raw: string;
  line: number;
  importKind?: "module" | "namespace" | "alias" | "static";
  alias?: string;
};

export type PluginParsedCall = {
  callerSymbolName?: string;
  calleeName: string;
  receiver?: string;
  argsCount?: number;
  raw: string;
  line: number;
};

export type PluginParseInput = {
  repoId: string;
  absolutePath: string;
  relativePath: string;
  language: string;
  source: string;
};

export type PluginParseResult = {
  symbols?: PluginParsedSymbol[];
  imports?: PluginParsedImport[];
  calls?: PluginParsedCall[];
  facts?: PluginAstFacts;
};

export type PluginFileView = {
  repoId: string;
  fileId: string;
  path: string;
  language: string;
  source?: string;
  symbols: readonly PluginSymbolView[];
  imports: readonly PluginImportView[];
  calls: readonly PluginCallView[];
};

export type PluginFileCollection = readonly PluginFileView[] & {
  all(): readonly PluginFileView[];
  byLanguage(language: string): readonly PluginFileView[];
  byRepo(repoId: string): readonly PluginFileView[];
  get(repoId: string, path: string): PluginFileView | undefined;
};

export type PluginEmitApi = {
  fact(fact: PluginContractFact): void;
  httpEndpoint(fact: Omit<PluginHttpEndpointFact, "kind">): void;
  schema(fact: Omit<PluginSchemaFact, "kind">): void;
  event(fact: Omit<PluginEventFact, "kind">): void;
  grpcMethod(fact: Omit<PluginGrpcMethodFact, "kind">): void;
  packageUsage(fact: Omit<PluginPackageUsageFact, "kind">): void;
  framework(fact: Omit<PluginFrameworkFact, "kind">): void;
  semanticRelation(fact: Omit<PluginSemanticRelationFact, "kind">): void;
};

export type PluginFactView = {
  httpEndpoints(): readonly PluginHttpEndpointFact[];
  schemas(): readonly PluginSchemaFact[];
  events(): readonly PluginEventFact[];
  grpcMethods(): readonly PluginGrpcMethodFact[];
  packageUsages(): readonly PluginPackageUsageFact[];
  frameworks(): readonly PluginFrameworkFact[];
  all(): readonly PluginContractFact[];
};

export type PluginContext = {
  repos: readonly PluginRepoView[];
  files: PluginFileCollection;
  symbols: readonly PluginSymbolView[];
  imports: readonly PluginImportView[];
  calls: readonly PluginCallView[];
  emit: PluginEmitApi;
};

export type PluginPostExtractContext = Omit<PluginContext, "emit"> & {
  facts: PluginFactView;
  emit: PluginEmitApi;
};

export type LanguagePlugin = {
  id: string;
  extensions: string[];
  parse?: (input: PluginParseInput) => Promise<PluginParseResult> | PluginParseResult;
  treeSitter?: {
    queries?: PluginTreeSitterQueryMap;
  };
  facts?: {
    queries?: PluginTreeSitterQueryMap;
    extract?: PluginAstFactExtractor;
  };
};

export type FactExtractorPlugin = {
  name: string;
  languages?: string[];
  frameworks?: string[];
  extract(context: PluginContext): Promise<void> | void;
  postExtract?(context: PluginPostExtractContext): Promise<void> | void;
};

export type FrameworkDetectorPlugin = {
  name: string;
  detect(context: PluginContext): Promise<void> | void;
};

export type PluginResolvedReference = {
  fromFilePath: string;
  fromSymbolName?: string;
  toFilePath?: string;
  toSymbolName?: string;
  confidence: ConfidenceInput;
  reason: string;
};

export type ResolverPlugin = {
  name: string;
  languages: string[];
  resolve(context: PluginContext): Promise<PluginResolvedReference[]> | PluginResolvedReference[];
};

export type PluginDefinition = {
  manifest: PluginManifest;
  languages?: LanguagePlugin[];
  factExtractors?: FactExtractorPlugin[];
  frameworkDetectors?: FrameworkDetectorPlugin[];
  resolvers?: ResolverPlugin[];
};

export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin;
}

export function defineLanguage(language: LanguagePlugin): LanguagePlugin {
  return language;
}

export function defineFactExtractor(extractor: FactExtractorPlugin): FactExtractorPlugin {
  return extractor;
}

export function defineFrameworkDetector(detector: FrameworkDetectorPlugin): FrameworkDetectorPlugin {
  return detector;
}

export function defineResolver(resolver: ResolverPlugin): ResolverPlugin {
  return resolver;
}
