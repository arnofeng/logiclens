import path from "node:path";
import fs from "node:fs/promises";
import type { AppConfig } from "../../config/schema.js";
import { writeGraphFactsWithKuzuAppendCopy, writeGraphFactsWithKuzuBulk, writeGraphFactsWithKuzuBulkUpsert } from "../graph-model/bulkWriter.js";
import { ALL_EVIDENCE_REL_TYPES, withTransaction, type GraphDB, type GraphWriteAtomicityMode, type GraphWriteBatchStatus } from "../graph-model/db.js";
import { buildGraphFactsBatch, type GraphFactsBatch } from "../graph-model/facts.js";
import { writeGraphFactsWithMerge } from "../graph-model/upsert.js";
import { writeGraphFactsWithNeo4jBatch } from "../../adapters/graph-db/neo4j/Neo4jBatchWriter.js";
import { resolveCalls, resolveImports } from "../extraction/resolveReferences.js";
import type { CodeSymbol, FileNode, ParsedFile, ParsedGraphFile, RepoNode } from "../parsing/types.js";
import type { IndexWriteMode } from "./context.js";
import { runIndexPhase } from "./phases.js";
import { shouldSummarizeGraphWithLlm, summarizeGraphWithProgress } from "./summaries.js";
import type { ProgressReporter } from "../../shared/progress.js";
import { BRAND_PATHS } from "../../shared/branding.js";
import { fileId as createFileId } from "../../shared/path.js";

export type GraphWriterMode = "bulk-copy" | "append-copy" | "bulk-upsert" | "merge";

export type GraphWriterSelection = {
  mode: GraphWriterMode;
  fast: boolean;
  fallbackToMerge: boolean;
};

export type FactBuildResult = {
  facts: GraphFactsBatch;
  counts: {
    files: number;
    code: number;
    sections: number;
    imports: number;
    calls: number;
    entities: number;
  };
};

export type GraphWriteResult = {
  writerMode: GraphWriterMode;
  batchId: string;
  repoNames: string[];
  repoIds: string[];
  atomicityMode: GraphWriteAtomicityMode;
  journalStatus: GraphWriteBatchStatus;
  recoveredBatchIds: string[];
  fallback: boolean;
  fallbackError?: string;
};

export type GraphWriteFailureDetails = {
  graphWriteAtomicity: GraphWriteAtomicityMode;
  graphWriteStatus: GraphWriteBatchStatus;
};

type ProgressBarLike = {
  update(current: number, label?: string, total?: number, stepMs?: number): void;
  reporter(): ProgressReporter;
  complete(label?: string): void;
};

export type PreparedGraphSummaries = {
  repoSummaries: ReadonlyArray<{
    repoId: string;
    summary: string;
  }>;
  systemSummary: string;
};

export type IncrementalPublicGraphReplacementPlan = {
  sourceFileIds: string[];
  deletedFileIds: string[];
  existingEvidenceIds: string[];
  staleCodeIds: string[];
  staleSectionIds: string[];
  staleEvidenceIds: string[];
  staleSpecIds: string[];
  orphanEntityIds: string[];
  orphanOperationIds: string[];
  orphanWorkflowIds: string[];
  orphanContractIds: string[];
};

type ActiveFileRow = Pick<FileNode, "id" | "repoId" | "path" | "directory" | "language" | "hash" | "loc">;

type ActiveCodeRow = Pick<
  CodeSymbol,
  "id" | "repoId" | "fileId" | "kind" | "name" | "qualifiedName" | "startLine" | "endLine" | "signature" | "hash"
> & { summary?: string | null };

const RELATIVE_IMPORT_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".vue",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.vue"
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function graphWriteAtomicityMode(_mode: GraphWriterMode): GraphWriteAtomicityMode {
  return "journaled-recoverable";
}

function markGraphWriteFailure(error: unknown, details: GraphWriteFailureDetails): unknown {
  if (error && (typeof error === "object" || typeof error === "function")) {
    Object.assign(error, details);
    return error;
  }
  const wrapped = new Error(errorMessage(error));
  Object.assign(wrapped, details);
  return wrapped;
}

function isParsedSourceFile(file: ParsedGraphFile): file is ParsedFile {
  return file.language !== "markdown";
}

function relativeImportCandidatePaths(file: ParsedFile): string[] {
  const candidates: string[] = [];
  for (const importRef of file.imports) {
    if (!importRef.module.startsWith(".")) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), importRef.module));
    for (const extension of RELATIVE_IMPORT_EXTENSIONS) candidates.push(`${base}${extension}`);
  }
  return [...new Set(candidates)];
}

function goPackageName(file: ParsedFile): string | undefined {
  return file.language === "go" ? file.source?.match(/^\s*package\s+(\w+)/m)?.[1] : undefined;
}

