import path from "node:path";
import { createRequire } from "node:module";
import type { CallEdge, CodeSymbol, ImportEdge, ParsedFile } from "../parsing/types.js";
import { fileId } from "../../shared/path.js";
import { confidenceBand, scoreCallResolution } from "../../shared/confidence.js";
import { hashText } from "../../shared/hash.js";
import Parser from "tree-sitter";
import { getCachedParser, getLanguageGrammar, parseTreeSitterSource } from "../parsing/treeSitter.js";
import { javaQueries } from "../parsing/languages/java.js";
import { getBrandedEnv } from "../../shared/branding.js";
import type { ProgressReporter } from "../../shared/progress.js";

export { scoreCallResolution } from "../../shared/confidence.js";

type TypeScriptApi = typeof import("typescript");

const require = createRequire(import.meta.url);
const MAX_CALL_RAW_LENGTH = 512;

function warnReferenceResolution(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : error ? String(error) : "";
  process.emitWarning(detail ? `${message}: ${detail}` : message, { code: "REFERENCE_RESOLUTION" });
}

function shouldWriteReferenceTrace(): boolean {
  return getBrandedEnv("REFERENCE_TRACE") === "1" || getBrandedEnv("REFERENCE_TRACE") === "true";
}

function writeReferenceTrace(message: string): void {
  if (shouldWriteReferenceTrace()) process.stderr.write(`${message}\n`);
}

function boundedRaw(raw: string): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_CALL_RAW_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_CALL_RAW_LENGTH)}...#${hashText(normalized).slice(0, 12)}`;
}

export function resolveImports(parsedFiles: ParsedFile[]): ImportEdge[] {
  const byRepoPath = new Map(parsedFiles.map((file) => [`${file.repoId}:${file.path}`, file.fileId]));
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".vue", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.vue"];
  const edges: ImportEdge[] = [];
  for (const file of parsedFiles) {
    for (const importRef of file.imports) {
      if (!importRef.module.startsWith(".")) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), importRef.module));
      const hit = byRepoPath.has(`${file.repoId}:${base}`)
        ? base
        : extensions.map((ext) => `${base}${ext}`).find((candidate) => byRepoPath.has(`${file.repoId}:${candidate}`));
      if (hit) edges.push({ fromFileId: file.fileId, toFileId: fileId(file.repoId, hit), module: importRef.module, raw: importRef.raw });
    }
  }
  return edges;
}

