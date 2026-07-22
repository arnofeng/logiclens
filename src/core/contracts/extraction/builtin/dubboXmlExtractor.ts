import { compatExtractor } from "./compat.js";
import type { CodeSymbol, ParsedFile } from "../../../parsing/types.js";
import type { FactCollector } from "../factCollector.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import { codeId } from "../../../../shared/path.js";
import { hashText } from "../../../../shared/hash.js";
import { parsedCodeFiles, pushDubboContract } from "./shared.js";
import { parseDubboXmlConfig, type DubboXmlEntry } from "./dubboXmlConfig.js";
import { indexedSourceAstNodes, parseSourceAst } from "./sourceAstUtils.js";
import {
  directJavaDubboMethodDeclarations,
  javaDubboImplementedInterfaces,
  javaDubboImports,
  javaDubboPackage,
  javaDubboParamTypes,
  javaDubboReturnType,
  makeJavaDubboSymbol,
  resolveJavaDubboType
} from "./javaDubboExtractor.js";

type JavaDubboImplementation = {
  file: ParsedFile;
  beanNames: Set<string>;
  interfaceNames: Set<string>;
  methods: ReturnType<typeof directJavaDubboMethodDeclarations>;
};

function makeXmlSymbol(file: ParsedFile, raw: string, offset: number, name: string): CodeSymbol {
  const source = file.source ?? raw;
  const startLine = source.slice(0, offset).split(/\r?\n/).length;
  const qualifiedName = `${name}@${offset}`;
  return {
    id: codeId(file.repoId, file.path, "variable", qualifiedName, startLine),
    repoId: file.repoId,
    fileId: file.fileId,
    kind: "variable",
    name,
    qualifiedName,
    startLine,
    endLine: startLine,
    signature: raw,
    source,
    hash: hashText(raw)
  };
}

function defaultBeanName(className: string): string {
  return className ? `${className[0]!.toLowerCase()}${className.slice(1)}` : className;
}

function explicitBeanNames(classText: string): string[] {
  const header = classText.slice(0, Math.max(0, classText.indexOf("{")));
  const names: string[] = [];
  for (const match of header.matchAll(/@(?:Component|Service|Named)\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g)) {
    names.push(match[1]!);
  }
  return names;
}

function collectJavaImplementations(files: ParsedFile[]): Map<string, JavaDubboImplementation[]> {
  const byRepo = new Map<string, JavaDubboImplementation[]>();
  for (const file of files) {
    if (file.language !== "java") continue;
    const ast = parseSourceAst(file, "java");
    if (!ast) continue;
    const imports = javaDubboImports(ast.source);
    const packageName = javaDubboPackage(ast.source, file);
    for (const node of indexedSourceAstNodes(ast, ["class_declaration"])) {
      const className = node.childForFieldName("name")?.text;
      if (!className) continue;
      const interfaceNames = new Set(
        javaDubboImplementedInterfaces(node)
          .map((name) => resolveJavaDubboType(name, imports, packageName))
          .filter((name): name is string => Boolean(name))
      );
      if (interfaceNames.size === 0) continue;
      const beanNames = new Set([defaultBeanName(className), ...explicitBeanNames(node.text)]);
      const list = byRepo.get(file.repoId) ?? [];
      list.push({
        file,
        beanNames,
        interfaceNames,
        methods: directJavaDubboMethodDeclarations(node)
      });
      byRepo.set(file.repoId, list);
    }
  }
  return byRepo;
}

function matchingImplementation(
  entry: DubboXmlEntry,
  implementations: JavaDubboImplementation[]
): JavaDubboImplementation | undefined {
  if (!entry.ref) return undefined;
  const matches = implementations.filter((candidate) => (
    candidate.beanNames.has(entry.ref!) && candidate.interfaceNames.has(entry.interfaceName)
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

export const dubboXmlExtractor = compatExtractor({
  name: "builtin:dubbo-xml",
  languages: ["xml"],
  frameworks: ["java:dubbo-xml"],
  extract(context, collector: FactCollector) {
    const files = [...parsedCodeFiles(context.parsedFiles)];
    const implementationsByRepo = collectJavaImplementations(files);
    const seen = new Set<string>();
    for (const file of files) {
      if (file.language !== "xml") continue;
      const source = file.source;
      if (!source) continue;
      for (const entry of parseDubboXmlConfig(source)) {
        const role = entry.kind === "service" ? "producer" : "consumer";
        const rule = entry.kind === "service" ? "dubbo-xml-service" : "dubbo-xml-reference";
        const explicitMethods = entry.methods;
        if (explicitMethods.length > 0) {
          for (const method of explicitMethods) {
            const key = `${file.repoId}:${role}:${entry.interfaceName}:${method.name}:${entry.group ?? ""}:${entry.version ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const symbol = makeXmlSymbol(file, method.raw, method.offset, `${entry.interfaceName}#${method.name}`);
            pushDubboContract({
              collector,
              file,
              symbol,
              interfaceName: entry.interfaceName,
              method: method.name,
              role,
              offset: 0,
              raw: method.raw,
              rule,
              confidence: confidenceFor("exact-parser-route"),
              group: entry.group,
              version: entry.version,
              config: "xml",
              framework: "dubbo-java"
            });
          }
          continue;
        }

        const implementation = entry.kind === "service"
          ? matchingImplementation(entry, implementationsByRepo.get(file.repoId) ?? [])
          : undefined;
        if (implementation && implementation.methods.length > 0) {
          for (const methodNode of implementation.methods) {
            const method = methodNode.childForFieldName("name")?.text;
            if (!method) continue;
            const key = `${file.repoId}:${role}:${entry.interfaceName}:${method}:${entry.group ?? ""}:${entry.version ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const symbol = makeJavaDubboSymbol(
              implementation.file,
              methodNode,
              "method",
              method,
              `${entry.interfaceName}.${method}`
            );
            pushDubboContract({
              collector,
              file: implementation.file,
              symbol,
              interfaceName: entry.interfaceName,
              method,
              role,
              offset: 0,
              raw: methodNode.text,
              rule: "dubbo-xml-service-implementation",
              confidence: confidenceFor("exact-parser-route"),
              group: entry.group,
              version: entry.version,
              requestTypes: javaDubboParamTypes(methodNode),
              responseType: javaDubboReturnType(methodNode),
              config: "xml",
              framework: "dubbo-java"
            });
          }
          continue;
        }

        const key = `${file.repoId}:${role}:${entry.interfaceName}:*:${entry.group ?? ""}:${entry.version ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const symbol = makeXmlSymbol(file, entry.raw, entry.offset, `${entry.interfaceName}#*`);
        pushDubboContract({
          collector,
          file,
          symbol,
          interfaceName: entry.interfaceName,
          method: "*",
          role,
          offset: 0,
          raw: entry.raw,
          rule,
          confidence: confidenceFor("exact-parser-route"),
          group: entry.group,
          version: entry.version,
          config: "xml",
          framework: "dubbo-java"
        });
      }
    }
  }
});
