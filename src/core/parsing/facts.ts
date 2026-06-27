import type { CallRef, CodeSymbol, ImportRef } from "./types.js";

export type AnnotationArgument = {
  name?: string;
  value: string;
  raw: string;
};

export type AnnotationFact = {
  ownerSymbolId?: string;
  ownerKind: "class" | "method" | "field" | "file";
  name: string;
  arguments: AnnotationArgument[];
  raw: string;
  line: number;
};

export type DecoratorFact = {
  ownerSymbolId?: string;
  ownerKind: "class" | "method" | "function" | "property";
  name: string;
  arguments: unknown[];
  raw: string;
  line: number;
};

export type LiteralFact = {
  value: string;
  kind: "string" | "template" | "number" | "object";
  ownerSymbolId?: string;
  line: number;
  raw: string;
};

export type ParsedSourceFacts = {
  repoId: string;
  fileId: string;
  path: string;
  language: string;
  packageName?: string;
  imports: ImportRef[];
  symbols: CodeSymbol[];
  annotations: AnnotationFact[];
  decorators: DecoratorFact[];
  calls: CallRef[];
  literals: LiteralFact[];
};
