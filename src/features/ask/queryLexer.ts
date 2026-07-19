export type QuoteKind = "double" | "single" | "backtick" | "book";

export type QueryTokenKind =
  | "word"
  | "symbolic"
  | "slash-target"
  | "prefixed-target"
  | "url"
  | "http-method";

export type QuerySpan = {
  raw: string;
  value: string;
  start: number;
  end: number;
  clause: number;
  quoted: boolean;
  quoteKind?: QuoteKind;
  kind: QueryTokenKind;
};

type QuotePair = { close: string; kind: QuoteKind };

const QUOTE_PAIRS: Record<string, QuotePair> = {
  "\"": { close: "\"", kind: "double" },
  "'": { close: "'", kind: "single" },
  "`": { close: "`", kind: "backtick" },
  "“": { close: "”", kind: "double" },
  "‘": { close: "’", kind: "single" },
  "《": { close: "》", kind: "book" }
};

const QUOTE_DELIMITERS = new Set([
  ...Object.keys(QUOTE_PAIRS),
  ...Object.values(QUOTE_PAIRS).map((pair) => pair.close)
]);
const HTTP_METHOD = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;
const PREFIXED_TARGET = /^(?:(?:api|event|schema|dto|enum):|(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):)/i;

function canonicalPunctuation(value: string): string {
  return value.replace(/：/gu, ":");
}

function isApostrophe(text: string, index: number): boolean {
  return text[index] === "'" && /[\p{L}\p{N}]/u.test(text[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[index + 1] ?? "");
}

function closingQuote(text: string, start: number, pair: QuotePair): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] !== pair.close || text[index - 1] === "\\") continue;
    if (pair.close === "'" && isApostrophe(text, index)) continue;
    return index;
  }
  return -1;
}

function isSeparator(char: string): boolean {
  return /\s/u.test(char) || /[,，。；;！!、()[\]（）【】]/u.test(char);
}

function isClauseSeparator(char: string): boolean {
  return /[,，。；;！!？?]/u.test(char);
}

function trimTokenEnd(raw: string): string {
  return raw.replace(/[?？:：.。]+$/u, "");
}

function tokenKind(value: string): QueryTokenKind {
  const canonical = canonicalPunctuation(value);
  if (HTTP_METHOD.test(canonical)) return "http-method";
  if (PREFIXED_TARGET.test(canonical)) return "prefixed-target";
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(canonical)) return "url";
  if (/^(?:\/|\.\.?\/|~\/)/u.test(canonical)) return "slash-target";
  if (/^[\p{L}\p{N}_'-]+$/u.test(canonical)) return "word";
  return "symbolic";
}

export function lexQuery(question: string): QuerySpan[] {
  const spans: QuerySpan[] = [];
  let clause = 0;
  let index = 0;

  while (index < question.length) {
    const char = question[index] ?? "";
    if (isSeparator(char)) {
      if (isClauseSeparator(char)) clause += 1;
      index += 1;
      continue;
    }

    const pair = QUOTE_PAIRS[char];
    if (pair && !isApostrophe(question, index)) {
      const close = closingQuote(question, index, pair);
      if (close >= 0) {
        const raw = question.slice(index, close + 1);
        const value = question.slice(index + 1, close);
        if (value.length > 0) {
          spans.push({ raw, value, start: index, end: close + 1, clause, quoted: true, quoteKind: pair.kind, kind: tokenKind(value) });
        }
        index = close + 1;
        continue;
      }
      index += 1;
      continue;
    }

    if (QUOTE_DELIMITERS.has(char)) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < question.length) {
      const current = question[index] ?? "";
      if (isSeparator(current)) break;
      if (QUOTE_DELIMITERS.has(current) && !isApostrophe(question, index)) break;
      index += 1;
    }
    const scanned = question.slice(start, index);
    const value = trimTokenEnd(scanned);
    if (value.length > 0) {
      spans.push({ raw: value, value, start, end: start + value.length, clause, quoted: false, kind: tokenKind(value) });
    }
    if (/[?？.。]/u.test(scanned.slice(value.length))) clause += 1;
    if (index === start) index += 1;
  }

  return spans;
}
