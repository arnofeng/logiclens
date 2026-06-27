import type { EdgeRow } from "../core/graph-model/subgraph.js";
import type { SemanticSearchResult } from "../core/semantic/semanticIndex.js";
import type { RetrievalResult } from "./retrieve.js";

export type RagContextOptions = {
  maxContextChars?: number;
  maxItemChars?: number;
};

export type RagCitation = {
  id: string;
  kind: string;
  repoName?: string;
  filePath: string;
  line?: number;
  endLine?: number;
  title: string;
  confidence?: number;
  resolution?: string;
};

export type RagContextItem = {
  citationId: string;
  kind: string;
  score: number;
  content: string;
};

export type RagAnswerContext = {
  questionKind: string;
  budget: {
    maxContextChars: number;
    usedChars: number;
    totalItems: number;
    includedItems: number;
    truncatedItems: number;
  };
  citations: RagCitation[];
  items: RagContextItem[];
};

const DEFAULT_CONTEXT_CHARS = 16000;
const DEFAULT_ITEM_CHARS = 1200;

function confidenceScore(confidence?: number): number {
  return typeof confidence === "number" ? Math.max(0, Math.min(confidence, 1)) * 10 : 0;
}

function resolutionScore(resolution?: string): number {
  if (resolution === "exact") return 12;
  if (resolution === "probable") return 8;
  if (resolution === "heuristic") return 2;
  if (resolution === "dynamic-unresolved") return 1;
  return 0;
}

function trimContent(value: string, maxChars: number): { content: string; truncated: boolean } {
  if (value.length <= maxChars) return { content: value, truncated: false };
  return { content: `${value.slice(0, Math.max(0, maxChars - 24))}\n[TRUNCATED]`, truncated: true };
}

function location(filePath: string, line?: number, endLine?: number): string {
  if (!filePath) return line && line > 0 ? `line ${line}` : "unknown location";
  if (!line || line <= 0) return filePath;
  return endLine && endLine > line ? `${filePath}:${line}-${endLine}` : `${filePath}:${line}`;
}

function untrustedBlock(citation: RagCitation, body: string): string {
  return [
    `UNTRUSTED_CONTEXT_BLOCK_START citation=${citation.id} source=${citation.kind} location=${location(citation.filePath, citation.line, citation.endLine)}`,
    body,
    "UNTRUSTED_CONTEXT_BLOCK_END"
  ].join("\n");
}

function pushCandidate(
  candidates: Array<{ citation: RagCitation; kind: string; score: number; body: string }>,
  citation: Omit<RagCitation, "id">,
  kind: string,
  score: number,
  body: string
): void {
  if (!body.trim()) return;
  const id = `C${candidates.length + 1}`;
  candidates.push({ citation: { ...citation, id }, kind, score, body });
}

function semanticLocation(row: SemanticSearchResult): { filePath: string; line?: number } {
  const title = row.title ?? "";
  const [filePath, maybeSymbol] = title.split(":");
  if (filePath && maybeSymbol) return { filePath };
  return { filePath: title || row.nodeId };
}

function edgeCitation(edge: EdgeRow): RagCitation {
  return {
    id: "",
    kind: "call-edge",
    filePath: edge.fromFile,
    title: `${edge.fromName} -> ${edge.toName}`,
    confidence: edge.confidence,
    resolution: edge.resolution
  };
}

