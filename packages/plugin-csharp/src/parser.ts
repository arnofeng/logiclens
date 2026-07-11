import type { PluginParseInput, PluginParseResult } from "@logiclens/plugin-sdk";

type Tree = { rootNode: { type: string; hasError: boolean } };
type ParserInstance = {
  setLanguage(language: unknown): void;
  parse(source: string): Tree;
};
type ParserConstructor = new () => ParserInstance;
type ModuleLoader = (specifier: string) => Promise<unknown>;

function moduleDefault(moduleValue: unknown): unknown {
  if (moduleValue && typeof moduleValue === "object" && "default" in moduleValue) {
    return (moduleValue as { default: unknown }).default;
  }
  return moduleValue;
}

export function createCSharpParser(moduleLoader: ModuleLoader = (specifier) => import(specifier)) {
  let loading: Promise<ParserInstance> | undefined;

  async function load(): Promise<ParserInstance> {
    if (loading) return loading;
    const attempt = Promise.all([
      moduleLoader("tree-sitter"),
      moduleLoader("tree-sitter-c-sharp")
    ]).then(([parserModule, grammarModule]) => {
      const Parser = moduleDefault(parserModule) as ParserConstructor;
      const grammar = moduleDefault(grammarModule);
      const parser = new Parser();
      parser.setLanguage(grammar);
      return parser;
    });
    loading = attempt;
    try {
      return await attempt;
    } catch (error) {
      if (loading === attempt) loading = undefined;
      throw error;
    }
  }

  return async function parse(input: PluginParseInput): Promise<PluginParseResult> {
    const parser = await load();
    const tree = parser.parse(input.source);
    if (tree.rootNode.type !== "compilation_unit") {
      throw new Error(`Unexpected C# syntax tree root: ${tree.rootNode.type}`);
    }
    if (tree.rootNode.hasError) {
      throw new Error(`C# source produced a syntax tree containing errors: ${input.relativePath}`);
    }
    return { symbols: [], imports: [], calls: [], facts: {} };
  };
}

export const parseCSharp = createCSharpParser();
