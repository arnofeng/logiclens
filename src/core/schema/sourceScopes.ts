import path from "node:path";
import fs from "node:fs/promises";
import type { ParsedFile, ParsedGraphFile } from "../parsing/types.js";
import { fileId as sourceFileId } from "../../shared/path.js";
import type {
  ResolutionImportBinding,
  ResolutionScopeIdentity,
  SchemaDeclarationCandidate,
  TypeDeclarationFact
} from "./model.js";

export interface SchemaSourceResolutionContext {
  languageId: string;
  repoId: string;
  fileId: string;
  resolutionScopeId: string;
  namespaceId: string;
  imports: ResolutionImportBinding[];
}

export interface SchemaDeclarationVisibilityTarget {
  sources: { repoId: string; fileId: string }[];
  exactScopes: ResolutionScopeIdentity[];
  scopePrefixes: Array<{
    languageId: string;
    repoId: string;
    resolutionScopePrefix: string;
  }>;
}

export function schemaLanguageId(language: string): string {
  return language === "tsx" ? "typescript" : language;
}

export function resolutionScopeIdForFile(
  file: Pick<ParsedFile, "language" | "path" | "source">,
  options: { goImportPath?: string } = {}
): string {
  const languageId = schemaLanguageId(file.language);
  const normalizedPath = normalizePath(file.path);
  if (languageId === "go") {
    const packageName = file.source?.match(/^\s*package\s+([A-Za-z_]\w*)/mu)?.[1] ?? "unknown";
    const directory = path.posix.dirname(normalizedPath);
    const importPath = options.goImportPath ?? (directory === "." ? "" : directory);
    return `package:${normalizeGoImportPath(importPath)}:${packageName}`;
  }
  if (languageId === "typescript" || languageId === "javascript") {
    return `module:${modulePath(normalizedPath)}`;
  }
  if (languageId === "python") {
    return `module:${modulePath(normalizedPath).replace(/\//gu, ".")}`;
  }
  if (languageId === "graphql") return `module:${modulePath(normalizedPath)}`;
  if (languageId === "proto") {
    const packageName = file.source?.match(/^\s*package\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;/mu)?.[1];
    return `package:${packageName ?? path.posix.dirname(normalizedPath)}`;
  }
  if (languageId === "java") return javaResolutionScopeId(normalizedPath);
  if (languageId === "csharp") return `namespace:${csharpNamespace(file.source)}`;
  return `source:${normalizedPath}`;
}

/**
 * Computes the same canonical Go package scope used by declaration extraction.
 * Other languages are purely path/source based and remain synchronous.
 */
export async function canonicalResolutionScopeIdForFile(
  file: ParsedFile,
  repoPath?: string
): Promise<string> {
  if (schemaLanguageId(file.language) !== "go" || !repoPath) return resolutionScopeIdForFile(file);
  return resolutionScopeIdForFile(file, {
    goImportPath: await canonicalGoImportPath(file, repoPath)
  });
}

/**
 * Produces bounded, visibility-derived declaration lookups for changed source
 * files. Every selector comes from a source scope or an explicit import; this
 * deliberately never falls back to a repository-wide simple-name search.
 */
