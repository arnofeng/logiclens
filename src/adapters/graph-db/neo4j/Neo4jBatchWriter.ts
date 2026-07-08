import type { GraphDB } from "../../../core/graph-model/db.js";
import type { GraphFactsBatch } from "../../../core/graph-model/facts.js";
import { systemId } from "../../../core/graph-model/schema.js";
import type { ProgressReporter } from "../../../shared/progress.js";
import { chunk } from "../../../shared/chunk.js";

/** Maximum rows per UNWIND batch to avoid excessive memory / transaction size. */
const BATCH_SIZE = 5000;

export type Neo4jBatchWriteOptions = {
  progress?: ProgressReporter;
};

// ── helpers ────────────────────────────────────────────────────────────────


/** Run `fn` for each chunk of `items`, reporting progress after each chunk. */
async function forEachChunk<T>(
  items: T[],
  fn: (chunkItems: T[], chunkIndex: number) => Promise<void>,
): Promise<void> {
  const chunks = chunk(items, BATCH_SIZE);
  for (let i = 0; i < chunks.length; i++) {
    await fn(chunks[i], i);
  }
}

// ── node writers ───────────────────────────────────────────────────────────

interface NodeTableSpec {
  label: string;
  props: string[];
  facts: Record<string, unknown>[];
}

function nodeSpecs(facts: GraphFactsBatch): NodeTableSpec[] {
  return [
    {
      label: "Repo",
      props: ["name", "path", "remoteUrl", "branch", "commitSha", "language", "indexedAt", "summary"],
      facts: facts.repos.map((r) => ({ id: r.id, name: r.name, path: r.path, remoteUrl: r.remoteUrl, branch: r.branch, commitSha: r.commitSha, language: r.language, indexedAt: r.indexedAt, summary: r.summary ?? "" })),
    },
    {
      label: "File",
      props: ["repoId", "path", "language", "hash", "loc", "batchId", "indexedAt", "active"],
      facts: facts.files.map((f) => ({ id: f.id, repoId: f.repoId, path: f.path, language: f.language, hash: f.hash, loc: f.loc, batchId: f.batchId ?? "", indexedAt: f.indexedAt ?? "", active: f.active ?? true })),
    },
    {
      label: "Code",
      props: ["repoId", "fileId", "kind", "name", "qualifiedName", "startLine", "endLine", "signature", "summary", "hash", "batchId", "indexedAt", "active"],
      facts: facts.code.map((c) => ({ id: c.id, repoId: c.repoId, fileId: c.fileId, kind: c.kind, name: c.name, qualifiedName: c.qualifiedName, startLine: c.startLine, endLine: c.endLine, signature: c.signature, summary: c.summary ?? "", hash: c.hash, batchId: c.batchId ?? "", indexedAt: c.indexedAt ?? "", active: c.active ?? true })),
    },
    {
      label: "Section",
      props: ["repoId", "fileId", "heading", "level", "startLine", "endLine", "text", "summary", "hash", "batchId", "indexedAt", "active"],
      facts: facts.sections.map((s) => ({ id: s.id, repoId: s.repoId, fileId: s.fileId, heading: s.heading, level: s.level, startLine: s.startLine, endLine: s.endLine, text: s.text, summary: s.summary ?? "", hash: s.hash, batchId: s.batchId ?? "", indexedAt: s.indexedAt ?? "", active: s.active ?? true })),
    },
    {
      label: "Entity",
      props: ["name", "kind", "description"],
      facts: facts.entities.map((e) => ({ id: e.id, name: e.name, kind: e.kind, description: e.description })),
    },
    {
      label: "Operation",
      props: ["verb", "entityName", "description"],
      facts: facts.operations.map((o) => ({ id: o.id, verb: o.verb, entityName: o.entityName, description: o.description })),
    },
    {
      label: "Workflow",
      props: ["name", "description"],
      facts: facts.workflows.map((w) => ({ id: w.id, name: w.name, description: w.description })),
    },
    {
      label: "Contract",
      props: ["kind", "key", "name", "description"],
      facts: facts.contracts.map((c) => ({ id: c.id, kind: c.kind, key: c.key, name: c.name, description: c.description })),
    },
    {
      label: "Evidence",
      props: ["repoId", "fileId", "filePath", "line", "raw", "rule", "confidence", "batchId", "indexedAt", "active"],
      facts: facts.evidence.map((e) => ({ id: e.id, repoId: e.repoId, fileId: e.fileId, filePath: e.filePath, line: e.line, raw: e.raw, rule: e.rule, confidence: e.confidence, batchId: e.batchId ?? "", indexedAt: e.indexedAt ?? "", active: e.active ?? true })),
    },
    {
      label: "ContractSpec",
      props: ["contractId", "specKind", "repoId", "fileId", "evidenceId", "sourceSymbolId", "canonicalKey", "httpMethod", "pathTemplate", "eventTopic", "framework", "version", "specJson", "confidence", "batchId", "indexedAt", "active"],
      facts: facts.contractSpecs.map((s) => ({ id: s.id, contractId: s.contractId, specKind: s.specKind, repoId: s.repoId, fileId: s.fileId, evidenceId: s.evidenceId, sourceSymbolId: s.sourceSymbolId ?? "", canonicalKey: s.canonicalKey, httpMethod: s.httpMethod ?? "", pathTemplate: s.pathTemplate ?? "", eventTopic: s.eventTopic ?? "", framework: s.framework ?? "", version: s.version ?? "", specJson: s.specJson, confidence: s.confidence, batchId: s.batchId ?? "", indexedAt: s.indexedAt ?? "", active: s.active ?? true })),
    },
  ];
}

