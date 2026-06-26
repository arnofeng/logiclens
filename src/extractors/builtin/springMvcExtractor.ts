import { joinApiPaths } from "../../contracts/apiPath.js";
import { confidenceFor } from "../../confidence.js";
import type { AnnotationFact } from "../../parsers/facts.js";
import type { ParsedFile } from "../../parsers/types.js";
import type { ContractExtractor } from "../../plugins/types.js";
import {
  createCrossRepoExtraction,
  isParsedCodeFile,
  pushApiContractFromPath,
  toFactBundle
} from "./shared.js";

const ANNOTATION_METHOD_MAP: Record<string, string> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH"
};

function springHttpMethod(annotation: AnnotationFact): string | undefined {
  const mapped = ANNOTATION_METHOD_MAP[annotation.name];
  if (mapped) return mapped;
  if (annotation.name === "RequestMapping") {
    const methodArg = annotation.arguments.find((a) => a.name === "method");
    if (!methodArg) return undefined;
    const match = methodArg.value.match(/RequestMethod\.(\w+)/);
    return match ? match[1]!.toUpperCase() : undefined;
  }
  return undefined;
}

function springPathsFromAnnotation(annotation: AnnotationFact): string[] {
  if (annotation.arguments.length === 0) return [""];
  const pathArgs = annotation.arguments.filter((argument) => !argument.name || argument.name === "value" || argument.name === "path");
  return pathArgs.length > 0 ? pathArgs.map((argument) => argument.value) : [""];
}

function springMappingsFromFacts(file: ParsedFile): Map<string, { annotation: string; path: string; raw: string; line: number }[]> {
  const result = new Map<string, { annotation: string; path: string; raw: string; line: number }[]>();
  for (const annotation of file.facts?.annotations ?? []) {
    if (!annotation.ownerSymbolId) continue;
    if (!["RequestMapping", "GetMapping", "PostMapping", "PutMapping", "DeleteMapping", "PatchMapping"].includes(annotation.name)) continue;
    const rows = result.get(annotation.ownerSymbolId) ?? [];
    for (const path of springPathsFromAnnotation(annotation)) {
      rows.push({ annotation: annotation.name, path, raw: annotation.raw, line: annotation.line });
    }
    result.set(annotation.ownerSymbolId, rows);
  }
  return result;
}

