import type {
  FactExtractorPlugin,
  FrameworkDetectorPlugin,
  LanguagePlugin,
  PluginCallView,
  PluginContractFact,
  PluginEmitApi,
  PluginFactView,
  PluginFileCollection,
  PluginFileView,
  PluginFrameworkFact,
  PluginImportView,
  PluginPostExtractContext,
  PluginRepoView,
  PluginSchemaField,
  PluginSymbolView
} from "@logiclens/plugin-sdk";
import type { ContractExtractor, ExtractContext, FrameworkDetector, LanguageParser, PostExtractContext } from "../registries/types.js";
import type { DetectedFramework } from "../frameworks/types.js";
import type { ExtractedFacts } from "../contracts/extraction/contracts.js";
import type { FactCollector } from "../contracts/extraction/factCollector.js";
import type { ParsedFile, ParsedGraphFile, RepoNode } from "../parsing/types.js";
import { evidence } from "../contracts/extraction/builtin/shared.js";
import { codeId, fileId } from "../../shared/path.js";
import { hashText } from "../../shared/hash.js";
import { normalizePublicFacts } from "./publicFactNormalizer.js";
import type { PublicContractFact } from "./publicFacts.js";

export function adaptFactExtractor(pluginExtractor: FactExtractorPlugin, scopeRepoId?: string): ContractExtractor {
  return {
    name: scopedCapabilityName(pluginExtractor.name, scopeRepoId),
    scopeRepoId,
    languages: pluginExtractor.languages,
    frameworks: pluginExtractor.frameworks,
    extract(context: ExtractContext, collector: FactCollector) {
      const emitted: PluginContractFact[] = [];
      const pluginContext = createPluginContext({
        repos: scopeRepos(context.repos, scopeRepoId),
        parsedFiles: scopeFiles(context.parsedFiles, scopeRepoId),
        emit: createEmitApi(emitted)
      });
      return Promise.resolve(pluginExtractor.extract(pluginContext))
        .then(() => normalizePublicFacts(toPublicFacts(emitted), collector));
    },
    postExtract: pluginExtractor.postExtract
      ? (context: PostExtractContext, collector: FactCollector) => {
          const emitted: PluginContractFact[] = [];
          const pluginContext: PluginPostExtractContext = {
            ...createPluginContext({
              repos: scopeRepos(context.repos, scopeRepoId),
              parsedFiles: scopeFiles(context.parsedFiles, scopeRepoId),
              emit: createEmitApi(emitted)
            }),
            facts: createFactView(context.mergedFacts, scopeRepoId)
          };
          return Promise.resolve(pluginExtractor.postExtract!(pluginContext))
            .then(() => normalizePublicFacts(toPublicFacts(emitted), collector));
        }
      : undefined
  };
}

export function adaptLanguageParser(language: LanguagePlugin, scopeRepoId?: string): LanguageParser | undefined {
  if (!language.parse) return undefined;
  return {
    name: scopedCapabilityName(`plugin:${language.id}`, scopeRepoId),
    language: language.id,
    extensions: language.extensions,
    scopeRepoId,
    async parse(input) {
      const result = await language.parse!({
        repoId: input.repoId,
        absolutePath: input.absolutePath,
        relativePath: input.relativePath,
        language: input.language,
        source: input.source
      });
      const symbols = (result.symbols ?? []).map((symbol) => {
        const qualifiedName = symbol.qualifiedName ?? symbol.name;
        const source = symbol.source ?? "";
        return {
          id: codeId(input.repoId, input.relativePath, symbol.kind, qualifiedName, symbol.startLine),
          repoId: input.repoId,
          fileId: input.fileId,
          kind: symbol.kind,
          name: symbol.name,
          qualifiedName,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          signature: symbol.signature ?? symbol.name,
          source,
          hash: hashText(source || symbol.signature || symbol.name)
        };
      });
      const symbolByName = new Map(symbols.map((symbol) => [symbol.name, symbol.id]));
      const imports = (result.imports ?? []).map((item) => ({
        fileId: input.fileId,
        module: item.module,
        raw: item.raw,
        line: item.line
      }));
      const calls = (result.calls ?? []).map((item) => ({
        callerSymbolId: item.callerSymbolName ? symbolByName.get(item.callerSymbolName) : undefined,
        calleeName: item.calleeName,
        receiver: item.receiver,
        argsCount: item.argsCount,
        raw: item.raw,
        fileId: input.fileId,
        line: item.line
      }));
      return {
        repoId: input.repoId,
        fileId: input.fileId,
        path: input.relativePath,
        absolutePath: input.absolutePath,
        language: input.language,
        hash: input.hash,
        loc: input.source.split(/\r?\n/).length,
        source: input.source,
        imports,
        symbols,
        calls,
        facts: result.facts ? {
          repoId: input.repoId,
          fileId: input.fileId,
          path: input.relativePath,
          language: input.language,
          packageName: result.facts.packageName,
          imports,
          symbols,
          annotations: (result.facts.annotations ?? []).map((annotation) => ({
            ...annotation,
            arguments: annotation.arguments ?? []
          })),
          decorators: [],
          calls,
          literals: result.facts.literals ?? []
        } : undefined
      };
    }
  };
}

