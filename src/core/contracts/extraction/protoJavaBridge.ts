import path from "node:path";
import type { ContractSpecNode, ParsedFile, ParsedGraphFile } from "../../parsing/types.js";
import type { GrpcMethodSpec, GrpcStreaming, SchemaSpec } from "../spec.js";
import { parseProto, type Message } from "./builtin/protoSchema.js";

export type ProtoJavaBridgeResolution =
  | { kind: "resolved"; protoCanonicalName: string; javaCanonicalName: string; schemaNode?: ContractSpecNode }
  | { kind: "unresolved" | "ambiguous"; candidates?: string[] };

type Mapping = { repoId: string; javaName: string; protoName: string; schemaNode?: ContractSpecNode };

export type ProtoJavaIdentityBridge = {
  mappings: readonly { javaName: string; protoName: string; schemaSpecId?: string }[];
  resolve(fileId: string, rawJavaType: string): ProtoJavaBridgeResolution;
  resolveCanonical(repoId: string, javaCanonicalName: string): ProtoJavaBridgeResolution;
  resolveMethod(fileId: string, service: string, method: string): { fullName: string; streaming: GrpcStreaming } | undefined;
  resolveMethodByProtoTypes(repoId: string, service: string, method: string, requestProtoType?: string, responseProtoType?: string): { fullName: string; streaming: GrpcStreaming } | undefined;
};