export function buildAnswerContext(retrieval: RetrievalResult, options: RagContextOptions = {}): RagAnswerContext {
  const maxContextChars = Math.max(1000, options.maxContextChars ?? DEFAULT_CONTEXT_CHARS);
  const maxItemChars = Math.max(200, options.maxItemChars ?? DEFAULT_ITEM_CHARS);
  const candidates: Array<{ citation: RagCitation; kind: string; score: number; body: string }> = [];

  for (const row of retrieval.contracts) {
    pushCandidate(
      candidates,
      {
        kind: "contract",
        repoName: row.repoName,
        filePath: row.filePath,
        line: row.line,
        title: `${row.kind}:${row.key} ${row.role}`,
        confidence: row.confidence,
        resolution: row.resolution
      },
      "contract",
      110 + confidenceScore(row.confidence) + resolutionScore(row.resolution),
      JSON.stringify({
        contract: `${row.kind}:${row.key}`,
        role: row.role,
        repoName: row.repoName,
        filePath: row.filePath,
        line: row.line,
        rule: row.rule,
        confidence: row.confidence,
        resolution: row.resolution,
        raw: row.raw
      }, null, 2)
    );
  }

  for (const row of retrieval.dependencies) {
    pushCandidate(
      candidates,
      {
        kind: "dependency",
        repoName: row.fromRepo,
        filePath: row.filePath,
        line: row.line,
        title: `${row.fromRepo} -> ${row.toRepo} ${row.dependencyType}`,
        confidence: row.confidence,
        resolution: row.resolution
      },
      "dependency",
      100 + confidenceScore(row.confidence) + resolutionScore(row.resolution),
      JSON.stringify(row, null, 2)
    );
  }

  for (const row of retrieval.entities) {
    pushCandidate(
      candidates,
      {
        kind: `entity-${row.sourceKind}`,
        repoName: row.repoName,
        filePath: row.filePath,
        line: row.line,
        title: `${row.entityName} ${row.role}`,
        confidence: row.confidence
      },
      "entity",
      80 + confidenceScore(row.confidence),
      JSON.stringify(row, null, 2)
    );
  }

  for (const row of retrieval.code) {
    pushCandidate(
      candidates,
      {
        kind: "code",
        repoName: row.repoName,
        filePath: row.filePath,
        title: row.qualifiedName || row.name
      },
      "code",
      70,
      JSON.stringify({
        repoName: row.repoName,
        filePath: row.filePath,
        kind: row.kind,
        qualifiedName: row.qualifiedName,
        signature: row.signature,
        summary: row.summary
      }, null, 2)
    );
  }

  for (const row of retrieval.sections) {
    pushCandidate(
      candidates,
      {
        kind: "section",
        repoName: row.repoName,
        filePath: row.filePath,
        line: row.startLine,
        endLine: row.endLine,
        title: row.heading
      },
      "section",
      65,
      JSON.stringify({
        repoName: row.repoName,
        filePath: row.filePath,
        heading: row.heading,
        lines: `${row.startLine}-${row.endLine}`,
        summary: row.summary,
        text: row.text
      }, null, 2)
    );
  }

  for (const edge of retrieval.edges) {
    const citation = edgeCitation(edge);
    pushCandidate(
      candidates,
      citation,
      "call-edge",
      60 + confidenceScore(edge.confidence) + resolutionScore(edge.resolution),
      JSON.stringify(edge, null, 2)
    );
  }

  for (const row of retrieval.semantic) {
    const semanticLoc = semanticLocation(row);
    pushCandidate(
      candidates,
      {
        kind: `semantic-${row.nodeKind}`,
        repoName: row.repoId,
        filePath: semanticLoc.filePath,
        line: semanticLoc.line,
        title: row.title,
        confidence: row.score
      },
      "semantic",
      40 + confidenceScore(row.score),
      JSON.stringify({
        nodeKind: row.nodeKind,
        title: row.title,
        score: row.score,
        sourceText: row.sourceText
      }, null, 2)
    );
  }

  const sorted = candidates.sort((a, b) => b.score - a.score);
  const citations: RagCitation[] = [];
  const items: RagContextItem[] = [];
  let usedChars = 0;
  let truncatedItems = 0;

  for (const candidate of sorted) {
    const trimmed = trimContent(candidate.body, maxItemChars);
    if (trimmed.truncated) truncatedItems += 1;
    const wrapped = untrustedBlock(candidate.citation, trimmed.content);
    if (items.length > 0 && usedChars + wrapped.length > maxContextChars) {
      truncatedItems += 1;
      continue;
    }
    if (items.length === 0 && wrapped.length > maxContextChars) {
      const forceTrimmed = trimContent(candidate.body, Math.max(200, maxContextChars - 180));
      citations.push(candidate.citation);
      const forced = untrustedBlock(candidate.citation, forceTrimmed.content);
      items.push({ citationId: candidate.citation.id, kind: candidate.kind, score: candidate.score, content: forced });
      usedChars += forced.length;
      truncatedItems += 1;
      continue;
    }
    citations.push(candidate.citation);
    items.push({ citationId: candidate.citation.id, kind: candidate.kind, score: candidate.score, content: wrapped });
    usedChars += wrapped.length;
  }

  return {
    questionKind: retrieval.questionKind,
    budget: {
      maxContextChars,
      usedChars,
      totalItems: candidates.length,
      includedItems: items.length,
      truncatedItems
    },
    citations,
    items
  };
}

export function formatAnswerContext(context: RagAnswerContext): string {
  return JSON.stringify({
    questionKind: context.questionKind,
    budget: context.budget,
    citations: context.citations,
    context: context.items.map((item) => ({
      citationId: item.citationId,
      kind: item.kind,
      score: Number(item.score.toFixed(2)),
      content: item.content
    }))
  }, null, 2);
}