export async function schemaDeclarationVisibilityTarget(input: {
  files: readonly ParsedGraphFile[];
  candidates: readonly SchemaDeclarationCandidate[];
  repoPaths?: ReadonlyMap<string, string>;
}): Promise<SchemaDeclarationVisibilityTarget> {
  const sources = new Map<string, { repoId: string; fileId: string }>();
  const scopes = new Map<string, ResolutionScopeIdentity>();
  const prefixes = new Map<string, {
    languageId: string;
    repoId: string;
    resolutionScopePrefix: string;
  }>();
  const addSource = (repoId: string, fileId: string): void => {
    sources.set(`${repoId}\0${fileId}`, { repoId, fileId });
  };
  const addScope = (scope: ResolutionScopeIdentity): void => {
    scopes.set(`${scope.languageId}\0${scope.repoId}\0${scope.resolutionScopeId}`, scope);
  };
  const addPrefix = (languageId: string, repoId: string, resolutionScopePrefix: string): void => {
    prefixes.set(`${languageId}\0${repoId}\0${resolutionScopePrefix}`, {
      languageId,
      repoId,
      resolutionScopePrefix
    });
  };

  for (const candidate of input.candidates) addScope(candidate.declaration);
  for (const graphFile of input.files) {
    if (!("symbols" in graphFile)) continue;
    const file = graphFile;
    const languageId = schemaLanguageId(file.language);
    const candidateScopes = [...new Set(input.candidates
      .filter((candidate) => candidate.fileId === file.fileId
        && candidate.declaration.repoId === file.repoId
        && candidate.declaration.languageId === languageId)
      .map((candidate) => candidate.declaration.resolutionScopeId))];
    addScope({
      languageId,
      repoId: file.repoId,
      resolutionScopeId: candidateScopes.length === 1
        ? candidateScopes[0]!
        : await canonicalResolutionScopeIdForFile(file, input.repoPaths?.get(file.repoId))
    });
    for (const importRef of file.imports) {
      if (importRef.resolvedFileId) addSource(file.repoId, importRef.resolvedFileId);
      if (languageId === "typescript" || languageId === "javascript") {
        if (!importRef.module.startsWith(".")) continue;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(normalizePath(file.path)), importRef.module));
        addScope({ languageId, repoId: file.repoId, resolutionScopeId: `module:${modulePath(base)}` });
        addScope({ languageId, repoId: file.repoId, resolutionScopeId: `module:${modulePath(base)}/index` });
        continue;
      }
      if (languageId === "go") {
        const importPath = normalizeGoImportPath(importRef.module);
        if (importPath) addPrefix("go", file.repoId, `package:${importPath}:`);
        continue;
      }
      if (languageId === "java") {
        // The visibility query cannot address declarations by canonical name.
        // Load the bounded Java declaration catalog for this repository, then
        // bind only exact imports in addJavaImportBindings. This is catalog
        // discovery, never a simple-name resolution fallback.
        if (importRef.importKind !== "static") addPrefix("java", file.repoId, "module:");
        continue;
      }
      if (languageId === "proto") {
        const rootTarget = normalizePath(importRef.module);
        const relativeTarget = normalizePath(path.posix.join(path.posix.dirname(normalizePath(file.path)), importRef.module));
        addSource(file.repoId, sourceFileId(file.repoId, rootTarget));
        addSource(file.repoId, sourceFileId(file.repoId, relativeTarget));
        continue;
      }
      if (languageId === "python") {
        for (const targetPath of pythonImportTargetPaths(file, importRef.module)) {
          for (const candidatePath of [`${targetPath}.py`, `${targetPath}/__init__.py`]) {
            addSource(file.repoId, sourceFileId(file.repoId, candidatePath));
            addScope({
              languageId,
              repoId: file.repoId,
              resolutionScopeId: `module:${modulePath(candidatePath).replace(/\//gu, ".")}`
            });
          }
        }
        continue;
      }
      if (languageId === "graphql") {
        if (!importRef.module.startsWith(".")) continue;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(normalizePath(file.path)), importRef.module));
        addScope({ languageId, repoId: file.repoId, resolutionScopeId: `module:${modulePath(base)}` });
        continue;
      }
      if (languageId === "csharp") {
        const target = importRef.module.replace(/^global::/u, "");
        if (!target) continue;
        addScope({ languageId, repoId: file.repoId, resolutionScopeId: `namespace:${target}` });
        const parent = canonicalParent(target);
        if (parent) addScope({ languageId, repoId: file.repoId, resolutionScopeId: `namespace:${parent}` });
      }
    }
  }
  return {
    sources: [...sources.values()].sort(compareSources),
    exactScopes: [...scopes.values()].sort(compareScopes),
    scopePrefixes: [...prefixes.values()].sort((left, right) =>
      left.languageId.localeCompare(right.languageId)
      || left.repoId.localeCompare(right.repoId)
      || left.resolutionScopePrefix.localeCompare(right.resolutionScopePrefix))
  };
}

