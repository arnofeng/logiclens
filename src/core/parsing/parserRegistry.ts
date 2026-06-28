import fs from "node:fs/promises";
import path from "node:path";
import Parser from "tree-sitter";
import { parseMarkdownDocument } from "./markdown/adapter.js";
import { LANGUAGE_DEFINITIONS, getLanguageDefinition, languageDefForExtension, type LanguageDefinition } from "./languages/registry.js";
import { GenericTreeSitterParser } from "./genericTreeSitterParser.js";
import { createVueParser } from "./languages/vue.js";
import { parserRegistry } from "../registries/registry.js";
import { fileId } from "../../shared/path.js";
import { hashText } from "../../shared/hash.js";
import type { DocumentLanguage, FileLanguage, ParsedDocument, ParsedFile, ParsedGraphFile, SourceLanguage } from "./types.js";
import type { LanguageParser } from "../registries/types.js";

const markdownParser: LanguageParser = {
  name: "builtin:markdown",
  language: "markdown",
  extensions: [".md", ".mdx"],
  parse(input) {
    return parseMarkdownDocument({
      repoId: input.repoId,
      fileId: input.fileId,
      relativePath: input.relativePath,
      source: input.source,
      hash: input.hash
    });
  }
};

function findTypeIdentifier(node: Parser.SyntaxNode): string | null {
  if (node.type === "type_identifier") return node.text;
  for (let i = 0; i < node.childCount; i++) {
    const res = findTypeIdentifier(node.child(i)!);
    if (res) return res;
  }
  return null;
}

function getQualifiedPrefix(node: Parser.SyntaxNode): string {
  if (node.type === "method_declaration") {
    const receiverNode = node.childForFieldName("receiver");
    if (receiverNode) {
      const typeName = findTypeIdentifier(receiverNode);
      if (typeName) {
        return typeName + ".";
      }
    }
  }
  const classes: string[] = [];
  let curr = node.parent;
  while (curr) {
    if (curr.type === "class_declaration" || curr.type === "class_definition") {
      const nameNode = curr.childForFieldName("name");
      if (nameNode) {
        classes.unshift(nameNode.text);
      }
    }
    curr = curr.parent;
  }
  return classes.length > 0 ? classes.join(".") + "." : "";
}

function createSourceParser(def: LanguageDefinition): LanguageParser {
  const grammar = def.loadGrammar();
  return new GenericTreeSitterParser({
    language: def.id,
    extensions: def.extensions,
    grammar,
    queries: def.queries,
    helpers: {
      getQualifiedPrefix: def.helpers?.getQualifiedPrefix ?? getQualifiedPrefix,
      getSignature: def.helpers?.getSignature
    }
  });
}

/**
 * P1-3 – File-level-only parser.
 *
 * Produces a ParsedFile with zero symbols, imports, and calls so that the
 * graph only records the FileNode. Framework extractors (e.g. Spring) can
 * then read these files directly to extract config key-value pairs without
 * a full AST parse.
 *
 * Suitable for: YAML, TOML, .properties config files.
 */
function createFileLevelParser(language: string, extensions: string[]): LanguageParser {
  return {
    name: `builtin:${language}`,
    language,
    extensions,
    parse(input) {
      const loc = input.source.split(/\r?\n/).length;
      const parsedFile: ParsedFile = {
        repoId: input.repoId,
        fileId: input.fileId,
        path: input.relativePath,
        language: input.language,
        hash: input.hash,
        loc,
        imports: [],
        symbols: [],
        calls: []
      };
      return Promise.resolve(parsedFile);
    }
  };
}


let builtinsRegistered = false;

export function builtinLanguageForPath(relativePath: string): string | undefined {
  const normalized = relativePath.split(path.sep).join("/");
  
  const staticExtensions = [
    [".mdx", "markdown"],
    [".md", "markdown"],
    [".yaml", "yaml"],
    [".yml", "yaml"],
    [".toml", "toml"],
    [".properties", "properties"],
    [".vue", "vue"]
  ];
  const matchedStatic = staticExtensions.find(([ext]) => normalized.endsWith(ext));
  if (matchedStatic) return matchedStatic[1];

  const ext = path.extname(normalized);
  const registryDef = languageDefForExtension(ext);
  if (registryDef) return registryDef.id;

  return undefined;
}