export function resolveCalls(parsedFiles: ParsedFile[], progress?: ProgressReporter): CallEdge[] {
  const started = Date.now();
  let completedProgressSteps = 0;
  const totalProgressSteps = 8;
  const reportProgress = (label: string): void => {
    completedProgressSteps += 1;
    progress?.({ current: completedProgressSteps, total: totalProgressSteps, label });
  };

  const callCount = parsedFiles.reduce((count, file) => count + file.calls.length, 0);
  writeReferenceTrace(`Resolve calls prepare start: files=${parsedFiles.length} calls=${callCount}`);
  const symbols = parsedFiles.flatMap((file) => file.symbols);
  const byName = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    for (const key of [symbol.name, symbol.qualifiedName.split(".").at(-1) ?? symbol.qualifiedName]) {
      const list = byName.get(key) ?? [];
      list.push(symbol);
      byName.set(key, list);
    }
  }
  const importsByFile = resolveImports(parsedFiles).reduce((acc, edge) => {
    const list = acc.get(edge.fromFileId) ?? [];
    list.push(edge.toFileId);
    acc.set(edge.fromFileId, list);
    return acc;
  }, new Map<string, string[]>());
  reportProgress("prepare");

  let stepStarted = Date.now();
  writeReferenceTrace(`Resolve calls re-exports start: symbols=${symbols.length}`);
  const reExportTargets = buildReExportTargets(parsedFiles, importsByFile, byName);
  writeReferenceTrace(`Resolve calls re-exports complete: targets=${reExportTargets.size} duration=${Date.now() - stepStarted}ms`);
  reportProgress("re-export targets");

  stepStarted = Date.now();
  writeReferenceTrace("Resolve calls imported aliases start");
  const importedAliasTargets = buildImportedAliasTargets(parsedFiles, importsByFile, byName, reExportTargets);
  writeReferenceTrace(`Resolve calls imported aliases complete: targets=${importedAliasTargets.size} duration=${Date.now() - stepStarted}ms`);
  reportProgress("imported aliases");

  stepStarted = Date.now();
  writeReferenceTrace("Resolve calls TypeScript compiler targets start");
  const compilerTargets = buildTypeScriptCompilerTargets(parsedFiles);
  writeReferenceTrace(`Resolve calls TypeScript compiler targets complete: targets=${compilerTargets.size} duration=${Date.now() - stepStarted}ms`);
  reportProgress("TypeScript compiler targets");

  stepStarted = Date.now();
  writeReferenceTrace("Resolve calls Java static targets start");
  const javaStaticTargets = buildJavaStaticTargets(parsedFiles);
  writeReferenceTrace(`Resolve calls Java static targets complete: targets=${javaStaticTargets.size} duration=${Date.now() - stepStarted}ms`);
  reportProgress("Java static targets");

  stepStarted = Date.now();
  writeReferenceTrace("Resolve calls Python module targets start");
  const pythonStaticTargets = buildPythonModuleTargets(parsedFiles);
  writeReferenceTrace(`Resolve calls Python module targets complete: targets=${pythonStaticTargets.size} duration=${Date.now() - stepStarted}ms`);
  reportProgress("Python module targets");

  stepStarted = Date.now();
  writeReferenceTrace("Resolve calls Go package targets start");
  const goStaticTargets = buildGoPackageTargets(parsedFiles);
  writeReferenceTrace(`Resolve calls Go package targets complete: targets=${goStaticTargets.size} duration=${Date.now() - stepStarted}ms`);
  reportProgress("Go package targets");

  stepStarted = Date.now();
  writeReferenceTrace("Resolve calls edge matching start");
  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const file of parsedFiles) {
    for (const call of file.calls) {
      if (!call.callerSymbolId) continue;
      const raw = boundedRaw(call.raw);
      const keyForCall = callKey(file.fileId, call.line, raw);
      const compilerTarget = compilerTargets.get(keyForCall) ?? javaStaticTargets.get(keyForCall) ?? pythonStaticTargets.get(keyForCall) ?? goStaticTargets.get(keyForCall);
      if (compilerTarget && compilerTarget.id !== call.callerSymbolId) {
        const key = `${call.callerSymbolId}->${compilerTarget.id}:${raw}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ fromCodeId: call.callerSymbolId, toCodeId: compilerTarget.id, confidence: 0.95, resolution: "exact", raw });
        }
        continue;
      }
      const importedFiles = new Set(importsByFile.get(file.fileId) ?? []);
      const candidates = uniqueSymbols([
        ...(byName.get(call.calleeName) ?? []),
        ...(importedAliasTargets.get(`${file.fileId}:${call.calleeName}`) ?? [])
      ]);
      const best = candidates
        .filter((candidate) => candidate.id !== call.callerSymbolId)
        .map((candidate) => {
          const imported = importedFiles.has(candidate.fileId) || aliasMatches(file.fileId, call.calleeName, candidate, importedAliasTargets);
          return {
            candidate,
            imported,
            score: scoreCallResolution({
              sameFile: candidate.fileId === file.fileId,
              // Import evidence is deliberately file-scoped: without a full type
              // checker, it upgrades same-repo imported candidates to probable,
              // while same-file lexical containment remains the only exact edge.
              imported,
              sameRepo: candidate.repoId === file.repoId,
              nameExact: candidate.name === call.calleeName || candidate.qualifiedName.endsWith(`.${call.calleeName}`) || aliasMatches(file.fileId, call.calleeName, candidate, importedAliasTargets)
            })
          };
        })
        .sort((a, b) => b.score - a.score || Number(b.imported) - Number(a.imported) || Number(b.candidate.fileId === file.fileId) - Number(a.candidate.fileId === file.fileId))[0];
      if (best && best.score >= 0.4) {
        const key = `${call.callerSymbolId}->${best.candidate.id}:${raw}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ fromCodeId: call.callerSymbolId, toCodeId: best.candidate.id, confidence: best.score, resolution: confidenceBand(best.score), raw });
        }
      }
    }
  }
  writeReferenceTrace(`Resolve calls edge matching complete: edges=${edges.length} duration=${Date.now() - stepStarted}ms total=${Date.now() - started}ms`);
  reportProgress("edge matching");
  return edges;
}

