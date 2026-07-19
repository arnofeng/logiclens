import type { LanguageParser } from "../../registries/types.js";
import type { ParsedFile } from "../types.js";
import { parserExtensionsFor } from "../extensionMetadata.js";

export function createGraphqlParser(): LanguageParser {
  return {
    name: "builtin:graphql",
    language: "graphql",
    extensions: parserExtensionsFor("graphql"),
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