async function writeNodeTable(
  db: GraphDB,
  label: string,
  props: string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  const setClause = props.map((p) => `n.${p} = row.${p}`).join(", ");
  await forEachChunk(rows, async (chunkRows) => {
    await db.query(
      `UNWIND $batch AS row MERGE (n:${label} {id: row.id}) ON CREATE SET ${setClause} ON MATCH SET ${setClause};`,
      { batch: chunkRows as unknown as import("../../../core/graph-model/db.js").GraphValue },
    );
  });
}

// ── relation writers ───────────────────────────────────────────────────────

interface RelationSpec {
  label: string;
  fromLabel: string;
  toLabel: string;
  /** Properties used as part of the merge key (to deduplicate edges). */
  mergeProps: string[];
  /** Properties set after merge. */
  setProps: string[];
  rows: Record<string, unknown>[];
}

function relationSpecs(facts: GraphFactsBatch): RelationSpec[] {
  return [
    {
      label: "IMPORTS",
      fromLabel: "File",
      toLabel: "File",
      mergeProps: ["module", "raw"],
      setProps: ["batchId", "active"],
      rows: facts.imports.map((e) => ({ fromId: e.fromFileId, toId: e.toFileId, module: e.module, raw: e.raw, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "CALLS",
      fromLabel: "Code",
      toLabel: "Code",
      mergeProps: ["raw"],
      setProps: ["confidence", "resolution", "batchId", "active"],
      rows: facts.calls.map((e) => ({ fromId: e.fromCodeId, toId: e.toCodeId, confidence: e.confidence, resolution: e.resolution, raw: e.raw, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "DESCRIBES",
      fromLabel: "Section",
      toLabel: "Repo",
      mergeProps: [],
      setProps: [],
      rows: facts.sectionDescribesRepos.map((e) => ({ fromId: e.sectionId, toId: e.repoId })),
    },
    {
      label: "DOCUMENTS",
      fromLabel: "Section",
      toLabel: "Code",
      mergeProps: [],
      setProps: ["confidence"],
      rows: facts.sectionDocumentsCode.map((e) => ({ fromId: e.sectionId, toId: e.codeId, confidence: e.confidence })),
    },
    {
      label: "REFERENCES",
      fromLabel: "Section",
      toLabel: "File",
      mergeProps: ["raw"],
      setProps: [],
      rows: facts.sectionReferencesFile.map((e) => ({ fromId: e.sectionId, toId: e.fileId, raw: e.raw })),
    },
    {
      label: "OWNS_PACKAGE",
      fromLabel: "Repo",
      toLabel: "Contract",
      mergeProps: ["evidenceId"],
      setProps: ["confidence", "batchId", "active"],
      rows: facts.repoContracts.filter((e) => e.role === "owner").map((e) => ({ fromId: e.repoId, toId: e.contractId, evidenceId: e.evidenceId, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "PRODUCES",
      fromLabel: "Repo",
      toLabel: "Contract",
      mergeProps: ["evidenceId"],
      setProps: ["confidence", "batchId", "active"],
      rows: facts.repoContracts.filter((e) => e.role === "producer").map((e) => ({ fromId: e.repoId, toId: e.contractId, evidenceId: e.evidenceId, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "CONSUMES",
      fromLabel: "Repo",
      toLabel: "Contract",
      mergeProps: ["evidenceId"],
      setProps: ["confidence", "batchId", "active"],
      rows: facts.repoContracts.filter((e) => e.role === "consumer").map((e) => ({ fromId: e.repoId, toId: e.contractId, evidenceId: e.evidenceId, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "SHARES_CONTRACT",
      fromLabel: "Repo",
      toLabel: "Contract",
      mergeProps: ["evidenceId"],
      setProps: ["confidence", "batchId", "active"],
      rows: facts.repoContracts.filter((e) => e.role === "shared").map((e) => ({ fromId: e.repoId, toId: e.contractId, evidenceId: e.evidenceId, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "CONTRACT_MENTIONS",
      fromLabel: "Contract",
      toLabel: "Entity",
      mergeProps: ["evidenceId"],
      setProps: ["confidence", "batchId", "active"],
      rows: facts.contractEntities.map((e) => ({ fromId: e.contractId, toId: e.entityId, evidenceId: e.evidenceId, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "PARTICIPATES_IN",
      fromLabel: "Repo",
      toLabel: "Operation",
      mergeProps: ["role", "evidenceId"],
      setProps: ["confidence", "batchId", "active"],
      rows: facts.operationRepos.map((e) => ({ fromId: e.repoId, toId: e.operationId, role: e.role, evidenceId: e.evidenceId, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "WORKFLOW_STEP",
      fromLabel: "Workflow",
      toLabel: "Operation",
      mergeProps: ["step", "evidenceId"],
      setProps: ["confidence", "batchId", "active"],
      rows: facts.workflowOperations.map((e) => ({ fromId: e.workflowId, toId: e.operationId, step: e.step, evidenceId: e.evidenceId, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "USES_PACKAGE",
      fromLabel: "Repo",
      toLabel: "Contract",
      mergeProps: ["packageName", "evidenceId", "raw"],
      setProps: ["confidence", "batchId", "active"],
      rows: facts.packageUsages.map((e) => ({ fromId: e.repoId, toId: e.packageContractId, packageName: e.packageName, evidenceId: e.evidenceId, raw: e.raw, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "DEPENDS_ON",
      fromLabel: "Repo",
      toLabel: "Repo",
      mergeProps: ["dependencyType", "sourceContractId", "targetContractId", "evidenceId", "raw"],
      setProps: ["confidence", "batchId", "active"],
      rows: facts.repoDependencies.map((e) => ({ fromId: e.fromRepoId, toId: e.toRepoId, dependencyType: e.dependencyType, sourceContractId: e.sourceContractId, targetContractId: e.targetContractId, evidenceId: e.evidenceId, raw: e.raw, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "HAS_SPEC",
      fromLabel: "Contract",
      toLabel: "ContractSpec",
      mergeProps: ["evidenceId"],
      setProps: ["confidence", "batchId", "active"],
      rows: facts.contractSpecEdges.map((e) => ({ fromId: e.contractId, toId: e.specId, evidenceId: e.evidenceId, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
    {
      label: "SEMANTIC_REL",
      fromLabel: "ContractSpec",
      toLabel: "ContractSpec",
      mergeProps: ["kind", "evidenceId"],
      setProps: ["reason", "confidence", "batchId", "active"],
      rows: facts.semanticRelations.map((e) => ({ fromId: e.fromSpecId, toId: e.toSpecId, kind: e.kind, evidenceId: e.evidenceId, reason: e.reason, confidence: e.confidence, batchId: e.batchId ?? "", active: e.active ?? true })),
    },
  ];
}

async function writeRelationTable(
  db: GraphDB,
  spec: RelationSpec,
): Promise<void> {
  if (spec.rows.length === 0) return;
  const mergeClause = spec.mergeProps.length > 0
    ? `{${spec.mergeProps.map((p) => `${p}: row.${p}`).join(", ")}}`
    : "";
  const setClause = spec.setProps.length > 0
    ? ` SET ${spec.setProps.map((p) => `r.${p} = row.${p}`).join(", ")}`
    : "";
  await forEachChunk(spec.rows, async (chunkRows) => {
    await db.query(
      `UNWIND $batch AS row ` +
      `MATCH (a:${spec.fromLabel} {id: row.fromId}), (b:${spec.toLabel} {id: row.toId}) ` +
      `MERGE (a)-[r:${spec.label}${mergeClause}]->(b)${setClause};`,
      { batch: chunkRows as unknown as import("../../../core/graph-model/db.js").GraphValue },
    );
  });
}

// ── pair-table writers (simple FROM → TO edges without merge-key) ──────────

interface PairSpec {
  label: string;
  fromLabel: string;
  toLabel: string;
  setProps?: string[];
  rows: Record<string, unknown>[];
}

function pairSpecs(facts: GraphFactsBatch): PairSpec[] {
  return [
    {
      label: "CONTAINS",
      fromLabel: "System",
      toLabel: "Repo",
      rows: facts.repos.map((repo) => ({ fromId: systemId, toId: repo.id })),
    },
    {
      label: "CONTAINS",
      fromLabel: "Repo",
      toLabel: "File",
      rows: facts.contains.filter((e) => e.fromId.startsWith("repo:") && e.toId.startsWith("file:")).map((e) => ({ fromId: e.fromId, toId: e.toId })),
    },
    {
      label: "CONTAINS",
      fromLabel: "File",
      toLabel: "Code",
      rows: facts.contains.filter((e) => e.fromId.startsWith("file:") && e.toId.startsWith("code:")).map((e) => ({ fromId: e.fromId, toId: e.toId })),
    },
    {
      label: "CONTAINS",
      fromLabel: "File",
      toLabel: "Section",
      rows: facts.contains.filter((e) => e.fromId.startsWith("file:") && e.toId.startsWith("section:")).map((e) => ({ fromId: e.fromId, toId: e.toId })),
    },
    {
      label: "MENTIONS",
      fromLabel: "Code",
      toLabel: "Entity",
      setProps: ["confidence"],
      rows: facts.mentions.filter((e) => e.sourceKind === "code").map((e) => ({ fromId: e.fromId, toId: e.entityId, confidence: e.confidence })),
    },
    {
      label: "MENTIONS",
      fromLabel: "Section",
      toLabel: "Entity",
      setProps: ["confidence"],
      rows: facts.mentions.filter((e) => e.sourceKind === "section").map((e) => ({ fromId: e.fromId, toId: e.entityId, confidence: e.confidence })),
    },
    {
      label: "HAS_EVIDENCE",
      fromLabel: "Contract",
      toLabel: "Evidence",
      rows: facts.repoContracts.map((e) => ({ fromId: e.contractId, toId: e.evidenceId })),
    },
    {
      label: "HAS_EVIDENCE",
      fromLabel: "Repo",
      toLabel: "Evidence",
      rows: facts.evidence.map((e) => ({ fromId: e.repoId, toId: e.id })),
    },
  ];
}

async function writePairTable(
  db: GraphDB,
  spec: PairSpec,
): Promise<void> {
  if (spec.rows.length === 0) return;
  const setClause = spec.setProps && spec.setProps.length > 0
    ? ` SET ${spec.setProps.map((p) => `r.${p} = row.${p}`).join(", ")}`
    : "";
  await forEachChunk(spec.rows, async (chunkRows) => {
    await db.query(
      `UNWIND $batch AS row ` +
      `MATCH (a:${spec.fromLabel} {id: row.fromId}), (b:${spec.toLabel} {id: row.toId}) ` +
      `MERGE (a)-[r:${spec.label}]->(b)${setClause};`,
      { batch: chunkRows as unknown as import("../../../core/graph-model/db.js").GraphValue },
    );
  });
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Write a {@link GraphFactsBatch} to Neo4j using UNWIND-based batch Cypher
 * queries.  This is 50-100× faster than the one-by-one merge writer because it
 * reduces ~40 000 individual transactions to about 30.
 */
export async function writeGraphFactsWithNeo4jBatch(
  db: GraphDB,
  facts: GraphFactsBatch,
  options: Neo4jBatchWriteOptions = {},
): Promise<void> {
  const progress = options.progress;

  const nodeTables = nodeSpecs(facts).filter((s) => s.facts.length > 0);
  const pairTables = pairSpecs(facts).filter((s) => s.rows.length > 0);
  const relTables = relationSpecs(facts).filter((s) => s.rows.length > 0);
  const totalSteps = nodeTables.length + pairTables.length + relTables.length;
  let completed = 0;

  function report(label: string): void {
    completed += 1;
    progress?.({ current: completed, total: totalSteps, label });
  }

  // Phase 1: nodes (with label suffix for clarity)
  for (const spec of nodeTables) {
    await writeNodeTable(db, spec.label, spec.props, spec.facts);
    report(`upsert ${spec.label}`);
  }

  // Phase 2: pair edges (CONTAINS, MENTIONS, HAS_EVIDENCE)
  for (const spec of pairTables) {
    await writePairTable(db, spec);
    report(`merge ${spec.label} ${spec.fromLabel}→${spec.toLabel}`);
  }

  // Phase 3: relation edges with merge keys
  for (const spec of relTables) {
    await writeRelationTable(db, spec);
    report(`merge ${spec.label}`);
  }
}
