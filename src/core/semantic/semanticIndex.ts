import fs from "node:fs/promises";
import path from "node:path";
import { ChromaClient, type Metadata } from "chromadb";
import type { EmbeddingLevel, LogicLensConfig } from "../../config/schema.js";
import type { ParsedDocument, ParsedFile, ParsedGraphFile, RepoNode } from "../parsing/types.js";
import { systemId } from "../graph-model/schema.js";
import { hashText } from "../../shared/hash.js";
import type { ProgressReporter } from "../../shared/progress.js";
import { writeErrorLog } from "../../shared/logger.js";
import { cosineSimilarity, resolveEmbeddingProvider, type EmbeddingVector, type EmbeddingProvider } from "./embeddings.js";
import { extractHeuristicEntities, extractHeuristicEntitiesFromSection } from "./extractEntities.js";
import { createProviderCallRuntime, type ProviderCallStats, type ProviderPolicy } from "../../shared/providerPolicy.js";

export type SemanticNodeKind = "Code" | "Section" | "Entity" | "File" | "Repo" | "System";

export type SemanticRecord = {
  nodeId: string;
  nodeKind: SemanticNodeKind;
  repoId?: string;
  title: string;
  sourceText: string;
  sourceHash: string;
  embedding?: EmbeddingVector;
  updatedAt: string;
};

export type SemanticSearchResult = SemanticRecord & {
  score: number;
};

export interface SemanticIndex {
  records(): Promise<SemanticRecord[]>;
  upsert(records: SemanticRecord[]): Promise<void>;
  search(query: string, options?: { embeddingProvider?: EmbeddingProvider; limit?: number; providerPolicy?: ProviderPolicy }): Promise<SemanticSearchResult[]>;
}

export type SemanticIndexFallbackEvent = {
  operation: "records" | "upsert" | "search";
  message: string;
};

export type SemanticIndexingResult = {
  records: number;
  changed: number;
  cached: number;
  fallbackEvents: SemanticIndexFallbackEvent[];
  providerStats?: ProviderCallStats;
};

const jsonIndexWriteLocks = new Map<string, Promise<void>>();

async function withJsonIndexWriteLock<T>(indexPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = jsonIndexWriteLocks.get(indexPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current, () => current);
  jsonIndexWriteLocks.set(indexPath, next);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (jsonIndexWriteLocks.get(indexPath) === next) jsonIndexWriteLocks.delete(indexPath);
  }
}

export class JsonSemanticIndex implements SemanticIndex {
  private readonly indexPath: string;

  constructor(indexPath: string) {
    this.indexPath = path.resolve(indexPath);
  }

  private async read(): Promise<SemanticRecord[]> {
    try {
      return JSON.parse(await fs.readFile(this.indexPath, "utf8")) as SemanticRecord[];
    } catch {
      return [];
    }
  }

  async records(): Promise<SemanticRecord[]> {
    return this.read();
  }

