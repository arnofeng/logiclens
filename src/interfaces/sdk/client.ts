import path from "node:path";
import fs from "node:fs";
import { repoId } from "../../shared/path.js";
import { loadConfig, defaultConfig } from "../../config/loadConfig.js";
import type { AppConfig } from "../../config/schema.js";
import type { GraphDB, Stats } from "../../core/graph-model/db.js";
import { createGraphDB } from "../../core/graph-model/factory.js";
import { registerBuiltinEmbeddingProviders } from "../../adapters/embeddings/builtinProviders.js";
import {
  listDependencies,
  listContracts,
  listUnresolvedEvidence,
  traceContract,
  traceEntity,
  hasCodeSymbolMatch,
  type DependencyQueryOptions,
  type DependencyRow,
  type ContractSummaryRow,
  type ContractTraceRow,
  type EntityTraceRow,
  type UnresolvedEvidenceRow,
  type CodeSearchRow
} from "../../core/graph-model/queries.js";
import type { SemanticImpactReport } from "../../core/contracts/impact/semanticImpact.js";
import { retrieveForQuestion, type RetrievalResult } from "../../features/ask/retrieve.js";
import { answerQuestion } from "../../features/ask/answer.js";
import { rebuildRepoDependencies } from "../../core/graph-model/rebuildRelations.js";
import { discoverGitRepos } from "../../core/workspace/repoDiscovery.js";
import { toRepoNode } from "../../core/workspace/repoRegistry.js";
import type { DiscoveredRepo } from "../../core/workspace/repoDiscovery.js";
import type { RepoNode } from "../../core/parsing/types.js";


// Options types for index:
import type { IndexOptions, IndexResult } from "../../core/indexing/types.js";
import { runIndexing } from "../../core/indexing/run.js";
import { FileWatcher, type PendingFile, type WatchOptions, type WatchStatus } from "../../features/watch/watcher.js";
import { shouldEnableWatcher } from "../../features/watch/policy.js";
import { SingleProcessIndexQueue, type IndexQueueSource, type IndexQueueStatusSnapshot } from "../../core/indexing/scheduler.js";

/**
 * Represents the result of an impact analysis, including contract traces,
 * entity traces, matched code seeds, call edges, related document sections,
 * and a list of recommended files to inspect.
 */
export type ImpactResult = {
  symbolOrEntity: string;
  semanticImpact?: SemanticImpactReport;
  contractTrace: ContractTraceRow[];
  entityTrace: EntityTraceRow[];
  seeds: any[];
  edges: any[];
  sections: any[];
  recommendedFiles: string[];
};

/**
 * Custom logging interface for the SDK client to delegate stdout, stderr,
 * warnings, errors, and progress updates.
 */
export type AppLogger = {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (...args: any[]) => void;
  writeStderr?: (message: string) => void;
  createProgressBar?: (label: string, total: number) => any;
};

const defaultLogger: Required<AppLogger> = {
  log: () => {},
  warn: () => {},
  error: () => {},
  writeStderr: () => {},
  createProgressBar: () => {
    return {
      tick: () => {},
      update: () => {},
      complete: () => {},
      reporter: () => () => {}
    };
  }
};

/**
 * Configuration options for creating a client.
 */
export type AppClientOptions = {
  /** The current working directory / project root path */
  cwd?: string;
  /** Explicit workspace configuration object; if omitted, loaded from the branded config file. */
  config?: AppConfig;
  /** Custom logger implementation */
  logger?: AppLogger;
};

export type ClientOptions = AppClientOptions;

export type AppIndexOptions = IndexOptions & {
  queueSource?: IndexQueueSource;
  queueLabel?: string;
};

/**
 * Programmatic Node.js ESM client for the branded graph workspace to perform initialization,
 * indexing, relationship rebuilds, and dependency/impact querying.
 */
export class AppClient {
  private config: AppConfig;
  private cwd: string;
  private dbInstance?: GraphDB;
  private dbPromise?: Promise<GraphDB>;
  private closed = false;
  private providersRegistered = false;
  private options: AppClientOptions;
  private logger: Required<AppLogger>;
  private watcher?: FileWatcher;
  private indexQueue = new SingleProcessIndexQueue();

  constructor(options: ClientOptions, config: AppConfig) {
    this.options = options;
    this.config = config;
    this.cwd = options.cwd ?? process.cwd();
    this.logger = {
      ...defaultLogger,
      ...options.logger
    };
    this.ensureProviders();
  }

