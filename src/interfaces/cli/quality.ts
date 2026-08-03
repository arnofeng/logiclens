import path from "node:path";
import { loadConfig } from "../../config/loadConfig.js";
import { createGraphDB } from "../../core/graph-model/factory.js";
import { auditRelationQuality, rejectEvidence, upsertAliasOverride } from "../../features/quality/quality.js";
import { repoId } from "../../shared/path.js";
import { auditContractQuality } from "../../features/quality/qualityRules.js";
import { deriveWorkspaceId } from "../../core/workspace/identity.js";
import { canonicalSerialize } from "../../core/schema/model.js";
import {
  querySchemaQuality,
  SCHEMA_OUTCOMES,
  type SchemaOutcome,
  type SchemaQualityDetail,
  type SchemaQualityGroupBy,
  type SchemaQualityReport,
  type SchemaQualitySummary
} from "../../core/schema/quality.js";

export type QualityOptions = {
  minConfidence?: number;
  limit?: number;
  rejectEvidence?: string;
  reason?: string;
  alias?: string;
  targetRepo?: string;
  groupBy?: string;
  details?: string;
  json?: boolean;
};

export async function qualityCommand(
  actionOrOptions: string | QualityOptions | undefined,
  optionsInput?: QualityOptions,
  cwd = process.cwd()
): Promise<void> {
  let action: string | undefined = undefined;
  let options: QualityOptions = {};
  if (typeof actionOrOptions === "string") {
    action = actionOrOptions;
    options = optionsInput ?? {};
  } else {
    options = actionOrOptions ?? {};
  }

  const config = await loadConfig(cwd);
  const db = await createGraphDB(config.graph.provider, {
    path: path.resolve(cwd, config.graph.path),
    url: config.graph.url,
    username: config.graph.username,
    password: config.graph.password,
    database: config.graph.database
  });
  try {
    await db.initSchema(config.systemName);
    const workspaceId = deriveWorkspaceId(config.systemName);

    if (action === "schemas") {
      const groupBy = parseGroupBy(options.groupBy);
      const details = parseDetails(options.details);
      const report = await querySchemaQuality(db, workspaceId, { groupBy, details });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatSchemaQualityText(report));
      return;
    }
    
    if (action === "contracts") {
      const violations = await auditContractQuality(db, workspaceId);
      if (violations.length === 0) {
        console.log("No contract quality issues found.");
        return;
      }
      for (const v of violations) {
        console.log(`[${v.severity}] ${v.description}`);
        for (const detail of v.details) {
          console.log(detail);
        }
        console.log(v.suggestedFix);
        console.log();
      }
      return;
    }

    if (options.rejectEvidence) {
      await rejectEvidence(db, workspaceId, { evidenceId: options.rejectEvidence, reason: options.reason ?? "Marked as false positive" });
      console.log(`Rejected evidence: ${options.rejectEvidence}`);
      return;
    }
    if (options.alias && options.targetRepo) {
      await upsertAliasOverride(db, { alias: options.alias, targetRepoId: repoId(options.targetRepo), reason: options.reason ?? "Manual alias override" });
      console.log(`Alias override: ${options.alias} -> ${options.targetRepo}`);
      return;
    }
    const audit = await auditRelationQuality(db, workspaceId, { minConfidence: options.minConfidence, limit: options.limit });
    console.log("Low-confidence relations:");
    for (const row of audit.lowConfidence) {
      console.log(`- ${row.evidenceId} ${row.repoName} ${row.role} ${row.contractKind}:${row.contractKey} confidence=${row.confidence} ${row.filePath}:${row.line} rule=${row.rule}`);
    }
    console.log("Conflicting producers:");
    for (const row of audit.conflicts) {
      console.log(`- ${row.contractKind}:${row.contractKey} producers=${row.producers}`);
    }
  } finally {
    await db.close();
  }
}

