import { type GraphDB, withTransaction } from "./db.js";
import type { ParsedGraphFile, RepoNode } from "../parsing/types.js";
import { summarizeReposAndSystem } from "../semantic/summarizeGraph.js";
import { buildGraphFactsBatch, type GraphFactsBatch } from "./facts.js";

export type UpsertParsedFilesOptions = {
  semantic: boolean;
  llmSummary?: boolean;
  llmModel?: string;
  maxSourceChars?: number;
  apiKey?: string;
  baseUrl?: string;
  batchId?: string;
};

function normalizeOptions(options: boolean | UpsertParsedFilesOptions): UpsertParsedFilesOptions {
  return typeof options === "boolean" ? { semantic: options } : options;
}

export async function writeGraphFactsWithMerge(db: GraphDB, facts: GraphFactsBatch): Promise<void> {
  await withTransaction(db, async () => {
    // High-volume operations use UNWIND-based batch methods to reduce DB
    // round-trips (4 calls for thousands of items instead of N calls).
    if (facts.files.length > 0) await db.upsertFilesBatch(facts.files);
    if (facts.code.length > 0) await db.upsertCodeBatch(facts.code);
    if (facts.imports.length > 0) await db.addImportsBatch(facts.imports);
    if (facts.calls.length > 0) await db.addCallsBatch(facts.calls);
    if (facts.semanticRelations.length > 0) await db.addSemanticRelationsBatch(facts.semanticRelations);
    if (facts.repoDependencies.length > 0) await db.addRepoDependenciesBatch(facts.repoDependencies);

    // Lower-volume operations — sections are coupled with their describes
    // edges so a batch would need two parallel arrays; keep individual.
    for (const section of facts.sections) {
      await db.upsertSection(section);
      const describes = facts.sectionDescribesRepos.find((edge) => edge.sectionId === section.id);
      if (describes) await db.addSectionDescribesRepo(section.id, describes.repoId);
    }

    // Lower-volume operations:
    for (const edge of facts.contains) await db.addContains(edge.fromId, edge.toId);
    for (const entity of facts.entities) await db.upsertEntity(entity);
    for (const mention of facts.mentions) {
      if (mention.sourceKind === "section") await db.addSectionMention(mention.fromId, mention.entityId, mention.confidence);
      else await db.addMention(mention.fromId, mention.entityId, mention.confidence);
    }
    for (const contract of facts.contracts) await db.upsertContract(contract);
    for (const evidence of facts.evidence) {
      await db.upsertEvidence(evidence);
      await db.addRepoEvidence(evidence.repoId, evidence.id);
    }
    for (const edge of facts.repoContracts) {
      await db.addRepoContract(edge);
      await db.addContractEvidence(edge.contractId, edge.evidenceId);
    }
    for (const edge of facts.packageUsages) await db.addPackageUsage(edge);
    for (const edge of facts.contractEntities) await db.addContractEntity(edge);
    for (const operation of facts.operations) await db.upsertOperation(operation);
    for (const workflow of facts.workflows) await db.upsertWorkflow(workflow);
    for (const edge of facts.operationRepos) await db.addOperationRepo(edge);
    for (const edge of facts.workflowOperations) await db.addWorkflowOperation(edge);
    for (const edge of facts.sectionReferencesFile) await db.addSectionReferencesFile(edge.sectionId, edge.fileId, edge.raw);
    for (const edge of facts.sectionDocumentsCode) await db.addSectionDocumentsCode(edge.sectionId, edge.codeId, edge.confidence);
    for (const spec of facts.contractSpecs) await db.upsertContractSpec(spec);
    for (const edge of facts.contractSpecEdges) await db.addHasSpec(edge);
  });
}

export async function upsertParsedFiles(db: GraphDB, parsedFiles: ParsedGraphFile[], optionsInput: boolean | UpsertParsedFilesOptions, repos?: RepoNode[]): Promise<void> {
  const options = normalizeOptions(optionsInput);
  const batchId = options.batchId ?? "";
  const repoRows = repos ?? await db.listRepos();
  const repoIds = new Set(parsedFiles.map((file) => file.repoId));
  const aliasOverrides = await db.listActiveAliasOverrides();
  const facts = await buildGraphFactsBatch({
    batchId,
    repos: repoRows.filter((repo) => repoIds.has(repo.id)),
    parsedFiles,
    semantic: options.semantic,
    aliasOverrides
  });
  await writeGraphFactsWithMerge(db, facts);

  const summaries = await summarizeReposAndSystem({
    repos: repoRows.filter((repo) => repoIds.has(repo.id)),
    parsedFiles,
    crossRepo: facts.crossRepo,
    options: {
      semantic: options.llmSummary !== undefined ? options.llmSummary : options.semantic,
      model: options.llmModel ?? "gpt-4.1-mini",
      maxSourceChars: options.maxSourceChars ?? 6000,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl
    }
  });
  for (const summary of summaries.repoSummaries) await db.updateRepoSummary(summary.repoId, summary.summary);
  await db.updateSystemSummary(summaries.systemSummary);
}
