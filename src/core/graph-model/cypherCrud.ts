import type {
  CallEdge,
  CodeSymbol,
  ContractEntityEdge,
  ContractNode,
  ContractSpecEdge,
  ContractSpecNode,
  DocSection,
  EntityNode,
  EvidenceNode,
  FileNode,
  ImportEdge,
  OperationNode,
  OperationRepoEdge,
  PackageUsageEdge,
  RepoContractEdge,
  RepoDependencyEdge,
  RepoNode,
  SemanticRelationEdge,
  WorkflowNode,
  WorkflowOperationEdge
} from "../parsing/types.js";
import { chunk } from "../../shared/chunk.js";
import { systemId } from "./schema.js";
import type {
  ActiveAliasOverride,
  GraphValue,
  GraphWriteAtomicityMode,
  GraphWriteBatchStatus,
  PublicGraphStatsUpdate,
  PublicGraphStatsSnapshot,
  Stats,
  StatsDelta
} from "./db.js";
import {
  publicNodeStorageId,
  publicNodeStorageParams,
  publicGraphStatsId,
  publicRelationshipScopeParams,
  type PublicGraphGenerationScope,
  type PublicGraphNodeLabel
} from "./publicGraphGeneration.js";
import { collapseSemanticRelations } from "../contracts/extraction/dedup.js";

const BATCH_SIZE = 5000;
const STAT_FIELDS = [
  "repos",
  "files",
  "codeNodes",
  "sectionNodes",
  "callEdges",
  "importEdges",
  "entities"
] as const satisfies readonly (keyof Stats)[];

export type CypherExecutor = {
  query<T = Record<string, GraphValue>>(
    cypher: string,
    params?: Record<string, GraphValue>
  ): Promise<T[]>;
};

export type CypherCrud = ReturnType<typeof createCypherCrud>;

type RelationWrite = {
  relationshipType: string;
  fromLabel: PublicGraphNodeLabel;
  toLabel: PublicGraphNodeLabel;
  fromId: string;
  toId: string;
  mergeProperties?: Record<string, GraphValue>;
  setProperties?: Record<string, GraphValue>;
};

function asGraphProperties(value: object): Record<string, GraphValue> {
  return value as unknown as Record<string, GraphValue>;
}

function propertyAssignments(variable: string, properties: readonly string[]): string {
  return properties.map((property) => `${variable}.${property} = row.${property}`).join(", ");
}

