import Parser from "tree-sitter";
import type { LanguageParser, ParseInput } from "../plugins/types.js";
import type { ParsedFile, LanguageExtractorConfig } from "./types.js";
import { parseTreeSitterSource } from "./treeSitter.js";
import { extractSymbolsFromTreeSitter } from "../extraction/extractSymbols.js";
import { extractImportsFromTreeSitter } from "../extraction/extractImports.js";
import { extractCallsFromTreeSitter } from "../extraction/extractCalls.js";
import { extractLanguageFacts } from "./languageFacts.js";
import { codeId } from "../../shared/path.js";

export class GenericTreeSitterParser implements LanguageParser {
  private queriesCache = new Map<string, Parser.Query>();

  constructor(private config: LanguageExtractorConfig) {}

  get name(): string {
    return `builtin:${this.config.language}`;
  }

  get language(): string {
    return this.config.language;
  }

  get extensions(): string[] {
    return this.config.extensions;
  }

  private getQuery(type: "symbols" | "imports" | "calls"): Parser.Query {
    const key = `${this.config.language}:${type}`;
    let query = this.queriesCache.get(key);
    if (!query) {
      query = new Parser.Query(this.config.grammar, this.config.queries[type]);
      this.queriesCache.set(key, query);
    }
    return query;
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    const parser = new Parser();
    parser.setLanguage(this.config.grammar);
    const tree = parseTreeSitterSource(parser, input.source);

    const symbolsQuery = this.getQuery("symbols");
    const importsQuery = this.getQuery("imports");
    const callsQuery = this.getQuery("calls");

    const symbols = extractSymbolsFromTreeSitter({
      repoId: input.repoId,
      relativePath: input.relativePath,
      tree,
      fileId: input.fileId,
      language: this.config.language,
      query: symbolsQuery,
      getQualifiedPrefix: this.config.helpers.getQualifiedPrefix,
      getSignature: this.config.helpers.getSignature
    });

    const imports = extractImportsFromTreeSitter(
      tree,
      input.fileId,
      this.config.language,
      importsQuery,
      input.relativePath
    );

    const calls = extractCallsFromTreeSitter(
      tree,
      input.fileId,
      this.config.language,
      symbols,
      callsQuery
    );

    const parsedFile: ParsedFile = {
      repoId: input.repoId,
      fileId: input.fileId,
      path: input.relativePath,
      absolutePath: input.absolutePath,
      language: this.config.language,
      hash: input.hash,
      loc: input.source.split(/\r?\n/).length,
      source: input.source,
      imports,
      symbols,
      calls
    };
    parsedFile.facts = extractLanguageFacts({ parsedFile, source: input.source, tree });

    // P0-3: For Java files that declare a package, prefix every symbol's
    // qualifiedName with the package name so cross-repo disambiguation works.
    // e.g.  "UserService.createUser"  →  "com.example.service.UserService.createUser"
    // The id is also recomputed so DB lookups remain consistent.
    if (this.config.language === "java") {
      const packageName = parsedFile.facts?.packageName;
      if (packageName) {
        applyJavaPackagePrefix(parsedFile, packageName);
      }
    }

    return parsedFile;
  }
}

/**
 * Prepend `packageName` to every symbol's qualifiedName (and recompute its id)
 * for a Java ParsedFile. Only called when the file has a `package` declaration.
 *
 * Keeps all symbol id references in facts and calls aligned with the new id.
 */
function applyJavaPackagePrefix(parsedFile: ParsedFile, packageName: string): void {
  const idMap = new Map<string, string>();
  for (const symbol of parsedFile.symbols) {
    // Avoid double-prefixing if re-indexed (qualifiedName already starts with package)
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