  /**
   * Returns the resolved workspace configuration for this client.
   */
  getConfig(): AppConfig {
    return this.config;
  }

  getCwd(): string {
    return this.cwd;
  }

  private async getDb(): Promise<GraphDB> {
    if (this.closed) {
      throw new Error("Client is closed");
    }
    if (!this.dbPromise) {
      this.dbPromise = this.openDb()
        .catch((error) => {
          this.dbPromise = undefined;
          throw error;
        });
    }
    return this.dbPromise;
  }

  private async openDb(): Promise<GraphDB> {
    const graphPath = path.resolve(this.cwd, this.config.graph.path);
    const db = await createGraphDB(this.config.graph.provider, {
      path: graphPath,
      url: this.config.graph.url,
      username: this.config.graph.username,
      password: this.config.graph.password
    });
    await db.initSchema(this.config.systemName);
    this.dbInstance = db;
    return db;
  }

  /**
   * Ensures built-in providers are registered for this process.
   */
  ensureProviders(): void {
    if (this.providersRegistered) return;
    registerBuiltinEmbeddingProviders(this.config);
    this.providersRegistered = true;
  }

  /**
   * Adds a repository to this client's in-memory configuration so it is picked
   * up by subsequent operations (e.g. `index()`). This does NOT persist to
   * `config.yaml`; persistence is the CLI layer's responsibility. The mutation
   * is scoped to this client instance and is discarded when the process exits.
   *
   * @param repoPath - The absolute or relative path to the repository directory.
   * @param options - Additional options.
   * @param options.name - The unique name for the repository. Defaults to the directory's basename.
   * @returns An object containing the resolved name and the stored relative path.
   */
  async addRepo(repoPath: string, options?: { name?: string }): Promise<{ name: string; storedPath: string }> {
    const absolute = path.resolve(this.cwd, repoPath);
    const name = options?.name ?? path.basename(absolute);
    const storedPath = path.relative(this.cwd, absolute).replace(/\\/g, "/") || ".";
    const repos = this.config.repos.filter((repo) => repo.name !== name);
    repos.push({ name, path: storedPath });
    this.config = { ...this.config, repos };
    return { name, storedPath };
  }

  /**
   * Discovers and adds multiple Git repositories found under a given directory.
   * Optionally triggers initial indexing on the newly discovered repositories.
   *
   * Like {@link addRepo}, this only updates this client's in-memory configuration
   * and does not persist to `config.yaml`; persistence is the CLI layer's job.
   *
   * @param directory - The directory path to search for Git repositories.
   * @param options - Additional options.
   * @param options.index - Whether to automatically run indexing on the found repositories.
   * @param options.changedOnly - If indexing, whether to index only changed files.
   * @param options.maxFiles - If indexing, the maximum number of files to process per repo.
   * @param options.writeMode - Index writing mode.
   * @returns A summary of discovered, skipped, and added repositories.
   */
  async addRepos(directory: string, options?: any): Promise<{
    discovered: DiscoveredRepo[];
    skipped: { nonDirectories: number; withoutGit: number };
    addedRepos: { name: string; path: string }[];
  }> {
    const absoluteDirectory = path.resolve(this.cwd, directory);
    const discovery = await discoverGitRepos(absoluteDirectory);
    
    const byName = new Map(this.config.repos.map((repo) => [repo.name, repo]));
    for (const repo of discovery.repos) {
      const relPath = path.relative(this.cwd, repo.absolutePath).replace(/\\/g, "/") || ".";
      byName.set(repo.name, { name: repo.name, path: relPath });
    }
    const repos = [...byName.values()];
    this.config = { ...this.config, repos };

    const addedRepos = discovery.repos.map((r) => ({
      name: r.name,
      path: path.relative(this.cwd, r.absolutePath).replace(/\\/g, "/") || "."
    }));

    if (options?.index) {
      for (const repo of discovery.repos) {
        await this.index({
          repo: repo.name,
          changedOnly: options.changedOnly,
          maxFiles: options.maxFiles,
          writeMode: options.writeMode
        });
      }
    }

    return {
      discovered: discovery.repos,
      skipped: discovery.skipped,
      addedRepos
    };
  }