function buildPythonModuleTargets(parsedFiles: ParsedFile[]): Map<string, CodeSymbol> {
  const pythonFiles = parsedFiles.filter((file) => file.language === "python");
  if (pythonFiles.length === 0) return new Map();
  const moduleFiles = new Map<string, ParsedFile>();
  for (const file of pythonFiles) {
    for (const name of pythonModuleNames(file)) moduleFiles.set(`${file.repoId}:${name}`, file);
  }

  const targets = new Map<string, CodeSymbol>();
  for (const file of pythonFiles) {
    const imports = pythonImportIndex(file, moduleFiles);
    for (const call of file.calls) {
      const receiver = call.receiver;
      const functionName = call.calleeName;
      if (!functionName) continue;
      const targetFile = receiver ? imports.modules.get(receiver) : undefined;
      const directTarget = !receiver ? imports.symbols.get(functionName) : undefined;
      const target = directTarget ?? (targetFile ? findTopLevelSymbol(targetFile, functionName) : undefined);
      if (target) targets.set(callKey(file.fileId, call.line, boundedRaw(call.raw)), target);
    }
  }
  return targets;
}

function pythonImportIndex(file: ParsedFile, moduleFiles: Map<string, ParsedFile>): { modules: Map<string, ParsedFile>; symbols: Map<string, CodeSymbol> } {
  const modules = new Map<string, ParsedFile>();
  const symbols = new Map<string, CodeSymbol>();
  for (const importRef of file.imports) {
    const targetFile = moduleFiles.get(`${file.repoId}:${importRef.module}`) ?? moduleFiles.get(`${file.repoId}:${importRef.module.split(".").at(-1)}`);
    if (!targetFile) continue;
    for (const binding of importRef.bindings || []) {
      if (binding.kind === "namespace") {
        modules.set(binding.localName, targetFile);
      } else if (binding.kind === "named") {
        if (binding.importedName && binding.importedName !== "*") {
          const symbol = findTopLevelSymbol(targetFile, binding.importedName);
          if (symbol) {
            symbols.set(binding.localName, symbol);
          }
        }
      }
    }
  }
  return { modules, symbols };
}

function pythonModuleNames(file: ParsedFile): string[] {
  const withoutExt = file.path.replace(/\.py$/, "").replace(/\/__init__$/, "");
  const dotted = withoutExt.split("/").filter(Boolean).join(".");
  const base = dotted.split(".").at(-1) ?? dotted;
  return Array.from(new Set([dotted, base].filter(Boolean)));
}

function buildGoPackageTargets(parsedFiles: ParsedFile[]): Map<string, CodeSymbol> {
  const goFiles = parsedFiles.filter((file) => file.language === "go");
  if (goFiles.length === 0) return new Map();
  const filesByPackage = new Map<string, ParsedFile[]>();
  for (const file of goFiles) {
    const packageName = goPackageName(file);
    if (!packageName) continue;
    const files = filesByPackage.get(`${file.repoId}:${packageName}`) ?? [];
    files.push(file);
    filesByPackage.set(`${file.repoId}:${packageName}`, files);
  }

  const targets = new Map<string, CodeSymbol>();
  for (const file of goFiles) {
    const importPackages = goImportIndex(file, filesByPackage);
    const currentPackageFiles = filesByPackage.get(`${file.repoId}:${goPackageName(file)}`) ?? [file];
    for (const call of file.calls) {
      const receiver = call.receiver;
      const functionName = call.calleeName;
      if (!functionName) continue;
      const files = receiver ? importPackages.get(receiver) : currentPackageFiles;
      if (!files) continue;
      const target = uniqueSymbols(files.flatMap((targetFile) => targetFile.symbols.filter((symbol) => symbol.kind === "function" && symbol.name === functionName))).at(0);
      if (target) targets.set(callKey(file.fileId, call.line, boundedRaw(call.raw)), target);
    }
  }
  return targets;
}

