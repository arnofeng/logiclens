export type IndexPhaseName =
  | "repo-planning"
  | "scan"
  | "parse"
  | "llm-summary"
  | "fact-build"
  | "graph-write"
  | "semantic-write"
  | "stale-mark"
  | "relation-rebuild"
  | "index-state-commit";

export type IndexPhaseScope = {
  phase: IndexPhaseName;
  repoName?: string;
  repoId?: string;
  batchId?: string;
  filePath?: string;
  writerMode?: string;
};

export type IndexPhaseResult<T> = {
  phase: IndexPhaseName;
  durationMs: number;
  result: T;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatScope(scope: IndexPhaseScope): string {
  const details = [
    `phase=${scope.phase}`,
    scope.repoName ? `repo=${scope.repoName}` : undefined,
    scope.repoId ? `repoId=${scope.repoId}` : undefined,
    scope.batchId ? `batchId=${scope.batchId}` : undefined,
    scope.filePath ? `file=${scope.filePath}` : undefined,
    scope.writerMode ? `writerMode=${scope.writerMode}` : undefined
  ].filter((detail): detail is string => Boolean(detail));
  return details.join(" ");
}

export class IndexPhaseError extends Error {
  readonly scope: IndexPhaseScope;
  readonly graphWriteAtomicity?: string;
  readonly graphWriteStatus?: string;

  constructor(scope: IndexPhaseScope, cause: unknown) {
    super(`Index phase failed (${formatScope(scope)}): ${errorMessage(cause)}`, {
      cause
    });
    this.name = "IndexPhaseError";
    this.scope = scope;
    if (cause && typeof cause === "object") {
      const graphWriteFailure = cause as { graphWriteAtomicity?: string; graphWriteStatus?: string };
      this.graphWriteAtomicity = graphWriteFailure.graphWriteAtomicity;
      this.graphWriteStatus = graphWriteFailure.graphWriteStatus;
    }
  }
}

export async function runIndexPhase<T>(
  scope: IndexPhaseScope,
  fn: () => Promise<T> | T
): Promise<IndexPhaseResult<T>> {
  const started = Date.now();
  try {
    const result = await fn();
    return {
      phase: scope.phase,
      durationMs: Date.now() - started,
      result
    };
  } catch (error) {
    if (error instanceof IndexPhaseError) throw error;
    throw new IndexPhaseError(scope, error);
  }
}
