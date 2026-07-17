const LEXICAL_VALUE_PATTERN = /[\p{L}\p{M}\p{N}]+(?:[._/-]+[\p{L}\p{M}\p{N}]+)*/gu;
const HAN_RUN_PATTERN = /[\p{Script=Han}]+/gu;
const IDENTIFIER_SEPARATOR_PATTERN = /[._/-]+/g;
const SLASH_SEGMENT_PATTERN = /(?<![:/])\/([\p{L}\p{M}\p{N}{}._-]+)/gu;

function lowercase(value: string): string {
  return value.toLowerCase();
}

function splitIdentifierPart(value: string): string[] {
  return value
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .split(/\s+/u)
    .filter(Boolean);
}

/**
 * Produces deterministic search tokens for prose, identifiers, paths and
 * mixed-language source facts. The implementation is locale and I/O free.
 */
export function tokenizeLexicalText(text: string): string[] {
  const normalized = text.normalize("NFKC");
  const pathNormalized = normalized.replace(/\\/g, "/");
  const tokens = new Set<string>();

  for (const result of pathNormalized.matchAll(LEXICAL_VALUE_PATTERN)) {
    const match = result[0];
    const followsRootSeparator = (result.index ?? 0) > 0 && pathNormalized[(result.index ?? 0) - 1] === "/";
    const isRootedPathRemainder = followsRootSeparator && match.includes("/");
    const whole = lowercase(match);
    if (!isRootedPathRemainder) tokens.add(whole);

    const separated = match.split(IDENTIFIER_SEPARATOR_PATTERN).filter(Boolean);
    for (const value of separated) {
      for (const part of splitIdentifierPart(value)) {
        tokens.add(lowercase(part));
      }
    }

    if (separated.length > 1 && !isRootedPathRemainder) {
      const identifier = separated.map(lowercase).join("_");
      tokens.add(`ident_${identifier}`);
    }
  }

  for (const match of pathNormalized.matchAll(SLASH_SEGMENT_PATTERN)) {
    const segment = match[1]?.replace(/[{}]/g, "");
    if (!segment) continue;
    const lowered = lowercase(segment);
    tokens.add(`/${lowered}`);
    tokens.add(`ident_${lowered.replace(/[^\p{L}\p{M}\p{N}]+/gu, "_")}`);
  }

  for (const run of normalized.match(HAN_RUN_PATTERN) ?? []) {
    const characters = Array.from(run);
    for (const character of characters) tokens.add(`cjk_${character}`);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      tokens.add(`cjk_${characters[index]}${characters[index + 1]}`);
    }
  }

  return [...tokens].sort();
}
