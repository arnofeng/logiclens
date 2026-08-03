import type { RepoNode } from "../parsing/types.js";
import type { WorkspaceLexicalStore } from "../retrieval/provider.js";
import type { LexicalDocument, LexicalIndexHealth } from "../retrieval/types.js";
import { getBrandedEnv } from "../../shared/branding.js";
import { runIndexPhase, type IndexPhaseName } from "./phases.js";

export type LexicalWriteResult = {
  phase: IndexPhaseName;
  durationMs: number;
  documentCount: number;
  reconciledRepoIds: string[];
  providerHealth: LexicalIndexHealth;
  projectionSchemaVersion: string;
  tokenizerVersion: string;
  indexStatus: LexicalIndexHealth["status"];
  indexReasons: string[];
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function runLexicalWritePhase(input: {
  store: WorkspaceLexicalStore;
  workspaceId: string;
  generation: string;
  batchId: string;
  repos: readonly RepoNode[];
  documents: readonly LexicalDocument[];
  repoName?: string;
  repoId?: string;
  reconcileRepos?: boolean;
  reconcileReason?: string;
  activeFileIdsByRepo?: ReadonlyMap<string, readonly string[]>;
  touchedFileIdsByRepo?: ReadonlyMap<string, readonly string[]>;
  deleteDocumentIds?: readonly string[];
}): Promise<LexicalWriteResult> {
  const phase = await runIndexPhase({
    phase: "lexical-write",
    batchId: input.batchId,
    repoName: input.repoName,
    repoId: input.repoId
  }, async () => {
    const validationStarted = Date.now();
    const documents = [...input.documents].sort((left, right) => compareText(left.id, right.id));
    for (const document of documents) {
      if (document.workspaceId !== input.workspaceId) {
        throw new Error(`Lexical document ${document.id} belongs to a different workspace.`);
      }
      if (document.batchId !== input.batchId) {
        throw new Error(`Lexical document ${document.id} belongs to a different batch.`);
      }
    }
    writeLexicalTrace(`phase validation documents=${documents.length} duration=${Date.now() - validationStarted}ms`);
    const repos = [...new Map(input.repos.map((repo) => [repo.id, repo])).values()]
      .sort((left, right) => compareText(left.id, right.id));
    await input.store.stageBatch?.({
      workspaceId: input.workspaceId,
      generation: input.generation,
      batchId: input.batchId,
      repoIds: repos.map((repo) => repo.id)
    });
    const deleteDocumentIds = [...new Set(input.deleteDocumentIds ?? [])].sort(compareText);
    if (deleteDocumentIds.length > 0) await input.store.deleteDocuments({
      workspaceId: input.workspaceId,
      generation: input.generation,
      documentIds: deleteDocumentIds
    });
    const upsertStarted = Date.now();
    if (documents.length > 0) await input.store.upsertDocuments({
      workspaceId: input.workspaceId,
      generation: input.generation,
      documents
    });
    writeLexicalTrace(`phase upsert documents=${documents.length} duration=${Date.now() - upsertStarted}ms`);
    const reconcileStarted = Date.now();
    const reconcileRepos = input.reconcileRepos ?? true;
    writeLexicalTrace(`phase reconcile decision=${reconcileRepos ? "execute" : "skip"} reason=${input.reconcileReason ?? (input.reconcileRepos === undefined ? "default" : "pipeline")}`);
    if (reconcileRepos) for (const repo of repos) {
      const activeDocumentIds = [...new Set(documents
        .filter((document) => document.repoId === repo.id && document.active)
        .map((document) => document.id))]
        .sort(compareText);
      await input.store.reconcileRepoDocuments({
        workspaceId: input.workspaceId,
        generation: input.generation,
        repoId: repo.id,
        batchId: input.batchId,
        activeDocumentIds
      });
    }
    if (input.activeFileIdsByRepo) for (const repo of repos) {
      await input.store.reconcileRepoFileDocuments({
        workspaceId: input.workspaceId,
        generation: input.generation,
        repoId: repo.id,
        batchId: input.batchId,
        activeFileIds: input.activeFileIdsByRepo.get(repo.id) ?? []
      });
    }
    if (input.touchedFileIdsByRepo && input.store.replaceSourceDocuments) for (const repo of repos) {
      const touchedFileIds = input.touchedFileIdsByRepo.get(repo.id) ?? [];
      if (touchedFileIds.length === 0) continue;
      await input.store.replaceSourceDocuments({
        workspaceId: input.workspaceId,
        generation: input.generation,
        repoId: repo.id,
        batchId: input.batchId,
        touchedFileIds,
        activeDocumentIds: documents.filter((document) => document.repoId === repo.id && document.active).map((document) => document.id)
      });
    }
    writeLexicalTrace(`phase reconcile repos=${repos.length} duration=${Date.now() - reconcileStarted}ms`);
    const healthStarted = Date.now();
    const providerHealth = await input.store.pendingHealth({
      workspaceId: input.workspaceId,
      generation: input.generation
    });
    writeLexicalTrace(`phase health duration=${Date.now() - healthStarted}ms status=${providerHealth.status}`);
    return {
      documentCount: documents.length,
      reconciledRepoIds: reconcileRepos ? repos.map((repo) => repo.id) : [],
      providerHealth
    };
  });
  return {
    phase: phase.phase,
    durationMs: phase.durationMs,
    documentCount: phase.result.documentCount,
    reconciledRepoIds: phase.result.reconciledRepoIds,
    providerHealth: phase.result.providerHealth,
    projectionSchemaVersion: phase.result.providerHealth.projectionSchemaVersion,
    tokenizerVersion: phase.result.providerHealth.tokenizerVersion,
    indexStatus: phase.result.providerHealth.status,
    indexReasons: [...phase.result.providerHealth.reasons]
  };
}

function writeLexicalTrace(message: string): void {
  const value = getBrandedEnv("LEXICAL_TRACE");
  if (value === "1" || value === "true") process.stderr.write(`Lexical write ${message}\n`);
}