export function adaptFrameworkDetector(pluginDetector: FrameworkDetectorPlugin, scopeRepoId?: string): FrameworkDetector {
  return {
    name: scopedCapabilityName(pluginDetector.name, scopeRepoId),
    scopeRepoId,
    async detect(repo: RepoNode, parsedFiles: ParsedGraphFile[]): Promise<DetectedFramework[]> {
      if (scopeRepoId && repo.id !== scopeRepoId) return [];
      const emitted: PluginContractFact[] = [];
      const pluginContext = createPluginContext({
        repos: [repo],
        parsedFiles,
        emit: createEmitApi(emitted)
      });
      await pluginDetector.detect(pluginContext);
      return emitted
        .filter((fact): fact is PluginFrameworkFact => fact.kind === "framework")
        .map((fact) => ({
          repoId: fact.repoId,
          name: fact.name,
          language: fact.language,
          confidence: Math.max(...fact.evidence.map((item) => confidenceValue(item.confidence)), 0),
          evidence: fact.evidence.map((item) => evidence({
            repoId: fact.repoId,
            fileId: fileId(fact.repoId, item.filePath),
            filePath: item.filePath,
            line: item.line,
            raw: item.raw,
            rule: item.rule,
            confidence: confidenceValue(item.confidence)
          }))
        }));
    }
  };
}

function createPluginContext(input: {
  repos: readonly RepoNode[];
  parsedFiles: readonly ParsedGraphFile[];
  emit: PluginEmitApi;
}) {
  const files = input.parsedFiles.filter(isParsedCodeFile).map(toPluginFileView);
  const fileCollection = createFileCollection(files);
  return {
    repos: input.repos.map(toPluginRepoView),
    files: fileCollection,
    symbols: files.flatMap((file) => [...file.symbols]),
    imports: files.flatMap((file) => [...file.imports]),
    calls: files.flatMap((file) => [...file.calls]),
    emit: input.emit
  };
}

function createEmitApi(target: PluginContractFact[]): PluginEmitApi {
  return {
    fact(fact) { target.push(fact); },
    httpEndpoint(fact) { target.push({ ...fact, kind: "httpEndpoint" }); },
    schema(fact) { target.push({ ...fact, kind: "schema" }); },
    event(fact) { target.push({ ...fact, kind: "event" }); },
    grpcMethod(fact) { target.push({ ...fact, kind: "grpcMethod" }); },
    packageUsage(fact) { target.push({ ...fact, kind: "packageUsage" }); },
    framework(fact) { target.push({ ...fact, kind: "framework" }); },
    semanticRelation(fact) { target.push({ ...fact, kind: "semanticRelation" }); }
  };
}

function createFileCollection(files: PluginFileView[]): PluginFileCollection {
  return Object.assign(files, {
    all: () => files,
    byLanguage: (language: string) => files.filter((file) => file.language === language),
    byRepo: (repoId: string) => files.filter((file) => file.repoId === repoId),
    get: (repoId: string, path: string) => files.find((file) => file.repoId === repoId && file.path === path)
  });
}

