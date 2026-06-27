// ---------------------------------------------------------------------------
// Phase 5: Impact Analysis — type definitions
// ---------------------------------------------------------------------------

import type { SemanticRelationKind } from "../../parsers/types.js";

// ---------------------------------------------------------------------------
// ChangeIntent — what the user wants to assess
// ---------------------------------------------------------------------------

/** The kind of change being made to a contract. */
export type ChangeType =
  // HTTP endpoint changes
  | "endpoint-removed"
  | "endpoint-renamed"
  | "endpoint-schema-change"
  // Event changes
  | "topic-removed"
  | "topic-renamed"
  | "event-payload-change"
  // Schema field changes
  | "field-added"
  | "field-removed"
  | "field-type-changed";

/** Describes a proposed or hypothetical change to a contract. */
export type ChangeIntent = {
  /** The target spec, e.g. "schema:CreateOrderRequest" or "api:POST:/api/orders" */
  target: string;
  /** What kind of change is being made */
  changeType: ChangeType;
  /** Supplemental detail — field name for field changes, new name for renames */
  detail?: string;
};

// ---------------------------------------------------------------------------
// Severity & impact items
// ---------------------------------------------------------------------------

/** Severity of a single impact. */
export type ImpactSeverity = "breaking" | "risky" | "compatible";

/** A single impacted item — a consumer or dependent affected by the change. */
export type ImpactItem = {
  /** How severe this impact is */
  severity: ImpactSeverity;
  /** The repo containing the affected code */
  repoId: string;
  /** The repo name (if available) */
  repoName?: string;
  /** The file path within the repo */
  filePath: string;
  /** 1-based line number where the affected symbol/code is */
  line?: number;
  /** The name of the affected symbol or contract */
  symbol: string;
  /** The kind of SEMANTIC_REL edge that connects the change to this impact */
  relationKind: SemanticRelationKind;
  /** Human-readable description of the impact */
  description: string;
  /** The raw code or evidence snippet */
  evidence: string;
  /** Associated ContractSpec ID */
  specId: string;
  /** Confidence of this impact assessment (0-1) */
  confidence: number;
};

// ---------------------------------------------------------------------------
// Impact report
// ---------------------------------------------------------------------------

/** Full structured impact analysis report. */
export type ImpactReport = {
  /** The change that was analyzed */
  change: ChangeIntent;
  /** Overall severity (worst-case across all items) */
  overallSeverity: ImpactSeverity;
  /** Individual impacted items, ordered by severity then repo */
  impacts: ImpactItem[];
  /** Summary counts by severity */
  summary: {
    breaking: number;
    risky: number;
    compatible: number;
  };
  /** Recommended files to inspect (deduplicated repo/file pairs) */
  recommendedFiles: string[];
  /** How many SEMANTIC_REL edges were traversed */
  traversedEdgeCount: number;
  /** How many ContractSpec nodes were inspected */
  inspectedSpecCount: number;
};
