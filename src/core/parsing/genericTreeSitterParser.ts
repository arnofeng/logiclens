import Parser from "tree-sitter";
import type { LanguageParser, ParseInput } from "../registries/types.js";
import type { ParsedFile, LanguageExtractorConfig } from "./types.js";
import { getCachedParser, parseTreeSitterSource } from "./treeSitter.js";
import { getLanguageDefinition } from "./languages/registry.js";
import { extractSymbolsFromTreeSitter } from "../extraction/extractSymbols.js";
import { extractImportsFromTreeSitter } from "../extraction/extractImports.js";
import { extractCallsFromTreeSitter } from "../extraction/extractCalls.js";
import { extractLanguageFacts } from "./languageFacts.js";


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
    const parser = getCachedParser(this.config.language);
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

    const def = getLanguageDefinition(this.config.language);
    if (def?.postParse) {
      def.postParse(parsedFile);
    }

    return parsedFile;
  }
}