function createFactView(facts: ExtractedFacts, scopeRepoId?: string): PluginFactView {
  const all = facts.contractSpecs
    .filter((spec) => !scopeRepoId || spec.repoId === scopeRepoId)
    .flatMap((spec): PluginContractFact[] => {
    const evidenceNode = facts.evidence.find((item) => item.id === spec.evidenceId);
    const baseEvidence = {
      filePath: evidenceNode?.filePath ?? "",
      line: evidenceNode?.line ?? 1,
      raw: evidenceNode?.raw ?? "",
      rule: evidenceNode?.rule ?? "merged-fact",
      confidence: evidenceNode?.confidence ?? spec.confidence
    };
    const parsed = safeParseSpec(spec.specJson);
    if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) return [];
    if (parsed.kind === "http-endpoint") {
      return [{
        kind: "httpEndpoint",
        repoId: spec.repoId,
        filePath: evidenceNode?.filePath ?? "",
        method: spec.httpMethod,
        path: String((parsed as { path?: unknown }).path ?? spec.pathTemplate ?? ""),
        role: "producer",
        framework: spec.framework,
        sourceSymbolId: spec.sourceSymbolId,
        evidence: baseEvidence
      }];
    }
    if (parsed.kind === "schema") {
      const schema = parsed as { name?: string; language?: string; fields?: PluginSchemaField[] };
      return [{
        kind: "schema",
        repoId: spec.repoId,
        filePath: evidenceNode?.filePath ?? "",
        name: schema.name ?? spec.canonicalKey,
        language: schema.language ?? "",
        fields: schema.fields ?? [],
        sourceSymbolId: spec.sourceSymbolId,
        evidence: baseEvidence
      }];
    }
    if (parsed.kind === "event") {
      return [{
        kind: "event",
        repoId: spec.repoId,
        filePath: evidenceNode?.filePath ?? "",
        topic: String((parsed as { topic?: unknown }).topic ?? spec.eventTopic ?? ""),
        role: "producer",
        framework: spec.framework,
        payloadType: (parsed as { payloadType?: string }).payloadType,
        evidence: baseEvidence
      }];
    }
    if (parsed.kind === "grpc-method") {
      const grpc = parsed as { service?: string; method?: string; fullName?: string; package?: string; requestType?: string; responseType?: string; streaming?: "unary" | "client-stream" | "server-stream" | "bidi-stream" };
      return [{
        kind: "grpcMethod",
        repoId: spec.repoId,
        filePath: evidenceNode?.filePath ?? "",
        service: grpc.service ?? "",
        method: grpc.method ?? "",
        fullName: grpc.fullName ?? spec.canonicalKey,
        role: "producer",
        package: grpc.package,
        requestType: grpc.requestType,
        responseType: grpc.responseType,
        streaming: grpc.streaming,
        sourceSymbolId: spec.sourceSymbolId,
        evidence: baseEvidence
      }];
    }
    return [];
  });
  return {
    httpEndpoints: () => all.filter((fact): fact is Extract<PluginContractFact, { kind: "httpEndpoint" }> => fact.kind === "httpEndpoint"),
    schemas: () => all.filter((fact): fact is Extract<PluginContractFact, { kind: "schema" }> => fact.kind === "schema"),
    events: () => all.filter((fact): fact is Extract<PluginContractFact, { kind: "event" }> => fact.kind === "event"),
    grpcMethods: () => all.filter((fact): fact is Extract<PluginContractFact, { kind: "grpcMethod" }> => fact.kind === "grpcMethod"),
    packageUsages: () => all.filter((fact): fact is Extract<PluginContractFact, { kind: "packageUsage" }> => fact.kind === "packageUsage"),
    frameworks: () => all.filter((fact): fact is PluginFrameworkFact => fact.kind === "framework"),
    all: () => all
  };
}

function scopedCapabilityName(name: string, scopeRepoId?: string): string {
  return scopeRepoId ? `${name}@${scopeRepoId}` : name;
}

function scopeRepos(repos: readonly RepoNode[], scopeRepoId?: string): RepoNode[] {
  return scopeRepoId ? repos.filter((repo) => repo.id === scopeRepoId) : [...repos];
}

function scopeFiles(files: readonly ParsedGraphFile[], scopeRepoId?: string): ParsedGraphFile[] {
  return scopeRepoId ? files.filter((file) => file.repoId === scopeRepoId) : [...files];
}

function toPluginRepoView(repo: RepoNode): PluginRepoView {
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    language: repo.language
  };
}

function toPluginFileView(file: ParsedFile): PluginFileView {
  const symbols: PluginSymbolView[] = file.symbols.map((symbol) => ({
    id: symbol.id,
    filePath: file.path,
    name: symbol.name,
    kind: symbol.kind,
    qualifiedName: symbol.qualifiedName,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    signature: symbol.signature
  }));
  const imports: PluginImportView[] = file.imports.map((item) => ({
    filePath: file.path,
    module: item.module,
    raw: item.raw,
    line: item.line
  }));
  const calls: PluginCallView[] = file.calls.map((item) => ({
    filePath: file.path,
    calleeName: item.calleeName,
    receiver: item.receiver,
    raw: item.raw,
    line: item.line
  }));
  return {
    repoId: file.repoId,
    path: file.path,
    language: file.language,
    source: file.source,
    symbols,
    imports,
    calls
  };
}

function toPublicFacts(facts: readonly PluginContractFact[]): PublicContractFact[] {
  return facts.flatMap((fact): PublicContractFact[] => {
    if (fact.kind === "framework") return [];
    if (fact.kind === "semanticRelation") {
      return [{
        kind: "semanticRelation",
        fromSpecId: fact.fromSpecKey,
        toSpecId: fact.toSpecKey,
        relation: fact.relation,
        reason: fact.reason,
        evidence: {
          repoId: fact.repoId,
          filePath: fact.evidence.filePath,
          line: fact.evidence.line,
          raw: fact.evidence.raw,
          rule: fact.evidence.rule,
          confidence: fact.evidence.confidence
        }
      }];
    }
    return [{
      ...fact,
      evidence: {
        ...fact.evidence,
        repoId: fact.repoId,
        filePath: fact.filePath
      }
    } as PublicContractFact];
  });
}

function isParsedCodeFile(file: ParsedGraphFile): file is ParsedFile {
  return "symbols" in file && "imports" in file && "calls" in file;
}

function confidenceValue(value: number | "exact" | "probable" | "heuristic"): number {
  if (typeof value === "number") return Math.max(0, Math.min(1, value));
  if (value === "exact") return 0.95;
  if (value === "probable") return 0.8;
  return 0.6;
}

function safeParseSpec(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
