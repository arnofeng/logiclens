import type { EvidenceNode, ParsedGraphFile, RepoNode } from "../parsing/types.js";

export type DetectedFramework = {
  repoId: string;
  name: string;      // e.g. "java:spring-mvc", "js:axios", "go:gin", etc.
  language: string;  // e.g. "java", "javascript", "go", "python"
  confidence: number;
  evidence: EvidenceNode[];
};

/**
 * Interface for framework detectors.
 * Used to discover repository-level frameworks and languages.
 */
export interface FrameworkDetector {
  /** The unique name of the framework detector */
  name: string;
  /**
   * Performs framework detection on a repository.
   * Can return a promise or a direct value.
   */
  detect(repo: RepoNode, parsedFiles: ParsedGraphFile[]): Promise<DetectedFramework[]> | DetectedFramework[];
}