export async function prepareIncrementalReferenceFacts(
  db: GraphDB,
  facts: GraphFactsBatch,
  parsedFiles: readonly ParsedGraphFile[],
  deletedFileIds: readonly string[] = []
): Promise<void> {
  const changedSourceFiles = parsedFiles.filter(isParsedSourceFile);
  if (changedSourceFiles.length === 0) return;

  const touchedFileIds = new Set([
    ...changedSourceFiles.map((file) => file.fileId),
    ...deletedFileIds
  ]);
  const candidateFileIds = new Set<string>();
  for (const file of changedSourceFiles) {
    for (const candidatePath of relativeImportCandidatePaths(file)) {
      candidateFileIds.add(createFileId(file.repoId, candidatePath));
    }
  }

  const activeFileRows = candidateFileIds.size === 0
    ? []
    : await db.query<ActiveFileRow>(
      `MATCH (f:File)
       WHERE f.workspaceId = $workspaceId AND f.generation = $generation
         AND f.id IN $candidateFileIds AND (f.active IS NULL OR f.active = true)
       RETURN f.id AS id, f.repoId AS repoId, f.path AS path, f.language AS language,
              f.directory AS directory, f.hash AS hash, f.loc AS loc;`,
      {
        workspaceId: facts.workspaceId,
        generation: facts.generation,
        candidateFileIds: [...candidateFileIds]
      }
    );

  const goDirectories = new Map<string, { repoId: string; directory: string; packageName: string }>();
  for (const file of changedSourceFiles) {
    const packageName = goPackageName(file);
    if (!packageName) continue;
    const directory = path.posix.dirname(file.path);
    goDirectories.set(`${file.repoId}:${directory}:${packageName}`, { repoId: file.repoId, directory, packageName });
  }
  for (const { repoId, directory } of goDirectories.values()) {
    const rows = await db.query<ActiveFileRow>(
      `MATCH (f:File)
       WHERE f.workspaceId = $workspaceId AND f.generation = $generation
         AND f.repoId = $repoId AND f.language = 'go' AND f.directory = $directory
         AND (f.active IS NULL OR f.active = true)
       RETURN f.id AS id, f.repoId AS repoId, f.path AS path, f.language AS language,
              f.directory AS directory, f.hash AS hash, f.loc AS loc;`,
      { workspaceId: facts.workspaceId, generation: facts.generation, repoId, directory }
    );
    activeFileRows.push(...rows);
  }

  const currentFiles = new Map(facts.files.map((file) => [file.id, file]));
  const catalogFiles = new Map<string, ActiveFileRow>();
  for (const row of activeFileRows) {
    if (!touchedFileIds.has(row.id)) catalogFiles.set(row.id, row);
  }
  for (const file of facts.files) catalogFiles.set(file.id, file);

  const targetFileIds = [...catalogFiles.keys()];
  const activeCodeRows = targetFileIds.length === 0
    ? []
    : await db.query<ActiveCodeRow>(
      `MATCH (c:Code)
       WHERE c.workspaceId = $workspaceId AND c.generation = $generation
         AND c.fileId IN $targetFileIds AND (c.active IS NULL OR c.active = true)
       RETURN c.id AS id, c.repoId AS repoId, c.fileId AS fileId, c.kind AS kind,
              c.name AS name, c.qualifiedName AS qualifiedName, c.startLine AS startLine,
              c.endLine AS endLine, c.signature AS signature, c.summary AS summary, c.hash AS hash;`,
      { workspaceId: facts.workspaceId, generation: facts.generation, targetFileIds }
    );
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const row of activeCodeRows) {
    if (touchedFileIds.has(row.fileId)) continue;
    const symbols = symbolsByFile.get(row.fileId) ?? [];
    symbols.push({
      ...row,
      startLine: Number(row.startLine),
      endLine: Number(row.endLine),
      summary: row.summary ?? undefined,
      source: ""
    });
    symbolsByFile.set(row.fileId, symbols);
  }
  for (const symbol of facts.code) {
    const symbols = symbolsByFile.get(symbol.fileId) ?? [];
    symbols.push(symbol);
    symbolsByFile.set(symbol.fileId, symbols);
  }

  const packageByDirectory = new Map(
    [...goDirectories.values()].map((entry) => [`${entry.repoId}:${entry.directory}`, entry.packageName])
  );
  const repoPaths = new Map(facts.repos.map((repo) => [repo.id, repo.path]));
  const catalogStubs: ParsedFile[] = [];
  for (const file of catalogFiles.values()) {
    if (currentFiles.has(file.id)) continue;
    const directory = path.posix.dirname(file.path);
    const packageName = packageByDirectory.get(`${file.repoId}:${directory}`);
    const repoPath = repoPaths.get(file.repoId);
    const absolutePath = repoPath ? path.resolve(repoPath, file.path) : undefined;
    let source = packageName ? `package ${packageName}` : "";
    if (absolutePath) {
      try {
        source = await fs.readFile(absolutePath, "utf8");
      } catch {
        // A concurrent filesystem removal is represented by the mutation's
        // explicit source tombstone; never invent source text for resolution.
      }
    }
    catalogStubs.push({
      repoId: file.repoId,
      fileId: file.id,
      path: file.path,
      absolutePath,
      language: file.language,
      hash: file.hash,
      loc: Number(file.loc),
      source,
      imports: [],
      symbols: symbolsByFile.get(file.id) ?? [],
      calls: []
    });
  }

  const resolutionCatalog = [...changedSourceFiles, ...catalogStubs];
  facts.imports = resolveImports(resolutionCatalog).map((edge) => ({
    ...edge,
    batchId: facts.batchId,
    active: true
  }));
  facts.calls = resolveCalls(resolutionCatalog).map((edge) => ({
    ...edge,
    batchId: facts.batchId,
    active: true
  }));
}

function sortedIds(rows: readonly { id: string }[]): string[] {
  return [...new Set(rows.map((row) => row.id))].sort();
}