export function buildSchemaSourceContexts(
  files: readonly ParsedGraphFile[],
  declarations: readonly TypeDeclarationFact[],
  candidates: readonly SchemaDeclarationCandidate[]
): SchemaSourceResolutionContext[] {
  const codeFiles = files.filter((file): file is ParsedFile => "symbols" in file);
  const declarationsByFile = new Map<string, TypeDeclarationFact[]>();
  for (const declaration of declarations) {
    const list = declarationsByFile.get(declaration.fileId) ?? [];
    list.push(declaration);
    declarationsByFile.set(declaration.fileId, list);
  }
  const candidatePathByFile = new Map(candidates.map((candidate) => [candidate.fileId, normalizePath(candidate.filePath)]));
  const knownPathByFile = new Map<string, string>([
    ...candidates.map((candidate) => [candidate.fileId, normalizePath(candidate.filePath)] as const),
    ...codeFiles.map((file) => [file.fileId, normalizePath(file.path)] as const)
  ]);
  const contexts: SchemaSourceResolutionContext[] = [];
  for (const file of codeFiles) {
    const languageId = schemaLanguageId(file.language);
    const resolutionScopeId = sourceResolutionScopeId(file, languageId, declarationsByFile, declarations, candidatePathByFile);
    const imports = resolveVisibleImports(file, languageId, resolutionScopeId, declarations, declarationsByFile, knownPathByFile);
    contexts.push({
      languageId,
      repoId: file.repoId,
      fileId: file.fileId,
      resolutionScopeId,
      namespaceId: languageId === "java" ? `package:${javaPackageName(file.source)}` : resolutionScopeId,
      imports
    });
  }
  return contexts;
}

function resolveVisibleImports(
  file: ParsedFile,
  languageId: string,
  resolutionScopeId: string,
  declarations: readonly TypeDeclarationFact[],
  declarationsByFile: ReadonlyMap<string, readonly TypeDeclarationFact[]>,
  knownPathByFile: ReadonlyMap<string, string>
): ResolutionImportBinding[] {
  const result = new Map<string, ResolutionImportBinding>();
  if (languageId === "java") {
    addJavaImportBindings(result, file, resolutionScopeId, declarations);
    return [...result.values()].sort((a, b) => importKey(a).localeCompare(importKey(b)));
  }
  for (const declaration of declarations) {
    if (declaration.identity.languageId !== languageId
      || declaration.identity.repoId !== file.repoId
      || declaration.identity.resolutionScopeId !== resolutionScopeId) continue;
    addImport(result, {
      localName: localNameInScope(declaration.identity.canonicalName, languageId, resolutionScopeId),
      canonicalName: declaration.identity.canonicalName,
      declarationId: declaration.id,
      resolutionScopeId: declaration.identity.resolutionScopeId,
      kind: "named"
    });
  }
  if (languageId === "csharp") {
    for (const declaration of declarations) {
      if (declaration.identity.languageId !== "csharp" || declaration.identity.repoId !== file.repoId
        || !declaration.identity.canonicalName.includes(".")
        || !csharpSourceReferencesCanonical(file.source, declaration.identity.canonicalName)) continue;
      addImport(result, bindingFor(declaration.identity.canonicalName, declaration, "named"));
    }
  }
  for (const importRef of file.imports) {
    const targetDeclarations = declarationsForImport(file, languageId, importRef, declarations, declarationsByFile, knownPathByFile);
    if (languageId === "csharp") {
      addCsharpImportBindings(result, importRef, targetDeclarations);
      continue;
    }
    if (languageId === "proto") {
      addProtoImportBindings(result, resolutionScopeId, targetDeclarations);
      continue;
    }
    for (const binding of importRef.bindings ?? []) {
      if (binding.kind === "side-effect") continue;
      if (binding.kind === "namespace") {
        for (const declaration of targetDeclarations) {
          addImport(result, {
            localName: `${binding.localName}.${terminalName(declaration.identity.canonicalName)}`,
            canonicalName: declaration.identity.canonicalName,
            declarationId: declaration.id,
            resolutionScopeId: declaration.identity.resolutionScopeId,
            kind: "namespace"
          });
        }
        continue;
      }
      const importedName = binding.importedName === "default" ? undefined : binding.importedName;
      const matches = targetDeclarations.filter((declaration) => !importedName || terminalName(declaration.identity.canonicalName) === importedName);
      for (const declaration of matches) {
        addImport(result, {
          localName: binding.localName,
          canonicalName: declaration.identity.canonicalName,
          declarationId: declaration.id,
          resolutionScopeId: declaration.identity.resolutionScopeId,
          kind: binding.kind
        });
      }
    }
    if (languageId === "go") {
      for (const declaration of targetDeclarations) {
        const localNamespace = goImportAlias(importRef.raw) ?? goPackageNameFromScope(declaration.identity.resolutionScopeId);
        if (!localNamespace || localNamespace === "_") continue;
        const localName = localNamespace === "."
          ? terminalName(declaration.identity.canonicalName)
          : `${localNamespace}.${terminalName(declaration.identity.canonicalName)}`;
        addImport(result, {
          localName,
          canonicalName: declaration.identity.canonicalName,
          declarationId: declaration.id,
          resolutionScopeId: declaration.identity.resolutionScopeId,
          kind: "namespace"
        });
      }
    }
  }
  return [...result.values()].sort((a, b) => importKey(a).localeCompare(importKey(b)));
}

