import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  configSchema,
  type LogicLensConfig,
  defaultProviderRetry,
  defaultProviderRateLimit,
  defaultInclude,
  defaultExclude
} from "./schema.js";

export const configPath = (cwd = process.cwd()): string => path.join(cwd, ".logiclens", "config.yaml");

export async function loadConfig(cwd = process.cwd()): Promise<LogicLensConfig> {
  const file = configPath(cwd);
  const raw = await fs.readFile(file, "utf8");
  return configSchema.parse(YAML.parse(raw));
}

/**
 * Prunes default configuration options from the given configuration object,
 * leaving only user-defined overrides and essential configuration fields.
 */
export function pruneConfig(config: LogicLensConfig): any {
  const pruned: any = {};

  // Always write systemName so it doesn't get removed when configuration is updated
  pruned.systemName = config.systemName;

  // Always write repos (even if empty, to allow clearing repos)
  pruned.repos = config.repos;

  if (config.plugins && config.plugins.length > 0) {
    pruned.plugins = config.plugins;
  }

  // Only include frameworks if they have custom overrides
  if (config.frameworks && (config.frameworks.include.length > 0 || config.frameworks.exclude.length > 0)) {
    pruned.frameworks = config.frameworks;
  }

  // Only include files if they differ from the default list
  if (config.include && JSON.stringify(config.include) !== JSON.stringify(defaultInclude)) {
    pruned.include = config.include;
  }
  if (config.exclude && JSON.stringify(config.exclude) !== JSON.stringify(defaultExclude)) {
    pruned.exclude = config.exclude;
  }

  // Graph: only include path if it is different from default, or provider if it's different from kuzu
  if (config.graph) {
    const graphPruned: any = {};
    if (config.graph.provider !== "kuzu") graphPruned.provider = config.graph.provider;
    if (config.graph.path !== ".logiclens/graph") graphPruned.path = config.graph.path;
    if (Object.keys(graphPruned).length > 0) {
      pruned.graph = graphPruned;
    }
  }

  // LLM: prune retry, budget, rateLimit if they are default
  if (config.llm) {
    const llmPruned: any = {};
    if (config.llm.provider !== "openai") llmPruned.provider = config.llm.provider;
    if (config.llm.apiKey !== undefined) llmPruned.apiKey = config.llm.apiKey;
    if (config.llm.baseUrl !== undefined) llmPruned.baseUrl = config.llm.baseUrl;
    if (config.llm.model !== "gpt-4.1-mini") llmPruned.model = config.llm.model;
    if (config.llm.maxSourceCharsPerNode !== 6000) llmPruned.maxSourceCharsPerNode = config.llm.maxSourceCharsPerNode;
    
    // Check if retry is non-default
    if (config.llm.retry && JSON.stringify(config.llm.retry) !== JSON.stringify(defaultProviderRetry)) {
      llmPruned.retry = config.llm.retry;
    }
    // Check if budget is non-default
    if (config.llm.budget && Object.keys(config.llm.budget).length > 0) {
      llmPruned.budget = config.llm.budget;
    }
    // Check if rateLimit is non-default
    if (config.llm.rateLimit && JSON.stringify(config.llm.rateLimit) !== JSON.stringify(defaultProviderRateLimit)) {
      llmPruned.rateLimit = config.llm.rateLimit;
    }

    if (Object.keys(llmPruned).length > 0) {
      pruned.llm = llmPruned;
    }
  }

  // Embedding
  if (config.embedding) {
    const embPruned: any = {};
    if (config.embedding.provider !== "openai") embPruned.provider = config.embedding.provider;
    if (config.embedding.apiKey !== undefined) embPruned.apiKey = config.embedding.apiKey;
    if (config.embedding.baseUrl !== undefined) embPruned.baseUrl = config.embedding.baseUrl;
    if (config.embedding.model !== "text-embedding-3-small") embPruned.model = config.embedding.model;
    if (config.embedding.level !== "off") embPruned.level = config.embedding.level;
    if (config.embedding.batchSize !== 64) embPruned.batchSize = config.embedding.batchSize;
    if (config.embedding.concurrency !== 2) embPruned.concurrency = config.embedding.concurrency;

    if (config.embedding.retry && JSON.stringify(config.embedding.retry) !== JSON.stringify(defaultProviderRetry)) {
      embPruned.retry = config.embedding.retry;
    }
    if (config.embedding.budget && Object.keys(config.embedding.budget).length > 0) {
      embPruned.budget = config.embedding.budget;
    }
    if (config.embedding.rateLimit && JSON.stringify(config.embedding.rateLimit) !== JSON.stringify(defaultProviderRateLimit)) {
      embPruned.rateLimit = config.embedding.rateLimit;
    }

    if (Object.keys(embPruned).length > 0) {
      pruned.embedding = embPruned;
    }
  }

  // Semantic
  if (config.semantic) {
    const semPruned: any = {};
    if (config.semantic.provider !== "json") semPruned.provider = config.semantic.provider;
    if (config.semantic.jsonPath !== ".logiclens/semantic-index.json") semPruned.jsonPath = config.semantic.jsonPath;
    
    // Chroma
    if (config.semantic.chroma && JSON.stringify(config.semantic.chroma) !== JSON.stringify({ mode: "local", url: "http://localhost:8000", collection: "logiclens" })) {
      semPruned.chroma = config.semantic.chroma;
    }

    if (Object.keys(semPruned).length > 0) {
      pruned.semantic = semPruned;
    }
  }

  // MCP
  if (config.mcp) {
    const mcpPruned: any = {};
    if (config.mcp.allowUnsafeCypher !== false) mcpPruned.allowUnsafeCypher = config.mcp.allowUnsafeCypher;
    if (config.mcp.logCalls !== false) mcpPruned.logCalls = config.mcp.logCalls;
    if (Object.keys(mcpPruned).length > 0) {
      pruned.mcp = mcpPruned;
    }
  }

  // Watch
  if (config.watch) {
    const watchPruned: any = {};
    if (config.watch.enabled !== true) watchPruned.enabled = config.watch.enabled;
    if (config.watch.mode !== "auto") watchPruned.mode = config.watch.mode;
    if (config.watch.debounceMs !== 2000) watchPruned.debounceMs = config.watch.debounceMs;
    if (config.watch.maxRoots !== 256) watchPruned.maxRoots = config.watch.maxRoots;
    if (config.watch.maxLinuxDirs !== 20000) watchPruned.maxLinuxDirs = config.watch.maxLinuxDirs;
    if (config.watch.syncConcurrency !== 1) watchPruned.syncConcurrency = config.watch.syncConcurrency;
    if (config.watch.catchUp !== "background") watchPruned.catchUp = config.watch.catchUp;

    if (Object.keys(watchPruned).length > 0) {
      pruned.watch = watchPruned;
    }
  }

  // Indexing
  if (config.indexing) {
    const idxPruned: any = {};
    if (config.indexing.concurrency !== 4) idxPruned.concurrency = config.indexing.concurrency;
    if (config.indexing.summarizeChangedOnly !== true) idxPruned.summarizeChangedOnly = config.indexing.summarizeChangedOnly;
    if (config.indexing.maxFilesPerRun !== 5000) idxPruned.maxFilesPerRun = config.indexing.maxFilesPerRun;
    if (config.indexing.batchSize !== 0) idxPruned.batchSize = config.indexing.batchSize;
    if (config.indexing.llmSummaryLevel !== "off") idxPruned.llmSummaryLevel = config.indexing.llmSummaryLevel;

    if (Object.keys(idxPruned).length > 0) {
      pruned.indexing = idxPruned;
    }
  }

  return pruned;
}

