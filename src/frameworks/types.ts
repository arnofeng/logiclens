import type { EvidenceNode } from "../parsers/types.js";

export type DetectedFramework = {
  repoId: string;
  name: string;      // e.g. "java:spring-mvc", "js:axios", "go:gin", etc.
  language: string;  // e.g. "java", "javascript", "go", "python"
  confidence: number;
  evidence: EvidenceNode[];
};