export async function prepareIncrementalPublicGraphReplacement(
  db: GraphDB,
  facts: GraphFactsBatch,
  parsedFiles: readonly ParsedGraphFile[],
  deletedFileIds: readonly string[]
): Promise<IncrementalPublicGraphReplacementPlan> {
  await prepareIncrementalReferenceFacts(db, facts, parsedFiles, deletedFileIds);
  const touchedFileIds = [...new Set([
    ...parsedFiles.map((file) => file.fileId),
    ...deletedFileIds
  ])].sort();
  if (touchedFileIds.length === 0) {
    return {
      sourceFileIds: [],
      deletedFileIds: [],
      existingEvidenceIds: [],
      staleCodeIds: [],
      staleSectionIds: [],
      staleEvidenceIds: [],
      staleSpecIds: [],
      orphanEntityIds: [],
      orphanOperationIds: [],
      orphanWorkflowIds: [],
      orphanContractIds: []
    };
  }

  const activeSpecIds = [...new Set(facts.contractSpecs.map((spec) => spec.id))].sort();
  const activeEvidenceIds = [...new Set(facts.evidence.map((item) => item.id))].sort();
  const activeCodeIds = [...new Set(facts.code.map((item) => item.id))].sort();
  const activeSectionIds = [...new Set(facts.sections.map((item) => item.id))].sort();
  const scopeParams = {
    workspaceId: facts.workspaceId,
    generation: facts.generation,
    touchedFileIds
  };

  // Mutation preparation may run against embedded Kuzu. Keep bounded reads
  // sequential so prepared statements never share one native query window.
  const existingCode = await db.query<{ id: string }>(
    "MATCH (n:Code) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.fileId IN $touchedFileIds AND (n.active IS NULL OR n.active = true) RETURN n.id AS id;",
    scopeParams
  );
  const existingSections = await db.query<{ id: string }>(
    "MATCH (n:Section) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.fileId IN $touchedFileIds AND (n.active IS NULL OR n.active = true) RETURN n.id AS id;",
    scopeParams
  );
  const existingEvidence = await db.query<{ id: string }>(
    "MATCH (n:Evidence) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.fileId IN $touchedFileIds AND (n.active IS NULL OR n.active = true) RETURN n.id AS id;",
    scopeParams
  );
  const existingSpecs = await db.query<{ id: string; contractId: string }>(
    "MATCH (n:ContractSpec) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.fileId IN $touchedFileIds AND (n.active IS NULL OR n.active = true) RETURN n.id AS id, n.contractId AS contractId;",
    scopeParams
  );
  const existingCodeIds = sortedIds(existingCode);
  const existingSectionIds = sortedIds(existingSections);
  const existingEvidenceIds = sortedIds(existingEvidence);
  const existingSpecIds = sortedIds(existingSpecs);
  const activeCodeIdSet = new Set(activeCodeIds);
  const activeSectionIdSet = new Set(activeSectionIds);
  const activeEvidenceIdSet = new Set(activeEvidenceIds);
  const activeSpecIdSet = new Set(activeSpecIds);
  const staleCodeIds = existingCodeIds.filter((id) => !activeCodeIdSet.has(id));
  const staleSectionIds = existingSectionIds.filter((id) => !activeSectionIdSet.has(id));
  const staleEvidenceIds = existingEvidenceIds.filter((id) => !activeEvidenceIdSet.has(id));
  const staleSpecIds = existingSpecIds.filter((id) => !activeSpecIdSet.has(id));

  const entityCandidates = new Set<string>();
  for (const query of [
    "MATCH (source:Code)-[r:MENTIONS]->(n:Entity) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation AND n.workspaceId = $workspaceId AND n.generation = $generation RETURN n.id AS id;",
    "MATCH (source:Section)-[r:MENTIONS]->(n:Entity) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation AND n.workspaceId = $workspaceId AND n.generation = $generation RETURN n.id AS id;",
    "MATCH (source:Code)-[r:OPERATES_ON]->(n:Entity) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation AND n.workspaceId = $workspaceId AND n.generation = $generation RETURN n.id AS id;"
  ]) {
    for (const row of await db.query<{ id: string }>(query, scopeParams)) entityCandidates.add(row.id);
  }

  const operationCandidates = new Set<string>();
  const workflowCandidates = new Set<string>();
  const contractCandidates = new Set(existingSpecs.map((spec) => spec.contractId));
  if (existingEvidenceIds.length > 0) {
    for (const row of await db.query<{ id: string }>(
      "MATCH (:Contract)-[r:CONTRACT_MENTIONS]->(n:Entity) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.evidenceId IN $evidenceIds AND n.workspaceId = $workspaceId AND n.generation = $generation RETURN n.id AS id;",
      { workspaceId: facts.workspaceId, generation: facts.generation, evidenceIds: existingEvidenceIds }
    )) entityCandidates.add(row.id);
    for (const row of await db.query<{ id: string }>(
      "MATCH (:Repo)-[r:PARTICIPATES_IN]->(n:Operation) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.evidenceId IN $evidenceIds AND n.workspaceId = $workspaceId AND n.generation = $generation RETURN n.id AS id;",
      { workspaceId: facts.workspaceId, generation: facts.generation, evidenceIds: existingEvidenceIds }
    )) operationCandidates.add(row.id);
    for (const row of await db.query<{ workflowId: string; operationId: string }>(
      "MATCH (w:Workflow)-[r:WORKFLOW_STEP]->(o:Operation) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.evidenceId IN $evidenceIds AND w.workspaceId = $workspaceId AND w.generation = $generation AND o.workspaceId = $workspaceId AND o.generation = $generation RETURN w.id AS workflowId, o.id AS operationId;",
      { workspaceId: facts.workspaceId, generation: facts.generation, evidenceIds: existingEvidenceIds }
    )) {
      workflowCandidates.add(row.workflowId);
      operationCandidates.add(row.operationId);
    }
    for (const relation of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "USES_PACKAGE"] as const) {
      for (const row of await db.query<{ id: string }>(
        `MATCH ()-[r:${relation}]->(n:Contract) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.evidenceId IN $evidenceIds AND n.workspaceId = $workspaceId AND n.generation = $generation RETURN n.id AS id;`,
        { workspaceId: facts.workspaceId, generation: facts.generation, evidenceIds: existingEvidenceIds }
      )) contractCandidates.add(row.id);
    }
  }

  const retainedEntities = new Set(facts.entities.map((entity) => entity.id));
  const entityCandidateIds = [...entityCandidates].sort();
  if (entityCandidateIds.length > 0) {
    for (const query of [
      "MATCH (source:Code)-[r:MENTIONS]->(n:Entity) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND NOT (source.fileId IN $sourceFileIds) AND r.workspaceId = $workspaceId AND r.generation = $generation AND n.workspaceId = $workspaceId AND n.generation = $generation AND n.id IN $candidateIds RETURN n.id AS id;",
      "MATCH (source:Section)-[r:MENTIONS]->(n:Entity) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND NOT (source.fileId IN $sourceFileIds) AND r.workspaceId = $workspaceId AND r.generation = $generation AND n.workspaceId = $workspaceId AND n.generation = $generation AND n.id IN $candidateIds RETURN n.id AS id;",
      "MATCH (source:Code)-[r:OPERATES_ON]->(n:Entity) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND NOT (source.fileId IN $sourceFileIds) AND r.workspaceId = $workspaceId AND r.generation = $generation AND n.workspaceId = $workspaceId AND n.generation = $generation AND n.id IN $candidateIds RETURN n.id AS id;"
    ]) {
      for (const row of await db.query<{ id: string }>(query, {
        workspaceId: facts.workspaceId,
        generation: facts.generation,
        sourceFileIds: touchedFileIds,
        candidateIds: entityCandidateIds
      })) retainedEntities.add(row.id);
    }
    if (existingEvidenceIds.length > 0) {
      for (const row of await db.query<{ id: string }>(
        "MATCH ()-[r:CONTRACT_MENTIONS]->(n:Entity) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND NOT (r.evidenceId IN $evidenceIds) AND (r.active IS NULL OR r.active = true) AND n.workspaceId = $workspaceId AND n.generation = $generation AND n.id IN $candidateIds RETURN n.id AS id;",
        { workspaceId: facts.workspaceId, generation: facts.generation, evidenceIds: existingEvidenceIds, candidateIds: entityCandidateIds }
      )) retainedEntities.add(row.id);
    }
  }

  const retainedOperations = new Set(facts.operations.map((operation) => operation.id));
  const operationCandidateIds = [...operationCandidates].sort();
  if (operationCandidateIds.length > 0 && existingEvidenceIds.length > 0) {
    for (const relation of ["PARTICIPATES_IN", "WORKFLOW_STEP"] as const) {
      for (const row of await db.query<{ id: string }>(
        `MATCH ()-[r:${relation}]->(n:Operation) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND NOT (r.evidenceId IN $evidenceIds) AND (r.active IS NULL OR r.active = true) AND n.workspaceId = $workspaceId AND n.generation = $generation AND n.id IN $candidateIds RETURN n.id AS id;`,
        { workspaceId: facts.workspaceId, generation: facts.generation, evidenceIds: existingEvidenceIds, candidateIds: operationCandidateIds }
      )) retainedOperations.add(row.id);
    }
  }

  const retainedWorkflows = new Set(facts.workflows.map((workflow) => workflow.id));
  const workflowCandidateIds = [...workflowCandidates].sort();
  if (workflowCandidateIds.length > 0 && existingEvidenceIds.length > 0) {
    for (const row of await db.query<{ id: string }>(
      "MATCH (n:Workflow)-[r:WORKFLOW_STEP]->(:Operation) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND NOT (r.evidenceId IN $evidenceIds) AND (r.active IS NULL OR r.active = true) AND n.workspaceId = $workspaceId AND n.generation = $generation AND n.id IN $candidateIds RETURN n.id AS id;",
      { workspaceId: facts.workspaceId, generation: facts.generation, evidenceIds: existingEvidenceIds, candidateIds: workflowCandidateIds }
    )) retainedWorkflows.add(row.id);
  }

  const retainedContracts = new Set(facts.contracts.map((contract) => contract.id));
  const contractCandidateIds = [...contractCandidates].sort();
  if (contractCandidateIds.length > 0) {
    if (existingEvidenceIds.length > 0) {
      for (const relation of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "USES_PACKAGE"] as const) {
        for (const row of await db.query<{ id: string }>(
          `MATCH ()-[r:${relation}]->(n:Contract) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND NOT (r.evidenceId IN $evidenceIds) AND (r.active IS NULL OR r.active = true) AND n.workspaceId = $workspaceId AND n.generation = $generation AND n.id IN $candidateIds RETURN n.id AS id;`,
          { workspaceId: facts.workspaceId, generation: facts.generation, evidenceIds: existingEvidenceIds, candidateIds: contractCandidateIds }
        )) retainedContracts.add(row.id);
      }
    }
    for (const row of await db.query<{ id: string }>(
      "MATCH (n:Contract)-[r:HAS_SPEC]->(s:ContractSpec) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.id IN $candidateIds AND r.workspaceId = $workspaceId AND r.generation = $generation AND (r.active IS NULL OR r.active = true) AND s.workspaceId = $workspaceId AND s.generation = $generation AND NOT (s.fileId IN $sourceFileIds) AND (s.active IS NULL OR s.active = true) RETURN n.id AS id;",
      { workspaceId: facts.workspaceId, generation: facts.generation, candidateIds: contractCandidateIds, sourceFileIds: touchedFileIds }
    )) retainedContracts.add(row.id);
  }

  return {
    sourceFileIds: touchedFileIds,
    deletedFileIds: [...new Set(deletedFileIds)].sort(),
    existingEvidenceIds,
    staleCodeIds,
    staleSectionIds,
    staleEvidenceIds,
    staleSpecIds,
    orphanEntityIds: entityCandidateIds.filter((id) => !retainedEntities.has(id)),
    orphanOperationIds: operationCandidateIds.filter((id) => !retainedOperations.has(id)),
    orphanWorkflowIds: workflowCandidateIds.filter((id) => !retainedWorkflows.has(id)),
    orphanContractIds: contractCandidateIds.filter((id) => !retainedContracts.has(id))
  };
}

