import { z } from "zod";
import { BRAND_DEFAULTS, BRAND_PATHS } from "../shared/branding.js";

export const repoConfigSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1)
});

const optionalUrlString = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());
const optionalSecretString = z.preprocess((value) => value === "" ? undefined : value, z.string().optional());

const providerRetrySchema = z.object({
  maxRetries: z.number().int().nonnegative().default(2),
  initialDelayMs: z.number().int().nonnegative().default(500),
  maxDelayMs: z.number().int().nonnegative().default(8000),
  jitterRatio: z.number().nonnegative().default(0.2),
  timeoutMs: z.number().int().nonnegative().default(60000)
}).default({ maxRetries: 2, initialDelayMs: 500, maxDelayMs: 8000, jitterRatio: 0.2, timeoutMs: 60000 });

const providerBudgetSchema = z.object({
  maxRequests: z.number().int().positive().optional(),
  maxEstimatedTokens: z.number().int().positive().optional(),
  maxElapsedMs: z.number().int().positive().optional(),
  maxFailures: z.number().int().positive().optional()
}).default({});

const providerRateLimitSchema = z.object({
  minDelayMs: z.number().int().nonnegative().default(0)
}).default({ minDelayMs: 0 });

export const defaultProviderRetry = { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 8000, jitterRatio: 0.2, timeoutMs: 60000 };
export const defaultProviderRateLimit = { minDelayMs: 0 };
export const defaultInclude = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.java",
  "**/*.py",
  "**/*.go",
  "**/*.md",
  "**/*.mdx",
  "**/*.yml",
  "**/*.yaml",
  "**/*.toml",
  "**/*.properties",
  "**/*.vue"
];
export const defaultExclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/target/**",
  "**/.git/**"
];

export const configSchema = z.object({
  systemName: z.string().default("default-system"),
  repos: z.array(repoConfigSchema).default([]),
  frameworks: z.object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([])
  }).default({ include: [], exclude: [] }),
  include: z.array(z.string()).default(defaultInclude),
  exclude: z.array(z.string()).default(defaultExclude),
  graph: z.object({
    provider: z.enum(["kuzu", "neo4j"]).default("kuzu"),
    path: z.string().default(BRAND_PATHS.graph),
    url: z.string().optional(),
    username: optionalSecretString,
    password: optionalSecretString
  }).default({ provider: "kuzu", path: BRAND_PATHS.graph }),
  llm: z.object({
    provider: z.literal("openai").default("openai"),
    apiKey: optionalSecretString,
    baseUrl: optionalUrlString,
    model: z.string().default("gpt-4.1-mini"),
    maxSourceCharsPerNode: z.number().int().positive().default(6000),
    retry: providerRetrySchema,
    budget: providerBudgetSchema,
    rateLimit: providerRateLimitSchema
  }).default({ provider: "openai", model: "gpt-4.1-mini", maxSourceCharsPerNode: 6000, retry: defaultProviderRetry, budget: {}, rateLimit: defaultProviderRateLimit }),
  embedding: z.object({
    provider: z.string().default("off"),
    apiKey: optionalSecretString,
    baseUrl: optionalUrlString,
    model: z.string().optional(),
    level: z.enum(["off", "repo", "docs", "file", "node", "all"]).default("off"),
    batchSize: z.number().int().positive().default(64),
    concurrency: z.number().int().positive().default(2),
    retry: providerRetrySchema,
    budget: providerBudgetSchema,
    rateLimit: providerRateLimitSchema
  }).default({ provider: "off", level: "off", batchSize: 64, concurrency: 2, retry: defaultProviderRetry, budget: {}, rateLimit: defaultProviderRateLimit }),
  semantic: z.object({
    provider: z.enum(["json", "chroma"]).default("json"),
    jsonPath: z.string().default(BRAND_PATHS.semanticIndex),
    chroma: z.object({
      mode: z.enum(["local", "remote"]).default("local"),
      url: z.string().default("http://localhost:8000"),
      collection: z.string().default(BRAND_DEFAULTS.chromaCollection),
      authToken: z.string().optional(),
      tenant: z.string().optional(),
      database: z.string().optional()
    }).default({ mode: "local", url: "http://localhost:8000", collection: BRAND_DEFAULTS.chromaCollection })
  }).default({
    provider: "json",
    jsonPath: BRAND_PATHS.semanticIndex,
    chroma: { mode: "local", url: "http://localhost:8000", collection: BRAND_DEFAULTS.chromaCollection }
  }),
  mcp: z.object({
    logCalls: z.boolean().default(false)
  }).default({ logCalls: false }),
  plugins: z.object({
    enabled: z.array(z.string()).default([]),
    failFast: z.boolean().default(false)
  }).default({ enabled: [], failFast: false }),
  watch: z.object({
    enabled: z.boolean().default(true),
    mode: z.enum(["auto", "repo-roots", "common-root", "off"]).default("auto"),
    debounceMs: z.number().int().positive().default(2000),
    maxRoots: z.number().int().positive().default(256),
    maxLinuxDirs: z.number().int().positive().default(20000),
    syncConcurrency: z.number().int().positive().default(1),
    catchUp: z.enum(["blocking", "background", "off"]).default("background")
  }).default({
    enabled: true,
    mode: "auto",
    debounceMs: 2000,
    maxRoots: 256,
    maxLinuxDirs: 20000,
    syncConcurrency: 1,
    catchUp: "background"
  }),
  indexing: z.object({
    concurrency: z.number().int().positive().default(4),
    summarizeChangedOnly: z.boolean().default(true),
    maxFilesPerRun: z.number().int().positive().default(5000),
    batchSize: z.number().int().nonnegative().default(0),
    llmSummaryLevel: z.enum(["off", "repo", "file", "node"]).default("off")
  }).default({ concurrency: 4, summarizeChangedOnly: true, maxFilesPerRun: 5000, batchSize: 0, llmSummaryLevel: "off" })
});

export type AppConfig = z.infer<typeof configSchema>;
export type EmbeddingLevel = AppConfig["embedding"]["level"];
export type LlmSummaryLevel = AppConfig["indexing"]["llmSummaryLevel"];
