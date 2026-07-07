import crypto from "node:crypto";
import type { CrossRepoExtraction } from "../contracts/extraction/crossRepoContracts.js";
import type { ParsedGraphFile, RepoNode } from "../parsing/types.js";
import type { GraphDB } from "./db.js";
import { upsertParsedFiles, type UpsertParsedFilesOptions } from "./upsert.js";

export type GraphFactsBatch = {
  batchId: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  contracts?: CrossRepoExtraction;
};

export function createBatchId(prefix = "batch"): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export async function writeGraphFactsBatch(db: GraphDB, batch: GraphFactsBatch, options: UpsertParsedFilesOptions): Promise<void> {
  await upsertParsedFiles(db, batch.parsedFiles, { ...options, batchId: batch.batchId }, batch.repos);
}