function goImportIndex(file: ParsedFile, filesByPackage: Map<string, ParsedFile[]>): Map<string, ParsedFile[]> {
  const imports = new Map<string, ParsedFile[]>();
  for (const importRef of file.imports) {
    const raw = importRef.raw.trim();
    const alias = raw.match(/^import\s+(\w+)\s+["']/)?.[1] ?? raw.match(/^(\w+)\s+["']/)?.[1];
    const packageName = alias ?? importRef.module.split("/").at(-1);
    if (!packageName || packageName === "_") continue;
    const files = filesByPackage.get(`${file.repoId}:${packageName}`);
    if (files) imports.set(packageName, files);
  }
  return imports;
}

function goPackageName(file: ParsedFile): string | undefined {
  return file.source?.match(/^\s*package\s+(\w+)/m)?.[1];
}

function findTopLevelSymbol(file: ParsedFile, name: string): CodeSymbol | undefined {
  return file.symbols.find((symbol) =>
    symbol.name === name &&
    (symbol.kind === "function" || symbol.kind === "class" || symbol.kind === "struct" || symbol.kind === "interface") &&
    !symbol.qualifiedName.includes(".")
  );
}

function buildJavaStaticTargets(parsedFiles: ParsedFile[]): Map<string, CodeSymbol> {
  const javaFiles = parsedFiles.filter((file) => file.language === "java");
  if (javaFiles.length === 0) return new Map();
  const classesByQualifiedName = new Map<string, CodeSymbol>();
  const methodsByOwnerAndName = new Map<string, CodeSymbol[]>();
  const filesById = new Map(javaFiles.map((file) => [file.fileId, file]));
  for (const file of javaFiles) {
    for (const symbol of file.symbols) {
      if (symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum") {
        classesByQualifiedName.set(symbol.qualifiedName, symbol);
      }
      if (symbol.kind === "method") {
        const owner = javaOwnerName(symbol);
        const list = methodsByOwnerAndName.get(`${owner}:${symbol.name}`) ?? [];
        list.push(symbol);
        methodsByOwnerAndName.set(`${owner}:${symbol.name}`, list);
      }
    }
  }

  const targets = new Map<string, CodeSymbol>();
  for (const file of javaFiles) {
    const packageName = file.facts?.packageName;
    const importIndex = javaImportIndex(file);
    const variableTypes = javaVariableTypes(file, importIndex, packageName, classesByQualifiedName);
    for (const call of file.calls) {
      const constructorType = call.raw.trim().startsWith("new ") ? call.calleeName : undefined;
      if (constructorType) {
        const classSymbol = classesByQualifiedName.get(resolveJavaTypeName(constructorType, importIndex, packageName, classesByQualifiedName));
        if (classSymbol) targets.set(callKey(file.fileId, call.line, boundedRaw(call.raw)), classSymbol);
        continue;
      }

      const receiver = call.receiver;
      const methodName = call.calleeName;
      if (!methodName) continue;
      const ownerName = receiver
        ? javaReceiverType(receiver, variableTypes, importIndex, packageName, classesByQualifiedName, call.callerSymbolId)
        : javaOwnerName(filesById.get(file.fileId)?.symbols.find((symbol) => symbol.id === call.callerSymbolId));
      if (!ownerName) continue;

      // Java enhancement stays intentionally bounded: package/import and the
      // receiver's declared class select the owner, then signature arity breaks
      // overload ties when the source shape is simple enough to count.
      const candidates = methodsByOwnerAndName.get(`${ownerName}:${methodName}`) ?? [];
      const byArity = candidates.filter((candidate) => javaSignatureArity(candidate.signature) === (call.argsCount ?? 0));
      const target = (byArity.length === 1 ? byArity : candidates).at(0);
      if (target) targets.set(callKey(file.fileId, call.line, boundedRaw(call.raw)), target);
    }
  }
  return targets;
}

function javaImportIndex(file: ParsedFile): { exact: Map<string, string>; wildcards: string[] } {
  const exact = new Map<string, string>();
  const wildcards: string[] = [];
  for (const importRef of file.imports) {
    if (importRef.module.endsWith(".*")) {
      wildcards.push(importRef.module.slice(0, -2));
      continue;
    }
    exact.set(importRef.module.split(".").at(-1) ?? importRef.module, importRef.module);
  }
  return { exact, wildcards };
}

let javaVariablesQuery: Parser.Query | undefined;

function getJavaVariablesQuery(): Parser.Query {
  if (!javaVariablesQuery) {
    const grammar = getLanguageGrammar("java");
    javaVariablesQuery = new Parser.Query(grammar, javaQueries.variables);
  }
  return javaVariablesQuery;
}

function javaVariableTypes(
  file: ParsedFile,
  imports: { exact: Map<string, string>; wildcards: string[] },
  packageName: string | undefined,
  classesByQualifiedName: Map<string, CodeSymbol>
): Map<string, string> {
  const types = new Map<string, string>();
  const source = file.source;
  if (!source) return types;

  const findContainingSymbol = (line: number): CodeSymbol | undefined => {
    return file.symbols
      .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
  };

  try {
    const parser = getCachedParser("java");
    const tree = parseTreeSitterSource(parser, source);

    const query = getJavaVariablesQuery();
    const matches = query.matches(tree.rootNode);

    for (const match of matches) {
      let typeText = "";
      let varName = "";
      let startLine = 1;
      for (const capture of match.captures) {
        if (capture.name === "variable.type") {
          typeText = capture.node.text.replace(/<.*$/, "").trim();
        } else if (capture.name === "variable.name") {
          varName = capture.node.text.trim();
          startLine = capture.node.startPosition.row + 1;
        }
      }
      if (typeText && varName) {
        const resolvedType = resolveJavaTypeName(typeText, imports, packageName, classesByQualifiedName);
        const container = findContainingSymbol(startLine);
        if (container && container.kind !== "class" && container.kind !== "interface" && container.kind !== "enum") {
          types.set(`${container.id}:${varName}`, resolvedType);
        } else {
          types.set(varName, resolvedType);
        }
      }
    }
  } catch (e) {
    warnReferenceResolution(`Java variable type extraction failed for ${file.path}`, e);
  }

  return types;
}

function javaReceiverType(
  receiver: string,
  variables: Map<string, string>,
  imports: { exact: Map<string, string>; wildcards: string[] },
  packageName: string | undefined,
  classesByQualifiedName: Map<string, CodeSymbol>,
  callerSymbolId?: string
): string {
  if (callerSymbolId) {
    const localKey = `${callerSymbolId}:${receiver}`;
    if (variables.has(localKey)) {
      return variables.get(localKey)!;
    }
  }
  return variables.get(receiver) ?? resolveJavaTypeName(receiver, imports, packageName, classesByQualifiedName);
}

function resolveJavaTypeName(typeName: string, imports: { exact: Map<string, string>; wildcards: string[] }, packageName: string | undefined, classesByQualifiedName: Map<string, CodeSymbol>): string {
  if (typeName.includes(".")) return typeName;
  const exact = imports.exact.get(typeName);
  if (exact) return exact;
  const samePackage = packageName ? `${packageName}.${typeName}` : undefined;
  if (samePackage && classesByQualifiedName.has(samePackage)) return samePackage;
  const wildcardHit = imports.wildcards.map((pkg) => `${pkg}.${typeName}`).find((qualifiedName) => classesByQualifiedName.has(qualifiedName));
  return wildcardHit ?? samePackage ?? typeName;
}

function javaOwnerName(symbol: CodeSymbol | undefined): string | undefined {
  if (!symbol) return undefined;
  if (symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "enum") return symbol.qualifiedName;
  return symbol.qualifiedName.split(".").slice(0, -1).join(".");
}

function javaSignatureArity(signature: string): number {
  const params = signature.match(/\(([\s\S]*)\)/)?.[1]?.trim();
  if (!params) return 0;
  return splitTopLevel(params).length;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(" || char === "<" || char === "[") depth += 1;
    if (char === ")" || char === ">" || char === "]") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function buildTypeScriptCompilerTargets(parsedFiles: ParsedFile[]): Map<string, CodeSymbol> {
  const ts = loadTypeScriptCompiler();
  if (!ts) return new Map();
  const sourceFiles = parsedFiles.filter((file) => isJavaScriptLike(file) && file.source && file.absolutePath);
  if (sourceFiles.length === 0) return new Map();

  try {
    const sourceByPath = new Map(sourceFiles.map((file) => [path.resolve(file.absolutePath!), file.source!]));
    const parsedByPath = new Map(sourceFiles.map((file) => [path.resolve(file.absolutePath!), file]));
    const host = ts.createCompilerHost({ allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true });
    const defaultGetSourceFile = host.getSourceFile.bind(host);
    const defaultReadFile = host.readFile.bind(host);
    const defaultFileExists = host.fileExists.bind(host);
    host.readFile = (fileName: string) => sourceByPath.get(path.resolve(fileName)) ?? defaultReadFile(fileName);
    host.fileExists = (fileName: string) => sourceByPath.has(path.resolve(fileName)) || defaultFileExists(fileName);
    host.getSourceFile = (fileName: string, languageVersion: any) => {
      const source = sourceByPath.get(path.resolve(fileName));
      return source !== undefined
        ? ts.createSourceFile(fileName, source, languageVersion, true)
        : defaultGetSourceFile(fileName, languageVersion);
    };
    const program = ts.createProgram(Array.from(sourceByPath.keys()), { allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true }, host);
    const checker = program.getTypeChecker();
    const targets = new Map<string, CodeSymbol>();

    for (const sourceFile of program.getSourceFiles()) {
      const parsed = parsedByPath.get(path.resolve(sourceFile.fileName));
      if (!parsed) continue;
      const visit = (node: any) => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const expression = ts.isNewExpression(node) ? node.expression : node.expression;
          const symbol = checker.getSymbolAtLocation(expression);
          const resolvedSymbol = symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
          const target = resolvedSymbol ? symbolFromDeclaration(ts, sourceFiles, resolvedSymbol.valueDeclaration ?? resolvedSymbol.declarations?.[0]) : undefined;
          if (target) targets.set(callKey(parsed.fileId, lineOf(ts, sourceFile, node), boundedRaw(node.getText(sourceFile))), target);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return targets;
  } catch (error) {
    warnReferenceResolution("TypeScript compiler target extraction failed", error);
    return new Map();
  }
}

function symbolFromDeclaration(ts: TypeScriptApi, parsedFiles: ParsedFile[], declaration: any): CodeSymbol | undefined {
  if (!declaration) return undefined;
  const declarationSourceFile = declaration.getSourceFile();
  const parsed = parsedFiles.find((file) => file.absolutePath && path.resolve(file.absolutePath) === path.resolve(declarationSourceFile.fileName));
  if (!parsed) return undefined;
  const name = declaration.name?.text;
  const line = lineOf(ts, declarationSourceFile, declaration.name ?? declaration);
  return parsed.symbols.find((symbol) => (!name || symbol.name === name) && symbol.startLine <= line && symbol.endLine >= line);
}

function loadTypeScriptCompiler(): TypeScriptApi | undefined {
  try {
    return require("typescript") as TypeScriptApi;
  } catch {
    return undefined;
  }
}

function isJavaScriptLike(file: ParsedFile): boolean {
  return file.language === "typescript" || file.language === "tsx" || file.language === "javascript" || file.language === "jsx";
}

function lineOf(_ts: TypeScriptApi, sourceFile: any, node: any): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function callKey(fileIdValue: string, line: number, raw: string): string {
  return `${fileIdValue}:${line}:${raw}`;
}

function buildImportedAliasTargets(
  parsedFiles: ParsedFile[],
  importsByFile: Map<string, string[]>,
  byName: Map<string, CodeSymbol[]>,
  reExportTargets: Map<string, CodeSymbol[]>
): Map<string, CodeSymbol[]> {
  const targets = new Map<string, CodeSymbol[]>();
  for (const file of parsedFiles) {
    const importedFileIds = new Set(importsByFile.get(file.fileId) ?? []);
    for (const importRef of file.imports) {
      if (importRef.raw.trim().startsWith("export ")) continue;
      const bindings = importRef.bindings ?? [];
      for (const binding of bindings) {
        if (binding.kind === "namespace") continue;
        const names = [binding.localName, binding.importedName].filter((name): name is string => Boolean(name && name !== "default"));
        for (const name of names) {
          const directSymbols = (byName.get(name) ?? []).filter((symbol) => importedFileIds.has(symbol.fileId));
          const barrelSymbols = Array.from(importedFileIds).flatMap((fileIdValue) => [
            ...(reExportTargets.get(`${fileIdValue}:${name}`) ?? []),
            ...(reExportTargets.get(`${fileIdValue}:*`) ?? [])
          ]);
          const symbols = uniqueSymbols([...directSymbols, ...barrelSymbols]);
          if (symbols.length > 0) {
            const key = `${file.fileId}:${binding.localName}`;
            targets.set(key, uniqueSymbols([...(targets.get(key) ?? []), ...symbols]));
          }
        }
      }
    }
  }
  return targets;
}

function buildReExportTargets(parsedFiles: ParsedFile[], importsByFile: Map<string, string[]>, byName: Map<string, CodeSymbol[]>): Map<string, CodeSymbol[]> {
  const targets = new Map<string, CodeSymbol[]>();
  for (const file of parsedFiles) {
    const exportedFileIds = new Set(importsByFile.get(file.fileId) ?? []);
    for (const importRef of file.imports.filter((item) => item.raw.trim().startsWith("export "))) {
      const bindings = importRef.bindings ?? [];
      for (const binding of bindings) {
        if (binding.localName === "*") {
          const symbols = parsedFiles.flatMap((candidateFile) => exportedFileIds.has(candidateFile.fileId) ? candidateFile.symbols : []);
          targets.set(`${file.fileId}:*`, uniqueSymbols([...(targets.get(`${file.fileId}:*`) ?? []), ...symbols]));
          continue;
        }
        const names = [binding.importedName, binding.localName].filter((name): name is string => Boolean(name));
        for (const name of names) {
          const symbols = (byName.get(name) ?? []).filter((symbol) => exportedFileIds.has(symbol.fileId));
          if (symbols.length > 0) {
            const key = `${file.fileId}:${binding.localName}`;
            targets.set(key, uniqueSymbols([...(targets.get(key) ?? []), ...symbols]));
          }
        }
      }
    }
  }
  return targets;
}

function aliasMatches(fileIdValue: string, calleeName: string, candidate: CodeSymbol, importedAliasTargets: Map<string, CodeSymbol[]>): boolean {
  return (importedAliasTargets.get(`${fileIdValue}:${calleeName}`) ?? []).some((symbol) => symbol.id === candidate.id);
}

function uniqueSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  return Array.from(new Map(symbols.map((symbol) => [symbol.id, symbol])).values());
}