/**
 * Register built-in language parsers.
 *
 * P1-2 – Lazy grammar loading:
 * Pass a `languages` set (collected from scanned file extensions) to only load
 * the grammars that are actually needed for this repo. When omitted every
 * built-in language is registered (safe default for one-off calls).
 *
 * Markdown is always registered because it is needed for document indexing
 * regardless of the source language set.
 */
export function registerBuiltinParsers(languages?: Set<string>): void {
  if (builtinsRegistered && !languages) return;

  // Markdown is always needed (README, docs, MDX).
  if (!parserRegistry.resolve({ language: "markdown" })) {
    parserRegistry.register(markdownParser);
  }

  const should = (lang: string) => !languages || languages.has(lang);

  for (const def of LANGUAGE_DEFINITIONS) {
    if (should(def.id) && !parserRegistry.resolve({ language: def.id })) {
      parserRegistry.register(createSourceParser(def));
    }
  }

  if (should("vue") && !parserRegistry.resolve({ language: "vue" })) {
    const tsxDef = getLanguageDefinition("tsx")!;
    const jsxDef = getLanguageDefinition("jsx")!;
    const jsDef = getLanguageDefinition("javascript")!;
    if (!parserRegistry.resolve({ language: "tsx" })) {
      parserRegistry.register(createSourceParser(tsxDef));
    }
    if (!parserRegistry.resolve({ language: "jsx" })) {
      parserRegistry.register(createSourceParser(jsxDef));
    }
    if (!parserRegistry.resolve({ language: "javascript" })) {
      parserRegistry.register(createSourceParser(jsDef));
    }
    parserRegistry.register(createVueParser());
  }

  // P1-3: File-level-only parsers for config files — always register;
  // these are cheap (no grammar load) and needed across all repos.
  if (!parserRegistry.resolve({ language: "yaml" })) {
    parserRegistry.register(createFileLevelParser("yaml", [".yml", ".yaml"]));
  }
  if (!parserRegistry.resolve({ language: "toml" })) {
    parserRegistry.register(createFileLevelParser("toml", [".toml"]));
  }
  if (!parserRegistry.resolve({ language: "properties" })) {
    parserRegistry.register(createFileLevelParser("properties", [".properties"]));
  }

  if (!languages) builtinsRegistered = true;
}

export function parseSourceFile(input: {
  repoId: string;
  absolutePath: string;
  relativePath: string;
  language: SourceLanguage;
}): Promise<ParsedFile>;
export function parseSourceFile(input: {
  repoId: string;
  absolutePath: string;
  relativePath: string;
  language: DocumentLanguage;
}): Promise<ParsedDocument>;
export function parseSourceFile(input: {
  repoId: string;
  absolutePath: string;
  relativePath: string;
  language: FileLanguage;
}): Promise<ParsedGraphFile>;
export function parseSourceFile(input: {
  repoId: string;
  absolutePath: string;
  relativePath: string;
  language: string;
}): Promise<ParsedGraphFile>;
export async function parseSourceFile(input: {
  repoId: string;
  absolutePath: string;
  relativePath: string;
  language: FileLanguage | string;
}): Promise<ParsedGraphFile> {
  const source = await fs.readFile(input.absolutePath, "utf8");
  const normalizedPath = input.relativePath.split(path.sep).join("/");
  if (!parserRegistry.resolve({ language: input.language, relativePath: normalizedPath })) {
    registerBuiltinParsers(new Set([input.language]));
  }
  const id = fileId(input.repoId, normalizedPath);
  const hash = hashText(source);
  const parser = parserRegistry.resolve({ language: input.language, relativePath: normalizedPath });
  if (!parser) throw new Error(`No parser registered for ${input.language} (${normalizedPath}).`);
  return parser.parse({
    repoId: input.repoId,
    absolutePath: input.absolutePath,
    relativePath: normalizedPath,
    language: input.language,
    source,
    fileId: id,
    hash
  });
}
