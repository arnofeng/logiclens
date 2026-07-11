import fs from "node:fs/promises";
import path from "node:path";
import Parser from "tree-sitter";
import { parseMarkdownDocument } from "./markdown/adapter.js";
import { LANGUAGE_DEFINITIONS, getLanguageDefinition, languageDefForExtension, loadLanguageGrammar, type LanguageDefinition } from "./languages/registry.js";
import { LazyTreeSitterParser } from "./lazyTreeSitterParser.js";
import { createVueParser } from "./languages/vue.js";
import { createGraphqlParser } from "./languages/graphql.js";
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
    if (
      curr.type === "class_declaration" ||
      curr.type === "class_definition" ||
      curr.type === "interface_declaration" ||
      curr.type === "enum_declaration"
    ) {
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
  return new LazyTreeSitterParser(def, {
    getQualifiedPrefix: def.helpers?.getQualifiedPrefix ?? getQualifiedPrefix,
    getSignature: def.helpers?.getSignature
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

function createSourceOnlyParser(language: string, extensions: string[], sourceFilter?: (source: string) => boolean): LanguageParser {
  return {
    name: `builtin:${language}`,
    language,
    extensions,
    parse(input) {
      const loc = input.source.split(/\r?\n/).length;
      const shouldKeepSource = sourceFilter ? sourceFilter(input.source) : true;
      const parsedFile: ParsedFile = {
        repoId: input.repoId,
        fileId: input.fileId,
        path: input.relativePath,
        absolutePath: input.absolutePath,
        language: input.language,
        hash: input.hash,
        loc,
        source: shouldKeepSource ? input.source : undefined,
        imports: [],
        symbols: [],
        calls: []
      };
      return Promise.resolve(parsedFile);
    }
  };
}

function hasDubboXmlConfig(source: string): boolean {
  return /<dubbo:(?:service|reference)\b/i.test(source) ||
    /xmlns:dubbo\s*=\s*["'][^"']*dubbo[^"']*["']/i.test(source);
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
    [".vue", "vue"],
    [".proto", "proto"],
    [".xml", "xml"],
    [".graphql", "graphql"],
    [".gql", "graphql"]
  ];
  const matchedStatic = staticExtensions.find(([ext]) => normalized.endsWith(ext));
  if (matchedStatic) return matchedStatic[1];

  const ext = path.extname(normalized);
  const registryDef = languageDefForExtension(ext);
  if (registryDef) return registryDef.id;

  return undefined;
}

function createProtoParser(): LanguageParser {
  return {
    name: "builtin:proto",
    language: "proto",
    extensions: [".proto"],
    parse(input) {
      const loc = input.source.split(/\r?\n/).length;
      const parsedFile: ParsedFile = {
        repoId: input.repoId,
        fileId: input.fileId,
        path: input.relativePath,
        absolutePath: input.absolutePath,
        language: input.language,
        hash: input.hash,
        loc,
        source: input.source,
        imports: [],
        symbols: [],
        calls: []
      };
      return Promise.resolve(parsedFile);
    }
  };
}

/**
 * Register built-in language parsers.
 *
 * P1-2 – Lazy grammar loading:
 * Pass a `languages` set (collected from scanned file extensions) to only
 * register parsers that are actually needed for this repo. Tree-sitter
 * grammars are loaded on first AST use. When omitted every
 * built-in language is registered (safe default for one-off calls).
 *
 * Markdown is always registered because it is needed for document indexing
 * regardless of the source language set.
 */
export async function registerBuiltinParsers(languages?: Set<string>): Promise<void> {
  if (builtinsRegistered && !languages) return;

  registerCommonParsers();

  const should = (lang: string) => !languages || languages.has(lang);

  for (const def of LANGUAGE_DEFINITIONS) {
    if (should(def.id) && !parserRegistry.resolve({ language: def.id })) {
      parserRegistry.register(createSourceParser(def));
    }
  }

  if (should("vue") && !parserRegistry.resolve({ language: "vue" })) {
    const tsDef = getLanguageDefinition("typescript")!;
    const tsxDef = getLanguageDefinition("tsx")!;
    const jsxDef = getLanguageDefinition("jsx")!;
    const jsDef = getLanguageDefinition("javascript")!;
    if (!parserRegistry.resolve({ language: "typescript" })) {
      parserRegistry.register(createSourceParser(tsDef));
    }
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

  if (!languages) builtinsRegistered = true;
}

export async function ensureBuiltinGrammarsForParsedFiles(
  parsedFiles: readonly ParsedGraphFile[]
): Promise<void> {
  const definitions = new Map<string, LanguageDefinition>();
  for (const file of parsedFiles) {
    const language = file.language === "vue" && "parseLanguage" in file
      ? file.parseLanguage ?? "tsx"
      : file.language === "vue"
        ? "tsx"
        : file.language;
    const definition = getLanguageDefinition(language);
    if (definition) definitions.set(definition.id, definition);
  }
  await Promise.all([...definitions.values()].map((definition) => loadLanguageGrammar(definition)));
}

export function registerCommonParsers(): void {
  if (!parserRegistry.resolve({ language: "markdown" })) {
    parserRegistry.register(markdownParser);
  }
  if (!parserRegistry.resolve({ language: "proto" })) {
    parserRegistry.register(createProtoParser());
  }
  if (!parserRegistry.resolve({ language: "graphql" })) {
    parserRegistry.register(createGraphqlParser());
  }
  if (!parserRegistry.resolve({ language: "yaml" })) {
    parserRegistry.register(createFileLevelParser("yaml", [".yml", ".yaml"]));
  }
  if (!parserRegistry.resolve({ language: "toml" })) {
    parserRegistry.register(createFileLevelParser("toml", [".toml"]));
  }
  if (!parserRegistry.resolve({ language: "properties" })) {
    parserRegistry.register(createFileLevelParser("properties", [".properties"]));
  }
  if (!parserRegistry.resolve({ language: "xml" })) {
    parserRegistry.register(createSourceOnlyParser("xml", [".xml"], hasDubboXmlConfig));
  }
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
  const id = fileId(input.repoId, normalizedPath);
  const hash = hashText(source);
  let parser = parserRegistry.resolve({ language: input.language, relativePath: normalizedPath });
  if (!parser) {
    await registerBuiltinParsers(new Set([input.language]));
    parser = parserRegistry.resolve({ language: input.language, relativePath: normalizedPath });
  }
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