  /**
   * Runs the indexing process to parse source files, extract code symbols, doc sections,
   * entities, and contracts, then loads them into the graph database.
   * 
   * @param options - Indexing options such as target repo, maximum files, and incremental mode.
   * @returns A promise that resolves to the index result.
   */
  async index(options?: AppIndexOptions): Promise<IndexResult> {
    const { queueSource = "manual", queueLabel, ...indexOptions } = options ?? {};
    return this.indexQueue.enqueue({
      source: queueSource,
      label: queueLabel ?? describeIndexOptions(indexOptions),
      run: async () => {
        this.ensureProviders();
        const db = await this.getDb();
        return runIndexing(db, this.config, { ...indexOptions, cwd: this.cwd, logger: this.logger });
      }
    });
  }

  getIndexQueueStatus(): IndexQueueStatusSnapshot {
    return this.indexQueue.getStatus();
  }

  /**
   * Rebuilds relationship edges in the graph database.
   * Resolves dependencies and contracts across repositories based on the index.
   * 
   * @param options - Options to filter by repository or rebuild fully.
   * @param options.repo - If provided, limits rebuilding to a specific repository.
   * @param options.full - If true, rebuilds all relations regardless of other options.
   * @returns The number of rebuilt relationship edges.
   */
  async rebuildRelations(options?: { repo?: string; full?: boolean }): Promise<{ rebuiltCount: number }> {
    const db = await this.getDb();
    const targetRepoIds = options?.full || !options?.repo
      ? undefined
      : this.config.repos.filter((repo) => repo.name === options.repo).map((repo) => toRepoNode(repo, this.cwd).id);
    
    if (options?.repo && !options?.full && targetRepoIds?.length === 0) {
      throw new Error(`Unknown repo: ${options.repo}`);
    }

    const dependencies = await rebuildRepoDependencies(db, { repoIds: targetRepoIds, logger: this.logger });
    return { rebuiltCount: dependencies.length };
  }

  /**
   * Retrieves summary statistics of the graph database.
   * Returns counts of repositories, files, code symbols, sections, entities, and edges.
   * 
   * @returns A promise resolving to the database statistics.
   */
  async stats(): Promise<Stats> {
    const db = await this.getDb();
    return db.stats();
  }

  /**
   * Returns the repositories already present in the graph. Useful for cheaply
   * detecting which configured repos have been indexed before without computing
   * the full stats payload.
   */
  async listRepos(): Promise<RepoNode[]> {
    const db = await this.getDb();
    return db.listRepos();
  }

  /**
   * Lists the repository-level and contract dependencies registered in the graph.
   *
   * @param options - Query parameters.
   * @param options.limit - The maximum number of rows to retrieve.
   * @param options.repo - Filter dependencies involving a specific repository.
   * @param options.target - Filter dependencies targeting a specific repository (requires repo).
   * @param options.direction - Direction: outgoing (repo as consumer) or incoming (repo as producer).
   * @returns An array of dependency rows.
   */
  async dependencies(options?: DependencyQueryOptions): Promise<DependencyRow[]> {
    if (options?.direction && !options?.repo) {
      throw new Error("direction requires repo");
    }
    if (options?.target && !options?.repo) {
      throw new Error("target requires repo");
    }
    const db = await this.getDb();
    return listDependencies(db, options);
  }

  /**
   * Lists auditable extraction sites that looked like external contract calls
   * but could not be reduced to a stable static contract key.
   */
  async unresolvedEvidence(options?: { limit?: number }): Promise<UnresolvedEvidenceRow[]> {
    const db = await this.getDb();
    return listUnresolvedEvidence(db, options?.limit);
  }

  /**
   * Lists contracts registered in the graph database, optionally filtered by contract kind.
   * 
   * @param options - Query parameters.
   * @param options.kind - The contract kind (e.g., 'package', 'api', 'event', etc.) to filter by.
   * @param options.limit - The maximum number of rows to retrieve.
   * @returns An array of contract summary rows.
   */
  async contracts(options?: { kind?: string; limit?: number; repo?: string; direction?: string }): Promise<ContractSummaryRow[]> {
    if (options?.direction && !options?.repo) {
      throw new Error("direction requires repo");
    }
    const directions = new Set(["outgoing", "incoming"]);
    if (options?.direction && !directions.has(options.direction)) {
      throw new Error(`Unsupported direction "${options.direction}". Expected one of: outgoing, incoming`);
    }

    const db = await this.getDb();

    const contractKinds = new Set(["package", "api", "event", "dto", "schema", "enum", "config"]);
    let parsedKind: any = undefined;
    if (options?.kind) {
      if (!contractKinds.has(options.kind)) {
        throw new Error(`Unsupported contract kind "${options.kind}". Expected one of: ${[...contractKinds].join(", ")}`);
      }
      parsedKind = options.kind;
    }

    return listContracts(db, {
      kind: parsedKind,
      limit: options?.limit,
      repo: options?.repo,
      direction: options?.direction as "outgoing" | "incoming" | undefined,
    });
  }