export function buildProtoJavaIdentityBridge(
  files: readonly ParsedGraphFile[],
  nodes: readonly ContractSpecNode[]
): ProtoJavaIdentityBridge {
  const schemaByCanonical = new Map<string, ContractSpecNode>();
  for (const node of nodes) {
    try {
      if (node.specKind !== "schema") continue;
      const spec = JSON.parse(node.specJson) as SchemaSpec;
      if (spec.languageId === "proto") schemaByCanonical.set(spec.declaration.canonicalName, node);
    } catch {}
  }
  const mappings: Mapping[] = [];
  const methodMappings: {
    repoId: string;
    javaServiceName: string;
    service: string;
    method: string;
    fullName: string;
    streaming: GrpcStreaming;
    requestProtoType?: string;
    responseProtoType?: string;
  }[] = [];
  for (const node of nodes) {
    if (node.specKind !== "grpc-method" || node.framework !== "proto") continue;
    try {
      const spec = JSON.parse(node.specJson) as GrpcMethodSpec;
      const canonicalType = (raw: string | undefined): string | undefined => {
        if (!raw) return undefined;
        if (raw.startsWith(".")) return raw.slice(1);
        if (schemaByCanonical.has(raw)) return raw;
        return spec.package ? `${spec.package}.${raw}` : raw;
      };
      methodMappings.push({
        repoId: node.repoId,
        javaServiceName: "",
        service: spec.service,
        method: spec.method,
        fullName: spec.fullName,
        streaming: spec.streaming,
        requestProtoType: canonicalType(spec.requestType),
        responseProtoType: canonicalType(spec.responseType)
      });
    } catch {}
  }
  const sourceFiles = files.filter((file): file is ParsedFile => "source" in file);
  const javaFiles = new Map(sourceFiles.filter((file) => file.language === "java").map((file) => [file.fileId, file]));
  for (const file of sourceFiles) {
    if (file.language !== "proto" || !file.source) continue;
    const schema = parseProto(file.source);
    if (!schema) continue;
    const protoPackage = schema.package ?? "";
    const javaPackage = sourceOptionString(file.source, "java_package") ?? optionString(schema.options, "java_package") ?? protoPackage;
    const configuredOuter = sourceOptionString(file.source, "java_outer_classname") ?? optionString(schema.options, "java_outer_classname");
    const baseOuter = configuredOuter ?? defaultOuterClass(file.path);
    const topLevelNames = new Set([...schema.messages.map((message) => message.name), ...(schema.services ?? []).map((service) => service.name), ...schema.enums.map((item: { name?: string }) => item.name).filter((name): name is string => Boolean(name))]);
    const outerClass = configuredOuter ?? (topLevelNames.has(baseOuter) ? `${baseOuter}OuterClass` : baseOuter);
    const multipleFiles = sourceOptionBoolean(file.source, "java_multiple_files") ?? optionBoolean(schema.options, "java_multiple_files");
    for (const service of schema.services ?? []) {
      const javaServiceName = [...(javaPackage ? [javaPackage] : []), `${service.name}Grpc`].join(".");
      for (const method of service.methods) {
        const client = method.client_streaming ?? false;
        const server = method.server_streaming ?? false;
        const streaming: GrpcStreaming = client && server ? "bidi-stream" : client ? "client-stream" : server ? "server-stream" : "unary";
        const canonicalProtoType = (raw: string): string => raw.startsWith(".")
          ? raw.slice(1)
          : protoPackage ? `${protoPackage}.${raw}` : raw;
        methodMappings.push({ repoId: file.repoId,
          javaServiceName, service: service.name, method: method.name,
          fullName: [...(protoPackage ? [`${protoPackage}.${service.name}`] : [service.name]), method.name].join("/"), streaming,
          requestProtoType: canonicalProtoType(method.input_type),
          responseProtoType: canonicalProtoType(method.output_type)
        });
      }
    }
    for (const { javaName, protoName } of messageMappings(schema.messages, protoPackage, javaPackage, outerClass, multipleFiles)) {
      mappings.push({ repoId: file.repoId, javaName, protoName, schemaNode: schemaByCanonical.get(protoName) });
    }
  }
  for (const node of nodes) {
    if (node.specKind !== "schema") continue;
    try {
      const spec = JSON.parse(node.specJson) as SchemaSpec;
      if (spec.languageId !== "proto") continue;
      for (const identity of spec.generatedTypeIdentities ?? []) {
        if (identity.languageId !== "java") continue;
        mappings.push({ repoId: node.repoId, javaName: identity.canonicalName, protoName: spec.declaration.canonicalName, schemaNode: node });
      }
    } catch {}
  }
  const byJavaName = new Map<string, Mapping[]>();
  for (const mapping of mappings) {
    const key = mapping.javaName.replace(/\$/gu, ".");
    byJavaName.set(key, [...(byJavaName.get(key) ?? []), mapping]);
  }
  return {
    mappings: mappings.map((mapping) => ({ javaName: mapping.javaName, protoName: mapping.protoName, schemaSpecId: mapping.schemaNode?.id }))
      .sort((left, right) => left.javaName.localeCompare(right.javaName) || left.protoName.localeCompare(right.protoName)),
    resolve(fileId, rawJavaType) {
      const file = javaFiles.get(fileId);
      if (!file?.source) return { kind: "unresolved" };
      const raw = rawJavaType.replace(/\s+/gu, "").replace(/\$/gu, ".");
      const erased = raw.replace(/<.*>/su, "").replace(/\[\]$/u, "");
      const candidates = new Set<string>();
      if (erased.includes(".")) candidates.add(erased);
      const first = erased.split(".")[0]!;
      for (const match of file.source.matchAll(/^\s*import\s+([\w$.]+)\s*;/gmu)) {
        const imported = match[1]!.replace(/\$/gu, ".");
        if (imported.split(".").at(-1) === first) candidates.add(`${imported}${erased.slice(first.length)}`);
        if (imported.split(".").at(-1) === erased) candidates.add(imported);
      }
      const packageName = /^\s*package\s+([\w.]+)\s*;/mu.exec(file.source)?.[1];
      if (packageName) candidates.add(`${packageName}.${erased}`);
      const matches = [...candidates].flatMap((candidate) => byJavaName.get(candidate) ?? []).filter((mapping) => mapping.repoId === file.repoId);
      const unique = [...new Map(matches.map((match) => [match.protoName, match])).values()];
      if (unique.length === 1) return { kind: "resolved", protoCanonicalName: unique[0]!.protoName, javaCanonicalName: unique[0]!.javaName, schemaNode: unique[0]!.schemaNode };
      if (unique.length > 1) return { kind: "ambiguous", candidates: unique.map((item) => item.protoName).sort() };
      const structuralCandidates = mappings.filter((mapping) => mapping.repoId === file.repoId && (mapping.javaName === erased || mapping.javaName.endsWith(`.${erased}`)))
        .map((mapping) => mapping.protoName).sort();
      return { kind: "unresolved", candidates: structuralCandidates.length > 0 ? structuralCandidates : undefined };
    },
    resolveCanonical(repoId, javaCanonicalName) {
      const matches = (byJavaName.get(javaCanonicalName.replace(/\$/gu, ".")) ?? []).filter((mapping) => mapping.repoId === repoId);
      const unique = [...new Map(matches.map((mapping) => [mapping.protoName, mapping])).values()];
      if (unique.length === 1) return { kind: "resolved", protoCanonicalName: unique[0]!.protoName, javaCanonicalName: unique[0]!.javaName, schemaNode: unique[0]!.schemaNode };
      return unique.length > 1 ? { kind: "ambiguous", candidates: unique.map((mapping) => mapping.protoName).sort() } : { kind: "unresolved" };
    },
    resolveMethod(fileId, service, method) {
      const file = javaFiles.get(fileId);
      if (!file?.source) return undefined;
      const serviceType = `${service}Grpc`;
      const javaCandidates = javaTypeCandidates(file.source, serviceType);
      const matches = methodMappings.filter((mapping) => mapping.repoId === file.repoId && mapping.method.toLowerCase() === method.toLowerCase()
        && (javaCandidates.has(mapping.javaServiceName) || mapping.service === service && methodMappings.filter((item) => item.repoId === file.repoId && item.service === service && item.method.toLowerCase() === method.toLowerCase()).length === 1));
      return matches.length === 1 ? { fullName: matches[0]!.fullName, streaming: matches[0]!.streaming } : undefined;
    },
    resolveMethodByProtoTypes(repoId, service, method, requestProtoType, responseProtoType) {
      const matches = methodMappings.filter((mapping) => mapping.repoId === repoId
        && mapping.service === service
        && mapping.method.toLowerCase() === method.toLowerCase()
        && (!requestProtoType || !mapping.requestProtoType || mapping.requestProtoType === requestProtoType)
        && (!responseProtoType || !mapping.responseProtoType || mapping.responseProtoType === responseProtoType));
      const unique = [...new Map(matches.map((mapping) => [mapping.fullName, mapping])).values()];
      return unique.length === 1 ? { fullName: unique[0]!.fullName, streaming: unique[0]!.streaming } : undefined;
    }
  };
}

