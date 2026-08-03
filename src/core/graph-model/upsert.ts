import { type GraphDB, withTransaction } from "./db.js";
import type { ParsedGraphFile, RepoNode } from "../parsing/types.js";
import { summarizeReposAndSystem } from "../semantic/summarizeGraph.js";
import { buildGraphFactsBatch, type GraphFactsBatch } from "./facts.js";

export type UpsertParsedFilesOptions = {
  semantic: boolean;
  workspaceId: string;
  generation: string;
  systemName: string;
  llmSummary?: boolean;
  llmModel?: string;
  maxSourceChars?: number;
  apiKey?: string;
  baseUrl?: string;
  batchId?: string;
};

export async function writeGraphFactsWithMerge(db: GraphDB, facts: GraphFactsBatch): Promise<void> {
  const scope = { workspaceId: facts.workspaceId, generation: facts.generation };
  await withTransaction(db, async () => {
    await db.upsertSystem(facts.systemName, scope);
    for (const repo of facts.repos) await db.upsertRepo(repo, scope);
    // High-volume operations use UNWIND-based batch methods to reduce DB
    // round-trips (4 calls for thousands of items instead of N calls).
    if (facts.files.length > 0) await db.upsertFilesBatch(facts.files, scope);
    if (facts.code.length > 0) await db.upsertCodeBatch(facts.code, scope);
    if (facts.imports.length > 0) await db.addImportsBatch(facts.imports, scope);
    if (facts.calls.length > 0) await db.addCallsBatch(facts.calls, scope);
    if (facts.repoDependencies.length > 0) await db.addRepoDependenciesBatch(facts.repoDependencies, scope);

    // Lower-volume operations — sections are coupled with their describes
    // edges so a batch would need two parallel arrays; keep individual.
    for (const section of facts.sections) {
      await db.upsertSection(section, scope);
      const describes = facts.sectionDescribesRepos.find((edge) => edge.sectionId === section.id);
      if (describes) await db.addSectionDescribesRepo(section.id, describes.repoId, scope);
    }

    // Lower-volume operations:
    for (const edge of facts.contains) await db.addContains(edge.fromId, edge.toId, scope);
    for (const entity of facts.entities) await db.upsertEntity(entity, scope);
    for (const mention of facts.mentions) {
      if (mention.sourceKind === "section") await db.addSectionMention(mention.fromId, mention.entityId, mention.confidence, scope);
      else await db.addMention(mention.fromId, mention.entityId, mention.confidence, scope);
    }
    for (const contract of facts.contracts) await db.upsertContract(contract, scope);
    for (const evidence of facts.evidence) {
      await db.upsertEvidence(evidence, scope);
      await db.addRepoEvidence(evidence.repoId, evidence.id, scope);
    }
    for (const edge of facts.repoContracts) {
      await db.addRepoContract(edge, scope);
      await db.addContractEvidence(edge.contractId, edge.evidenceId, scope);
    }
    for (const edge of facts.packageUsages) await db.addPackageUsage(edge, scope);
    for (const edge of facts.contractEntities) await db.addContractEntity(edge, scope);
    for (const operation of facts.operations) await db.upsertOperation(operation, scope);
    for (const workflow of facts.workflows) await db.upsertWorkflow(workflow, scope);
    for (const edge of facts.operationRepos) await db.addOperationRepo(edge, scope);
    for (const edge of facts.workflowOperations) await db.addWorkflowOperation(edge, scope);
    for (const edge of facts.sectionReferencesFile) await db.addSectionReferencesFile(edge.sectionId, edge.fileId, edge.raw, scope);
    for (const edge of facts.sectionDocumentsCode) await db.addSectionDocumentsCode(edge.sectionId, edge.codeId, edge.confidence, scope);
    for (const spec of facts.contractSpecs) await db.upsertContractSpec(spec, scope);
    for (const edge of facts.contractSpecEdges) await db.addHasSpec(edge, scope);
    if (facts.semanticRelations.length > 0) await db.addSemanticRelationsBatch(facts.semanticRelations, scope);
  });
}

export async function upsertParsedFiles(db: GraphDB, parsedFiles: ParsedGraphFile[], options: UpsertParsedFilesOptions, repos?: RepoNode[]): Promise<void> {
  const batchId = options.batchId ?? "";
  const scope = { workspaceId: options.workspaceId, generation: options.generation };
  const repoRows = repos ?? await db.listRepos(scope);
  const repoIds = new Set(parsedFiles.map((file) => file.repoId));
  const aliasOverrides = await db.listActiveAliasOverrides();
  const facts = await buildGraphFactsBatch({
    batchId,
    workspaceId: options.workspaceId,
    generation: options.generation,
    systemName: options.systemName,
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
  for (const summary of summaries.repoSummaries) await db.updateRepoSummary(summary.repoId, summary.summary, scope);
  await db.updateSystemSummary(summaries.systemSummary, scope);
}