  /**
   * Analyzes the potential downstream impact of modifying a code symbol or contract.
   * Walks the call graph, identifies documented doc sections, and recommends files to check.
   * 
   * @param target - The target symbol or entity name to analyze.
   * @returns The impact analysis result including seeds, edges, doc sections, and recommended files.
   */
  async impact(target: string): Promise<ImpactResult> {
    const db = await this.getDb();
    const semanticImpact = await this.semanticImpact(target);
    const contractKinds = new Set(["package", "api", "event", "dto", "schema", "enum", "config"]);
    const [kind, ...rest] = target.split(":");
    const value = rest.join(":");
    const isContract = contractKinds.has(kind) && value;
    
    const parsedContract = isContract ? { kind: kind as any, value } : undefined;
    const contractTrace = parsedContract ? await traceContract(db, parsedContract.kind, parsedContract.value) : [];
    const entityTrace = await traceEntity(db, target);
    
    const { findContractSourceSymbols, findImpact, findImpactSections, sectionsDocumentingCode } = await import("../../core/graph-model/queries.js");
    const { callEdgesAround } = await import("../../core/graph-model/subgraph.js");
    
    let seeds: CodeSearchRow[] = [];
    if (isContract && contractTrace.length > 0) {
      const contractIds = [...new Set(contractTrace.map((row) => row.contractId))];
      seeds = await findContractSourceSymbols(db, contractIds);
    }
    if (seeds.length === 0) {
      seeds = await findImpact(db, target);
    }
    const directSections = await findImpactSections(db, target);
    const documentedSections = await sectionsDocumentingCode(db, seeds.map((seed) => seed.codeId));
    const sections = [...new Map([...directSections, ...documentedSections].map((section) => [section.sectionId, section])).values()];
    const edges = await callEdgesAround(db, seeds.map((seed) => seed.codeId));

    const recommendedFiles = [...new Set([
      ...seeds.map((seed) => `${seed.repoName}/${seed.filePath}`),
      ...edges.flatMap((edge) => [edge.fromFile, edge.toFile]),
      ...sections.map((section) => `${section.repoName}/${section.filePath}`)
    ])];

    return {
      symbolOrEntity: target,
      semanticImpact: semanticImpact ?? undefined,
      contractTrace,
      entityTrace,
      seeds,
      edges,
      sections,
      recommendedFiles
    };
  }

  /**
   * Analyzes the downstream impact of a proposed contract change using the
   * SEMANTIC_REL graph. Walks transitive dependencies to find all affected
   * consumers, assigns severity (breaking/risky/compatible), and returns a
   * structured {@link ImpactReport}.
   *
   * @param changeIntent - The proposed change, e.g.
   *   `{ target: "schema:CreateOrderRequest", changeType: "field-removed", detail: "couponCode" }`
   * @returns The full impact analysis report.
   */
  async analyzeChangeImpact(changeIntent: {
    target: string;
    changeType: string;
    detail?: string;
    maxHops?: number;
  }): Promise<import("../../core/contracts/impact/types.js").ImpactReport> {
    const db = await this.getDb();
    const { analyzeImpactFromDB } = await import("../../core/contracts/impact/impactEngine.js");

    // Resolve file paths for field-level search.  fileId format is
    // "file:<repoName>:<relativePath>"; we map repoName → disk path via config
    // or fall back to <cwd>/<repoName>.
    const repoPaths = new Map<string, string>();
    for (const repo of this.config.repos ?? []) {
      if (repo.name) repoPaths.set(repo.name, repo.path ?? path.join(this.cwd, repo.name));
    }

    const readFile = (repoName: string, fileId: string): string | undefined => {
      // fileId: "file:repoName:relative/path"
      const parts = fileId.split(":");
      const fRepoName = parts[1] ?? repoName;
      const relativePath = parts.slice(2).join(":");
      if (!relativePath) return undefined;

      const repoPath = repoPaths.get(fRepoName) ?? path.join(this.cwd, fRepoName);
      try {
        return fs.readFileSync(path.join(repoPath, relativePath), "utf-8");
      } catch {
        return undefined;
      }
    };

    const report = await analyzeImpactFromDB(
      {
        target: changeIntent.target,
        changeType: changeIntent.changeType as any,
        detail: changeIntent.detail,
      },
      db,
      { readFile, maxHops: changeIntent.maxHops }
    );
    return report;
  }

