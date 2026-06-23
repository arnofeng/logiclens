import type { CodeSymbol, DocSection, EntityNode } from "../parsers/types.js";
import { entityId } from "../utils/path.js";

const stopWords = new Set(["Promise", "String", "Number", "Boolean", "Array", "Map", "Set", "Error"]);

export function extractHeuristicEntities(symbol: CodeSymbol): EntityNode[] {
  const text = `${symbol.qualifiedName} ${symbol.signature} ${symbol.source.slice(0, 1200)}`;
  return extractEntitiesFromText(text, `Mentioned by ${symbol.qualifiedName}`);
}

export function extractHeuristicEntitiesFromSection(section: DocSection): EntityNode[] {
  return extractEntitiesFromText(`${section.heading} ${section.text.slice(0, 3000)}`, `Mentioned by ${section.heading}`);
}

function extractEntitiesFromText(text: string, description: string): EntityNode[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:Event|Command|Query|Service|Controller|Order|Payment|User)?\b/g)) {
    const value = match[0];
    if (value.length > 2 && !stopWords.has(value)) names.add(value);
  }
  return [...names].map((name) => ({ id: entityId(name), name, kind: "domain-term", description }));
}
