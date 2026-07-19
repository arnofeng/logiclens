export type ParserExtensionMetadata = {
  language: string;
  extensions: readonly string[];
};

export const BUILTIN_PARSER_EXTENSION_METADATA: readonly ParserExtensionMetadata[] = [
  { language: "typescript", extensions: [".ts"] },
  { language: "tsx", extensions: [".tsx"] },
  { language: "javascript", extensions: [".js"] },
  { language: "jsx", extensions: [".jsx"] },
  { language: "java", extensions: [".java"] },
  { language: "python", extensions: [".py"] },
  { language: "go", extensions: [".go"] },
  { language: "markdown", extensions: [".md", ".mdx"] },
  { language: "yaml", extensions: [".yaml", ".yml"] },
  { language: "toml", extensions: [".toml"] },
  { language: "properties", extensions: [".properties"] },
  { language: "xml", extensions: [".xml"] },
  { language: "vue", extensions: [".vue"] },
  { language: "proto", extensions: [".proto"] },
  { language: "graphql", extensions: [".graphql", ".gql"] }
] as const;

export const BUILTIN_PARSER_EXTENSIONS: ReadonlySet<string> = new Set(
  BUILTIN_PARSER_EXTENSION_METADATA.flatMap((entry) => entry.extensions)
);

export function parserExtensionsFor(language: string): string[] {
  return [...(BUILTIN_PARSER_EXTENSION_METADATA.find((entry) => entry.language === language)?.extensions ?? [])];
}
