import type { GraphDB } from "../../graph-model/db.js";
import type {
  ContractSpecNode,
  RepoDependencyEdge,
  SemanticRelationEdge
} from "../../parsing/types.js";
import { isKnownSpecKind } from "../../parsing/types.js";
import { materializeDependenciesFromSemanticRelations } from "../extraction/crossRepoContracts.js";
import {
  DEP_EDGE_RETURN,
  SEMANTIC_REL_RETURN,
  SPEC_RETURN,
  rowToContractSpec,
  rowToDepEdge,
  rowToSemanticRel,
  type DepEdgeRow,
  type SemanticRelRow,
  type SpecRow
} from "../specRows.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DependencySetKey = {
  fromRepo: string;
  toRepo: string;
  dependencyType: RepoDependencyEdge["dependencyType"];
  sourceContractId: string;
  targetContractId: string;
};

export type MetricByType = {
  dependencyType: string;
  expected: number;
  actual: number;
  truePositive: number;
  falsePositive: DependencySetKey[];
  falseNegative: DependencySetKey[];
  precision: number;
  recall: number;
  f1: number;
};

export type PrecisionRecallReport = {
  /** Per-dependency-type metrics. */
  byType: MetricByType[];
  /** Aggregate across all types. */
  aggregate: MetricByType;
  /** Total SEMANTIC_REL edges inspected. */
  semanticRelCount: number;
  /** Total DEPENDS_ON edges from the old track. */
  legacyDepCount: number;
  /** Total materialized DEPENDS_ON edges. */
  materializedCount: number;
};

// ---------------------------------------------------------------------------
// Key extraction
// ---------------------------------------------------------------------------

function toKey(edge: RepoDependencyEdge): string {
  return `${edge.fromRepoId}:${edge.toRepoId}:${edge.dependencyType}:${edge.sourceContractId}:${edge.targetContractId}`;
}

function toStructuredKey(edge: RepoDependencyEdge): DependencySetKey {
  return {
    fromRepo: edge.fromRepoId,
    toRepo: edge.toRepoId,
    dependencyType: edge.dependencyType,
    sourceContractId: edge.sourceContractId,
    targetContractId: edge.targetContractId
  };
}

// ---------------------------------------------------------------------------
// Set comparison
// ---------------------------------------------------------------------------

/**
 * Compares a "candidate" set (the new system) against a "baseline" set
 * (the old system / ground truth). Precision = |candidate ∩ baseline| / |candidate|,
 * Recall = |candidate ∩ baseline| / |baseline|.
 */
export function compareDependencySets(
  candidate: RepoDependencyEdge[],
  baseline: RepoDependencyEdge[]
): { byType: MetricByType[]; aggregate: MetricByType } {
  const candidateKeys = new Map<string, RepoDependencyEdge>();
  for (const edge of candidate) {
    const key = toKey(edge);
    if (!candidateKeys.has(key)) candidateKeys.set(key, edge);
  }

  const baselineKeys = new Map<string, RepoDependencyEdge>();
  for (const edge of baseline) {
    const key = toKey(edge);
    if (!baselineKeys.has(key)) baselineKeys.set(key, edge);
  }

  const candidateSet = new Set(candidateKeys.keys());
  const baselineSet = new Set(baselineKeys.keys());

  // Group by dependency type
  const types = new Set<string>();
  for (const edge of [...candidate, ...baseline]) {
    types.add(edge.dependencyType);
  }

  const byType: MetricByType[] = [];
  for (const depType of [...types].sort()) {
    const typeCandidates = new Set<string>();
    const typeBaseline = new Set<string>();
    for (const key of candidateSet) {
      if (candidateKeys.get(key)!.dependencyType === depType) typeCandidates.add(key);
    }
    for (const key of baselineSet) {
      if (baselineKeys.get(key)!.dependencyType === depType) typeBaseline.add(key);
    }

    const truePositive = [...typeCandidates].filter((k) => typeBaseline.has(k));
    const falsePositiveKeys = [...typeCandidates].filter((k) => !typeBaseline.has(k));
    const falseNegativeKeys = [...typeBaseline].filter((k) => !typeCandidates.has(k));

    const tp = truePositive.length;
    const precision = typeCandidates.size === 0 ? 1 : tp / typeCandidates.size;
    const recall = typeBaseline.size === 0 ? 1 : tp / typeBaseline.size;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    byType.push({
      dependencyType: depType,
      expected: typeBaseline.size,
      actual: typeCandidates.size,
      truePositive: tp,
      falsePositive: falsePositiveKeys.map((k) => toStructuredKey(candidateKeys.get(k)!)),
      falseNegative: falseNegativeKeys.map((k) => toStructuredKey(baselineKeys.get(k)!)),
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1: Number(f1.toFixed(4))
    });
  }

  // Aggregate
  const allTP = [...candidateSet].filter((k) => baselineSet.has(k));
  const allFP = [...candidateSet].filter((k) => !baselineSet.has(k));
  const allFN = [...baselineSet].filter((k) => !candidateSet.has(k));
  const aggPrecision = candidateSet.size === 0 ? 1 : allTP.length / candidateSet.size;
  const aggRecall = baselineSet.size === 0 ? 1 : allTP.length / baselineSet.size;
  const aggF1 = aggPrecision + aggRecall === 0 ? 0 : (2 * aggPrecision * aggRecall) / (aggPrecision + aggRecall);

  const aggregate: MetricByType = {
    dependencyType: "ALL",
    expected: baselineSet.size,
    actual: candidateSet.size,
    truePositive: allTP.length,
    falsePositive: allFP.map((k) => toStructuredKey(candidateKeys.get(k)!)),
    falseNegative: allFN.map((k) => toStructuredKey(baselineKeys.get(k)!)),
    precision: Number(aggPrecision.toFixed(4)),
    recall: Number(aggRecall.toFixed(4)),
    f1: Number(aggF1.toFixed(4))
  };

  return { byType, aggregate };
}