function addJavaImportBindings(
  result: Map<string, ResolutionImportBinding>,
  file: ParsedFile,
  resolutionScopeId: string,
  declarations: readonly TypeDeclarationFact[]
): void {
  const packageName = javaPackageName(file.source);
  const repoDeclarations = declarations.filter((declaration) => declaration.identity.languageId === "java"
    && declaration.identity.repoId === file.repoId);
  const sameScopeDeclarations = repoDeclarations.filter((declaration) => declaration.identity.resolutionScopeId === resolutionScopeId);
  const explicitImportDeclarations = repoDeclarations.filter((declaration) =>
    javaScopeVisibleForExplicitImport(resolutionScopeId, declaration.identity.resolutionScopeId));
  for (const declaration of sameScopeDeclarations) {
    const canonicalName = declaration.identity.canonicalName;
    if (canonicalName === packageName || canonicalName.startsWith(`${packageName}.`)) {
      const relative = packageName ? canonicalName.slice(packageName.length + 1) : canonicalName;
      if (relative && !relative.includes(".")) addImport(result, bindingFor(relative, declaration, "named"));
    }
    // FQNs are always legal in source and do not depend on import state.
    addImport(result, bindingFor(canonicalName, declaration, "namespace"));
  }
  const imports = [...(file.source ?? "").matchAll(/^\s*import\s+(?!static\s+)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$*][\w$*]*)*)\s*;/gmu)]
    .map((match) => match[1]!);
  for (const imported of imports) {
    if (imported.endsWith(".*")) {
      const namespace = imported.slice(0, -2);
      // Wildcards are not precise enough to infer a build dependency. Keep
      // them source-set local so main/test or sibling modules cannot leak into
      // one another through a same-package simple name.
      for (const declaration of sameScopeDeclarations) {
        if (javaDeclarationPackage(declaration.identity.canonicalName) === namespace) {
          addImport(result, bindingFor(terminalName(declaration.identity.canonicalName), declaration, "namespace"));
        }
      }
      continue;
    }
    // An explicit canonical import is deterministic even when the declaration
    // lives in another module/source set. The binding retains the target scope,
    // which is later persisted as a ResolutionScopeDependencyFact.
    for (const declaration of explicitImportDeclarations) {
      if (declaration.identity.canonicalName === imported) {
        addImport(result, bindingFor(terminalName(imported), declaration, "named"));
      } else if (declaration.identity.canonicalName.startsWith(`${imported}.`)) {
        addImport(result, bindingFor(declaration.identity.canonicalName.slice(imported.lastIndexOf(".") + 1), declaration, "named"));
      }
    }
  }
}

