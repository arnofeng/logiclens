import { createClient } from "../sdk/client.js";
import type { ImpactReport } from "../../core/contracts/impact/types.js";
import type { ImpactResult } from "../sdk/client.js";
import type {
  SemanticImpactEdge,
  SemanticImpactNode,
  SemanticImpactReport
} from "../../core/contracts/impact/semanticImpact.js";
import { BRAND } from "../../shared/branding.js";

export type ImpactCommandOptions = {
  /** Optional change description, e.g. "field-removed:couponCode" */
  change?: string;
  maxHops?: number;
  legacy?: boolean;
  verbose?: boolean;
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
        maxHops: options.maxHops,
      });

      printImpactReport(report);
      return;
    }

    const semanticImpact = await client.semanticImpact(symbolOrEntity, { maxHops: options.maxHops });
    if (semanticImpact) {
      const hasSymbolMatch = isBareTarget(symbolOrEntity)
        ? await client.hasCodeSymbolMatch(symbolOrEntity)
        : false;
      printSemanticImpactReport(semanticImpact, { showSymbolHint: hasSymbolMatch, rawTarget: symbolOrEntity });

      if (options.legacy || options.verbose) {
        console.log("");
        console.log("Legacy symbol/call graph context:");
        printLegacyImpactResult(await client.impact(symbolOrEntity), false);
      }
      return;
    }

    if (isExplicitContractTarget(symbolOrEntity)) {
      console.log(`No contract spec found for "${symbolOrEntity}".`);
      return;
    }

    // -- Legacy: Symbol/entity search-based impact ----------------------------
    printLegacyImpactResult(await client.impact(symbolOrEntity), true);
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

function printLegacyImpactResult(result: ImpactResult, includeHeader: boolean): void {
  if (includeHeader) console.log(`Potential impact for ${result.symbolOrEntity}:`);
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
}

function printSemanticImpactReport(
  report: SemanticImpactReport,
  options: { showSymbolHint: boolean; rawTarget: string }
): void {
  if (options.showSymbolHint) {
    console.log(`Note: Also matched code symbols for "${options.rawTarget}". If you wanted the code symbol call graph, run:`);
    console.log(`  ${BRAND.cliName} impact ${quoteIfNeeded(options.rawTarget)} --legacy`);
    console.log("");
  }

  const title = `Semantic Contract Impact: ${report.target}`;
  console.log(title);
  console.log("=".repeat(title.length));
  console.log(`Impact Radius: ${report.affectedRepos.length} repos affected, ${Math.max(0, report.nodes.length - report.targets.length)} specs impacted (max-hops: ${report.maxHops})`);
  console.log("");

  if (report.affectedRepos.length > 0) {
    console.log("Affected Repositories & Services:");
    for (const repo of report.affectedRepos) console.log(`  - ${repo}`);
    console.log("");
  }

  console.log("Transitive Impact Chain:");
  const children = buildChildren(report);
  for (const target of report.targets) {
    printImpactNode(target, children, report, 0);
  }

  if (report.nodes.length === report.targets.length) {
    console.log("  No downstream impacted specs found.");
  }

  if (report.truncated) {
    console.log("");
    console.log(`Traversal stopped at max hops. Raise --max-hops to expand.`);
  }

  if (report.recommendedFiles.length > 0) {
    console.log("");
    console.log("Recommended files to inspect:");
    for (const file of report.recommendedFiles) console.log(`  - ${file}`);
  }
}

function buildChildren(report: SemanticImpactReport): Map<string, SemanticImpactNode[]> {
  const nodesById = new Map(report.nodes.map((n) => [n.specId, n]));
  const children = new Map<string, SemanticImpactNode[]>();
  for (const node of report.nodes) {
    if (!node.viaSpecId) continue;
    const parent = nodesById.get(node.viaSpecId);
    if (!parent || parent.hop !== node.hop - 1) continue;
    const list = children.get(parent.specId);
    if (list) list.push(node); else children.set(parent.specId, [node]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.hop - b.hop || repoOf(a.repoId).localeCompare(repoOf(b.repoId)) || a.summary.localeCompare(b.summary));
  }
  return children;
}

function printImpactNode(
  node: SemanticImpactNode,
  children: Map<string, SemanticImpactNode[]>,
  report: SemanticImpactReport,
  depth: number
): void {
  const indent = "  ".repeat(depth + 1);
  console.log(`${indent}[Hop ${node.hop}] ${node.summary} (${repoOf(node.repoId)})`);
  if (node.filePath) console.log(`${indent}  file: ${node.filePath}`);

  for (const child of children.get(node.specId) ?? []) {
    const edge = edgeToChild(report, child);
    console.log("");
    if (edge) {
      console.log(`${indent}  -> [${edge.kind}] confidence=${formatConfidence(edge.confidence)}`);
    } else if (child.relationKind) {
      console.log(`${indent}  -> [${child.relationKind}] confidence=${formatConfidence(child.confidence)}`);
    }
    printImpactNode(child, children, report, depth + 1);
    if (child.reason) console.log(`${"  ".repeat(depth + 2)}  reason: ${child.reason}`);
  }
}

function edgeToChild(report: SemanticImpactReport, child: SemanticImpactNode): SemanticImpactEdge | undefined {
  return report.edges.find((e) =>
    e.hop === child.hop &&
    e.kind === child.relationKind &&
    (e.fromSpecId === child.specId || e.toSpecId === child.specId)
  );
}

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

function isBareTarget(target: string): boolean {
  return !isExplicitContractTarget(target);
}

function isExplicitContractTarget(target: string): boolean {
  const trimmed = target.trim();
  const first = trimmed.split(/[\s:]/)[0]?.toLowerCase();
  return !!first && (
    ["http", "api", "event", "schema", "dto", "grpc", "dubbo", "graphql", "package", "config"].includes(first) ||
    ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(first.toUpperCase())
  );
}

function repoOf(repoId: string): string {
  return repoId.replace(/^repo:/, "");
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
