import fs from "node:fs/promises";
import path from "node:path";
import { systemId } from "./schema.js";
import type { GraphFactsBatch } from "./facts.js";

export type CsvTableName =
  | "Repo"
  | "File"
  | "Code"
  | "Section"
  | "Entity"
  | "Operation"
  | "Workflow"
  | "Contract"
  | "Evidence"
  | "CONTAINS"
  | "IMPORTS"
  | "CALLS"
  | "MENTIONS"
  | "DESCRIBES"
  | "DOCUMENTS"
  | "REFERENCES"
  | "OPERATES_ON"
  | "OWNS_PACKAGE"
  | "PRODUCES"
  | "CONSUMES"
  | "SHARES_CONTRACT"
  | "CONTRACT_MENTIONS"
  | "PARTICIPATES_IN"
  | "WORKFLOW_STEP"
  | "HAS_EVIDENCE"
  | "USES_PACKAGE"
  | "DEPENDS_ON"
  | "ContractSpec"
  | "HAS_SPEC"
  | "SEMANTIC_REL";

export type CsvStagingResult = {
  dir: string;
  files: Partial<Record<CsvTableName, string>>;
  rowCounts: Partial<Record<CsvTableName, number>>;
};

type CsvRow = Array<string | number | boolean | undefined | null>;

function csvValue(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return `"${String(value).replace(/"/g, '""')}"`;
}

function formatDouble(value: number | undefined | null): string | number {
  if (value === undefined || value === null) return "";
  return value % 1 === 0 ? `${value}.0` : value;
}

async function writeTable(outputDir: string, tableName: CsvTableName, rows: CsvRow[], result: CsvStagingResult): Promise<void> {
  if (rows.length === 0) return;
  const filePath = path.join(outputDir, `${tableName}.csv`);
  await fs.writeFile(filePath, rows.map((row) => row.map(csvValue).join(",")).join("\n"), "utf8");
  result.files[tableName] = filePath;
  result.rowCounts[tableName] = rows.length;
}

