import type { GraphFactsBatch } from "../graph-model/facts.js";
import { projectLexicalDocuments } from "../retrieval/projection.js";
import type { LexicalDocument } from "../retrieval/types.js";
import { runIndexPhase, type IndexPhaseName } from "./phases.js";

export type LexicalProjectionResult = {
  phase: IndexPhaseName;
  durationMs: number;
  documents: LexicalDocument[];
  documentCount: number;
};

export async function runLexicalProjectionPhase(input: {
  facts: GraphFactsBatch;
  workspaceId: string;
  repoName?: string;
  repoId?: string;
}): Promise<LexicalProjectionResult> {
  const phase = await runIndexPhase({
    phase: "lexical-projection",
    batchId: input.facts.batchId,
    repoName: input.repoName,
    repoId: input.repoId
  }, () => projectLexicalDocuments(input.facts, input.workspaceId));
  return {
    phase: phase.phase,
    durationMs: phase.durationMs,
    documents: phase.result,
    documentCount: phase.result.length
  };
}