async function applyIncrementalPublicGraphReplacement(
  db: GraphDB,
  facts: GraphFactsBatch,
  replacement: IncrementalPublicGraphReplacementPlan
): Promise<void> {
  const touchedFileIds = replacement.sourceFileIds;
  if (touchedFileIds.length === 0) return;
  const existingEvidenceIds = replacement.existingEvidenceIds;
  const scopeParams = { workspaceId: facts.workspaceId, generation: facts.generation, touchedFileIds };

  for (const query of [
    "MATCH (source:File)-[r:CONTAINS]->(:Code) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.id IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
    "MATCH (source:File)-[r:CONTAINS]->(:Section) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.id IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
    "MATCH (source:File)-[r:IMPORTS]->(:File) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.id IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
    "MATCH (source:Code)-[r:CALLS]->(:Code) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
    "MATCH (source:Code)-[r:MENTIONS]->(:Entity) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
    "MATCH (source:Section)-[r:MENTIONS]->(:Entity) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
    "MATCH (source:Code)-[r:OPERATES_ON]->(:Entity) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
    "MATCH (source:Section)-[r:DESCRIBES]->(:Repo) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
    "MATCH (source:Section)-[r:DOCUMENTS]->(:Code) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
    "MATCH (source:Section)-[r:REFERENCES]->(:File) WHERE source.workspaceId = $workspaceId AND source.generation = $generation AND source.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;"
  ]) await db.query(query, scopeParams);

  if (existingEvidenceIds.length > 0) {
    await db.query(
      "MATCH ()-[r:HAS_EVIDENCE]->(n:Evidence) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND n.workspaceId = $workspaceId AND n.generation = $generation AND n.id IN $evidenceIds DELETE r;",
      { workspaceId: facts.workspaceId, generation: facts.generation, evidenceIds: existingEvidenceIds }
    );
    for (const relation of [...ALL_EVIDENCE_REL_TYPES, "SEMANTIC_REL"] as const) {
      await db.query(
        `MATCH ()-[r:${relation}]->() WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND r.evidenceId IN $evidenceIds DELETE r;`,
        { workspaceId: facts.workspaceId, generation: facts.generation, evidenceIds: existingEvidenceIds }
      );
    }
  }

  await db.query(
    "MATCH (:Contract)-[r:HAS_SPEC]->(n:ContractSpec) WHERE r.workspaceId = $workspaceId AND r.generation = $generation AND n.workspaceId = $workspaceId AND n.generation = $generation AND n.fileId IN $touchedFileIds DELETE r;",
    scopeParams
  );
  for (const query of [
    "MATCH (n:ContractSpec)-[r:SEMANTIC_REL]->(:ContractSpec) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;",
    "MATCH (:ContractSpec)-[r:SEMANTIC_REL]->(n:ContractSpec) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.fileId IN $touchedFileIds AND r.workspaceId = $workspaceId AND r.generation = $generation DELETE r;"
  ]) await db.query(query, scopeParams);

  for (const [label, ids] of [
    ["Code", replacement.staleCodeIds],
    ["Section", replacement.staleSectionIds],
    ["Evidence", replacement.staleEvidenceIds],
    ["ContractSpec", replacement.staleSpecIds],
    ["Entity", replacement.orphanEntityIds],
    ["Operation", replacement.orphanOperationIds],
    ["Workflow", replacement.orphanWorkflowIds],
    ["Contract", replacement.orphanContractIds],
    ["File", replacement.deletedFileIds]
  ] as const) {
    if (ids.length === 0) continue;
    await db.query(
      `MATCH (n:${label}) WHERE n.workspaceId = $workspaceId AND n.generation = $generation AND n.id IN $ids DETACH DELETE n;`,
      { workspaceId: facts.workspaceId, generation: facts.generation, ids }
    );
  }
}

