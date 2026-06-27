import path from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import { createGraphDB } from "../core/graph-model/factory.js";
import { auditRelationQuality, rejectEvidence, upsertAliasOverride } from "../features/quality/quality.js";
import { repoId } from "../shared/path.js";
import { auditContractQuality } from "../features/quality/qualityRules.js";

export type QualityOptions = {
  minConfidence?: number;
  limit?: number;
  rejectEvidence?: string;
  reason?: string;
  alias?: string;
  targetRepo?: string;
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
  const db = await createGraphDB(config.graph.provider, { path: path.resolve(cwd, config.graph.path), url: config.graph.url, username: config.graph.username, password: config.graph.password });
  try {
    await db.initSchema(config.systemName);
    
    if (action === "contracts") {
      const violations = await auditContractQuality(db);
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
      await rejectEvidence(db, { evidenceId: options.rejectEvidence, reason: options.reason ?? "Marked as false positive" });
      console.log(`Rejected evidence: ${options.rejectEvidence}`);
      return;
    }
    if (options.alias && options.targetRepo) {
      await upsertAliasOverride(db, { alias: options.alias, targetRepoId: repoId(options.targetRepo), reason: options.reason ?? "Manual alias override" });
      console.log(`Alias override: ${options.alias} -> ${options.targetRepo}`);
      return;
    }
    const audit = await auditRelationQuality(db, { minConfidence: options.minConfidence, limit: options.limit });
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
