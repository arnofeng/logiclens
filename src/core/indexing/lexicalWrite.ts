import type { RepoNode } from "../parsing/types.js";
import type { WorkspaceLexicalStore } from "../retrieval/provider.js";
import type { LexicalDocument, LexicalIndexHealth } from "../retrieval/types.js";
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
  batchId: string;
  repos: readonly RepoNode[];
  documents: readonly LexicalDocument[];
  repoName?: string;
  repoId?: string;
  reconcileRepos?: boolean;
  activeFileIdsByRepo?: ReadonlyMap<string, readonly string[]>;
}): Promise<LexicalWriteResult> {
  const phase = await runIndexPhase({
    phase: "lexical-write",
    batchId: input.batchId,
    repoName: input.repoName,
    repoId: input.repoId
  }, async () => {
    const documents = [...input.documents].sort((left, right) => compareText(left.id, right.id));
    for (const document of documents) {
      if (document.workspaceId !== input.workspaceId) {
        throw new Error(`Lexical document ${document.id} belongs to a different workspace.`);
      }
      if (document.batchId !== input.batchId) {
        throw new Error(`Lexical document ${document.id} belongs to a different batch.`);
      }
    }
    const repos = [...new Map(input.repos.map((repo) => [repo.id, repo])).values()]
      .sort((left, right) => compareText(left.id, right.id));
    if (documents.length > 0) await input.store.upsertDocuments(documents);
    if (input.reconcileRepos ?? true) for (const repo of repos) {
      const activeDocumentIds = [...new Set(documents
        .filter((document) => document.repoId === repo.id && document.active)
        .map((document) => document.id))]
        .sort(compareText);
      await input.store.reconcileRepoDocuments({
        workspaceId: input.workspaceId,
        repoId: repo.id,
        batchId: input.batchId,
        activeDocumentIds
      });
    }
    if (input.activeFileIdsByRepo) for (const repo of repos) {
      await input.store.reconcileRepoFileDocuments({
        workspaceId: input.workspaceId,
        repoId: repo.id,
        batchId: input.batchId,
        activeFileIds: input.activeFileIdsByRepo.get(repo.id) ?? []
      });
    }
    const providerHealth = await input.store.health(input.workspaceId);
    return {
      documentCount: documents.length,
      reconciledRepoIds: (input.reconcileRepos ?? true) ? repos.map((repo) => repo.id) : [],
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
