import Parser from "tree-sitter";
import JavaScriptGrammar from "tree-sitter-javascript";
import JavaGrammar from "tree-sitter-java";
import TypeScriptModule from "tree-sitter-typescript";
import PythonGrammar from "tree-sitter-python";
import GoGrammar from "tree-sitter-go";
import type { SourceLanguage } from "./types.js";

const grammars = TypeScriptModule as unknown as { typescript: unknown; tsx: unknown };

export function getLanguageGrammar(language: SourceLanguage): any {
  return language === "tsx"
    ? grammars.tsx
    : language === "typescript"
      ? grammars.typescript
      : language === "java"
        ? JavaGrammar
        : language === "python"
          ? PythonGrammar
          : language === "go"
            ? GoGrammar
            : JavaScriptGrammar;
}

export function parseWithTreeSitter(source: string, language: SourceLanguage): Parser.Tree {
  const parser = new Parser();
  const grammar = getLanguageGrammar(language);
  parser.setLanguage(grammar as never);
  return parseTreeSitterSource(parser, source);
}

export function parseTreeSitterSource(parser: Parser, source: string): Parser.Tree {
  return parser.parse((index) => index < source.length ? source.slice(index, index + 8192) : null);
}