async function deleteOrphanContracts(db: GraphDB, facts: GraphFactsBatch, repoIds: readonly string[]): Promise<void> {
  const candidates = new Set(facts.contracts.map((contract) => contract.id));
  for (const relation of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "USES_PACKAGE"] as const) {
    const rows = await db.query<{ id: string }>(
      `MATCH (repo:Repo)-[r:${relation}]->(c:Contract) WHERE repo.workspaceId = $workspaceId AND repo.generation = $generation AND c.workspaceId = $workspaceId AND c.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND repo.id IN $repoIds RETURN c.id AS id;`,
      { workspaceId: facts.workspaceId, generation: facts.generation, repoIds: [...repoIds] }
    );
    for (const row of rows) candidates.add(row.id);
  }
  const previouslySpecified = await db.query<{ id: string }>(
    "MATCH (c:Contract)-[r:HAS_SPEC]->(s:ContractSpec) WHERE c.workspaceId = $workspaceId AND c.generation = $generation AND s.workspaceId = $workspaceId AND s.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND s.repoId IN $repoIds RETURN c.id AS id;",
    { workspaceId: facts.workspaceId, generation: facts.generation, repoIds: [...repoIds] }
  );
  for (const row of previouslySpecified) candidates.add(row.id);
  const candidateIds = [...candidates].sort();
  if (candidateIds.length === 0) return;
  const retained = new Set<string>();
  for (const relation of ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT", "USES_PACKAGE"] as const) {
    const rows = await db.query<{ id: string }>(
      `MATCH ()-[r:${relation}]->(c:Contract) WHERE c.workspaceId = $workspaceId AND c.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND c.id IN $candidateIds AND (r.active IS NULL OR r.active = true) RETURN c.id AS id;`,
      { workspaceId: facts.workspaceId, generation: facts.generation, candidateIds }
    );
    for (const row of rows) retained.add(row.id);
  }
  const specified = await db.query<{ id: string }>(
    "MATCH (c:Contract)-[r:HAS_SPEC]->(s:ContractSpec) WHERE c.workspaceId = $workspaceId AND c.generation = $generation AND s.workspaceId = $workspaceId AND s.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND c.id IN $candidateIds AND (r.active IS NULL OR r.active = true) RETURN c.id AS id;",
    { workspaceId: facts.workspaceId, generation: facts.generation, candidateIds }
  );
  for (const row of specified) retained.add(row.id);
  const orphanIds = candidateIds.filter((id) => !retained.has(id));
  if (orphanIds.length > 0) {
    await db.query(
      "MATCH (c:Contract) WHERE c.workspaceId = $workspaceId AND c.generation = $generation AND c.id IN $orphanIds DETACH DELETE c;",
      { workspaceId: facts.workspaceId, generation: facts.generation, orphanIds }
    );
  }
}