function javaScopeVisibleForExplicitImport(fromScopeId: string, targetScopeId: string): boolean {
  if (fromScopeId === targetScopeId) return true;
  const from = /^module:(.*):source-set:([^:]+)$/u.exec(fromScopeId);
  const target = /^module:(.*):source-set:([^:]+)$/u.exec(targetScopeId);
  if (!from || !target) return false;
  const [, fromModule, fromSourceSet] = from;
  const [, targetModule, targetSourceSet] = target;
  if (targetSourceSet === "main" || targetSourceSet?.startsWith("generated-")) return true;
  return fromModule === targetModule && fromSourceSet === "test" && targetSourceSet === "test";
}

function javaResolutionScopeId(normalizedPath: string): string {
  const match = /^(.*?)(?:\/)?src\/([^/]+)\/(?:java|kotlin)\//u.exec(normalizedPath);
  return match ? `module:${match[1] || "."}:source-set:${match[2]}` : "module:.:source-set:source";
}

function javaPackageName(source: string | undefined): string {
  return source?.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/mu)?.[1] ?? "";
}

function javaDeclarationPackage(canonicalName: string): string {
  const parts = canonicalName.split(".");
  const firstType = parts.findIndex((part) => /^[A-Z_$]/u.test(part));
  return (firstType < 0 ? parts.slice(0, -1) : parts.slice(0, firstType)).join(".");
}

function declarationsForImport(
  source: ParsedFile,
  languageId: string,
  importRef: ParsedFile["imports"][number],
  declarations: readonly TypeDeclarationFact[],
  declarationsByFile: ReadonlyMap<string, readonly TypeDeclarationFact[]>,
  knownPathByFile: ReadonlyMap<string, string>
): readonly TypeDeclarationFact[] {
  if (languageId === "typescript" || languageId === "javascript") {
    return declarationsForTsModule(source, importRef.module, declarationsByFile, knownPathByFile);
  }
  if (languageId === "go") return declarationsForGoImport(source, importRef.module, declarations);
  if (languageId === "proto") return declarationsForProtoImport(source, importRef.module, declarationsByFile, knownPathByFile);
  if (languageId === "csharp") return declarationsForCsharpImport(source, importRef, declarations);
  if (languageId === "python") return declarationsForPythonImport(source, importRef.module, declarationsByFile, knownPathByFile);
  if (languageId === "graphql") return declarationsForRelativePath(source, importRef.module, declarationsByFile, knownPathByFile, [".graphql", ".gql"]);
  return [];
}

function declarationsForTsModule(
  source: ParsedFile,
  moduleName: string,
  declarationsByFile: ReadonlyMap<string, readonly TypeDeclarationFact[]>,
  knownPathByFile: ReadonlyMap<string, string>
): readonly TypeDeclarationFact[] {
  if (!moduleName.startsWith(".")) return [];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(normalizePath(source.path)), moduleName));
  const matches: TypeDeclarationFact[] = [];
  for (const [fileId, filePath] of knownPathByFile) {
    if (modulePath(filePath) === modulePath(base) || modulePath(filePath) === `${modulePath(base)}/index`) {
      matches.push(...(declarationsByFile.get(fileId) ?? []));
    }
  }
  return matches;
}

function declarationsForGoImport(source: ParsedFile, moduleName: string, declarations: readonly TypeDeclarationFact[]): TypeDeclarationFact[] {
  const canonicalImportPath = normalizeGoImportPath(moduleName);
  return declarations.filter((declaration) => declaration.identity.languageId === "go"
    && declaration.identity.repoId === source.repoId
    && goImportPathFromScope(declaration.identity.resolutionScopeId) === canonicalImportPath);
}

