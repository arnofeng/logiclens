import type { LogicLensConfig } from "../config/schema.js";
import type { ExtractorFactBundle } from "../extractors/crossRepoContracts.js";
import type { ParsedGraphFile, RepoNode } from "../parsers/types.js";
import type { ProviderCallRuntime } from "../resilience/providerPolicy.js";

export type EmbeddingVector = number[];

export interface EmbeddingProvider {
  readonly name: string;
  embedTexts(texts: string[], runtime?: ProviderCallRuntime): Promise<(EmbeddingVector | undefined)[]>;
  embedText(text: string, runtime?: ProviderCallRuntime): Promise<EmbeddingVector | undefined>;
}

/**
 * Represents the input provided to a LanguageParser to parse a source file.
 */
export type ParseInput = {
  /** The unique ID of the repository containing the file */
  repoId: string;
  /** The absolute filesystem path of the source file */
  absolutePath: string;
  /** The workspace-relative path of the source file */
  relativePath: string;
  /** The programming language identifier, e.g., 'typescript', 'rust' */
  language: string;
  /** The raw source code text of the file */
  source: string;
  /** The unique ID of the file node in the graph */
  fileId: string;
  /** The MD5 or SHA256 hash of the file contents */
  hash: string;
};

/**
 * Represents the context provided to a ContractExtractor to extract contract and dependency information.
 */
export type ExtractContext = {
  /** List of all repositories in the workspace */
  repos: RepoNode[];
  /** List of all parsed file nodes in the workspace */
  parsedFiles: ParsedGraphFile[];
  /** Helper function to resolve repository metadata by its ID */
  repoResolver: (repoId: string) => RepoNode | undefined;
  /** Custom alias overrides for mapping dependencies to repositories */
  aliasOverrides?: Array<{ alias: string; targetRepoId: string }>;
};

/**
 * Interface that must be implemented by a custom language parser plugin.
 * Used to parse source files and extract basic AST nodes, functions, classes, and sections.
 */
export interface LanguageParser {
  /** The unique name of the language parser */
  name: string;
  /** The language identifier this parser handles, e.g. "go", "python" */
  language: string;
  /** List of file extensions supported by this parser (with dot prefix, e.g. [".go", ".py"]) */
  extensions: string[];
  /**
   * Parses the given input file and returns parsed AST nodes.
   * Can return a promise or a direct value.
   */
  parse(input: ParseInput): Promise<ParsedGraphFile> | ParsedGraphFile;
}

/**
 * Context provided to a ContractExtractor's postExtract hook.
 * Gives read-only access to the merged facts from all extract() calls
 * so extractors can do cross-file finalization.
 */
export type PostExtractContext = {
  /** The merged (and uniqued) fact bundle produced by all extract() calls */
  readonly mergedFacts: ExtractorFactBundle;
  /** List of all repositories in the workspace */
  readonly repos: RepoNode[];
  /** List of all parsed file nodes in the workspace */
  readonly parsedFiles: ParsedGraphFile[];
};

/**
 * Interface that must be implemented by a custom contract extractor plugin.
 * Used to discover cross-repository contracts, events, dependencies, and rules.
 */
export interface ContractExtractor {
  /** The unique name of the contract extractor */
  name: string;
  /** Languages supported by this contract extractor */
  languages?: string[];
  /** Frameworks supported by this contract extractor */
  frameworks?: string[];
  /**
   * Performs extraction of contracts, dependencies, entities, and workflows.
   * Can return a promise or a direct value.
   */
  extract(context: ExtractContext): Promise<ExtractorFactBundle> | ExtractorFactBundle;
  /**
   * P1-1 – Cross-file finalization hook (optional).
   *
   * Called once after ALL per-file extract() invocations are done and their
   * results have been merged. Use this to handle information that spans multiple
   * files, such as merging a Spring Controller's class-level \`@RequestMapping\`
   * prefix into each of its method-level \`@GetMapping\` routes.
   *
   * Return additional facts to merge into the final result, or return an empty
   * bundle if nothing needs to be added.
   */
  postExtract?(context: PostExtractContext): Promise<ExtractorFactBundle> | ExtractorFactBundle;
}

import type { DetectedFramework } from "../frameworks/types.js";

/**
 * Interface that must be implemented by a custom framework detector plugin.
 * Used to discover repository-level frameworks and languages.
 */
export interface FrameworkDetector {
  /** The unique name of the framework detector */
  name: string;
  /**
   * Performs framework detection on a repository.
   * Can return a promise or a direct value.
   */
  detect(repo: RepoNode, parsedFiles: ParsedGraphFile[]): Promise<DetectedFramework[]> | DetectedFramework[];
}

/**
 * The API context provided to a plugin's setup function to register parsers and framework detectors.
 */
export interface PluginContext {
  /** The current working directory of the workspace */
  cwd: string;
  /** The resolved LogicLens configuration object */
  config: LogicLensConfig;
  /**
   * Registers a custom language parser.
   */
  registerParser(parser: LanguageParser): void;
  /**
   * Registers a custom framework detector.
   */
  registerFrameworkDetector(detector: FrameworkDetector): void;
  registerEmbeddingProvider(provider: EmbeddingProvider): void;
}

/**
 * The interface for a LogicLens plugin definition.
 */
export interface LogicLensPlugin {
  /** The name of the plugin */
  name: string;
  /** The version of the plugin */
  version: string;
  /** The LogicLens plugin API version this plugin conforms to. Defaults to "1". */
  pluginApiVersion?: string;
  /**
   * Setup hook called when the plugin is initialized.
   * 
   * @param context - The plugin context providing registration APIs.
   * @param options - Custom options passed to the plugin from configuration.
   */
  setup(context: PluginContext, options?: unknown): Promise<void> | void;
}

/**
 * Metadata of a successfully loaded plugin.
 */
export type LoadedPlugin = {
  /** The name of the plugin */
  name: string;
  /** The version of the plugin */
  version: string;
  /** The module import path or package name */
  moduleName: string;
  /** The resolved filesystem path of the plugin */
  resolvedPath: string;
  /** The setup/initialization time in milliseconds */
  setupMs: number;
};