export function getGraphWriteFailureDetails(error: unknown): GraphWriteFailureDetails | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Partial<GraphWriteFailureDetails>;
  if (!candidate.graphWriteAtomicity || !candidate.graphWriteStatus) return undefined;
  return {
    graphWriteAtomicity: candidate.graphWriteAtomicity,
    graphWriteStatus: candidate.graphWriteStatus
  };
}

// Centralizes the existing writer-mode contract so batch/full/incremental
// orchestration cannot drift into slightly different auto-mode behavior.
export function selectGraphWriter(input: {
  writeMode: IndexWriteMode;
  changedOnly?: boolean;
  batchedFull?: boolean;
  fullCopyBulk?: boolean;
  graphIsEmpty?: boolean;
  provider?: string;
}): GraphWriterSelection {
  const { writeMode, changedOnly, batchedFull, fullCopyBulk, graphIsEmpty, provider } = input;
  // Non-Kuzu providers (e.g. Neo4j) don't support COPY FROM / LOAD FROM bulk
  // operations, so force merge mode regardless of writeMode.
  if (provider && provider !== "kuzu") {
    return {
      mode: "merge",
      fast: false,
      fallbackToMerge: false
    };
  }
  if (batchedFull) {
    return {
      mode: graphIsEmpty ? "bulk-copy" : "append-copy",
      fast: true,
      fallbackToMerge: false
    };
  }
  if (fullCopyBulk) {
    return {
      mode: "bulk-copy",
      fast: true,
      fallbackToMerge: false
    };
  }
  if (writeMode === "auto" && !changedOnly) {
    return {
      mode: "append-copy",
      fast: true,
      fallbackToMerge: true
    };
  }
  if (writeMode === "bulk-upsert" || (writeMode === "auto" && changedOnly)) {
    return {
      mode: "bulk-upsert",
      fast: true,
      // Explicit bulk-upsert keeps the old hard-fail behavior; auto
      // changed-only may fall back to merge if the fast path is unavailable.
      fallbackToMerge: writeMode !== "bulk-upsert"
    };
  }
  return {
    mode: "merge",
    fast: false,
    fallbackToMerge: false
  };
}

export async function runFactBuildPhase(input: {
  batchId: string;
  workspaceId: string;
  generation: string;
  systemName: string;
  indexedAt: string;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  config: AppConfig;
  repoName?: string;
  createProgressBar?: (label: string, total: number) => ProgressBarLike;
}): Promise<FactBuildResult> {
  const { batchId, workspaceId, generation, systemName, indexedAt, repos, parsedFiles, config, repoName, createProgressBar } = input;
  const result = await runIndexPhase({ phase: "fact-build", repoName, batchId }, async () => {
    const hasCodeFiles = parsedFiles.some((file) => file.language !== "markdown");
    const activeRepoIds = new Set(parsedFiles.map((file) => file.repoId));
    const activeRepoCount = repos.filter((repo) => activeRepoIds.has(repo.id)).length;
    const resolveCallsProgress = hasCodeFiles
      ? createProgressBar?.(repoName ? `Resolve calls ${repoName}` : "Resolve calls", 1)
      : undefined;
    const frameworkProgress = activeRepoCount > 1
      ? createProgressBar?.("Framework detection", activeRepoCount)
      : undefined;
    const extractionProgress = createProgressBar?.(repoName ? `Contract extraction ${repoName}` : "Contract extraction", 1);
    const facts = await buildGraphFactsBatch({
      batchId,
      workspaceId,
      generation,
      systemName,
      indexedAt,
      repos,
      parsedFiles,
      semantic: true,
      config,
      progress: extractionProgress?.reporter(),
      frameworkProgress: frameworkProgress?.reporter(),
      resolveCallsProgress: resolveCallsProgress?.reporter()
    });
    resolveCallsProgress?.complete("done");
    frameworkProgress?.complete("done");
    extractionProgress?.complete("done");
    return {
      facts,
      counts: {
        files: facts.files.length,
        code: facts.code.length,
        sections: facts.sections.length,
        imports: facts.imports.length,
        calls: facts.calls.length,
        entities: facts.entities.length
      }
    };
  });
  return result.result;
}

// 鈹€鈹€ summary helper (shared between Neo4j batch path and Kuzu path) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export async function prepareGraphSummaries(input: {
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  crossRepo: GraphFactsBatch["crossRepo"];
  config: AppConfig;
  llmSummaryLevel: AppConfig["indexing"]["llmSummaryLevel"];
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  label: string;
  createProgressBar: (label: string, total: number) => ProgressBarLike;
}): Promise<PreparedGraphSummaries> {
  const { repos, parsedFiles, crossRepo, config, llmSummaryLevel, openAiApiKey, openAiBaseUrl, label, createProgressBar } = input;
  const summaries = await summarizeGraphWithProgress({
    repos,
    parsedFiles,
    crossRepo,
    options: {
      semantic: shouldSummarizeGraphWithLlm(llmSummaryLevel),
      model: config.llm.model,
      maxSourceChars: config.llm.maxSourceCharsPerNode,
      apiKey: openAiApiKey,
      baseUrl: openAiBaseUrl,
      providerPolicy: { retry: config.llm.retry, budget: config.llm.budget, rateLimit: config.llm.rateLimit }
    }
  }, label, createProgressBar);
  return {
    repoSummaries: [...summaries.repoSummaries]
      .map((summary) => ({ repoId: summary.repoId, summary: summary.summary }))
      .sort((left, right) => left.repoId.localeCompare(right.repoId)),
    systemSummary: summaries.systemSummary
  };
}