export async function stageGraphFactsAsCsv(facts: GraphFactsBatch, outputRoot: string): Promise<CsvStagingResult> {
  const outputDir = path.join(outputRoot, facts.batchId.replace(/[^a-zA-Z0-9_.-]+/g, "_"));
  await fs.mkdir(outputDir, { recursive: true });
  const result: CsvStagingResult = { dir: outputDir, files: {}, rowCounts: {} };

  await writeTable(outputDir, "Repo", facts.repos.map((repo) => [
    repo.id,
    repo.name,
    repo.path,
    repo.remoteUrl,
    repo.branch,
    repo.commitSha,
    repo.language,
    repo.indexedAt,
    repo.summary ?? ""
  ]), result);
  await writeTable(outputDir, "File", facts.files.map((file) => [
    file.id,
    file.repoId,
    file.path,
    file.language,
    file.hash,
    file.loc,
    file.batchId ?? "",
    file.indexedAt ?? "",
    file.active ?? true
  ]), result);
  await writeTable(outputDir, "Code", facts.code.map((code) => [
    code.id,
    code.repoId,
    code.fileId,
    code.kind,
    code.name,
    code.qualifiedName,
    code.startLine,
    code.endLine,
    code.signature,
    code.summary ?? "",
    code.hash,
    code.batchId ?? "",
    code.indexedAt ?? "",
    code.active ?? true
  ]), result);
  await writeTable(outputDir, "Section", facts.sections.map((section) => [
    section.id,
    section.repoId,
    section.fileId,
    section.heading,
    section.level,
    section.startLine,
    section.endLine,
    section.text,
    section.summary ?? "",
    section.hash,
    section.batchId ?? "",
    section.indexedAt ?? "",
    section.active ?? true
  ]), result);
  await writeTable(outputDir, "Entity", facts.entities.map((entity) => [entity.id, entity.name, entity.kind, entity.description]), result);
  await writeTable(outputDir, "Operation", facts.operations.map((operation) => [operation.id, operation.verb, operation.entityName, operation.description]), result);
  await writeTable(outputDir, "Workflow", facts.workflows.map((workflow) => [workflow.id, workflow.name, workflow.description]), result);
  await writeTable(outputDir, "Contract", facts.contracts.map((contract) => [contract.id, contract.kind, contract.key, contract.name, contract.description]), result);
  await writeTable(outputDir, "ContractSpec", facts.contractSpecs.map((spec) => [
    spec.id,
    spec.contractId,
    spec.specKind,
    spec.repoId,
    spec.fileId,
    spec.evidenceId,
    spec.sourceSymbolId ?? "",
    spec.canonicalKey,
    spec.httpMethod ?? "",
    spec.pathTemplate ?? "",
    spec.eventTopic ?? "",
    spec.framework ?? "",
    spec.version ?? "",
    spec.specJson,
    formatDouble(spec.confidence),
    spec.batchId ?? "",
    spec.indexedAt ?? "",
    spec.active ?? true
  ]), result);
  await writeTable(outputDir, "Evidence", facts.evidence.map((evidence) => [
    evidence.id,
    evidence.repoId,
    evidence.fileId,
    evidence.filePath,
    evidence.line,
    evidence.raw,
    evidence.rule,
    formatDouble(evidence.confidence),
    evidence.batchId ?? "",
    evidence.indexedAt ?? "",
    evidence.active ?? true
  ]), result);

  await writeTable(outputDir, "CONTAINS", [
    ...facts.repos.map((repo) => [systemId, repo.id]),
    ...facts.contains.map((edge) => [edge.fromId, edge.toId])
  ], result);
  await writeTable(outputDir, "IMPORTS", facts.imports.map((edge) => [edge.fromFileId, edge.toFileId, edge.module, edge.raw, edge.batchId ?? "", edge.active ?? true]), result);
  await writeTable(outputDir, "CALLS", facts.calls.map((edge) => [edge.fromCodeId, edge.toCodeId, formatDouble(edge.confidence), edge.resolution, edge.raw, edge.batchId ?? "", edge.active ?? true]), result);
  await writeTable(outputDir, "MENTIONS", facts.mentions.map((edge) => [edge.fromId, edge.entityId, formatDouble(edge.confidence)]), result);
  await writeTable(outputDir, "DESCRIBES", facts.sectionDescribesRepos.map((edge) => [edge.sectionId, edge.repoId]), result);
  await writeTable(outputDir, "DOCUMENTS", facts.sectionDocumentsCode.map((edge) => [edge.sectionId, edge.codeId, formatDouble(edge.confidence)]), result);
  await writeTable(outputDir, "REFERENCES", facts.sectionReferencesFile.map((edge) => [edge.sectionId, edge.fileId, edge.raw]), result);
  await writeTable(outputDir, "HAS_EVIDENCE", [
    ...facts.repoContracts.map((edge) => [edge.contractId, edge.evidenceId]),
    ...facts.evidence.map((evidence) => [evidence.repoId, evidence.id])
  ], result);

  const repoContractRows = facts.repoContracts.map((edge) => [edge.repoId, edge.contractId, edge.evidenceId, formatDouble(edge.confidence), edge.batchId ?? "", edge.active ?? true]);
  await writeTable(outputDir, "OWNS_PACKAGE", repoContractRows.filter((_row, index) => facts.repoContracts[index]?.role === "owner"), result);
  await writeTable(outputDir, "PRODUCES", repoContractRows.filter((_row, index) => facts.repoContracts[index]?.role === "producer"), result);
  await writeTable(outputDir, "CONSUMES", repoContractRows.filter((_row, index) => facts.repoContracts[index]?.role === "consumer"), result);
  await writeTable(outputDir, "SHARES_CONTRACT", repoContractRows.filter((_row, index) => facts.repoContracts[index]?.role === "shared"), result);
  await writeTable(outputDir, "CONTRACT_MENTIONS", facts.contractEntities.map((edge) => [edge.contractId, edge.entityId, edge.evidenceId, formatDouble(edge.confidence), edge.batchId ?? "", edge.active ?? true]), result);
  await writeTable(outputDir, "PARTICIPATES_IN", facts.operationRepos.map((edge) => [edge.repoId, edge.operationId, edge.role, edge.evidenceId, formatDouble(edge.confidence), edge.batchId ?? "", edge.active ?? true]), result);
  await writeTable(outputDir, "WORKFLOW_STEP", facts.workflowOperations.map((edge) => [edge.workflowId, edge.operationId, edge.step, edge.evidenceId, formatDouble(edge.confidence), edge.batchId ?? "", edge.active ?? true]), result);
  await writeTable(outputDir, "USES_PACKAGE", facts.packageUsages.map((edge) => [edge.repoId, edge.packageContractId, edge.packageName, edge.evidenceId, edge.raw, formatDouble(edge.confidence), edge.batchId ?? "", edge.active ?? true]), result);
  await writeTable(outputDir, "DEPENDS_ON", facts.repoDependencies.map((edge) => [
    edge.fromRepoId,
    edge.toRepoId,
    edge.dependencyType,
    edge.sourceContractId,
    edge.targetContractId,
    edge.evidenceId,
    edge.raw,
    formatDouble(edge.confidence),
    edge.batchId ?? "",
    edge.active ?? true
  ]), result);
  await writeTable(outputDir, "HAS_SPEC", facts.contractSpecEdges.map((edge) => [
    edge.contractId,
    edge.specId,
    edge.evidenceId,
    formatDouble(edge.confidence),
    edge.batchId ?? "",
    edge.active ?? true
  ]), result);
  await writeTable(outputDir, "SEMANTIC_REL", facts.semanticRelations.map((edge) => [
    edge.fromSpecId,
    edge.toSpecId,
    edge.kind,
    edge.evidenceId,
    edge.reason,
    formatDouble(edge.confidence),
    edge.batchId ?? "",
    edge.active ?? true
  ]), result);

  return result;
}