  async semanticImpact(
    target: string,
    options?: { maxHops?: number }
  ): Promise<SemanticImpactReport | null> {
    const db = await this.getDb();
    const { analyzeSemanticImpactFromDB } = await import("../../core/contracts/impact/semanticImpact.js");
    return analyzeSemanticImpactFromDB(target, db, { maxHops: options?.maxHops });
  }

  async hasCodeSymbolMatch(target: string): Promise<boolean> {
    const db = await this.getDb();
    return hasCodeSymbolMatch(db, target);
  }

  /**
   * Retrieves relevant context (code, docs, entities) from the database to answer a question.
   * 
   * @param question - The user query or question.
   * @returns The structured context retrieval result.
   */
  async retrieve(question: string): Promise<RetrievalResult> {
    const db = await this.getDb();
    return retrieveForQuestion(db, question, { cwd: this.cwd, config: this.config });
  }

  /**
   * Answers a user question by retrieving context and querying the configured LLM.
   * 
   * @param question - The question to ask.
   * @returns The LLM-generated or fallback answer.
   */
  async ask(question: string): Promise<string> {
    const db = await this.getDb();
    const retrieval = await this.retrieve(question);
    return answerQuestion(
      question,
      retrieval,
      this.config.llm.model,
      this.config.llm.apiKey ?? process.env.OPENAI_API_KEY,
      this.config.llm.baseUrl ?? process.env.OPENAI_BASE_URL,
      {},
      {
        retry: this.config.llm.retry,
        budget: this.config.llm.budget,
        rateLimit: this.config.llm.rateLimit
      }
    );
  }

  log(message: string): void {
    this.logger.log(message);
  }

  warn(message: string): void {
    this.logger.warn(message);
  }

  error(message: string, ...args: any[]): void {
    this.logger.error(message, ...args);
  }

  async watch(options?: WatchOptions): Promise<boolean> {
    if (this.watcher) {
      return false;
    }
    const repoPaths = this.config.repos.map((r) => path.resolve(this.cwd, r.path));
    const policy = shouldEnableWatcher(repoPaths);
    if (!policy.allowed) {
      this.logger.warn(`Watcher not started: ${policy.reason}`);
      return false;
    }
    this.watcher = new FileWatcher(this, options);
    const started = await this.watcher.start().catch((err) => {
      this.logger.error("Failed to start file watcher:", err);
      return false;
    });
    if (!started) {
      this.watcher.stop();
      this.watcher = undefined;
      return false;
    }
    return true;
  }

