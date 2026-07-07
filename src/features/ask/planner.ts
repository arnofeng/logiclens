export type QuestionKind = "impact" | "workflow" | "symbol" | "dependency" | "debugging" | "general";

export function planQuestion(question: string): { kind: QuestionKind; terms: string[] } {
  const lowered = question.toLowerCase();
  const kind: QuestionKind = /impact|influence|who[\s_]*uses|\bref\b/.test(lowered)
    ? "impact"
    : /flow|workflow|chain|create/.test(lowered)
      ? "workflow"
      : /dependency|depend|import/.test(lowered)
        ? "dependency"
        : /error|bug|debug|exception/.test(lowered)
          ? "debugging"
          : /function|class|symbol|method/.test(lowered)
            ? "symbol"
            : "general";
  const terms = [...question.matchAll(/[A-Za-z_][A-Za-z0-9_]+|[\u4e00-\u9fa5]{2,}/g)].map((match) => match[0]);
  return { kind, terms: terms.length ? terms : [question] };
}