export function protoJavaMessageIdentityMap(filePath: string, source: string): { javaName: string; protoName: string }[] {
  const schema = parseProto(source);
  if (!schema) return [];
  const protoPackage = schema.package ?? "";
  const javaPackage = sourceOptionString(source, "java_package") ?? optionString(schema.options, "java_package") ?? protoPackage;
  const configuredOuter = sourceOptionString(source, "java_outer_classname") ?? optionString(schema.options, "java_outer_classname");
  const baseOuter = configuredOuter ?? defaultOuterClass(filePath);
  const topLevelNames = new Set([...schema.messages.map((message) => message.name), ...(schema.services ?? []).map((service) => service.name), ...schema.enums.map((item: { name?: string }) => item.name).filter((name): name is string => Boolean(name))]);
  const outerClass = configuredOuter ?? (topLevelNames.has(baseOuter) ? `${baseOuter}OuterClass` : baseOuter);
  const multipleFiles = sourceOptionBoolean(source, "java_multiple_files") ?? optionBoolean(schema.options, "java_multiple_files");
  return messageMappings(schema.messages, protoPackage, javaPackage, outerClass, multipleFiles);
}

function messageMappings(messages: Message[], protoPackage: string, javaPackage: string, outerClass: string, multipleFiles: boolean): { javaName: string; protoName: string }[] {
  const result: { javaName: string; protoName: string }[] = [];
  const visit = (items: Message[], protoParents: string[], javaParents: string[]): void => {
    for (const message of items) {
      const protoSegments = [...protoParents, message.name];
      const javaSegments = multipleFiles ? [...javaParents, message.name] : [outerClass, ...javaParents, message.name];
      result.push({
        protoName: [...(protoPackage ? [protoPackage] : []), ...protoSegments].join("."),
        javaName: [...(javaPackage ? [javaPackage] : []), ...javaSegments].join(".")
      });
      visit(message.messages ?? [], protoSegments, [...javaParents, message.name]);
    }
  };
  visit(messages, [], []);
  return result;
}

function javaTypeCandidates(source: string, erased: string): Set<string> {
  const candidates = new Set<string>();
  if (erased.includes(".")) candidates.add(erased);
  const first = erased.split(".")[0]!;
  for (const match of source.matchAll(/^\s*import\s+([\w$.]+)\s*;/gmu)) {
    const imported = match[1]!.replace(/\$/gu, ".");
    if (imported.split(".").at(-1) === first) candidates.add(`${imported}${erased.slice(first.length)}`);
    if (imported.split(".").at(-1) === erased) candidates.add(imported);
  }
  const packageName = /^\s*package\s+([\w.]+)\s*;/mu.exec(source)?.[1];
  if (packageName) candidates.add(`${packageName}.${erased}`);
  return candidates;
}

function optionString(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value.replace(/^['"]|['"]$/gu, "") : undefined;
}

function optionBoolean(options: Record<string, unknown>, name: string): boolean {
  const value = options[name];
  return value === true || value === "true";
}

function sourceOptionString(source: string, name: string): string | undefined {
  return new RegExp(`\\boption\\s+${name}\\s*=\\s*["']([^"']+)["']\\s*;`, "u").exec(source)?.[1];
}

function sourceOptionBoolean(source: string, name: string): boolean | undefined {
  const value = new RegExp(`\\boption\\s+${name}\\s*=\\s*(true|false)\\s*;`, "u").exec(source)?.[1];
  return value === undefined ? undefined : value === "true";
}

function defaultOuterClass(filePath: string): string {
  const base = path.posix.basename(filePath.replace(/\\/gu, "/"), ".proto");
  return base.split(/[^A-Za-z0-9]+/u).filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1)).join("") || "Proto";
}
