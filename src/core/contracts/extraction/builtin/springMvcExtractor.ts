import { canonicalHttpContractKey, joinApiPaths } from "../../apiPath.js";
import { confidenceFor } from "../../../../shared/confidence.js";
import type { AnnotationFact } from "../../../parsing/facts.js";
import type { ParsedFile } from "../../../parsing/types.js";
import type { ContractExtractor } from "../../../plugins/types.js";
import {
  createCrossRepoExtraction,
  isParsedCodeFile,
  pushApiContractFromPath,
  toFactBundle
} from "./shared.js";
import { findContainingSymbol, parseSourceAst, walkSourceAst } from "./sourceAstUtils.js";
import type Parser from "tree-sitter";

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

// ---------------------------------------------------------------------------
// Phase 3-E: Body type extraction from Java AST
// ---------------------------------------------------------------------------

type BodyTypeInfo = {
  requestBodyType?: string;
  responseBodyType?: string;
};

/**
 * Extracts @RequestBody parameter types and ResponseEntity<T> return types
 * from Java method declarations. Returns a map keyed by method symbol ID.
 */
function extractBodyTypes(file: ParsedFile): Map<string, BodyTypeInfo> {
  const map = new Map<string, BodyTypeInfo>();
  const ast = parseSourceAst(file, "java");
  if (!ast) return map;

  walkSourceAst(ast.tree.rootNode, (node) => {
    if (node.type !== "method_declaration") return;
    const methodSymbol = findContainingSymbol(file.symbols, node);
    if (!methodSymbol) return;

    const info: BodyTypeInfo = {};

    // Request body: find formal parameter annotated with @RequestBody
    const params = node.childForFieldName("parameters");
    if (params) {
      for (let i = 0; i < params.namedChildCount; i++) {
        const param = params.namedChild(i);
        if (!param) continue;
        const hasRequestBody = hasAnnotation(param, "RequestBody");
        if (!hasRequestBody) continue;
        const typeName = extractParameterTypeName(param);
        if (typeName) info.requestBodyType = typeName;
      }
    }

    // Response body: extract type argument from ResponseEntity<T> return type
    const returnType = node.childForFieldName("type");
    if (returnType) {
      const responseType = extractResponseTypeName(returnType);
      if (responseType) info.responseBodyType = responseType;
    }

    if (info.requestBodyType || info.responseBodyType) {
      map.set(methodSymbol.id, info);
    }
  });

  return map;
}

function hasAnnotation(node: Parser.SyntaxNode, annotationName: string): boolean {
  const modifiers = node.childForFieldName("modifiers");
  if (!modifiers) return false;
  for (let i = 0; i < modifiers.namedChildCount; i++) {
    const mod = modifiers.namedChild(i);
    if (!mod) continue;
    if (mod.type === "annotation" || mod.type === "marker_annotation") {
      const name = mod.childForFieldName("name");
      if (name && (name.text === annotationName || name.text === `@${annotationName}`)) {
        return true;
      }
    }
  }
  return false;
}

function extractParameterTypeName(param: Parser.SyntaxNode): string | undefined {
  // For a formal_parameter like "@RequestBody CreateOrderDTO dto"
  // the type node is a child. Look for type_identifier or generic_type.
  for (let i = 0; i < param.namedChildCount; i++) {
    const child = param.namedChild(i);
    if (!child) continue;
    if (child.type === "type_identifier") return child.text;
    if (child.type === "generic_type") {
      // ResponseEntity<CreateOrderDTO> → resolve the first type argument
      const typeArgs = child.childForFieldName("type_arguments");
      if (typeArgs) {
        const first = typeArgs.namedChild(0);
        if (first?.type === "type_identifier") return first.text;
        if (first?.type === "generic_type") return first.text;
      }
      // Fallback: return the raw generic text
      return child.text;
    }
    if (child.type === "array_type") return child.text;
    if (child.type === "integral_type" || child.type === "floating_point_type" ||
        child.type === "boolean_type" || child.type === "void_type") {
      return child.text;
    }
  }
  return undefined;
}

function extractResponseTypeName(returnType: Parser.SyntaxNode): string | undefined {
  // Direct type_identifier: `OrderResponse someMethod(...)`
  if (returnType.type === "type_identifier") {
    return returnType.text;
  }
  // Generic type: ResponseEntity<OrderResponse> → extract first type argument
  if (returnType.type === "generic_type") {
    const baseName = returnType.childForFieldName("name");
    const baseTypeName = baseName?.text;
    if (baseTypeName === "ResponseEntity" || baseTypeName === "Mono" || baseTypeName === "Flux") {
      const typeArgs = returnType.childForFieldName("type_arguments");
      if (typeArgs) {
        const first = typeArgs.namedChild(0);
        if (first?.type === "type_identifier") return first.text;
        if (first?.type === "generic_type") {
          // Nested generic: ResponseEntity<List<OrderResponse>>
          const innerName = first.childForFieldName("name");
          return innerName?.text ?? first.text;
        }
        return first?.text;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const springMvcExtractor: ContractExtractor = {
  name: "builtin:spring-mvc",
  languages: ["java"],
  frameworks: ["java:spring-mvc"],
  extract(context) {
    const result = createCrossRepoExtraction();
    for (const file of context.parsedFiles.filter(isParsedCodeFile)) {
      if (file.language !== "java") continue;
      const mappingsByOwner = springMappingsFromFacts(file);
      const bodyTypesBySymbol = extractBodyTypes(file);
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
          const bodyTypes = bodyTypesBySymbol.get(methodSymbol.id);
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
                framework: "spring-mvc",
                requestBodyType: bodyTypes?.requestBodyType,
                responseBodyType: bodyTypes?.responseBodyType
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
              // alreadyEmitted stores canonical keys (e.g. "get:/smart/customeractivity/list"),
              // so we must compare against the same canonical form — the raw path would
              // never match a method-prefixed key.
              const combinedKey = canonicalHttpContractKey({ method: httpMethod, path: combined });
              if (alreadyEmitted.has(combinedKey)) continue; // already correct
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
