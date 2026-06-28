import type { ExtractedFacts } from "../contracts/extraction/contracts.js";
import type { FactCollector } from "../contracts/extraction/factCollector.js";
import type { ParsedGraphFile, RepoNode } from "../parsing/types.js";
import type { ProviderCallRuntime } from "../../shared/providerPolicy.js";

export type EmbeddingVector = number[];

export interface EmbeddingProvider {
  readonly name: string;
  embedTexts(texts: string[], runtime?: ProviderCallRuntime): Promise<(EmbeddingVector | undefined)[]>;
  embedText(text: string, runtime?: ProviderCallRuntime): Promise<EmbeddingVector | undefined>;
}

export type ParseInput = {
  repoId: string;
  absolutePath: string;
  relativePath: string;
  language: string;
  source: string;
  fileId: string;
  hash: string;
};

export type ExtractContext = {
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  repoResolver?: (repoId: string) => RepoNode | undefined;
  aliasOverrides?: Array<{ alias: string; targetRepoId: string }>;
};

export interface LanguageParser {
  name: string;
  language: string;
  extensions: string[];
  parse(input: ParseInput): Promise<ParsedGraphFile> | ParsedGraphFile;
}

export type PostExtractContext = {
  readonly mergedFacts: ExtractedFacts;
  readonly repos: RepoNode[];
  readonly parsedFiles: ParsedGraphFile[];
};

export interface ContractExtractorDeps {
  parsedFiles?: boolean;
  repoResolver?: boolean;
  aliasOverrides?: boolean;
}

export interface ContractExtractor {
  name: string;
  languages?: string[];
  frameworks?: string[];
  needs?: ContractExtractorDeps;
  extract(context: ExtractContext, collector: FactCollector): Promise<void> | void;
  postExtract?(context: PostExtractContext, collector: FactCollector): Promise<void> | void;
}