  unwatch(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = undefined;
    }
  }

  isWatching(): boolean {
    return this.watcher ? this.watcher.isWatching() : false;
  }

  getPendingFiles(): PendingFile[] {
    return this.watcher ? this.watcher.getPendingFiles() : [];
  }

  isWatcherDegraded(): boolean {
    return this.watcher ? this.watcher.isDegraded() : false;
  }

  getWatcherDegradedReason(): string | null {
    return this.watcher ? this.watcher.getDegradedReason() : null;
  }

  getWatchStatus(catchUp?: WatchStatus["catchUp"]): WatchStatus {
    return this.watcher
      ? this.watcher.getStatus(catchUp)
      : {
        active: false,
        degraded: false,
        degradedReason: null,
        partial: false,
        partialReasons: [],
        mode: this.config.watch.mode,
        installedWatchers: 0,
        coveredRepos: [],
        uncoveredRepos: this.config.repos.map((repo) => repo.name),
        uncoveredPaths: [],
        pendingFiles: [],
        pausedRepos: [],
        indexQueue: this.getIndexQueueStatus(),
        catchUp: catchUp ?? {
          mode: this.config.watch.catchUp,
          running: false,
          completed: false,
          failed: false,
          pendingRepos: [],
          completedRepos: []
        }
      };
  }

  // ---------------------------------------------------------------------------
  // Phase 4.1: Semantic trace and explain-deps
  // ---------------------------------------------------------------------------

  /**
   * Traces single-hop SEMANTIC_REL edges from a given ContractSpec ID.
   *
   * NOTE: Single-hop only. Multi-hop transitive closure is not yet implemented.
   *
   * @param specId    The ContractSpec ID to trace from.
   * @param options.direction  "outgoing", "incoming", or "both" (default).
   * @returns Semantic trace rows showing the direct relation edges.
   */
  async semanticTrace(
    specId: string,
    options?: { direction?: "outgoing" | "incoming" | "both" }
  ): Promise<import("../../core/graph-model/queries.js").SemanticTraceRow[]> {
    const db = await this.getDb();
    const { semanticTrace } = await import("../../core/graph-model/queries.js");
    return semanticTrace(db, specId, options?.direction ?? "both");
  }

  /**
   * Multi-hop semantic trace keyed by a natural contract identifier.
   *
   * Resolves a human-readable target such as "http POST /orders",
   * "event OrderCreated", or "schema CreateOrderRequest" to its ContractSpec
   * node(s) and walks SEMANTIC_REL edges transitively (default 3 hops) in both
   * directions, returning the full connected sub-graph (consumers, request /
   * response / payload schemas, etc.).
   *
   * For single-hop by internal spec ID, use {@link semanticTrace}.
   *
   * @param target   Natural-key identifier or `kind:key` form.
   * @param options.maxHops   Max hops per direction (default 3).
   * @param options.direction "outgoing", "incoming", or "both" (default).
   */
  async trace(
    target: string,
    options?: { maxHops?: number; direction?: "outgoing" | "incoming" | "both" }
  ): Promise<import("../../core/contracts/semanticTrace.js").SemanticTraceGraph> {
    const db = await this.getDb();
    const { traceSemanticGraphFromDB } = await import("../../core/contracts/semanticTrace.js");
    return traceSemanticGraphFromDB(target, db, {
      maxHops: options?.maxHops,
      direction: options?.direction
    });
  }

  /**
   * Explains why two repos depend on each other by traversing SEMANTIC_REL edges.
   * Finds ContractSpecs in each repo and the semantic relations connecting them.
   *
   * @param fromRepo  The source repository name.
   * @param toRepo    The target repository name.
   * @returns An object containing the matched spec pairs and their relations.
   */
  async explainDeps(fromRepo: string, toRepo: string): Promise<{
    fromRepo: string;
    toRepo: string;
    relations: import("../../core/graph-model/queries.js").SemanticTraceRow[];
  }> {
    const db = await this.getDb();
    const fromRepoId = repoId(fromRepo);
    const toRepoId = repoId(toRepo);
    const { explainSemanticRelationsBetweenRepos } = await import("../../core/graph-model/queries.js");
    const relations = await explainSemanticRelationsBetweenRepos(db, fromRepoId, toRepoId);
    return { fromRepo, toRepo, relations };
  }

  /**
   * Safely closes the database connection. Subsequent client operations will fail.
   * This method is idempotent.
   */
  async close(): Promise<void> {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = undefined;
    }
    if (this.closed) return;
    await this.indexQueue.onIdle();
    if (this.dbInstance) {
      await this.dbInstance.close();
      this.dbInstance = undefined;
    }
    this.dbPromise = undefined;
    this.closed = true;
  }

}

function describeIndexOptions(options: IndexOptions): string {
  if (options.repo) return `repo:${options.repo}`;
  if (options.repos?.length) return `repos:${options.repos.join(",")}`;
  if (options.changedOnly) return "changed-only";
  return "all-repos";
}

/**
 * Factory function to create and configure a new client instance.
 * Automatically loads workspace configuration unless an explicit configuration is provided.
 * 
 * @param options - Client creation options.
 * @returns A promise that resolves to a new client instance.
 */
export async function createClient(options: ClientOptions = {}): Promise<AppClient> {
  const cwd = options.cwd ?? process.cwd();
  let config: AppConfig;
  if (options.config) {
    config = options.config;
  } else {
    try {
      config = await loadConfig(cwd);
    } catch {
      config = defaultConfig();
    }
  }
  return new AppClient(options, config);
}

export const GraphClient = AppClient;