  private async write(records: SemanticRecord[]): Promise<void> {
    const dir = path.dirname(this.indexPath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.${path.basename(this.indexPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
      await fs.writeFile(tempPath, JSON.stringify(records, null, 2), "utf8");
      await fs.rename(tempPath, this.indexPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async upsert(records: SemanticRecord[]): Promise<void> {
    await withJsonIndexWriteLock(this.indexPath, async () => {
      const current = new Map((await this.read()).map((record) => [record.nodeId, record]));
      for (const record of records) current.set(record.nodeId, record);
      await this.write([...current.values()]);
    });
  }

  async search(query: string, options: { embeddingProvider?: EmbeddingProvider; limit?: number; providerPolicy?: ProviderPolicy } = {}): Promise<SemanticSearchResult[]> {
    const records = await this.read();
    const queryEmbedding = options.embeddingProvider ? await options.embeddingProvider.embedText(query) : undefined;
    const terms = query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fa5]+/).filter(Boolean);
    const scored = records.map((record) => {
      const vectorScore = queryEmbedding && record.embedding ? cosineSimilarity(queryEmbedding, record.embedding) : 0;
      const text = `${record.title}\n${record.sourceText}`.toLowerCase();
      const keywordScore = terms.length === 0 ? 0 : terms.filter((term) => text.includes(term)).length / terms.length;
      return { ...record, score: Math.max(vectorScore, keywordScore * 0.65) };
    });
    return scored.filter((record) => record.score > 0).sort((a, b) => b.score - a.score).slice(0, options.limit ?? 10);
  }
}

type ChromaMetadata = Metadata & {
  nodeId: string;
  nodeKind: string;
  repoId: string;
  title: string;
  sourceHash: string;
  updatedAt: string;
};

export class ChromaSemanticIndex implements SemanticIndex {
  private readonly client: ChromaClient;

  constructor(private readonly options: {
    url: string;
    collection: string;
    authToken?: string;
    tenant?: string;
    database?: string;
  }) {
    const url = new URL(options.url);
    const headers = options.authToken ? { authorization: `Bearer ${options.authToken}`, "x-chroma-token": options.authToken } : undefined;
    this.client = new ChromaClient({
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      ssl: url.protocol === "https:",
      tenant: options.tenant,
      database: options.database,
      headers
    });
  }

  async records(): Promise<SemanticRecord[]> {
    const collection = await this.collectionHandle();
    const rows: SemanticRecord[] = [];
    const limit = 10000;
    for (let offset = 0; ; offset += limit) {
      const result = await collection.get<ChromaMetadata>({ include: ["documents", "metadatas", "embeddings"], limit, offset });
      rows.push(...result.ids.map((id, index) => {
        const metadata = result.metadatas[index];
        return {
          nodeId: metadata?.nodeId ?? id,
          nodeKind: (metadata?.nodeKind ?? "Code") as SemanticNodeKind,
          repoId: metadata?.repoId || undefined,
          title: metadata?.title ?? id,
          sourceText: result.documents[index] ?? "",
          sourceHash: metadata?.sourceHash ?? "",
          embedding: result.embeddings[index],
          updatedAt: metadata?.updatedAt ?? ""
        };
      }));
      if (result.ids.length < limit) break;
    }
    return rows;
  }

  private async collectionHandle() {
    return this.client.getOrCreateCollection({ name: this.options.collection, embeddingFunction: null });
  }

  async upsert(records: SemanticRecord[]): Promise<void> {
    const withEmbeddings = records.filter((record) => record.embedding && record.embedding.length > 0);
    if (withEmbeddings.length === 0) return;
    const collection = await this.collectionHandle();
    await collection.upsert({
      ids: withEmbeddings.map((record) => record.nodeId),
      embeddings: withEmbeddings.map((record) => record.embedding!),
      documents: withEmbeddings.map((record) => record.sourceText),
      metadatas: withEmbeddings.map((record): ChromaMetadata => ({
        nodeId: record.nodeId,
        nodeKind: record.nodeKind,
        repoId: record.repoId ?? "",
        title: record.title,
        sourceHash: record.sourceHash,
        updatedAt: record.updatedAt
      }))
    });
  }

  async search(query: string, options: { embeddingProvider?: EmbeddingProvider; limit?: number; providerPolicy?: ProviderPolicy } = {}): Promise<SemanticSearchResult[]> {
    const queryEmbedding = options.embeddingProvider ? await options.embeddingProvider.embedText(query) : undefined;
    if (!queryEmbedding) return [];
    const collection = await this.collectionHandle();
    const result = await collection.query<ChromaMetadata>({
      queryEmbeddings: [queryEmbedding],
      nResults: options.limit ?? 10,
      include: ["documents", "metadatas", "distances"]
    });
    const ids = result.ids[0] ?? [];
    const documents = result.documents[0] ?? [];
    const metadatas = result.metadatas[0] ?? [];
    const distances = result.distances[0] ?? [];
    return ids.map((id, index) => {
      const metadata = metadatas[index];
      const distance = distances[index] ?? 1;
      return {
        nodeId: metadata?.nodeId ?? id,
        nodeKind: (metadata?.nodeKind ?? "Code") as SemanticNodeKind,
        repoId: metadata?.repoId || undefined,
        title: metadata?.title ?? id,
        sourceText: documents[index] ?? "",
        sourceHash: metadata?.sourceHash ?? "",
        updatedAt: metadata?.updatedAt ?? "",
        score: Math.max(0, 1 - Number(distance))
      };
    });
  }
}

export class FallbackSemanticIndex implements SemanticIndex {
  private readonly fallbackEvents: SemanticIndexFallbackEvent[] = [];

  constructor(
    private readonly primary: SemanticIndex,
    private readonly fallback: SemanticIndex,
    private readonly cwd = process.cwd()
  ) {}

  consumeFallbackEvents(): SemanticIndexFallbackEvent[] {
    return this.fallbackEvents.splice(0);
  }

  private recordFallback(operation: SemanticIndexFallbackEvent["operation"], error: unknown): void {
    this.fallbackEvents.push({ operation, message: error instanceof Error ? error.message : String(error) });
  }

  async records(): Promise<SemanticRecord[]> {
    try {
      return await this.primary.records();
    } catch (error) {
      this.recordFallback("records", error);
      await writeErrorLog("semantic-index:records", error, this.cwd);
      return this.fallback.records();
    }
  }

  async upsert(records: SemanticRecord[]): Promise<void> {
    try {
      await this.primary.upsert(records);
    } catch (error) {
      this.recordFallback("upsert", error);
      await writeErrorLog("semantic-index:upsert", error, this.cwd);
      await this.fallback.upsert(records);
    }
  }

  async search(query: string, options: { embeddingProvider?: EmbeddingProvider; limit?: number; providerPolicy?: ProviderPolicy } = {}): Promise<SemanticSearchResult[]> {
    try {
      const rows = await this.primary.search(query, options);
      if (rows.length > 0) return rows;
    } catch (error) {
      this.recordFallback("search", error);
      await writeErrorLog("semantic-index:search", error, this.cwd);
    }
    return this.fallback.search(query, options);
  }
}

export function defaultSemanticIndex(cwd = process.cwd(), config?: Pick<LogicLensConfig, "semantic">): SemanticIndex {
  const json = new JsonSemanticIndex(path.resolve(cwd, config?.semantic.jsonPath ?? ".logiclens/semantic-index.json"));
  if (config?.semantic.provider === "chroma") {
    const chroma = new ChromaSemanticIndex({
      url: config.semantic.chroma.url,
      collection: config.semantic.chroma.collection,
      authToken: config.semantic.chroma.authToken,
      tenant: config.semantic.chroma.tenant,
      database: config.semantic.chroma.database
    });
    return new FallbackSemanticIndex(chroma, json, cwd);
  }
  return json;
}

function isParsedDocument(file: ParsedGraphFile): file is ParsedDocument {
  return file.language === "markdown";
}

function includeForLevel(kind: SemanticNodeKind, level: EmbeddingLevel, isDocFile = false): boolean {
  if (level === "off") return false;
  if (level === "all") return true;
  if (level === "repo") return kind === "System" || kind === "Repo";
  if (level === "docs") {
    return kind === "System" || kind === "Repo" || (isDocFile && (kind === "File" || kind === "Section")) || kind === "Entity";
  }
  if (level === "file") return kind === "System" || kind === "Repo" || kind === "File";
  return kind === "Code" || kind === "Section" || kind === "Entity";
}

function sourceFileText(file: ParsedFile): string {
  return [
    file.path,
    file.language,
    file.imports.map((item) => `import ${item.module}`).join("\n"),
    file.symbols.map((symbol) => `${symbol.kind} ${symbol.qualifiedName || symbol.name}\n${symbol.signature}\n${symbol.summary ?? ""}`).join("\n\n")
  ].filter(Boolean).join("\n");
}

function documentFileText(file: ParsedDocument): string {
  return [
    file.path,
    file.language,
    file.sections.map((section) => `${"#".repeat(section.level)} ${section.heading}\n${section.summary ?? ""}\n${section.text.slice(0, 1000)}`).join("\n\n")
  ].filter(Boolean).join("\n");
}

function pushRecord(records: Omit<SemanticRecord, "embedding" | "updatedAt">[], record: Omit<SemanticRecord, "embedding" | "updatedAt">, level: EmbeddingLevel, isDocFile = false): void {
  if (includeForLevel(record.nodeKind, level, isDocFile)) records.push(record);
}

export function buildSemanticRecords(input: { repos: RepoNode[]; parsedFiles: ParsedGraphFile[]; level?: EmbeddingLevel }): Omit<SemanticRecord, "embedding" | "updatedAt">[] {
  const level = input.level ?? "all";
  const records: Omit<SemanticRecord, "embedding" | "updatedAt">[] = [];
  const systemText = input.repos.map((repo) => `${repo.name} ${repo.language} ${repo.summary ?? ""}`).join("\n");
  pushRecord(records, { nodeId: systemId, nodeKind: "System", title: "System", sourceText: systemText, sourceHash: hashText(systemText) }, level, false);
  const entities = new Map<string, { name: string; description: string; repoId?: string }>();
  for (const repo of input.repos) {
    const text = [repo.name, repo.path, repo.language, repo.summary].filter(Boolean).join("\n");
    pushRecord(records, { nodeId: repo.id, nodeKind: "Repo", repoId: repo.id, title: repo.name, sourceText: text, sourceHash: hashText(text) }, level, false);
  }
  for (const file of input.parsedFiles) {
    const fileText = isParsedDocument(file) ? documentFileText(file) : sourceFileText(file);
    pushRecord(records, { nodeId: file.fileId, nodeKind: "File", repoId: file.repoId, title: file.path, sourceText: fileText, sourceHash: hashText(fileText) }, level, isParsedDocument(file));
    if (isParsedDocument(file)) {
      for (const section of file.sections) {
        const text = [section.heading, section.summary, section.text].filter(Boolean).join("\n");
        pushRecord(records, { nodeId: section.id, nodeKind: "Section", repoId: section.repoId, title: `${file.path}#${section.heading}`, sourceText: text, sourceHash: hashText(text) }, level, true);
        for (const entity of extractHeuristicEntitiesFromSection(section)) {
          entities.set(entity.id, { name: entity.name, description: `${entity.description}\n${text.slice(0, 500)}`, repoId: section.repoId });
        }
      }
      continue;
    }
    if (level === "docs") {
      continue;
    }
    for (const symbol of file.symbols) {
      const text = [symbol.kind, symbol.qualifiedName, symbol.signature, symbol.summary, symbol.source].filter(Boolean).join("\n");
      pushRecord(records, { nodeId: symbol.id, nodeKind: "Code", repoId: symbol.repoId, title: `${file.path}:${symbol.qualifiedName}`, sourceText: text, sourceHash: hashText(text) }, level, false);
      for (const entity of extractHeuristicEntities(symbol)) {
        entities.set(entity.id, { name: entity.name, description: `${entity.description}\n${text.slice(0, 500)}`, repoId: symbol.repoId });
      }
    }
  }
  for (const [nodeId, entity] of entities) {
    const text = `${entity.name}\n${entity.description}`;
    pushRecord(records, { nodeId, nodeKind: "Entity", repoId: entity.repoId, title: entity.name, sourceText: text, sourceHash: hashText(text) }, level, true);
  }
  return records;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function canReuseEmbedding(previous: SemanticRecord | undefined, sourceHash: string): previous is SemanticRecord & { embedding: EmbeddingVector } {
  return previous?.sourceHash === sourceHash && Array.isArray(previous.embedding) && previous.embedding.length > 0;
}

async function runConcurrent<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index]!, index);
    }
  }));
}

