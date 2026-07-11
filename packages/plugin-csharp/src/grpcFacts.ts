import type { FactExtractorPlugin, PluginFileView, PluginGrpcMethodFact, PluginSymbolView } from "@logiclens/plugin-sdk";
import { lexicalType } from "./events/types.js";

type Candidate = Omit<PluginGrpcMethodFact, "kind" | "repoId" | "filePath" | "sourceSymbolId"> & {
  line: number;
  raw: string;
  symbolName?: string;
};

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function simpleType(value: string): string {
  return value.trim().replace(/^global::/, "").replace(/\?$/, "").replace(/^.*\./, "");
}

function isGeneratedPath(filePath: string): boolean {
  return /(?:^|[\\/])(?:obj|generated)(?:[\\/]|$)/i.test(filePath)
    || /(?:\.g|\.generated|\.designer)\.cs$/i.test(filePath);
}

function serviceIdentity(base: string): { service: string; package?: string } | undefined {
  const parts = base.replace(/^global::/, "").split(".");
  if (parts.at(-1) !== `${parts.at(-2)}Base` || parts.length < 2) return undefined;
  const service = parts.at(-2)!;
  const packageName = parts.slice(0, -2).join(".");
  return { service, ...(packageName ? { package: packageName } : {}) };
}

function methodTypes(signature: string): Pick<PluginGrpcMethodFact, "requestType" | "responseType" | "streaming"> {
  const reader = signature.match(/IAsyncStreamReader\s*<\s*([^>]+)>/);
  const writer = signature.match(/IServerStreamWriter\s*<\s*([^>]+)>/);
  const parameters = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  const ordinary = parameters.split(",").map((item) => item.trim()).find((item) =>
    item && !/\b(?:ServerCallContext|IAsyncStreamReader|IServerStreamWriter)\b/.test(item));
  const requestType = reader?.[1] ?? ordinary?.match(/^(?:in\s+|ref\s+|out\s+)?([\w.<>?]+)/)?.[1];
  const returnType = signature.match(/(?:Task|ValueTask)\s*<\s*([^>]+)>/)?.[1];
  return {
    ...(requestType ? { requestType: simpleType(requestType) } : {}),
    ...(writer?.[1] || returnType ? { responseType: simpleType(writer?.[1] ?? returnType!) } : {}),
    streaming: reader && writer ? "bidi-stream" : reader ? "client-stream" : writer ? "server-stream" : "unary"
  };
}

function producerCandidates(file: PluginFileView): Candidate[] {
  const source = file.source ?? "";
  const output: Candidate[] = [];
  const classes = /class\s+(\w+)\s*:\s*([\w.:]+Base)\b/g;
  for (const match of source.matchAll(classes)) {
    const identity = serviceIdentity(match[2]!);
    if (!identity) continue;
    const start = match.index!;
    const nextClass = source.slice(start + match[0].length).search(/\bclass\s+\w+/);
    const end = nextClass < 0 ? source.length : start + match[0].length + nextClass;
    const body = source.slice(start, end);
    const methods = /\b(?:public|protected)\s+override\s+([^\n{;]+?)\s+(\w+)\s*\(([^)]*)\)/g;
    for (const method of body.matchAll(methods)) {
      const signature = method[0]!;
      if (!/\bServerCallContext\b/.test(signature)) continue;
      output.push({ ...identity, method: method[2]!, fullName: `${[identity.package, identity.service].filter(Boolean).join(".")}/${method[2]}`,
        role: "producer", framework: "grpc-dotnet", ...methodTypes(signature), line: lineAt(source, start + method.index!),
        raw: signature, symbolName: method[2], evidence: { filePath: file.path, line: 1, raw: "", rule: "grpc-dotnet-generated-base-override", confidence: "exact" } });
    }
  }
  return output;
}