export function formatSchemaQualityText(report: SchemaQualityReport): string {
  const lines = [
    `Schema quality (active generation: ${report.generation ?? "none"})`,
    formatSummary("Root outcomes", report.summary),
    formatDiagnostics("Diagnostic entries", report.summary)
  ];
  const incompleteRoots = SCHEMA_OUTCOMES
    .filter((outcome) => outcome !== "resolved")
    .reduce((total, outcome) => total + report.summary.rootOutcomes[outcome], 0);
  if (report.summary.rootOutcomes.roots === 0 && report.summary.diagnosticEntries.total === 0) {
    lines.push("Status: no schema roots or schema-chain diagnostics are present in the active generation.");
  } else if (incompleteRoots > 0 || report.summary.diagnosticEntries.total > 0) {
    lines.push("Status: schema contracts exist, but one or more schema chains are incomplete; inspect details before treating missing relations as no consumers.");
  } else {
    lines.push("Status: every schema root has a resolved relation; an absent consumer/relation is a genuine absence in the active generation.");
  }
  if (report.groupBy) {
    lines.push("", `Grouped by ${report.groupBy}:`);
    if (report.groups.length === 0) lines.push("- (no groups)");
    for (const group of report.groups) {
      lines.push(`- ${group.value}: ${formatSummary("roots", group.summary)}; ${formatDiagnostics("diagnostics", group.summary)}`);
    }
  }
  if (report.details.length > 0) {
    lines.push("", "Details:");
    for (const detail of report.details) lines.push(...formatDetail(detail));
  }
  return lines.join("\n");
}

function formatSummary(label: string, summary: SchemaQualitySummary): string {
  const counts = summary.rootOutcomes;
  return `${label}: roots=${counts.roots} resolved=${counts.resolved} unresolved=${counts.unresolved} external=${counts.external} ambiguous=${counts.ambiguous} unsupported=${counts.unsupported} truncated=${counts.truncated}`;
}

function formatDiagnostics(label: string, summary: SchemaQualitySummary): string {
  const counts = summary.diagnosticEntries;
  return `${label}: total=${counts.total} unresolved=${counts.unresolved} external=${counts.external} ambiguous=${counts.ambiguous} unsupported=${counts.unsupported} truncated=${counts.truncated}`;
}

function formatDetail(detail: SchemaQualityDetail): string[] {
  const location = [
    `repo=${detail.repoId ?? "-"}`,
    `source=${detail.sourceFileId ?? "-"}`,
    `owner=${detail.ownerSpecId ?? "-"}`,
    `root=${detail.rootReferenceId ?? "-"}`,
    `symbol=${detail.symbol ?? detail.rawTypeExpression ?? "-"}`,
    `field=${detail.fieldPath.join(".") || "<root>"}`,
    `typePath=${detail.typePath.map((part) => canonicalSerialize(part)).join(" -> ") || "<root>"}`,
    `relation=${detail.relationKind ?? "-"}`,
    `code=${detail.diagnosticCode}`
  ];
  if (detail.limit) location.push(`limit=${detail.limit.kind}:${detail.limit.value}`);
  const lines = [`- [${detail.outcome}] ${location.join(" ")}`];
  for (const candidate of detail.candidates) {
    const identity = `${candidate.identity.languageId}/${candidate.identity.repoId}/${candidate.identity.resolutionScopeId}/${candidate.identity.canonicalName}`;
    const evidence = [candidate.filePath ?? candidate.fileId, candidate.line, candidate.sourceSymbolId, candidate.rule]
      .filter((value) => value !== undefined).join(":");
    lines.push(`  candidate=${identity}${evidence ? ` source=${evidence}` : ""}${candidate.raw ? ` evidence=${JSON.stringify(candidate.raw)}` : ""}`);
  }
  return lines;
}

function parseGroupBy(value: string | undefined): SchemaQualityGroupBy | undefined {
  if (value === undefined) return undefined;
  if (value === "language" || value === "framework" || value === "relation-kind" || value === "repo") return value;
  throw new Error(`Invalid schema quality group: ${value}. Expected language, framework, relation-kind, or repo.`);
}

function parseDetails(value: string | undefined): Exclude<SchemaOutcome, "resolved">[] {
  if (!value) return [];
  const requested = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  const allowed = new Set<SchemaOutcome>(SCHEMA_OUTCOMES);
  for (const outcome of requested) {
    if (outcome === "resolved" || !allowed.has(outcome as SchemaOutcome)) {
      throw new Error(`Invalid schema quality detail: ${outcome}. Expected unresolved, external, ambiguous, unsupported, or truncated.`);
    }
  }
  return requested.sort().map((outcome) => outcome as Exclude<SchemaOutcome, "resolved">);
}