async function applyPreparedGraphSummaries(input: {
  db: GraphDB;
  facts: Pick<GraphFactsBatch, "workspaceId" | "generation">;
  summaries: PreparedGraphSummaries;
}): Promise<void> {
  const { db, facts, summaries } = input;
  const scope = { workspaceId: facts.workspaceId, generation: facts.generation };
  for (const summary of summaries.repoSummaries) await db.updateRepoSummary(summary.repoId, summary.summary, scope);
  await db.updateSystemSummary(summaries.systemSummary, scope);
}

async function generateAndUpdateSummaries(input: {
  db: GraphDB;
  facts: Pick<GraphFactsBatch, "workspaceId" | "generation">;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  crossRepo: GraphFactsBatch["crossRepo"];
  config: AppConfig;
  llmSummaryLevel: AppConfig["indexing"]["llmSummaryLevel"];
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  label: string;
  createProgressBar: (label: string, total: number) => ProgressBarLike;
}): Promise<void> {
  const summaries = await prepareGraphSummaries(input);
  await applyPreparedGraphSummaries({ db: input.db, facts: input.facts, summaries });
}

// 鈹€鈹€ legacy one-by-one merge writer (kept as fallback) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async function writeWithMerge(input: {
  db: GraphDB;
  facts: GraphFactsBatch;
}): Promise<void> {
  await writeGraphFactsWithMerge(input.db, input.facts);
}