function consumerCandidates(file: PluginFileView): Candidate[] {
  const source = file.source ?? "";
  const output: Candidate[] = [];
  const calls = /\b(\w+)\.(\w+?)(?:Async)?\s*\(([^)]*)\)/g;
  for (const match of source.matchAll(calls)) {
    const variable = match[1]!;
    const boundType = lexicalType(source, variable, match.index!);
    const clientType = boundType?.match(/^([\w.]+)\.(\w+)Client$/);
    const qualifier = clientType?.[1];
    const parts = qualifier?.split(".") ?? [];
    const service = parts.at(-1);
    const identity = service && service === clientType?.[2]
      ? { service, ...(parts.length > 1 ? { package: parts.slice(0, -1).join(".") } : {}) }
      : undefined;
    if (!identity) continue;
    const method = match[2]!;
    const firstArgument = match[3]!.split(",")[0]?.trim();
    const requestType = firstArgument && /^\w+$/.test(firstArgument) ? lexicalType(source, firstArgument, match.index!) : undefined;
    const prefix = source.slice(Math.max(0, match.index! - 160), match.index!);
    const callType = prefix.match(/(?:AsyncUnaryCall|AsyncClientStreamingCall|AsyncServerStreamingCall|AsyncDuplexStreamingCall)\s*<\s*([^;=]+)>\s+\w+\s*=\s*$/);
    const typeArgs = callType?.[1]?.split(",").map(simpleType) ?? [];
    const callKind = callType?.[0]?.match(/^\w+/)?.[0];
    const streaming = callKind === "AsyncClientStreamingCall" ? "client-stream" : callKind === "AsyncServerStreamingCall" ? "server-stream"
      : callKind === "AsyncDuplexStreamingCall" ? "bidi-stream" : "unary";
    const inferredRequestType = requestType ?? (callKind === "AsyncClientStreamingCall" || callKind === "AsyncDuplexStreamingCall" ? typeArgs[0] : undefined);
    const responseType = callKind === "AsyncClientStreamingCall" || callKind === "AsyncDuplexStreamingCall" ? typeArgs[1] : typeArgs[0];
    output.push({ ...identity, method, fullName: `${[identity.package, identity.service].filter(Boolean).join(".")}/${method}`, role: "consumer",
      framework: "grpc-dotnet", ...(inferredRequestType ? { requestType: simpleType(inferredRequestType) } : {}), ...(responseType ? { responseType } : {}), streaming,
      line: lineAt(source, match.index!), raw: match[0]!, evidence: { filePath: file.path, line: 1, raw: "", rule: "grpc-dotnet-typed-client-call", confidence: "exact" } });
  }
  return output;
}

function sourceSymbol(symbols: readonly PluginSymbolView[], file: PluginFileView, candidate: Candidate): string | undefined {
  return symbols.find((symbol) => symbol.filePath === file.path && symbol.name === candidate.symbolName && symbol.startLine <= candidate.line && symbol.endLine >= candidate.line)?.id
    ?? symbols.find((symbol) => symbol.filePath === file.path && symbol.startLine <= candidate.line && symbol.endLine >= candidate.line)?.id;
}

export const csharpGrpcExtractor: FactExtractorPlugin = {
  name: "csharp:grpc",
  languages: ["csharp"],
  extract(context) {
    for (const file of context.files.byLanguage("csharp")) {
      if (isGeneratedPath(file.path)) continue;
      for (const candidate of [...producerCandidates(file), ...consumerCandidates(file)]) {
        const isParsedCandidate = candidate.role === "producer"
          ? file.symbols.some((symbol) => symbol.kind === "method" && symbol.name === candidate.symbolName && symbol.startLine === candidate.line)
          : file.calls.some((call) => call.line === candidate.line &&
            (call.calleeName === `${candidate.method}Async` || call.calleeName === candidate.method));
        if (!isParsedCandidate) continue;
        const { line, raw, symbolName: _symbolName, evidence: _evidence, ...fact } = candidate;
        context.emit.grpcMethod({ ...fact, repoId: file.repoId, filePath: file.path,
          sourceSymbolId: sourceSymbol(context.symbols, file, candidate),
          evidence: { filePath: file.path, line, raw, rule: candidate.role === "producer" ? "grpc-dotnet-generated-base-override" : "grpc-dotnet-typed-client-call", confidence: "exact" } });
      }
    }
  }
};