export const springMvcExtractor: ContractExtractor = {
  name: "builtin:spring-mvc",
  languages: ["java"],
  frameworks: ["java:spring-mvc"],
  extract(context) {
    const result = createCrossRepoExtraction();
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "java") continue;
      const mappingsByOwner = springMappingsFromFacts(file);
      const classSymbols = file.symbols.filter((symbol) => symbol.kind === "class");
      for (const classSymbol of classSymbols) {
        const baseMappings = (mappingsByOwner.get(classSymbol.id) ?? [])
          .filter((mapping) => mapping.annotation === "RequestMapping")
          .map((mapping) => ({ ...mapping, offset: Math.max(0, classSymbol.source.indexOf(mapping.raw)) }));
        for (const baseMapping of baseMappings) {
          if (!baseMapping.path) continue;
          pushApiContractFromPath({
            result,
            file,
            symbol: classSymbol,
            apiPath: baseMapping.path,
            role: "producer",
            offset: baseMapping.offset,
            raw: baseMapping.raw,
            rule: "spring-request-mapping-producer",
            confidence: confidenceFor("exact-parser-route"),
            framework: "spring-mvc"
          });
        }

        const basePaths = baseMappings.length > 0 ? baseMappings.map((mapping) => mapping.path) : [""];
        const methodSymbols = file.symbols.filter((symbol) => symbol.kind === "method" && symbol.startLine >= classSymbol.startLine && symbol.endLine <= classSymbol.endLine);
        for (const methodSymbol of methodSymbols) {
          const rawMappings = mappingsByOwner.get(methodSymbol.id) ?? [];
          const mappings = rawMappings
            .map((mapping) => ({ ...mapping, offset: Math.max(0, methodSymbol.source.indexOf(mapping.raw)) }));
          for (const mapping of mappings) {
            const annotationFact = (file.facts?.annotations ?? []).find(
              (a) => a.ownerSymbolId === methodSymbol.id && a.raw === mapping.raw
            );
            const httpMethod = annotationFact ? springHttpMethod(annotationFact) : undefined;
            for (const basePath of basePaths) {
              pushApiContractFromPath({
                result,
                file,
                symbol: methodSymbol,
                apiPath: joinApiPaths(basePath, mapping.path),
                role: "producer",
                offset: mapping.offset,
                raw: mapping.raw,
                rule: "spring-mapping-producer",
                confidence: confidenceFor("exact-parser-route"),
                method: httpMethod,
                framework: "spring-mvc"
              });
            }
          }
        }
      }
    }
    return toFactBundle(result);
  },

  /**
   * P1-1 – postExtract: Cross-file Controller prefix finalization.
   *
   * The per-file extract() phase handles same-file prefix+method merging.
   * This hook handles the edge case where a base @RequestMapping is on a
   * class that was processed in a different extract() invocation (split repos,
   * plugin-registered extractor running after builtin, etc.).
   *
   * It scans the merged `repoContracts` for api contracts produced by the
   * "spring-request-mapping-producer" rule (class-level paths), then re-checks
   * every file to see if any method-level routes lack the prefix, and if so
   * emits an additional prefixed contract.
   *
   * In practice this is a no-op when all files are processed in one pass
   * (the common case), but it provides a safety net for multi-batch or
   * multi-extractor scenarios.
   */
  postExtract(context) {
    const result = createCrossRepoExtraction();

    const prefixesByFile = new Map<string, { line: number; path: string }[]>();
    for (const relation of context.mergedFacts.relations) {
      if (relation.kind !== "repo-contract") continue;
      if (relation.role !== "producer") continue;
      const ev = context.mergedFacts.evidence.find((e) => e.id === relation.evidenceId);
      if (!ev || ev.rule !== "spring-request-mapping-producer") continue;
      const contract = context.mergedFacts.contracts.find((c) => c.id === relation.contractId);
      if (!contract || contract.kind !== "api") continue;
      const rows = prefixesByFile.get(ev.fileId) ?? [];
      rows.push({ line: ev.line, path: contract.key });
      prefixesByFile.set(ev.fileId, rows);
    }

    if (prefixesByFile.size === 0) return toFactBundle(result);

    // For each file that has a class-level prefix, find method-level routes
    // that were already emitted without the prefix and emit prefixed versions.
    const alreadyEmitted = new Set(
      context.mergedFacts.contracts.filter((c) => c.kind === "api").map((c) => c.key)
    );

    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "java") continue;
      const filePrefixes = prefixesByFile.get(file.fileId);
      if (!filePrefixes) continue;
      const mappingsByOwner = springMappingsFromFacts(file);
      const classSymbols = file.symbols.filter((s) => s.kind === "class");
      for (const classSymbol of classSymbols) {
        const prefixes = filePrefixes
          .filter((prefix) => prefix.line >= classSymbol.startLine && prefix.line <= classSymbol.endLine)
          .map((prefix) => prefix.path);
        if (prefixes.length === 0) continue;
        const methodSymbols = file.symbols.filter(
          (s) => s.kind === "method" && s.startLine >= classSymbol.startLine && s.endLine <= classSymbol.endLine
        );
        for (const prefix of prefixes) {
          for (const methodSymbol of methodSymbols) {
            const factMappings = (mappingsByOwner.get(methodSymbol.id) ?? [])
              .map((m) => ({ ...m, offset: Math.max(0, methodSymbol.source.indexOf(m.raw)) }));
            const mappings = factMappings;
            for (const mapping of mappings) {
              const annotationFact = (file.facts?.annotations ?? []).find(
                (a) => a.ownerSymbolId === methodSymbol.id && a.raw === mapping.raw
              );
              const httpMethod = annotationFact ? springHttpMethod(annotationFact) : undefined;
              const combined = joinApiPaths(prefix, mapping.path);
              if (alreadyEmitted.has(combined)) continue; // already correct
              pushApiContractFromPath({
                result,
                file,
                symbol: methodSymbol,
                apiPath: combined,
                role: "producer",
                offset: mapping.offset,
                raw: mapping.raw,
                rule: "spring-mapping-prefix-merged",
                confidence: confidenceFor("probable-route-merge"),
                method: httpMethod,
                framework: "spring-mvc"
              });
            }
          }
        }
      }
    }
    return toFactBundle(result);
  }
};