function declarationsForProtoImport(
  source: ParsedFile,
  moduleName: string,
  declarationsByFile: ReadonlyMap<string, readonly TypeDeclarationFact[]>,
  knownPathByFile: ReadonlyMap<string, string>
): TypeDeclarationFact[] {
  const sourceRootPath = normalizePath(moduleName);
  const sourceRelativePath = normalizePath(path.posix.join(path.posix.dirname(normalizePath(source.path)), moduleName));
  // Protobuf imports are resolved against configured proto_path/source-set
  // roots. Repository-relative paths model that stable identity. Retain the
  // exact file-relative candidate for repositories that intentionally use it;
  // if both exist, both bindings remain visible and resolution is ambiguous.
  return declarationsAtExactPaths(
    source.repoId,
    "proto",
    new Set([sourceRootPath, sourceRelativePath]),
    declarationsByFile,
    knownPathByFile
  );
}

function declarationsForCsharpImport(
  source: ParsedFile,
  importRef: ParsedFile["imports"][number],
  declarations: readonly TypeDeclarationFact[]
): TypeDeclarationFact[] {
  const target = importRef.module.replace(/^global::/u, "");
  return declarations.filter((declaration) => {
    if (declaration.identity.languageId !== "csharp" || declaration.identity.repoId !== source.repoId) return false;
    if (importRef.importKind === "static") return canonicalParent(declaration.identity.canonicalName) === target;
    if (importRef.importKind === "alias") {
      return declaration.identity.canonicalName === target || isDirectNamespaceMember(declaration, target);
    }
    return isDirectNamespaceMember(declaration, target);
  });
}

function declarationsForPythonImport(
  source: ParsedFile,
  moduleName: string,
  declarationsByFile: ReadonlyMap<string, readonly TypeDeclarationFact[]>,
  knownPathByFile: ReadonlyMap<string, string>
): TypeDeclarationFact[] {
  const leadingDots = moduleName.match(/^\.+/u)?.[0].length ?? 0;
  const module = moduleName.slice(leadingDots).replace(/\./gu, "/");
  let base = leadingDots > 0 ? path.posix.dirname(normalizePath(source.path)) : "";
  for (let index = 1; index < leadingDots; index++) base = path.posix.dirname(base);
  const target = normalizePath(path.posix.join(base, module));
  return declarationsAtExactPaths(source.repoId, "python", new Set([`${target}.py`, `${target}/__init__.py`]), declarationsByFile, knownPathByFile);
}

function declarationsForRelativePath(
  source: ParsedFile,
  moduleName: string,
  declarationsByFile: ReadonlyMap<string, readonly TypeDeclarationFact[]>,
  knownPathByFile: ReadonlyMap<string, string>,
  extensions: readonly string[]
): TypeDeclarationFact[] {
  if (!moduleName.startsWith(".")) return [];
  const base = normalizePath(path.posix.join(path.posix.dirname(normalizePath(source.path)), moduleName));
  const paths = new Set([base, ...extensions.map((extension) => `${base}${extension}`)]);
  return declarationsAtExactPaths(source.repoId, schemaLanguageId(source.language), paths, declarationsByFile, knownPathByFile);
}

function declarationsAtExactPaths(
  repoId: string,
  languageId: string,
  paths: ReadonlySet<string>,
  declarationsByFile: ReadonlyMap<string, readonly TypeDeclarationFact[]>,
  knownPathByFile: ReadonlyMap<string, string>
): TypeDeclarationFact[] {
  const matches: TypeDeclarationFact[] = [];
  for (const [fileId, filePath] of knownPathByFile) {
    if (!paths.has(normalizePath(filePath))) continue;
    matches.push(...(declarationsByFile.get(fileId) ?? []).filter((declaration) => declaration.identity.repoId === repoId
      && declaration.identity.languageId === languageId));
  }
  return matches;
}