export async function runGraphWritePhase(input: {
  db: GraphDB;
  cwd: string;
  selection: GraphWriterSelection;
  facts: GraphFactsBatch;
  repos: RepoNode[];
  parsedFiles: ParsedGraphFile[];
  config: AppConfig;
  llmSummaryLevel: AppConfig["indexing"]["llmSummaryLevel"];
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  label: string;
  repoName?: string;
  createProgressBar: (label: string, total: number) => ProgressBarLike;
  log: (message: string) => void;
  warn: (message: string) => void;
  skipGraphWrite?: boolean;
  beforeWrite?: () => Promise<void>;
  deferWorkspaceCommit?: boolean;
  skipRecovery?: boolean;
  parentGeneration?: string;
  publicGraphReplacement?: IncrementalPublicGraphReplacementPlan;
  preparedSummaries?: PreparedGraphSummaries;
}): Promise<GraphWriteResult> {
  const { db, cwd, selection, facts, repos, parsedFiles, config, llmSummaryLevel, openAiApiKey, openAiBaseUrl, label, repoName, createProgressBar, log, warn, beforeWrite, deferWorkspaceCommit = false, skipRecovery = false, skipGraphWrite = false, parentGeneration, publicGraphReplacement, preparedSummaries } = input;
  const result = await runIndexPhase({
    phase: "graph-write",
    repoName,
    batchId: facts.batchId,
    writerMode: selection.mode
  }, async () => {
    let fallback = false;
    let fallbackError: string | undefined;
    let graphWriteCompleted = false;
    const stagingRoot = path.resolve(cwd, BRAND_PATHS.batchStaging);
    const repoIds = repos.map((repo) => repo.id);
    const repoNames = repos.map((repo) => repo.name);
    const atomicityMode = publicGraphReplacement
      ? "transactional"
      : graphWriteAtomicityMode(selection.mode);
    const recovered = skipRecovery
      ? []
      : await db.recoverIncompleteGraphWriteBatches({
        repoIds,
        workspaceId: facts.workspaceId,
        updatedAt: new Date().toISOString()
      });
    for (const journal of recovered) {
      warn(`Recovered incomplete graph writer batch repo=${journal.repoNames.join(",")} batchId=${journal.batchId} writer=${journal.writerMode}`);
    }

    log(`Writer: ${selection.mode}${repoName ? ` repo=${repoName}` : ""} batchId=${facts.batchId}`);
    await db.beginGraphWriteBatch({
      batchId: facts.batchId,
      repoIds,
      repoNames,
      writerMode: selection.mode,
      atomicityMode,
      workspaceId: facts.workspaceId,
      generation: facts.generation,
      parentGeneration,
      startedAt: new Date().toISOString(),
      completedStage: "begin"
    });
    async function cleanupFailedBatch(error: unknown, completedStage: string): Promise<GraphWriteBatchStatus> {
      const cleanupErrors: string[] = [];
      try {
        await db.failGraphWriteBatch({ batchId: facts.batchId, updatedAt: new Date().toISOString(), error: errorMessage(error), completedStage, awaitingCleanup: true });
      } catch (journalError) {
        cleanupErrors.push(`journal: ${errorMessage(journalError)}`);
      }
      // Staging only mutates the pending generation. A graph-writer failure is
      // rolled back by its bounded provider transaction; a later workspace
      // publication failure is cleaned by deleting the complete pending
      // generation in runIndexing. Never compensate against the active graph.
      if (!completedStage.includes("workspace")) return cleanupErrors.length === 0 ? "failed" : "awaiting-cleanup";
      try {
        await db.failGraphWriteBatch({
          batchId: facts.batchId,
          updatedAt: new Date().toISOString(),
          error: cleanupErrors.length > 0
            ? `${errorMessage(error)}; journal: ${cleanupErrors.join("; ")}`
            : errorMessage(error),
          completedStage: `${completedStage}-workspace-cleanup-pending`,
          awaitingCleanup: true
        });
      } catch {}
      return "awaiting-cleanup";
    }

    async function finishSuccessfulGraphWrite(stagePrefix = ""): Promise<void> {
      const graphStage = stagePrefix ? `${stagePrefix}-graph-written` : "graph-written";
      await db.updateGraphWriteBatch({ batchId: facts.batchId, updatedAt: new Date().toISOString(), completedStage: graphStage });
      if (deferWorkspaceCommit) {
        await db.updateGraphWriteBatch({
          batchId: facts.batchId,
          updatedAt: new Date().toISOString(),
          completedStage: stagePrefix ? `${stagePrefix}-workspace-pending` : "workspace-pending"
        });
      } else {
        await db.commitGraphWriteBatch({ batchId: facts.batchId, updatedAt: new Date().toISOString(), completedStage: stagePrefix ? `${stagePrefix}-commit` : "commit" });
      }
    }

    async function updateGraphSummaries(): Promise<void> {
      if (publicGraphReplacement) {
        if (preparedSummaries) {
          await applyPreparedGraphSummaries({ db, facts, summaries: preparedSummaries });
        }
        return;
      }
      if (shouldSummarizeGraphWithLlm(llmSummaryLevel)) {
        await generateAndUpdateSummaries({ db, facts, repos, parsedFiles, crossRepo: facts.crossRepo, config, llmSummaryLevel, openAiApiKey, openAiBaseUrl, label, createProgressBar });
      }
    }

    try {
      await beforeWrite?.();
      if (skipGraphWrite) {
        graphWriteCompleted = true;
        await finishSuccessfulGraphWrite();
      } else if (selection.mode === "merge") {
        // Neo4j: use UNWIND-based batch writer - 50-100x faster than the
        // one-by-one merge writer because it reduces ~40 000 individual
        // transactions to about 30.
        const writeProgress = createProgressBar(`Graph write ${label}`, 1);
        await withTransaction(db, async () => {
          if (publicGraphReplacement) {
            await applyIncrementalPublicGraphReplacement(db, facts, publicGraphReplacement);
          }
          await writeGraphFactsWithNeo4jBatch(db, facts, { progress: writeProgress.reporter() });
          if (!publicGraphReplacement) await deleteOrphanContracts(db, facts, repoIds);
        });
        graphWriteCompleted = true;
        writeProgress.complete();
        await updateGraphSummaries();
        await finishSuccessfulGraphWrite();
      } else {
        const writeProgress = createProgressBar(`Graph write ${label}`, 1);
        await withTransaction(db, async () => {
          if (publicGraphReplacement) {
            await applyIncrementalPublicGraphReplacement(db, facts, publicGraphReplacement);
          }
          if (selection.mode === "bulk-copy") {
            await writeGraphFactsWithKuzuBulk(db, facts, { stagingRoot, progress: writeProgress.reporter() });
          } else if (selection.mode === "append-copy") {
            // Append-copy only clears the repository's pending-generation
            // projection. Active-generation rows remain physically untouched.
            const scope = { workspaceId: facts.workspaceId, generation: facts.generation };
            for (const repo of repos) await db.clearRepoIndexedArtifacts(repo.id, scope);
            await writeGraphFactsWithKuzuAppendCopy(db, facts, { stagingRoot, progress: writeProgress.reporter() });
          } else {
            await writeGraphFactsWithKuzuBulkUpsert(db, facts, { stagingRoot, progress: writeProgress.reporter() });
          }
          if (!publicGraphReplacement) await deleteOrphanContracts(db, facts, repoIds);
        });
        graphWriteCompleted = true;
        writeProgress.complete();
        await updateGraphSummaries();
        await finishSuccessfulGraphWrite();
      }
    } catch (error) {
      const failedAfterGraphWrite = graphWriteCompleted;
      const writeFailureStatus = await cleanupFailedBatch(error, failedAfterGraphWrite ? "workspace-commit-failed" : "graph-write-failed");
      if (failedAfterGraphWrite || writeFailureStatus !== "failed" || !selection.fallbackToMerge) {
        throw markGraphWriteFailure(error, { graphWriteAtomicity: atomicityMode, graphWriteStatus: writeFailureStatus });
      }
      fallback = true;
      fallbackError = errorMessage(error);
      warn(`Fast graph writer failed${repoName ? ` for ${repoName}` : ""}; falling back to merge writer: ${fallbackError}`);
      await db.beginGraphWriteBatch({
        batchId: facts.batchId,
        repoIds,
        repoNames,
        writerMode: "merge",
        atomicityMode,
        workspaceId: facts.workspaceId,
        generation: facts.generation,
        parentGeneration,
        startedAt: new Date().toISOString(),
        completedStage: "fallback-begin",
        error: fallbackError
      });
      graphWriteCompleted = false;
      try {
        if (publicGraphReplacement) {
          await applyIncrementalPublicGraphReplacement(db, facts, publicGraphReplacement);
        }
        await writeWithMerge({ db, facts });
        if (!publicGraphReplacement) await deleteOrphanContracts(db, facts, repoIds);
        graphWriteCompleted = true;
        await updateGraphSummaries();
        await finishSuccessfulGraphWrite("fallback");
      } catch (fallbackWriteError) {
        const fallbackFailureStatus = await cleanupFailedBatch(
          fallbackWriteError,
          graphWriteCompleted ? "fallback-workspace-commit-failed" : "fallback-graph-write-failed"
        );
        throw markGraphWriteFailure(fallbackWriteError, { graphWriteAtomicity: atomicityMode, graphWriteStatus: fallbackFailureStatus });
      }
    } finally {
      await removeEmptyStagingDirectories(stagingRoot, warn);
    }

    return {
      writerMode: fallback ? "merge" : selection.mode,
      batchId: facts.batchId,
      repoNames,
      repoIds,
      atomicityMode,
      journalStatus: deferWorkspaceCommit ? "started" as const : "committed" as const,
      recoveredBatchIds: recovered.map((journal) => journal.batchId),
      fallback,
      fallbackError
    };
  });

  return result.result;
}

async function removeEmptyStagingDirectories(stagingRoot: string, warn: (message: string) => void): Promise<void> {
  for (const directory of [stagingRoot, path.dirname(stagingRoot)]) {
    try {
      await fs.rmdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        warn(`Failed to remove empty graph staging directory "${directory}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
