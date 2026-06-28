import type Parser from "tree-sitter";
import type { ParsedFile } from "../types.js";
import { codeId } from "../../../shared/path.js";

import JavaScriptGrammar from "tree-sitter-javascript";
import JavaGrammar from "tree-sitter-java";
import TypeScriptModule from "tree-sitter-typescript";
import PythonGrammar from "tree-sitter-python";
import GoGrammar from "tree-sitter-go";

import { tsQueries, jsQueries } from "./typescript.js";
import { javaQueries } from "./java.js";
import { pythonQueries } from "./python.js";
import { goQueries } from "./go.js";

const grammars = TypeScriptModule as unknown as { typescript: unknown; tsx: unknown };

export type FactsDialect = "java-annotations" | "js-decorators" | "none";

export interface LanguageDefinition {
  id: string;
  extensions: string[];
  loadGrammar: () => unknown;
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
    loadGrammar: () => grammars.typescript,
    queries: tsQueries,
    factsDialect: "js-decorators",
  },
  {
    id: "tsx",
    extensions: [".tsx"],
    loadGrammar: () => grammars.tsx,
    queries: tsQueries,
    factsDialect: "js-decorators",
  },
  {
    id: "javascript",
    extensions: [".js"],
    loadGrammar: () => JavaScriptGrammar,
    queries: jsQueries,
    factsDialect: "js-decorators",
  },
  {
    id: "jsx",
    extensions: [".jsx"],
    loadGrammar: () => JavaScriptGrammar,
    queries: jsQueries,
    factsDialect: "js-decorators",
  },
  {
    id: "java",
    extensions: [".java"],
    loadGrammar: () => JavaGrammar,
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
    loadGrammar: () => PythonGrammar,
    queries: pythonQueries,
    factsDialect: "js-decorators",
  },
  {
    id: "go",
    extensions: [".go"],
    loadGrammar: () => GoGrammar,
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

export function getLanguageDefinition(id: string): LanguageDefinition | undefined {
  return byId.get(id);
}

export function languageDefForExtension(ext: string): LanguageDefinition | undefined {
  return byExt.get(ext);
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