function addCsharpImportBindings(
  result: Map<string, ResolutionImportBinding>,
  importRef: ParsedFile["imports"][number],
  declarations: readonly TypeDeclarationFact[]
): void {
  for (const declaration of declarations) {
    if (importRef.importKind === "alias" && importRef.alias) {
      const localName = declaration.identity.canonicalName === importRef.module
        ? importRef.alias
        : `${importRef.alias}.${terminalName(declaration.identity.canonicalName)}`;
      addImport(result, bindingFor(localName, declaration, "named"));
      continue;
    }
    addImport(result, bindingFor(terminalName(declaration.identity.canonicalName), declaration, "namespace"));
  }
}

function addProtoImportBindings(
  result: Map<string, ResolutionImportBinding>,
  sourceScopeId: string,
  declarations: readonly TypeDeclarationFact[]
): void {
  const sourcePackage = sourceScopeId.startsWith("package:") ? sourceScopeId.slice("package:".length) : "";
  for (const declaration of declarations) {
    const canonicalName = declaration.identity.canonicalName;
    const names = new Set([canonicalName]);
    const sourceParts = sourcePackage.split(".").filter(Boolean);
    const canonicalParts = canonicalName.split(".").filter(Boolean);
    for (let length = sourceParts.length; length > 0; length--) {
      const ancestor = sourceParts.slice(0, length).join(".");
      if (canonicalParts.slice(0, length).join(".") === ancestor && canonicalParts.length > length) {
        names.add(canonicalParts.slice(length).join("."));
      }
    }
    for (const localName of names) addImport(result, bindingFor(localName, declaration, "namespace"));
  }
}

function bindingFor(localName: string, declaration: TypeDeclarationFact, kind: ResolutionImportBinding["kind"]): ResolutionImportBinding {
  return {
    localName,
    canonicalName: declaration.identity.canonicalName,
    declarationId: declaration.id,
    resolutionScopeId: declaration.identity.resolutionScopeId,
    kind
  };
}

function isDirectNamespaceMember(declaration: TypeDeclarationFact, namespace: string): boolean {
  if (declaration.identity.resolutionScopeId !== `namespace:${namespace || "<global>"}`) return false;
  const relativeName = namespace ? declaration.identity.canonicalName.slice(namespace.length + 1) : declaration.identity.canonicalName;
  return Boolean(relativeName) && !relativeName.includes(".");
}

function canonicalParent(canonicalName: string): string {
  return canonicalName.split(".").slice(0, -1).join(".");
}

function addImport(target: Map<string, ResolutionImportBinding>, binding: ResolutionImportBinding): void {
  target.set(importKey(binding), binding);
}

function importKey(binding: ResolutionImportBinding): string {
  return `${binding.localName}\0${binding.declarationId}`;
}

