import type Parser from "tree-sitter";
import type { ParsedFile } from "../types.js";
import { codeId } from "../../../shared/path.js";

import { tsQueries, jsQueries } from "./typescript.js";
import { javaQueries } from "./java.js";
import { pythonQueries } from "./python.js";
import { goQueries } from "./go.js";

export type FactsDialect = "java-annotations" | "js-decorators" | "none";

export interface LanguageDefinition {
  id: string;
  extensions: string[];
  loadGrammar: () => Promise<unknown>;
  queries: { symbols: string; imports: string; calls: string };
  factsDialect: FactsDialect;
  helpers?: {
    getQualifiedPrefix?(node: Parser.SyntaxNode): string;
    getSignature?(node: Parser.SyntaxNode): string;
  };
  postParse?: (parsedFile: ParsedFile) => void;
}

export const LANGUAGE_DEFINITIONS: LanguageDefinition[] = [
  {
    id: "typescript",
    extensions: [".ts"],
    loadGrammar: async () => {
      const module = await import("tree-sitter-typescript") as unknown as { default?: { typescript: unknown }; typescript?: unknown };
      return module.default?.typescript ?? module.typescript;
    },
    queries: tsQueries,
    factsDialect: "js-decorators",
  },
  {
    id: "tsx",
    extensions: [".tsx"],
    loadGrammar: async () => {
      const module = await import("tree-sitter-typescript") as unknown as { default?: { tsx: unknown }; tsx?: unknown };
      return module.default?.tsx ?? module.tsx;
    },
    queries: tsQueries,
    factsDialect: "js-decorators",
  },
  {
    id: "javascript",
    extensions: [".js"],
    loadGrammar: async () => {
      const module = await import("tree-sitter-javascript") as { default: unknown };
      return module.default;
    },
    queries: jsQueries,
    factsDialect: "js-decorators",
  },
  {
    id: "jsx",
    extensions: [".jsx"],
    loadGrammar: async () => {
      const module = await import("tree-sitter-javascript") as { default: unknown };
      return module.default;
    },
    queries: jsQueries,
    factsDialect: "js-decorators",
  },
  {
    id: "java",
    extensions: [".java"],
    loadGrammar: async () => {
      const module = await import("tree-sitter-java") as { default: unknown };
      return module.default;
    },
    queries: javaQueries,
    factsDialect: "java-annotations",
    postParse: (parsedFile: ParsedFile) => {
      const packageName = parsedFile.facts?.packageName;
      if (packageName) {
        applyJavaPackagePrefix(parsedFile, packageName);
      }
    }
  },
  {
    id: "python",
    extensions: [".py"],
    loadGrammar: async () => {
      const module = await import("tree-sitter-python") as { default: unknown };
      return module.default;
    },
    queries: pythonQueries,
    factsDialect: "js-decorators",
  },
  {
    id: "go",
    extensions: [".go"],
    loadGrammar: async () => {
      const module = await import("tree-sitter-go") as { default: unknown };
      return module.default;
    },
    queries: goQueries,
    factsDialect: "none",
  },
];

const byId = new Map<string, LanguageDefinition>(
  LANGUAGE_DEFINITIONS.map((d) => [d.id, d])
);

const byExt = new Map<string, LanguageDefinition>(
  LANGUAGE_DEFINITIONS.flatMap((d) => d.extensions.map((e) => [e, d] as const))
);

const loadedGrammars = new Map<string, unknown>();
const loadingGrammars = new Map<string, Promise<unknown>>();

export function getLanguageDefinition(id: string): LanguageDefinition | undefined {
  return byId.get(id);
}

export function languageDefForExtension(ext: string): LanguageDefinition | undefined {
  return byExt.get(ext);
}

export async function loadLanguageGrammar(def: LanguageDefinition): Promise<unknown> {
  if (loadedGrammars.has(def.id)) return loadedGrammars.get(def.id);

  let loading = loadingGrammars.get(def.id);
  if (!loading) {
    loading = def.loadGrammar()
      .then((grammar) => {
        loadedGrammars.set(def.id, grammar);
        return grammar;
      })
      .finally(() => {
        loadingGrammars.delete(def.id);
      });
    loadingGrammars.set(def.id, loading);
  }
  return loading;
}

export function getLoadedLanguageGrammar(id: string): unknown | undefined {
  return loadedGrammars.get(id);
}

function applyJavaPackagePrefix(parsedFile: ParsedFile, packageName: string): void {
  const idMap = new Map<string, string>();
  for (const symbol of parsedFile.symbols) {
    if (symbol.qualifiedName.startsWith(packageName + ".")) continue;

    const oldId = symbol.id;
    const oldQN = symbol.qualifiedName;
    symbol.qualifiedName = `${packageName}.${oldQN}`;
    symbol.id = codeId(symbol.repoId, parsedFile.path, symbol.kind, symbol.qualifiedName, symbol.startLine);
    idMap.set(oldId, symbol.id);
  }

  if (idMap.size === 0) return;

  for (const call of parsedFile.calls) {
    if (call.callerSymbolId) {
      call.callerSymbolId = idMap.get(call.callerSymbolId) ?? call.callerSymbolId;
    }
  }

  if (!parsedFile.facts) return;
  parsedFile.facts.symbols = parsedFile.symbols;
  for (const annotation of parsedFile.facts.annotations) {
    if (annotation.ownerSymbolId) {
      annotation.ownerSymbolId = idMap.get(annotation.ownerSymbolId) ?? annotation.ownerSymbolId;
    }
  }
  for (const decorator of parsedFile.facts.decorators) {
    if (decorator.ownerSymbolId) {
      decorator.ownerSymbolId = idMap.get(decorator.ownerSymbolId) ?? decorator.ownerSymbolId;
    }
  }
  for (const literal of parsedFile.facts.literals) {
    if (literal.ownerSymbolId) {
      literal.ownerSymbolId = idMap.get(literal.ownerSymbolId) ?? literal.ownerSymbolId;
    }
  }
}