function syncDocument(doc: YAML.Document, docMap: YAML.YAMLMap, obj: any) {
  const docKeys = new Set<string>();
  if (docMap.items) {
    for (const item of docMap.items) {
      if (YAML.isPair(item) && YAML.isScalar(item.key)) {
        docKeys.add(String(item.key.value));
      }
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!docMap.has(key)) {
        docMap.set(key, doc.createNode({}));
      }
      const child = docMap.get(key);
      if (YAML.isMap(child)) {
        syncDocument(doc, child as YAML.YAMLMap, value);
      } else {
        docMap.set(key, value);
      }
    } else {
      docMap.set(key, value);
    }
    docKeys.delete(key);
  }

  for (const key of docKeys) {
    docMap.delete(key);
  }
}

export async function writeConfig(config: LogicLensConfig, cwd = process.cwd()): Promise<void> {
  const file = configPath(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });

  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    // Ignore, file doesn't exist yet
  }

  const doc = YAML.parseDocument(raw);
  if (!doc.contents || !YAML.isMap(doc.contents)) {
    doc.contents = doc.createNode({}) as any;
  }

  const pruned = pruneConfig(config);
  syncDocument(doc, doc.contents as YAML.YAMLMap, pruned);

  await fs.writeFile(file, doc.toString(), "utf8");
}

export function defaultConfig(): LogicLensConfig {
  return configSchema.parse({});
}