function goImportAlias(raw: string): string | undefined {
  return raw.trim().match(/^(?:import\s+)?([A-Za-z_]\w*|\.)\s+["']/u)?.[1];
}

function terminalName(value: string): string {
  return value.split(/[.$/]/u).at(-1) ?? value;
}

function localNameInScope(canonicalName: string, languageId: string, resolutionScopeId: string): string {
  if (languageId === "csharp" && resolutionScopeId.startsWith("namespace:")) {
    const namespace = resolutionScopeId.slice("namespace:".length);
    return namespace === "<global>" ? canonicalName : canonicalName.replace(new RegExp(`^${escapeRegExp(namespace)}\\.`), "");
  }
  if (languageId === "proto" && resolutionScopeId.startsWith("package:")) {
    const packageName = resolutionScopeId.slice("package:".length);
    return canonicalName.replace(new RegExp(`^${escapeRegExp(packageName)}\\.`), "");
  }
  return terminalName(canonicalName);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function modulePath(value: string): string {
  return normalizePath(value).replace(/\.(?:d\.)?(?:tsx?|jsx?|mjs|cjs)$/u, "");
}

function normalizePath(value: string): string {
  return path.posix.normalize(value.replace(/\\/gu, "/")).replace(/^\.\//u, "");
}

function sourceResolutionScopeId(
  file: ParsedFile,
  languageId: string,
  declarationsByFile: ReadonlyMap<string, readonly TypeDeclarationFact[]>,
  declarations: readonly TypeDeclarationFact[],
  candidatePathByFile: ReadonlyMap<string, string>
): string {
  const localScopes = [...new Set((declarationsByFile.get(file.fileId) ?? [])
    .filter((declaration) => declaration.identity.languageId === languageId && declaration.identity.repoId === file.repoId)
    .map((declaration) => declaration.identity.resolutionScopeId))];
  if (localScopes.length === 1) return localScopes[0]!;
  if (languageId === "go") {
    const packageName = file.source?.match(/^\s*package\s+([A-Za-z_]\w*)/mu)?.[1];
    const directory = path.posix.dirname(normalizePath(file.path));
    const packageScopes = [...new Set(declarations
      .filter((declaration) => declaration.identity.languageId === "go"
        && declaration.identity.repoId === file.repoId
        && goPackageNameFromScope(declaration.identity.resolutionScopeId) === packageName
        && path.posix.dirname(candidatePathByFile.get(declaration.fileId) ?? "") === directory)
      .map((declaration) => declaration.identity.resolutionScopeId))];
    if (packageScopes.length === 1) return packageScopes[0]!;
  }
  return resolutionScopeIdForFile(file);
}

function normalizeGoImportPath(value: string): string {
  return value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

function goImportPathFromScope(scopeId: string): string | undefined {
  const match = scopeId.match(/^package:(.*):([A-Za-z_]\w*)$/u);
  return match ? normalizeGoImportPath(match[1]!) : undefined;
}

function goPackageNameFromScope(scopeId: string): string | undefined {
  return scopeId.match(/^package:(.*):([A-Za-z_]\w*)$/u)?.[2];
}

function csharpNamespace(source: string | undefined): string {
  return source?.match(/^\s*namespace\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:;|\{)/mu)?.[1] ?? "<global>";
}

function csharpSourceReferencesCanonical(source: string | undefined, canonicalName: string): boolean {
  if (!source) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9_.])(?:global::)?${escapeRegExp(canonicalName)}(?=$|[^A-Za-z0-9_])`, "mu").test(source);
}

async function canonicalGoImportPath(file: ParsedFile, repoPath: string): Promise<string | undefined> {
  const repoRoot = path.resolve(repoPath);
  const absolutePath = path.resolve(file.absolutePath ?? path.join(repoRoot, file.path));
  const packageDirectory = path.dirname(absolutePath);
  let directory = packageDirectory;
  while (directory === repoRoot || directory.startsWith(`${repoRoot}${path.sep}`)) {
    try {
      const source = await fs.readFile(path.join(directory, "go.mod"), "utf8");
      const moduleName = source.match(/^\s*module\s+([^\s]+)\s*$/mu)?.[1]?.trim();
      if (!moduleName) return undefined;
      const relativePackage = path.relative(directory, packageDirectory).replace(/\\/gu, "/");
      return relativePackage ? `${moduleName.replace(/\/$/u, "")}/${relativePackage}` : moduleName;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function pythonImportTargetPaths(source: ParsedFile, moduleName: string): string[] {
  const leadingDots = moduleName.match(/^\.+/u)?.[0].length ?? 0;
  const module = moduleName.slice(leadingDots).replace(/\./gu, "/");
  let base = leadingDots > 0 ? path.posix.dirname(normalizePath(source.path)) : "";
  for (let index = 1; index < leadingDots; index++) base = path.posix.dirname(base);
  const target = normalizePath(path.posix.join(base, module));
  return target ? [target] : [];
}

function compareSources(
  left: { repoId: string; fileId: string },
  right: { repoId: string; fileId: string }
): number {
  return left.repoId.localeCompare(right.repoId) || left.fileId.localeCompare(right.fileId);
}

function compareScopes(left: ResolutionScopeIdentity, right: ResolutionScopeIdentity): number {
  return left.languageId.localeCompare(right.languageId)
    || left.repoId.localeCompare(right.repoId)
    || left.resolutionScopeId.localeCompare(right.resolutionScopeId);
}