export function createCypherCrud(executor: CypherExecutor) {
  const query = executor.query.bind(executor);

  function requireNonNegativeSafeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative safe integer.`);
    }
    return value;
  }

  function validateStats(stats: Readonly<Stats>, label: string): Stats {
    return Object.fromEntries(STAT_FIELDS.map((field) => [
      field,
      requireNonNegativeSafeInteger(stats[field], `${label} ${field}`)
    ])) as Stats;
  }

  function validateStatsDelta(delta: Readonly<StatsDelta>): StatsDelta {
    return Object.fromEntries(STAT_FIELDS.map((field) => {
      const value = delta[field];
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`Public graph stats delta ${field} must be a safe integer.`);
      }
      return [field, value];
    })) as StatsDelta;
  }

  function statsParams(scope: PublicGraphGenerationScope): Record<string, GraphValue> {
    return {
      ...publicRelationshipScopeParams(scope),
      statsId: publicGraphStatsId(scope)
    };
  }

  async function readPublicGraphStats(scope: PublicGraphGenerationScope): Promise<PublicGraphStatsSnapshot | undefined> {
    const rows = await query<PublicGraphStatsSnapshot>(
      "MATCH (s:PublicGraphStats {id: $statsId}) " +
      "WHERE s.workspaceId = $workspaceId AND s.generation = $generation " +
      "RETURN s.revision AS revision, s.repos AS repos, s.files AS files, " +
      "s.codeNodes AS codeNodes, s.sectionNodes AS sectionNodes, s.callEdges AS callEdges, " +
      "s.importEdges AS importEdges, s.entities AS entities;",
      statsParams(scope)
    );
    const row = rows[0];
    if (!row) return undefined;
    if (typeof row.revision !== "string" || !row.revision.trim()) {
      throw new Error("Stored public graph stats revision is missing; run a clean full reindex.");
    }
    return { ...validateStats({
      repos: Number(row.repos),
      files: Number(row.files),
      codeNodes: Number(row.codeNodes),
      sectionNodes: Number(row.sectionNodes),
      callEdges: Number(row.callEdges),
      importEdges: Number(row.importEdges),
      entities: Number(row.entities)
    }, "Stored public graph stats"), revision: row.revision };
  }

  async function computePublicGraphStats(scope: PublicGraphGenerationScope): Promise<Stats> {
    const nodeCount = async (label: PublicGraphNodeLabel, active: boolean): Promise<number> => {
      const rows = await query<{ count: number }>(
        `MATCH (n:${label}) WHERE n.workspaceId = $workspaceId AND n.generation = $generation${active ? " AND (n.active IS NULL OR n.active = true)" : ""} RETURN count(n) AS count;`,
        publicRelationshipScopeParams(scope)
      );
      return Number(rows[0]?.count ?? 0);
    };
    const edgeCount = async (from: PublicGraphNodeLabel, relationshipType: string, to: PublicGraphNodeLabel): Promise<number> => {
      const rows = await query<{ count: number }>(
        `MATCH (a:${from})-[r:${relationshipType}]->(b:${to}) WHERE a.workspaceId = $workspaceId AND a.generation = $generation AND b.workspaceId = $workspaceId AND b.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation AND (r.active IS NULL OR r.active = true) RETURN count(r) AS count;`,
        publicRelationshipScopeParams(scope)
      );
      return Number(rows[0]?.count ?? 0);
    };
    const [repos, files, codeNodes, sectionNodes, callEdges, importEdges, entities] = await Promise.all([
      nodeCount("Repo", false),
      nodeCount("File", true),
      nodeCount("Code", true),
      nodeCount("Section", true),
      edgeCount("Code", "CALLS", "Code"),
      edgeCount("File", "IMPORTS", "File"),
      nodeCount("Entity", false)
    ]);
    return validateStats({ repos, files, codeNodes, sectionNodes, callEdges, importEdges, entities }, "Computed public graph stats");
  }

  async function initializePublicGraphStats(
    scope: PublicGraphGenerationScope,
    revision: string,
    input: Readonly<Stats>
  ): Promise<void> {
    if (!revision.trim()) throw new TypeError("Public graph stats revision must be non-empty.");
    const stats = validateStats(input, "Public graph stats");
    await query(
      "MERGE (s:PublicGraphStats {id: $statsId}) " +
      "SET s.workspaceId = $workspaceId, s.generation = $generation, s.revision = $revision, " +
      "s.repos = $repos, s.files = $files, s.codeNodes = $codeNodes, " +
      "s.sectionNodes = $sectionNodes, s.callEdges = $callEdges, " +
      "s.importEdges = $importEdges, s.entities = $entities, s.updatedAt = $updatedAt;",
      { ...statsParams(scope), ...stats, revision, updatedAt: new Date().toISOString() }
    );
  }

  async function applyPublicGraphStatsDelta(
    scope: PublicGraphGenerationScope,
    update: PublicGraphStatsUpdate
  ): Promise<Stats> {
    if (!update.expectedRevision.trim() || !update.nextRevision.trim()) {
      throw new TypeError("Public graph stats revisions must be non-empty.");
    }
    if (update.expectedRevision === update.nextRevision) {
      throw new TypeError("Public graph stats update must advance to a distinct revision.");
    }
    const currentRows = await query<(Stats & { revision: string })>(
      "MATCH (s:PublicGraphStats {id: $statsId}) " +
      "WHERE s.workspaceId = $workspaceId AND s.generation = $generation " +
      "RETURN s.revision AS revision, s.repos AS repos, s.files AS files, " +
      "s.codeNodes AS codeNodes, s.sectionNodes AS sectionNodes, s.callEdges AS callEdges, " +
      "s.importEdges AS importEdges, s.entities AS entities;",
      statsParams(scope)
    );
    const row = currentRows[0];
    if (!row || row.revision !== update.expectedRevision) {
      const actual = row?.revision ?? "missing";
      throw new Error(
        `Public graph stats revision ${actual} does not match incremental parent ${update.expectedRevision}; ` +
        "clean generated graph/internal/lexical artifacts and run a full reindex."
      );
    }
    const current = validateStats({
      repos: Number(row.repos),
      files: Number(row.files),
      codeNodes: Number(row.codeNodes),
      sectionNodes: Number(row.sectionNodes),
      callEdges: Number(row.callEdges),
      importEdges: Number(row.importEdges),
      entities: Number(row.entities)
    }, "Stored public graph stats");
    const delta = validateStatsDelta(update.delta);
    const next = Object.fromEntries(STAT_FIELDS.map((field) => [
      field,
      requireNonNegativeSafeInteger(current[field] + delta[field], `Next public graph stats ${field}`)
    ])) as Stats;
    const updated = await query<{ revision: string }>(
      "MATCH (s:PublicGraphStats {id: $statsId}) " +
      "WHERE s.workspaceId = $workspaceId AND s.generation = $generation AND s.revision = $expectedRevision " +
      "SET s.revision = $nextRevision, s.repos = $repos, s.files = $files, " +
      "s.codeNodes = $codeNodes, s.sectionNodes = $sectionNodes, s.callEdges = $callEdges, " +
      "s.importEdges = $importEdges, s.entities = $entities, s.updatedAt = $updatedAt " +
      "RETURN s.revision AS revision;",
      {
        ...statsParams(scope),
        ...next,
        expectedRevision: update.expectedRevision,
        nextRevision: update.nextRevision,
        updatedAt: new Date().toISOString()
      }
    );
    if (updated[0]?.revision !== update.nextRevision) {
      throw new Error("Public graph stats revision changed during incremental publication; retry from the active revision.");
    }
    return next;
  }

  async function upsertNode(
    label: PublicGraphNodeLabel,
    id: string,
    properties: Record<string, GraphValue>,
    scope: PublicGraphGenerationScope,
    preserveOnMatch: readonly string[] = []
  ): Promise<void> {
    const row = { ...publicNodeStorageParams(scope, id), ...properties };
    const names = Object.keys(row).filter((name) => name !== "storageId");
    const createSet = propertyAssignments("n", names);
    const matchNames = names.filter((name) => !preserveOnMatch.includes(name));
    const matchSet = propertyAssignments("n", matchNames);
    await query(
      `WITH $row AS row MERGE (n:${label} {storageId: row.storageId}) ` +
      `ON CREATE SET ${createSet} ` +
      (matchSet ? `ON MATCH SET ${matchSet};` : ";"),
      { row }
    );
  }

  async function upsertNodes(
    label: PublicGraphNodeLabel,
    rows: Array<{ id: string; properties: Record<string, GraphValue> }>,
    scope: PublicGraphGenerationScope
  ): Promise<void> {
    for (const items of chunk(rows, BATCH_SIZE)) {
      const batch = items.map((item) => ({
        ...publicNodeStorageParams(scope, item.id),
        ...item.properties
      }));
      const properties = Object.keys(batch[0] ?? {}).filter((name) => name !== "storageId");
      await query(
        `UNWIND $batch AS row MERGE (n:${label} {storageId: row.storageId}) ` +
        `SET ${propertyAssignments("n", properties)};`,
        { batch }
      );
    }
  }

  async function writeRelation(
    relation: RelationWrite,
    scope: PublicGraphGenerationScope
  ): Promise<void> {
    const mergeProperties = relation.mergeProperties ?? {};
    const setProperties = relation.setProperties ?? {};
    const params: Record<string, GraphValue> = {
      fromStorageId: publicNodeStorageId(scope.generation, relation.fromId),
      toStorageId: publicNodeStorageId(scope.generation, relation.toId),
      ...publicRelationshipScopeParams(scope),
      ...mergeProperties,
      ...setProperties
    };
    const mergeMap = Object.keys(mergeProperties)
      .map((property) => `${property}: $${property}`)
      .join(", ");
    const assignments = [
      "r.workspaceId = $workspaceId",
      "r.generation = $generation",
      ...Object.keys(setProperties).map((property) => `r.${property} = $${property}`)
    ].join(", ");
    await query(
      `MATCH (a:${relation.fromLabel} {storageId: $fromStorageId}), ` +
      `(b:${relation.toLabel} {storageId: $toStorageId}) ` +
      `MERGE (a)-[r:${relation.relationshipType}${mergeMap ? ` {${mergeMap}}` : ""}]->(b) ` +
      `SET ${assignments};`,
      params
    );
  }

  async function writeRelations(
    relation: Omit<RelationWrite, "fromId" | "toId" | "mergeProperties" | "setProperties"> & {
      rows: Array<{
        fromId: string;
        toId: string;
        mergeProperties?: Record<string, GraphValue>;
        setProperties?: Record<string, GraphValue>;
      }>;
      mergePropertyNames?: readonly string[];
      setPropertyNames?: readonly string[];
    },
    scope: PublicGraphGenerationScope
  ): Promise<void> {
    for (const items of chunk(relation.rows, BATCH_SIZE)) {
      const batch = items.map((item) => ({
        fromStorageId: publicNodeStorageId(scope.generation, item.fromId),
        toStorageId: publicNodeStorageId(scope.generation, item.toId),
        ...publicRelationshipScopeParams(scope),
        ...(item.mergeProperties ?? {}),
        ...(item.setProperties ?? {})
      }));
      const mergeMap = (relation.mergePropertyNames ?? [])
        .map((property) => `${property}: row.${property}`)
        .join(", ");
      const assignments = [
        "r.workspaceId = row.workspaceId",
        "r.generation = row.generation",
        ...(relation.setPropertyNames ?? []).map((property) => `r.${property} = row.${property}`)
      ].join(", ");
      await query(
        `UNWIND $batch AS row ` +
        `MATCH (a:${relation.fromLabel} {storageId: row.fromStorageId}), ` +
        `(b:${relation.toLabel} {storageId: row.toStorageId}) ` +
        `MERGE (a)-[r:${relation.relationshipType}${mergeMap ? ` {${mergeMap}}` : ""}]->(b) ` +
        `SET ${assignments};`,
        { batch }
      );
    }
  }

  async function addContains(
    fromId: string,
    toId: string,
    scope: PublicGraphGenerationScope
  ): Promise<void> {
    const labels = fromId.startsWith("system:")
      ? { fromLabel: "System" as const, toLabel: "Repo" as const }
      : fromId.startsWith("repo:")
        ? { fromLabel: "Repo" as const, toLabel: "File" as const }
        : toId.startsWith("section:")
          ? { fromLabel: "File" as const, toLabel: "Section" as const }
          : { fromLabel: "File" as const, toLabel: "Code" as const };
    await writeRelation({ relationshipType: "CONTAINS", ...labels, fromId, toId }, scope);
  }

  return {
    async upsertSystem(systemName: string, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("System", systemId, { name: systemName, summary: "" }, scope, ["summary"]);
    },

    async upsertRepo(repo: RepoNode, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("Repo", repo.id, {
        name: repo.name,
        path: repo.path,
        remoteUrl: repo.remoteUrl,
        branch: repo.branch,
        commitSha: repo.commitSha,
        language: repo.language,
        indexedAt: repo.indexedAt,
        summary: repo.summary ?? ""
      }, scope, ["summary"]);
      await addContains(systemId, repo.id, scope);
    },

    async updateRepoSummary(repoId: string, summary: string, scope: PublicGraphGenerationScope): Promise<void> {
      await query(
        "MATCH (r:Repo {storageId: $storageId}) SET r.summary = $summary;",
        { storageId: publicNodeStorageId(scope.generation, repoId), summary }
      );
    },

    async updateSystemSummary(summary: string, scope: PublicGraphGenerationScope): Promise<void> {
      await query(
        "MATCH (s:System {storageId: $storageId}) SET s.summary = $summary;",
        { storageId: publicNodeStorageId(scope.generation, systemId), summary }
      );
    },

    async upsertFile(file: FileNode, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("File", file.id, {
        repoId: file.repoId,
        path: file.path,
        directory: file.directory,
        language: file.language,
        hash: file.hash,
        loc: file.loc,
        batchId: file.batchId ?? "",
        indexedAt: file.indexedAt ?? "",
        active: file.active ?? true
      }, scope);
    },

    async upsertFilesBatch(files: FileNode[], scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNodes("File", files.map((file) => ({ id: file.id, properties: {
        repoId: file.repoId,
        path: file.path,
        directory: file.directory,
        language: file.language,
        hash: file.hash,
        loc: file.loc,
        batchId: file.batchId ?? "",
        indexedAt: file.indexedAt ?? "",
        active: file.active ?? true
      } })), scope);
    },

    async upsertCode(code: CodeSymbol, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("Code", code.id, {
        repoId: code.repoId,
        fileId: code.fileId,
        kind: code.kind,
        name: code.name,
        qualifiedName: code.qualifiedName,
        startLine: code.startLine,
        endLine: code.endLine,
        signature: code.signature,
        summary: code.summary ?? "",
        hash: code.hash,
        batchId: code.batchId ?? "",
        indexedAt: code.indexedAt ?? "",
        active: code.active ?? true
      }, scope);
    },

    async upsertCodeBatch(codes: CodeSymbol[], scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNodes("Code", codes.map((code) => ({ id: code.id, properties: {
        repoId: code.repoId,
        fileId: code.fileId,
        kind: code.kind,
        name: code.name,
        qualifiedName: code.qualifiedName,
        startLine: code.startLine,
        endLine: code.endLine,
        signature: code.signature,
        summary: code.summary ?? "",
        hash: code.hash,
        batchId: code.batchId ?? "",
        indexedAt: code.indexedAt ?? "",
        active: code.active ?? true
      } })), scope);
    },

    async upsertSection(section: DocSection, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("Section", section.id, {
        repoId: section.repoId,
        fileId: section.fileId,
        heading: section.heading,
        level: section.level,
        startLine: section.startLine,
        endLine: section.endLine,
        text: section.text,
        summary: section.summary ?? "",
        hash: section.hash,
        batchId: section.batchId ?? "",
        indexedAt: section.indexedAt ?? "",
        active: section.active ?? true
      }, scope);
    },

    async upsertEntity(entity: EntityNode, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("Entity", entity.id, asGraphProperties(entity), scope);
    },

    async upsertOperation(operation: OperationNode, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("Operation", operation.id, asGraphProperties(operation), scope);
    },

    async upsertWorkflow(workflow: WorkflowNode, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("Workflow", workflow.id, asGraphProperties(workflow), scope);
    },

    async upsertContract(contract: ContractNode, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("Contract", contract.id, asGraphProperties(contract), scope);
    },

    async upsertEvidence(evidence: EvidenceNode, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("Evidence", evidence.id, {
        ...asGraphProperties(evidence),
        batchId: evidence.batchId ?? "",
        indexedAt: evidence.indexedAt ?? "",
        active: evidence.active ?? true
      }, scope);
    },

    async addRepoContract(edge: RepoContractEdge, scope: PublicGraphGenerationScope): Promise<void> {
      const relationshipType = edge.role === "owner"
        ? "OWNS_PACKAGE"
        : edge.role === "producer"
          ? "PRODUCES"
          : edge.role === "consumer"
            ? "CONSUMES"
            : "SHARES_CONTRACT";
      await writeRelation({
        relationshipType,
        fromLabel: "Repo",
        toLabel: "Contract",
        fromId: edge.repoId,
        toId: edge.contractId,
        mergeProperties: { evidenceId: edge.evidenceId },
        setProperties: {
          confidence: edge.confidence,
          batchId: edge.batchId ?? "",
          active: edge.active ?? true
        }
      }, scope);
    },

    async addRepoDependency(edge: RepoDependencyEdge, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({
        relationshipType: "DEPENDS_ON",
        fromLabel: "Repo",
        toLabel: "Repo",
        fromId: edge.fromRepoId,
        toId: edge.toRepoId,
        mergeProperties: {
          dependencyType: edge.dependencyType,
          sourceContractId: edge.sourceContractId,
          targetContractId: edge.targetContractId,
          evidenceId: edge.evidenceId
        },
        setProperties: {
          raw: edge.raw,
          confidence: edge.confidence,
          batchId: edge.batchId ?? "",
          active: edge.active ?? true
        }
      }, scope);
    },

    async addRepoDependenciesBatch(edges: RepoDependencyEdge[], scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelations({
        relationshipType: "DEPENDS_ON",
        fromLabel: "Repo",
        toLabel: "Repo",
        mergePropertyNames: ["dependencyType", "sourceContractId", "targetContractId", "evidenceId"],
        setPropertyNames: ["raw", "confidence", "batchId", "active"],
        rows: edges.map((edge) => ({
          fromId: edge.fromRepoId,
          toId: edge.toRepoId,
          mergeProperties: {
            dependencyType: edge.dependencyType,
            sourceContractId: edge.sourceContractId,
            targetContractId: edge.targetContractId,
            evidenceId: edge.evidenceId
          },
          setProperties: {
            raw: edge.raw,
            confidence: edge.confidence,
            batchId: edge.batchId ?? "",
            active: edge.active ?? true
          }
        }))
      }, scope);
    },

    async addPackageUsage(edge: PackageUsageEdge, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({
        relationshipType: "USES_PACKAGE",
        fromLabel: "Repo",
        toLabel: "Contract",
        fromId: edge.repoId,
        toId: edge.packageContractId,
        mergeProperties: {
          packageName: edge.packageName,
          evidenceId: edge.evidenceId,
          raw: edge.raw
        },
        setProperties: {
          confidence: edge.confidence,
          batchId: edge.batchId ?? "",
          active: edge.active ?? true
        }
      }, scope);
    },

    async addContractEntity(edge: ContractEntityEdge, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({
        relationshipType: "CONTRACT_MENTIONS",
        fromLabel: "Contract",
        toLabel: "Entity",
        fromId: edge.contractId,
        toId: edge.entityId,
        mergeProperties: { evidenceId: edge.evidenceId },
        setProperties: { confidence: edge.confidence, batchId: edge.batchId ?? "", active: edge.active ?? true }
      }, scope);
    },

    async addOperationRepo(edge: OperationRepoEdge, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({
        relationshipType: "PARTICIPATES_IN",
        fromLabel: "Repo",
        toLabel: "Operation",
        fromId: edge.repoId,
        toId: edge.operationId,
        mergeProperties: { role: edge.role, evidenceId: edge.evidenceId },
        setProperties: { confidence: edge.confidence, batchId: edge.batchId ?? "", active: edge.active ?? true }
      }, scope);
    },

    async addWorkflowOperation(edge: WorkflowOperationEdge, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({
        relationshipType: "WORKFLOW_STEP",
        fromLabel: "Workflow",
        toLabel: "Operation",
        fromId: edge.workflowId,
        toId: edge.operationId,
        mergeProperties: { step: edge.step, evidenceId: edge.evidenceId },
        setProperties: { confidence: edge.confidence, batchId: edge.batchId ?? "", active: edge.active ?? true }
      }, scope);
    },

    async upsertContractSpec(spec: ContractSpecNode, scope: PublicGraphGenerationScope): Promise<void> {
      await upsertNode("ContractSpec", spec.id, {
        ...asGraphProperties(spec),
        sourceSymbolId: spec.sourceSymbolId ?? "",
        httpMethod: spec.httpMethod ?? "",
        pathTemplate: spec.pathTemplate ?? "",
        eventTopic: spec.eventTopic ?? "",
        framework: spec.framework ?? "",
        version: spec.version ?? "",
        batchId: spec.batchId ?? "",
        indexedAt: spec.indexedAt ?? "",
        active: spec.active ?? true
      }, scope);
    },

    async addHasSpec(edge: ContractSpecEdge, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({
        relationshipType: "HAS_SPEC",
        fromLabel: "Contract",
        toLabel: "ContractSpec",
        fromId: edge.contractId,
        toId: edge.specId,
        mergeProperties: { evidenceId: edge.evidenceId },
        setProperties: { confidence: edge.confidence, batchId: edge.batchId ?? "", active: edge.active ?? true }
      }, scope);
    },

    async addSemanticRelation(edge: SemanticRelationEdge, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({
        relationshipType: "SEMANTIC_REL",
        fromLabel: "ContractSpec",
        toLabel: "ContractSpec",
        fromId: edge.fromSpecId,
        toId: edge.toSpecId,
        mergeProperties: { kind: edge.kind },
        setProperties: {
          evidenceId: edge.evidenceId,
          reason: edge.reason,
          confidence: edge.confidence,
          batchId: edge.batchId ?? "",
          active: edge.active ?? true
        }
      }, scope);
    },

    async addSemanticRelationsBatch(edges: SemanticRelationEdge[], scope: PublicGraphGenerationScope): Promise<void> {
      const logicalRelations = collapseSemanticRelations(edges);
      await writeRelations({
        relationshipType: "SEMANTIC_REL",
        fromLabel: "ContractSpec",
        toLabel: "ContractSpec",
        mergePropertyNames: ["kind"],
        setPropertyNames: ["evidenceId", "reason", "confidence", "batchId", "active"],
        rows: logicalRelations.map((edge) => ({
          fromId: edge.fromSpecId,
          toId: edge.toSpecId,
          mergeProperties: { kind: edge.kind },
          setProperties: {
            evidenceId: edge.evidenceId,
            reason: edge.reason,
            confidence: edge.confidence,
            batchId: edge.batchId ?? "",
            active: edge.active ?? true
          }
        }))
      }, scope);
    },

    async clearSemanticRelationsForSpecs(specIds: string[], scope: PublicGraphGenerationScope): Promise<void> {
      if (specIds.length === 0) return;
      await query(
        `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
         WHERE a.workspaceId = $workspaceId AND a.generation = $generation
           AND b.workspaceId = $workspaceId AND b.generation = $generation
           AND r.workspaceId = $workspaceId AND r.generation = $generation
           AND (a.id IN $specIds OR b.id IN $specIds)
         DELETE r;`,
        { ...publicRelationshipScopeParams(scope), specIds }
      );
    },

    async addContractEvidence(contractId: string, evidenceId: string, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({ relationshipType: "HAS_EVIDENCE", fromLabel: "Contract", toLabel: "Evidence", fromId: contractId, toId: evidenceId }, scope);
    },

    async addRepoEvidence(repoId: string, evidenceId: string, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({ relationshipType: "HAS_EVIDENCE", fromLabel: "Repo", toLabel: "Evidence", fromId: repoId, toId: evidenceId }, scope);
    },

    addContains,

    async addImport(edge: ImportEdge, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({
        relationshipType: "IMPORTS",
        fromLabel: "File",
        toLabel: "File",
        fromId: edge.fromFileId,
        toId: edge.toFileId,
        mergeProperties: { module: edge.module },
        setProperties: { raw: edge.raw, batchId: edge.batchId ?? "", active: edge.active ?? true }
      }, scope);
    },

    async addImportsBatch(edges: ImportEdge[], scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelations({
        relationshipType: "IMPORTS",
        fromLabel: "File",
        toLabel: "File",
        mergePropertyNames: ["module"],
        setPropertyNames: ["raw", "batchId", "active"],
        rows: edges.map((edge) => ({
          fromId: edge.fromFileId,
          toId: edge.toFileId,
          mergeProperties: { module: edge.module },
          setProperties: { raw: edge.raw, batchId: edge.batchId ?? "", active: edge.active ?? true }
        }))
      }, scope);
    },

    async addCall(edge: CallEdge, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({
        relationshipType: "CALLS",
        fromLabel: "Code",
        toLabel: "Code",
        fromId: edge.fromCodeId,
        toId: edge.toCodeId,
        mergeProperties: { raw: edge.raw },
        setProperties: {
          confidence: edge.confidence,
          resolution: edge.resolution ?? "",
          batchId: edge.batchId ?? "",
          active: edge.active ?? true
        }
      }, scope);
    },

    async addCallsBatch(edges: CallEdge[], scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelations({
        relationshipType: "CALLS",
        fromLabel: "Code",
        toLabel: "Code",
        mergePropertyNames: ["raw"],
        setPropertyNames: ["confidence", "resolution", "batchId", "active"],
        rows: edges.map((edge) => ({
          fromId: edge.fromCodeId,
          toId: edge.toCodeId,
          mergeProperties: { raw: edge.raw },
          setProperties: {
            confidence: edge.confidence,
            resolution: edge.resolution ?? "",
            batchId: edge.batchId ?? "",
            active: edge.active ?? true
          }
        }))
      }, scope);
    },

    async addMention(codeId: string, entityId: string, confidence: number, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({ relationshipType: "MENTIONS", fromLabel: "Code", toLabel: "Entity", fromId: codeId, toId: entityId, mergeProperties: { confidence } }, scope);
    },

    async addSectionMention(sectionId: string, entityId: string, confidence: number, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({ relationshipType: "MENTIONS", fromLabel: "Section", toLabel: "Entity", fromId: sectionId, toId: entityId, mergeProperties: { confidence } }, scope);
    },

    async addSectionDescribesRepo(sectionId: string, repoId: string, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({ relationshipType: "DESCRIBES", fromLabel: "Section", toLabel: "Repo", fromId: sectionId, toId: repoId }, scope);
    },

    async addSectionDocumentsCode(sectionId: string, codeId: string, confidence: number, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({ relationshipType: "DOCUMENTS", fromLabel: "Section", toLabel: "Code", fromId: sectionId, toId: codeId, setProperties: { confidence } }, scope);
    },

    async addSectionReferencesFile(sectionId: string, fileId: string, raw: string, scope: PublicGraphGenerationScope): Promise<void> {
      await writeRelation({ relationshipType: "REFERENCES", fromLabel: "Section", toLabel: "File", fromId: sectionId, toId: fileId, mergeProperties: { raw } }, scope);
    },

    async clearRepoDependencies(repoIds: string[] | undefined, scope: PublicGraphGenerationScope): Promise<void> {
      const scoped = "a.workspaceId = $workspaceId AND a.generation = $generation AND b.workspaceId = $workspaceId AND b.generation = $generation AND r.workspaceId = $workspaceId AND r.generation = $generation";
      if (repoIds && repoIds.length > 0) {
        await query(
          `MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo) WHERE ${scoped} AND (a.id IN $repoIds OR b.id IN $repoIds) DELETE r;`,
          { ...publicRelationshipScopeParams(scope), repoIds }
        );
        return;
      }
      await query(
        `MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo) WHERE ${scoped} DELETE r;`,
        publicRelationshipScopeParams(scope)
      );
    },

    async clearRepoDependenciesForContracts(contractIds: string[], scope: PublicGraphGenerationScope): Promise<void> {
      if (contractIds.length === 0) return;
      await query(
        `MATCH (a:Repo)-[r:DEPENDS_ON]->(b:Repo)
         WHERE a.workspaceId = $workspaceId AND a.generation = $generation
           AND b.workspaceId = $workspaceId AND b.generation = $generation
           AND r.workspaceId = $workspaceId AND r.generation = $generation
           AND (r.sourceContractId IN $contractIds OR r.targetContractId IN $contractIds)
         DELETE r;`,
        { ...publicRelationshipScopeParams(scope), contractIds }
      );
    },

    async upsertIndexState(state: { repoId: string; repoName: string; lastBatchId: string; lastIndexedAt: string; lastCommitSha: string; filesScanned: number; filesChanged: number; filesStale: number; status: string; error?: string; graphWriteAtomicity?: GraphWriteAtomicityMode; graphWriteStatus?: GraphWriteBatchStatus; lexicalDocumentCount?: number; lexicalIndexSizeBytes?: number; lexicalProjectionSchemaVersion?: string; lexicalTokenizerVersion?: string; lexicalIndexStatus?: string; lexicalProjectionDurationMs?: number; lexicalWriteDurationMs?: number }): Promise<void> {
      await query(
        "MERGE (s:IndexState {id: $id}) ON CREATE SET s.repoId=$repoId, s.repoName=$repoName, s.lastBatchId=$lastBatchId, s.lastIndexedAt=$lastIndexedAt, s.lastCommitSha=$lastCommitSha, s.filesScanned=$filesScanned, s.filesChanged=$filesChanged, s.filesStale=$filesStale, s.status=$status, s.error=$error, s.graphWriteAtomicity=$graphWriteAtomicity, s.graphWriteStatus=$graphWriteStatus, s.lexicalDocumentCount=$lexicalDocumentCount, s.lexicalIndexSizeBytes=$lexicalIndexSizeBytes, s.lexicalProjectionSchemaVersion=$lexicalProjectionSchemaVersion, s.lexicalTokenizerVersion=$lexicalTokenizerVersion, s.lexicalIndexStatus=$lexicalIndexStatus, s.lexicalProjectionDurationMs=$lexicalProjectionDurationMs, s.lexicalWriteDurationMs=$lexicalWriteDurationMs ON MATCH SET s.repoId=$repoId, s.repoName=$repoName, s.lastBatchId=$lastBatchId, s.lastIndexedAt=$lastIndexedAt, s.lastCommitSha=$lastCommitSha, s.filesScanned=$filesScanned, s.filesChanged=$filesChanged, s.filesStale=$filesStale, s.status=$status, s.error=$error, s.graphWriteAtomicity=$graphWriteAtomicity, s.graphWriteStatus=$graphWriteStatus, s.lexicalDocumentCount=CASE WHEN $lexicalDocumentCount IS NULL THEN s.lexicalDocumentCount ELSE $lexicalDocumentCount END, s.lexicalIndexSizeBytes=CASE WHEN $lexicalIndexSizeBytes IS NULL THEN s.lexicalIndexSizeBytes ELSE $lexicalIndexSizeBytes END, s.lexicalProjectionSchemaVersion=CASE WHEN $lexicalProjectionSchemaVersion IS NULL THEN s.lexicalProjectionSchemaVersion ELSE $lexicalProjectionSchemaVersion END, s.lexicalTokenizerVersion=CASE WHEN $lexicalTokenizerVersion IS NULL THEN s.lexicalTokenizerVersion ELSE $lexicalTokenizerVersion END, s.lexicalIndexStatus=CASE WHEN $lexicalIndexStatus IS NULL THEN s.lexicalIndexStatus ELSE $lexicalIndexStatus END, s.lexicalProjectionDurationMs=CASE WHEN $lexicalProjectionDurationMs IS NULL THEN s.lexicalProjectionDurationMs ELSE $lexicalProjectionDurationMs END, s.lexicalWriteDurationMs=CASE WHEN $lexicalWriteDurationMs IS NULL THEN s.lexicalWriteDurationMs ELSE $lexicalWriteDurationMs END;",
        { id: `index-state:${state.repoId}`, ...state, error: state.error ?? "", graphWriteAtomicity: state.graphWriteAtomicity ?? "", graphWriteStatus: state.graphWriteStatus ?? "", lexicalDocumentCount: state.lexicalDocumentCount ?? null, lexicalIndexSizeBytes: state.lexicalIndexSizeBytes ?? null, lexicalProjectionSchemaVersion: state.lexicalProjectionSchemaVersion ?? null, lexicalTokenizerVersion: state.lexicalTokenizerVersion ?? null, lexicalIndexStatus: state.lexicalIndexStatus ?? null, lexicalProjectionDurationMs: state.lexicalProjectionDurationMs ?? null, lexicalWriteDurationMs: state.lexicalWriteDurationMs ?? null } as unknown as Record<string, GraphValue>
      );
    },

    async knownFileHashes(repoId: string, scope: PublicGraphGenerationScope): Promise<Map<string, string>> {
      const rows = await query<{ id: string; hash: string }>(
        "MATCH (f:File) WHERE f.workspaceId = $workspaceId AND f.generation = $generation AND f.repoId = $repoId RETURN f.id AS id, f.hash AS hash;",
        { ...publicRelationshipScopeParams(scope), repoId }
      );
      return new Map(rows.map((row) => [row.id, row.hash]));
    },

    async repoCount(scope: PublicGraphGenerationScope): Promise<number> {
      const rows = await query<{ count: number }>(
        "MATCH (r:Repo) WHERE r.workspaceId = $workspaceId AND r.generation = $generation RETURN count(r) AS count;",
        publicRelationshipScopeParams(scope)
      );
      return Number(rows[0]?.count ?? 0);
    },

    async listRepos(scope: PublicGraphGenerationScope): Promise<RepoNode[]> {
      return query<RepoNode>(
        "MATCH (r:Repo) WHERE r.workspaceId = $workspaceId AND r.generation = $generation RETURN r.id AS id, r.name AS name, r.path AS path, r.remoteUrl AS remoteUrl, r.branch AS branch, r.commitSha AS commitSha, r.language AS language, r.indexedAt AS indexedAt, r.summary AS summary;",
        publicRelationshipScopeParams(scope)
      );
    },

    async listActiveAliasOverrides(): Promise<ActiveAliasOverride[]> {
      return query<ActiveAliasOverride>(
        "MATCH (a:AliasOverride) WHERE a.active IS NULL OR a.active = true RETURN a.alias AS alias, a.targetRepoId AS targetRepoId;"
      );
    },

    readPublicGraphStats,
    computePublicGraphStats,
    initializePublicGraphStats,
    applyPublicGraphStatsDelta,

    async stats(scope: PublicGraphGenerationScope): Promise<Stats> {
      const stored = await readPublicGraphStats(scope);
      if (!stored) {
        throw new Error(
          "Public graph stats metadata is missing; clean generated graph/internal/lexical artifacts and run a full reindex."
        );
      }
      return stored;
    }
  };
}