function consumeSemanticFallbackEvents(index: SemanticIndex): SemanticIndexFallbackEvent[] {
  if (index instanceof FallbackSemanticIndex) return index.consumeFallbackEvents();
  return [];
}

export async function indexSemanticText(input: { cwd?: string; repos: RepoNode[]; parsedFiles: ParsedGraphFile[]; embeddingProvider?: EmbeddingProvider; config?: Pick<LogicLensConfig, "semantic" | "embedding">; progress?: ProgressReporter }): Promise<SemanticIndexingResult> {
  const level = input.config?.embedding.level ?? "all";
  const providerName = input.config?.embedding.provider ?? "off";
  if (level === "off" || providerName === "off") return { records: 0, changed: 0, cached: 0, fallbackEvents: [] };
  const provider = input.embeddingProvider ?? resolveEmbeddingProvider(providerName);
  const index = defaultSemanticIndex(input.cwd, input.config);
  const timestamp = new Date().toISOString();
  const existing = new Map((await index.records()).map((record) => [record.nodeId, record]));
  const semanticRecords = buildSemanticRecords({ ...input, level });
  const records: SemanticRecord[] = semanticRecords.map((record) => {
    const previous = existing.get(record.nodeId);
    const unchanged = canReuseEmbedding(previous, record.sourceHash);
    return { ...record, embedding: unchanged ? previous.embedding : undefined, updatedAt: unchanged ? previous.updatedAt : timestamp };
  });
  const changedIndexes = records.map((record, index) => ({ record, index })).filter(({ record }) => !canReuseEmbedding(existing.get(record.nodeId), record.sourceHash));
  const cachedCount = semanticRecords.length - changedIndexes.length;
  input.progress?.({ current: cachedCount, total: semanticRecords.length, label: changedIndexes.length === 0 ? "all embeddings cached" : "prepare embedding batches" });

  const batchSize = input.config?.embedding.batchSize ?? 64;
  const concurrency = input.config?.embedding.concurrency ?? 2;
  const providerRuntime = createProviderCallRuntime({
    retry: input.config?.embedding.retry,
    budget: input.config?.embedding.budget,
    rateLimit: input.config?.embedding.rateLimit
  });
  const batches = chunks(changedIndexes, batchSize);
  let completedBatches = 0;
  let completedRecords = cachedCount;
  await runConcurrent(batches, concurrency, async (batch) => {
    const embeddings = await provider.embedTexts(batch.map(({ record }) => record.sourceText), providerRuntime);
    for (const [offset, embedding] of embeddings.entries()) {
      const item = batch[offset]!;
      records[item.index] = { ...item.record, embedding };
    }
    completedBatches += 1;
    completedRecords += batch.length;
    input.progress?.({ current: completedRecords, total: semanticRecords.length, label: `embedding batch ${completedBatches}/${batches.length}` });
  });
  await index.upsert(records);
  input.progress?.({ current: semanticRecords.length, total: semanticRecords.length, label: "semantic index written" });
  return {
    records: semanticRecords.length,
    changed: changedIndexes.length,
    cached: cachedCount,
    fallbackEvents: consumeSemanticFallbackEvents(index),
    providerStats: providerRuntime.stats
  };
}
