import { createClient } from "../sdk/client.js";
import type { ImpactReport } from "../../core/contracts/impact/types.js";

export type ImpactCommandOptions = {
  /** Optional change description, e.g. "field-removed:couponCode" */
  change?: string;
};

export async function impactCommand(
  symbolOrEntity: string,
  options: ImpactCommandOptions = {},
  cwd = process.cwd()
): Promise<void> {
  const client = await createClient({ cwd });
  try {
    // -- Phase 5: Change-based impact analysis --------------------------------
    if (options.change) {
      const parsed = parseChangeOption(options.change);
      if (!parsed) {
        console.error(`Invalid --change format. Expected: <changeType>:<detail>, e.g. "field-removed:couponCode"`);
        process.exit(1);
      }

      const report = await client.analyzeChangeImpact({
        target: symbolOrEntity,
        changeType: parsed.changeType,
        detail: parsed.detail,
      });

      printImpactReport(report);
      return;
    }

    // -- Legacy: Symbol/entity search-based impact ----------------------------
    const result = await client.impact(symbolOrEntity);
    console.log(`Potential impact for ${symbolOrEntity}:`);
    if (result.contractTrace.length > 0) {
      console.log("");
      console.log("Contract producers/consumers:");
      for (const row of result.contractTrace) console.log(`- ${row.role} ${row.repoName}/${row.filePath}:${row.line} ${row.rule} ${row.raw}`);
    }
    if (result.entityTrace.length > 0) {
      console.log("");
      console.log("Entity graph context:");
      for (const row of result.entityTrace) console.log(`- ${row.sourceKind} ${row.repoName} ${row.name} ${row.filePath}:${row.line} ${row.role}`);
    }
    console.log("");
    console.log("Matched code:");
    for (const seed of result.seeds) console.log(`- ${seed.repoName}/${seed.filePath}:${seed.qualifiedName}`);
    console.log("");
    console.log("Related call edges:");
    for (const edge of result.edges) console.log(`- ${edge.fromFile}:${edge.fromName} -> ${edge.toFile}:${edge.toName} (${edge.resolution}, confidence=${edge.confidence})`);
    console.log("");
    console.log("Related docs:");
    for (const section of result.sections) console.log(`- ${section.repoName}/${section.filePath}:${section.heading} (lines ${section.startLine}-${section.endLine})`);
    console.log("");
    console.log("Recommended files to inspect:");
    for (const file of result.recommendedFiles) console.log(`- ${file}`);
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Change option parser
// ---------------------------------------------------------------------------

/** Valid change types recognized by the CLI. */
const VALID_CHANGE_TYPES = new Set([
  "field-added", "field-removed", "field-type-changed",
  "endpoint-removed", "endpoint-renamed", "endpoint-schema-change",
  "topic-removed", "topic-renamed", "event-payload-change",
  "rpc-removed", "rpc-renamed", "rpc-signature-change",
]);

function parseChangeOption(raw: string): { changeType: string; detail?: string } | null {
  const colonIdx = raw.indexOf(":");
  if (colonIdx === -1) {
    // No detail - just the change type
    if (VALID_CHANGE_TYPES.has(raw)) return { changeType: raw };
    return null;
  }
  const changeType = raw.slice(0, colonIdx);
  const detail = raw.slice(colonIdx + 1);
  if (!VALID_CHANGE_TYPES.has(changeType)) return null;
  return { changeType, detail: detail || undefined };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function printImpactReport(report: ImpactReport): void {
  const severityIcon = report.overallSeverity === "breaking" ? "馃敶"
    : report.overallSeverity === "risky" ? "馃煛"
    : "馃煝";

  console.log(`${severityIcon} Severity: ${report.overallSeverity}`);
  console.log("");
  console.log(`Change: ${report.change.changeType} on ${report.change.target}${report.change.detail ? ` (${report.change.detail})` : ""}`);
  console.log(`Traversed ${report.traversedEdgeCount} SEMANTIC_REL edges across ${report.inspectedSpecCount} specs`);
  console.log("");
  console.log(`Summary: ${report.summary.breaking} breaking, ${report.summary.risky} risky, ${report.summary.compatible} compatible`);
  console.log("");

  if (report.impacts.length === 0) {
    console.log("No impacts found.");
    return;
  }

  console.log("Direct impacts:");
  for (const imp of report.impacts) {
    const icon = imp.severity === "breaking" ? "馃敶"
      : imp.severity === "risky" ? "馃煛"
      : "馃煝";
    const lineInfo = imp.line ? `:${imp.line}` : "";
    console.log(`  ${icon} [${imp.severity}] ${imp.repoId} ${imp.symbol} (confidence=${formatConfidence(imp.confidence)})`);
    console.log(`    evidence: ${imp.repoId}/${imp.filePath}${lineInfo} '${imp.evidence}'`);
  }

  if (report.recommendedFiles.length > 0) {
    console.log("");
    console.log("Recommended files to inspect:");
    for (const file of report.recommendedFiles) {
      console.log(`  ${file}`);
    }
  }
}

function formatConfidence(confidence: number): string {
  return Number.isFinite(confidence) ? confidence.toFixed(2) : "n/a";
}