// ---------------------------------------------------------------------------
// In-memory evaluation (for tests and indexing pipeline)
// ---------------------------------------------------------------------------

/**
 * Evaluates precision/recall of SEMANTIC_REL-based dependency materialization
 * against legacy DEPENDS_ON edges, using in-memory data (no DB required).
 *
 * This is suitable for:
 * - Unit tests
 * - Running during indexing before persisting to the graph
 *
 * @param semanticRelations  Active SEMANTIC_REL edges from the resolver.
 * @param contractSpecs      All ContractSpec nodes.
 * @param legacyDeps         DEPENDS_ON edges produced by the old matcher
 *                           (`buildRepoDependenciesFromParticipants`).
 */
export function evaluatePrecisionRecallInMemory(
  semanticRelations: SemanticRelationEdge[],
  contractSpecs: ContractSpecNode[],
  legacyDeps: RepoDependencyEdge[]
): PrecisionRecallReport {
  const materialized = materializeDependenciesFromSemanticRelations(semanticRelations, contractSpecs);
  const { byType, aggregate } = compareDependencySets(materialized, legacyDeps);

  return {
    byType,
    aggregate,
    semanticRelCount: semanticRelations.length,
    legacyDepCount: legacyDeps.length,
    materializedCount: materialized.length
  };
}

// ---------------------------------------------------------------------------
// Graph DB evaluation (for runtime calibration against an indexed workspace)
// ---------------------------------------------------------------------------

/**
 * Evaluates precision/recall by querying the graph database for both
 * existing DEPENDS_ON edges and SEMANTIC_REL edges, then comparing
 * the materialized result against the legacy result.
 *
 * This is suitable for runtime calibration against an already-indexed workspace.
 */
export async function evaluatePrecisionRecall(db: GraphDB): Promise<PrecisionRecallReport> {
  // Load all active SEMANTIC_REL edges
  const semanticRows = await db.query<SemanticRelRow>(
    `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
     WHERE (r.active IS NULL OR r.active = true)
     RETURN ${SEMANTIC_REL_RETURN}`
  );

  // Load all active ContractSpec nodes
  const specRows = await db.query<SpecRow>(
    `MATCH (s:ContractSpec)
     WHERE (s.active IS NULL OR s.active = true)
     RETURN ${SPEC_RETURN}`
  );

  // Load all active DEPENDS_ON edges
  const depRows = await db.query<DepEdgeRow>(
    `MATCH (from:Repo)-[d:DEPENDS_ON]->(to:Repo)
     WHERE (d.active IS NULL OR d.active = true)
     RETURN ${DEP_EDGE_RETURN}`
  );

  const semanticRels = semanticRows.map(rowToSemanticRel);
  const specs = specRows.filter((row) => isKnownSpecKind(row.specKind)).map(rowToContractSpec);
  const legacyDeps = depRows.map(rowToDepEdge);

  return evaluatePrecisionRecallInMemory(semanticRels, specs, legacyDeps);
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export function formatPrecisionRecallReport(report: PrecisionRecallReport): string {
  const lines: string[] = [
    "═".repeat(70),
    "  Precision/Recall Calibration Report",
    "═".repeat(70),
    "",
    `  SEMANTIC_REL edges: ${report.semanticRelCount}`,
    `  Legacy DEPENDS_ON:  ${report.legacyDepCount}`,
    `  Materialized:       ${report.materializedCount}`,
    "",
    "  Per-type metrics:",
    "  ─────────────────────────────────────────────────────",
    ""
  ];

  for (const metric of report.byType) {
    lines.push(
      `  ${metric.dependencyType.padEnd(18)} ` +
      `P=${metric.precision.toFixed(3)} R=${metric.recall.toFixed(3)} F1=${metric.f1.toFixed(3)} ` +
      `expected=${metric.expected} actual=${metric.actual} TP=${metric.truePositive}`
    );
    if (metric.falsePositive.length > 0) {
      lines.push(`    FP (${metric.falsePositive.length}):`);
      for (const fp of metric.falsePositive.slice(0, 5)) {
        lines.push(`      ${fp.fromRepo} → ${fp.toRepo} [${fp.dependencyType}] ${fp.sourceContractId}`);
      }
      if (metric.falsePositive.length > 5) {
        lines.push(`      ... and ${metric.falsePositive.length - 5} more`);
      }
    }
    if (metric.falseNegative.length > 0) {
      lines.push(`    FN (${metric.falseNegative.length}):`);
      for (const fn of metric.falseNegative.slice(0, 5)) {
        lines.push(`      ${fn.fromRepo} → ${fn.toRepo} [${fn.dependencyType}] ${fn.sourceContractId}`);
      }
      if (metric.falseNegative.length > 5) {
        lines.push(`      ... and ${metric.falseNegative.length - 5} more`);
      }
    }
  }

  lines.push("");
  lines.push("  Aggregate:");
  lines.push(
    `  ${"ALL".padEnd(18)} ` +
    `P=${report.aggregate.precision.toFixed(3)} R=${report.aggregate.recall.toFixed(3)} F1=${report.aggregate.f1.toFixed(3)} ` +
    `expected=${report.aggregate.expected} actual=${report.aggregate.actual} TP=${report.aggregate.truePositive}`
  );
  lines.push("");
  lines.push("═".repeat(70));

  return lines.join("\n");
}
