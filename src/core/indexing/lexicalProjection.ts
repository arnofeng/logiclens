import type { GraphFactsBatch } from "../graph-model/facts.js";
import { projectLexicalDocuments } from "../retrieval/projection.js";
import type { LexicalDocument } from "../retrieval/types.js";
import type { ProgressReporter } from "../../shared/progress.js";
import { runIndexPhase, type IndexPhaseName } from "./phases.js";

type ProgressBarLike = {
  reporter(): ProgressReporter;
  complete(label?: string): void;
};

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
  createProgressBar?: (label: string, total: number) => ProgressBarLike;
}): Promise<LexicalProjectionResult> {
  const progress = input.createProgressBar?.(
    input.repoName ? `Lexical projection ${input.repoName}` : "Lexical projection",
    11
  );
  try {
    const phase = await runIndexPhase({
      phase: "lexical-projection",
      batchId: input.facts.batchId,
      repoName: input.repoName,
      repoId: input.repoId
    }, () => projectLexicalDocuments(input.facts, input.workspaceId, progress?.reporter()));
    progress?.complete("done");
    return {
      phase: phase.phase,
      durationMs: phase.durationMs,
      documents: phase.result,
      documentCount: phase.result.length
    };
  } catch (error) {
    progress?.complete("failed");
    throw error;
  }
}
