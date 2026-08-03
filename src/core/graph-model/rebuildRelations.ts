import { buildRepoDependenciesFromParticipants, materializeDependenciesFromSemanticRelations, type ContractParticipant } from "../contracts/extraction/crossRepoContracts.js";
import type { ContractKind, ContractNode, ContractRole, ContractSpecNode, EvidenceNode, RepoContractEdge, RepoDependencyEdge, SemanticRelationEdge } from "../parsing/types.js";
import { isKnownSpecKind } from "../parsing/types.js";
import type { GraphDB, GraphValue } from "./db.js";
import { mergeAndDedupeDeps } from "../contracts/depsMerge.js";
import { resolveSemanticRelations } from "../contracts/resolver.js";
import {
  SEMANTIC_REL_RETURN,
  SPEC_RETURN,
  rowToContractSpec,
  rowToSemanticRel,
  type SemanticRelRow,
  type SpecRow
} from "../contracts/specRows.js";
import type { PublicGraphGenerationScope } from "./publicGraphGeneration.js";
import type { GraphFactsBatch } from "./facts.js";
import { collapseSemanticRelations, semanticRelationDedupKey } from "../contracts/extraction/dedup.js";

type ParticipantRow = {
  repoId: string;
  contractId: string;
  role: ContractRole;
  evidenceId: string;
  confidence: number;
  kind: ContractKind;
  key: string;
  name: string;
  description: string;
  evidenceRepoId: string;
  fileId: string;
  filePath: string;
  line: number;
  raw: string;
  rule: string;
  evidenceConfidence: number;
};

export type RebuildRepoDependenciesLogger = {
  log?: (message: string) => void;
  createProgressBar?: (label: string, total: number) => any;
};

function toContractParticipants(rows: ParticipantRow[]): ContractParticipant[] {
  return rows.map((row) => ({
    repoId: row.repoId,
    contractId: row.contractId,
    role: row.role,
    evidenceId: row.evidenceId,
    confidence: row.confidence,
    contract: {
      id: row.contractId,
      kind: row.kind,
      key: row.key,
      name: row.name,
      description: row.description
    },
    evidence: {
      id: row.evidenceId,
      repoId: row.evidenceRepoId,
      fileId: row.fileId,
      filePath: row.filePath,
      line: row.line,
      raw: row.raw,
      rule: row.rule,
      confidence: row.evidenceConfidence
    }
  }));
}

function activeParticipantWhere(extra?: string): string {
  return [
    "edge.evidenceId = e.id",
    "r.workspaceId = $workspaceId",
    "c.workspaceId = $workspaceId",
    "e.workspaceId = $workspaceId",
    "edge.workspaceId = $workspaceId",
    "proof.workspaceId = $workspaceId",
    "r.generation = $generation",
    "c.generation = $generation",
    "e.generation = $generation",
    "edge.generation = $generation",
    "proof.generation = $generation",
    "(edge.active IS NULL OR edge.active = true)",
    "(e.active IS NULL OR e.active = true)",
    extra
  ].filter(Boolean).join(" AND ");
}

async function roleRows(db: GraphDB, scope: PublicGraphGenerationScope, rel: string, role: ContractRole, extraWhere?: string, params: Record<string, GraphValue> = {}): Promise<ParticipantRow[]> {
  return db.query<ParticipantRow>(
    `MATCH (r:Repo)-[edge:${rel}]->(c:Contract)-[proof:HAS_EVIDENCE]->(e:Evidence)
     WHERE ${activeParticipantWhere(extraWhere)}
     RETURN r.id AS repoId, c.id AS contractId, '${role}' AS role, edge.evidenceId AS evidenceId, edge.confidence AS confidence,
            c.kind AS kind, c.key AS key, c.name AS name, c.description AS description,
            e.repoId AS evidenceRepoId, e.fileId AS fileId, e.filePath AS filePath, e.line AS line,
            e.raw AS raw, e.rule AS rule, e.confidence AS evidenceConfidence;`,
    { ...params, ...scope }
  );
}

async function participantRows(db: GraphDB, scope: PublicGraphGenerationScope, extraWhere?: string, params: Record<string, GraphValue> = {}): Promise<ParticipantRow[]> {
  const roles: ContractRole[] = ["owner", "producer", "consumer", "shared"];
  const rels = ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT"];
  
  const promises = rels.map((rel, i) => roleRows(db, scope, rel, roles[i]!, extraWhere, params));
  const results = await Promise.all(promises);
  return results.flat();
}

export async function loadContractParticipants(db: GraphDB, scope: PublicGraphGenerationScope): Promise<ContractParticipant[]> {
  return toContractParticipants(await participantRows(db, scope));
}

export async function loadContractParticipantsForRepos(db: GraphDB, repoIds: string[], scope: PublicGraphGenerationScope): Promise<ContractParticipant[]> {
  if (repoIds.length === 0) return [];
  return toContractParticipants(await participantRows(db, scope, "r.id IN $repoIds", { repoIds }));
}

export async function loadContractParticipantsForContracts(db: GraphDB, contractIds: string[], scope: PublicGraphGenerationScope): Promise<ContractParticipant[]> {
  if (contractIds.length === 0) return [];
  return toContractParticipants(await participantRows(db, scope, "c.id IN $contractIds", { contractIds }));
}

// ---------------------------------------------------------------------------
// Phase 4.1: Cross-repo SEMANTIC_REL resolution for dependency materialization
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers for scoped candidate loading
// ---------------------------------------------------------------------------

/** Extracts the first non-template path segment as a bucket key. */
export function bucketKey(pathTemplate: string): string {
  const trimmed = pathTemplate.replace(/\/$/, "") || "/";
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const first = segments[0]!;
  if (/^\{.+\}$/.test(first)) return "*";
  return `/${first}`;
}

/**
 * Builds `s.repoId <> $p0 AND s.repoId <> $p1 ...` clauses and populates
 * params with the corresponding values.  Kuzu doesn't support NOT IN, so
 * each excluded repo gets its own parameter.
 */
export function buildExclusionClauses(
  repoIds: string[],
  paramPrefix: string
): { clauses: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const clauses = repoIds.map((id, i) => {
    const key = `${paramPrefix}${i}`;
    params[key] = id;
    return `s.repoId <> $${key}`;
  }).join(" AND ");
  return { clauses, params };
}

// ---------------------------------------------------------------------------
// Phase 4.1: Cross-repo SEMANTIC_REL resolution for dependency materialization
// ---------------------------------------------------------------------------

/**
 * Resolves SEMANTIC_REL edges (protocol-specific CALLS_*, INTERNAL_CALL, REQUEST_SCHEMA,
 * RESPONSE_SCHEMA, etc.) with cross-repo visibility and writes them
 * back to the graph so the downstream dependency materialization can consume
 * them.
 *
 * When {@link targetRepoIds} is provided, only loads the ContractSpecs and
 * role edges that are relevant to those target repos — anchor on the target,
 * query distant candidates by bucket/topic, feed only the candidate set to
 * the resolver.  This avoids pulling the entire graph into memory when a
 * single repo is added or rebuilt.
 *
 * Must run AFTER all repos have been indexed (so all ContractSpecs and
 * repo→contract role edges are present), and BEFORE
 * {@link loadSemanticRelations} (which reads SEMANTIC_REL from the graph).
 */
async function resolveAndWriteSemanticRelations(
  db: GraphDB,
  scope: PublicGraphGenerationScope,
  targetRepoIds?: Set<string>
): Promise<void> {
  const scoped = targetRepoIds !== undefined && targetRepoIds.size > 0;
  const repoIdsArray = scoped ? [...targetRepoIds!] : [];

  // ------------------------------------------------------------------
  // Step 1: Load target repo ContractSpecs
  // ------------------------------------------------------------------
  const targetSpecRows = scoped
    ? await db.query<SpecRow>(
        `MATCH (s:ContractSpec)
         WHERE s.workspaceId = $workspaceId AND s.generation = $generation
           AND (s.active IS NULL OR s.active = true)
           AND s.repoId IN $repoIds
         RETURN ${SPEC_RETURN}`,
        { ...scope, repoIds: repoIdsArray }
      )
    : await db.query<SpecRow>(
        `MATCH (s:ContractSpec)
         WHERE s.workspaceId = $workspaceId AND s.generation = $generation
           AND (s.active IS NULL OR s.active = true)
         RETURN ${SPEC_RETURN}`,
        scope
      );
  const targetSpecs = targetSpecRows.filter((row) => isKnownSpecKind(row.specKind)).map(rowToContractSpec);
  if (targetSpecs.length === 0) return;

  // Always load all schema specs — negligible count even at scale.
  const schemaRows = await db.query<SpecRow>(
    `MATCH (s:ContractSpec)
     WHERE s.workspaceId = $workspaceId AND s.generation = $generation
       AND s.specKind = 'schema'
       AND (s.active IS NULL OR s.active = true)
     RETURN ${SPEC_RETURN}`,
    scope
  );
  const schemaSpecs = schemaRows.map(rowToContractSpec);

  let contractSpecs: ContractSpecNode[];
  let specRepoMap: Map<string, string>;
  let repoContracts: RepoContractEdge[];
  let existingSemanticRelations: SemanticRelationEdge[];

  if (!scoped) {
    // ------------------------------------------------------------------
    // Full rebuild: load everything (no candidate pre-filtering needed).
    // ------------------------------------------------------------------
    contractSpecs = [...targetSpecs, ...schemaSpecs];
    // Deduplicate by id
    const dedup = new Map<string, ContractSpecNode>();
    for (const s of contractSpecs) dedup.set(s.id, s);
    contractSpecs = [...dedup.values()];
    specRepoMap = new Map(contractSpecs.map((s) => [s.id, s.repoId]));

    const participantRowsAll = await participantRows(db, scope);
    repoContracts = participantRowsAll.map((row) => ({
      repoId: row.repoId,
      contractId: row.contractId,
      role: row.role,
      evidenceId: row.evidenceId,
      confidence: row.confidence
    }));

    const semanticRelRows = await db.query<SemanticRelRow>(
      `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
       WHERE a.workspaceId = $workspaceId AND b.workspaceId = $workspaceId AND r.workspaceId = $workspaceId
         AND a.generation = $generation AND b.generation = $generation AND r.generation = $generation
         AND (r.active IS NULL OR r.active = true)
       RETURN ${SEMANTIC_REL_RETURN}`,
      scope
    );
    existingSemanticRelations = semanticRelRows.map(rowToSemanticRel);
  } else {
    // ------------------------------------------------------------------
    // Scoped rebuild: anchor on target repos, query only distant
    // candidates that could plausibly match.
    // ------------------------------------------------------------------

    // Step 2: Extract candidate keys from target HTTP & event specs.
    const httpBuckets = new Set<string>();
    const eventTopics = new Set<string>();
    let hasWildcardHttp = false;

    for (const spec of targetSpecs) {
      if (spec.specKind === "http-endpoint" && spec.pathTemplate) {
        const bk = bucketKey(spec.pathTemplate);
        httpBuckets.add(bk);
        if (bk === "*") hasWildcardHttp = true;
      }
      if (spec.specKind === "event" && spec.eventTopic) {
        eventTopics.add(spec.eventTopic);
      }
    }

    // Build repo exclusion clauses (reused across HTTP / event queries).
    const { clauses: excludeClauses, params: excludeParams } =
      buildExclusionClauses(repoIdsArray, "exclude");

    // Step 3: Load candidate HTTP specs.
    // If the target has ANY wildcard-first-path specs (bucket "*"), the
    // httpResolver matches them against ALL other buckets — so we must
    // fall back to loading every http-endpoint spec to avoid false
    // negatives (see httpResolver.ts:248-275 cross-bucket matching).
    let candidateHttpSpecs: ContractSpecNode[] = [];
    if (hasWildcardHttp) {
      // Fallback: load ALL http-endpoint specs from other repos.
      const allHttpParams: Record<string, GraphValue> = { ...scope, ...excludeParams };
      const allHttpRows = await db.query<SpecRow>(
        `MATCH (s:ContractSpec)
         WHERE s.workspaceId = $workspaceId AND s.generation = $generation
           AND s.specKind = 'http-endpoint'
           AND (s.active IS NULL OR s.active = true)
           AND ${excludeClauses}
         RETURN ${SPEC_RETURN}`,
        allHttpParams
      );
      candidateHttpSpecs = allHttpRows.map(rowToContractSpec);
    } else if (httpBuckets.size > 0) {
      // Bucket-scoped: build parameterized STARTS-WITH / = conditions.
      const prefixConditions: string[] = [];
      const prefixParams: Record<string, unknown> = {};
      let prefixIdx = 0;

      for (const bucket of httpBuckets) {
        if (bucket === "/") {
          const k0 = `p${prefixIdx++}`; prefixParams[k0] = "";
          const k1 = `p${prefixIdx++}`; prefixParams[k1] = "/";
          prefixConditions.push(`s.pathTemplate = $${k0}`, `s.pathTemplate = $${k1}`);
        } else if (bucket === "*") {
          const k = `p${prefixIdx++}`; prefixParams[k] = "/{";
          prefixConditions.push(`s.pathTemplate STARTS WITH $${k}`);
        } else {
          const k0 = `p${prefixIdx++}`; prefixParams[k0] = `${bucket}/`;
          const k1 = `p${prefixIdx++}`; prefixParams[k1] = bucket;
          prefixConditions.push(`s.pathTemplate STARTS WITH $${k0}`, `s.pathTemplate = $${k1}`);
        }
      }
      // Always pull in wildcard bucket for cross-bucket template matching
      // (concrete-target ↔ wildcard-distant, see httpResolver.ts:217).
      // The enclosing else-if branch guarantees hasWildcardHttp === false,
      // so httpBuckets cannot contain "*" — this condition is always true.
      const kw = `p${prefixIdx++}`; prefixParams[kw] = "/{";
      prefixConditions.push(`s.pathTemplate STARTS WITH $${kw}`);

      const httpParams: Record<string, GraphValue> = { ...scope, ...excludeParams, ...prefixParams as Record<string, GraphValue> };
      const httpCandidateRows = await db.query<SpecRow>(
        `MATCH (s:ContractSpec)
         WHERE s.workspaceId = $workspaceId AND s.generation = $generation
           AND s.specKind = 'http-endpoint'
           AND (s.active IS NULL OR s.active = true)
           AND ${excludeClauses}
           AND (${prefixConditions.join(" OR ")})
         RETURN ${SPEC_RETURN}`,
        httpParams
      );
      candidateHttpSpecs = httpCandidateRows.map(rowToContractSpec);
    }

    // Step 4: Load candidate event specs — same topic, different repos.
    let candidateEventSpecs: ContractSpecNode[] = [];
    if (eventTopics.size > 0) {
      const evParams: Record<string, GraphValue> = { ...scope, ...excludeParams, topics: [...eventTopics] };
      const eventCandidateRows = await db.query<SpecRow>(
        `MATCH (s:ContractSpec)
         WHERE s.workspaceId = $workspaceId AND s.generation = $generation
           AND s.specKind = 'event'
           AND (s.active IS NULL OR s.active = true)
           AND ${excludeClauses}
           AND s.eventTopic IN $topics
         RETURN ${SPEC_RETURN}`,
        evParams
      );
      candidateEventSpecs = eventCandidateRows.map(rowToContractSpec);
    }

    // Step 5: Combine and deduplicate.
    const dedup = new Map<string, ContractSpecNode>();
    for (const s of targetSpecs) dedup.set(s.id, s);
    for (const s of candidateHttpSpecs) dedup.set(s.id, s);
    for (const s of candidateEventSpecs) dedup.set(s.id, s);
    for (const s of schemaSpecs) dedup.set(s.id, s);
    contractSpecs = [...dedup.values()];
    specRepoMap = new Map(contractSpecs.map((s) => [s.id, s.repoId]));

    // Step 6: Load repo→contract roles only for involved contractIds.
    const contractIds = [...new Set(contractSpecs.map((s) => s.contractId))];
    const scopedParticipantRows = contractIds.length > 0
      ? await participantRows(db, scope, "c.id IN $contractIds", { contractIds })
      : [];
    repoContracts = scopedParticipantRows.map((row) => ({
      repoId: row.repoId,
      contractId: row.contractId,
      role: row.role,
      evidenceId: row.evidenceId,
      confidence: row.confidence
    }));

    // Step 7: Load existing SEMANTIC_REL only for involved specIds.
    const specIds = [...dedup.keys()];
    const semanticRelRows = specIds.length > 0
      ? await db.query<SemanticRelRow>(
          `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
           WHERE a.workspaceId = $workspaceId AND b.workspaceId = $workspaceId AND r.workspaceId = $workspaceId
             AND a.generation = $generation AND b.generation = $generation AND r.generation = $generation
             AND (r.active IS NULL OR r.active = true)
             AND (a.id IN $specIds OR b.id IN $specIds)
           RETURN ${SEMANTIC_REL_RETURN}`,
          { ...scope, specIds }
        )
      : [];
    existingSemanticRelations = semanticRelRows.map(rowToSemanticRel);
  }

  // ------------------------------------------------------------------
  // Run the language-independent dual-track resolver on the candidate set.
  // ------------------------------------------------------------------
  const resolvedEdges = resolveSemanticRelations({
    contractSpecs,
    repoContracts,
    existingSemanticRelations
  });

  if (resolvedEdges.length === 0) return;

  // When target repos are specified, only persist edges that involve at
  // least one of those repos.
  const eligibleEdges = scoped
    ? resolvedEdges.filter((edge) => {
        const fromRepo = specRepoMap.get(edge.fromSpecId);
        const toRepo = specRepoMap.get(edge.toSpecId);
        return (fromRepo && targetRepoIds!.has(fromRepo)) ||
               (toRepo && targetRepoIds!.has(toRepo));
      })
    : resolvedEdges;

  if (eligibleEdges.length === 0) return;

  const existingByLogicalId = new Map(existingSemanticRelations.map((edge) => [
    `${edge.fromSpecId}\0${edge.toSpecId}\0${edge.kind}`,
    edge
  ]));
  const edges: SemanticRelationEdge[] = [];
  for (const edge of eligibleEdges) {
    const existing = existingByLogicalId.get(`${edge.fromSpecId}\0${edge.toSpecId}\0${edge.kind}`);
    if (existing?.evidenceId === edge.evidenceId
      && existing.confidence === edge.confidence
      && existing.reason === edge.reason) continue;
    if (existing) {
      await db.query(
        "MATCH (a:ContractSpec {id: $fromSpecId})-[r:SEMANTIC_REL]->(b:ContractSpec {id: $toSpecId}) WHERE a.workspaceId = $workspaceId AND b.workspaceId = $workspaceId AND r.workspaceId = $workspaceId AND a.generation = $generation AND b.generation = $generation AND r.generation = $generation AND r.kind = $kind DELETE r;",
        { ...scope, fromSpecId: edge.fromSpecId, toSpecId: edge.toSpecId, kind: edge.kind }
      );
    }
    edges.push(edge);
  }

  if (edges.length === 0) return;

  // Write in 5000-edge batches.
  const batchSize = 5000;
  for (let i = 0; i < edges.length; i += batchSize) {
    const chunk = edges.slice(i, i + batchSize).map((edge) => ({
      ...edge,
      batchId: "",
      active: true
    }));
    await db.addSemanticRelationsBatch(chunk, scope);
  }
}

// ---------------------------------------------------------------------------
// Phase 4.2: SEMANTIC_REL loading for dependency materialization
// ---------------------------------------------------------------------------

async function loadSemanticRelations(db: GraphDB, scope: PublicGraphGenerationScope, repoIds?: Set<string>): Promise<{
  edges: SemanticRelationEdge[];
  specs: ContractSpecNode[];
}> {
  // Load active SEMANTIC_REL edges. When target repos are specified, only
  // load edges that involve specs in those repos (either endpoint).
  const scoped = repoIds !== undefined && repoIds.size > 0;

  const semanticRows = await db.query<SemanticRelRow>(
    scoped
      ? `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
         WHERE a.workspaceId = $workspaceId AND b.workspaceId = $workspaceId AND r.workspaceId = $workspaceId
           AND a.generation = $generation AND b.generation = $generation AND r.generation = $generation
           AND (r.active IS NULL OR r.active = true)
           AND (a.repoId IN $repoIds OR b.repoId IN $repoIds)
         RETURN ${SEMANTIC_REL_RETURN}`
      : `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
         WHERE a.workspaceId = $workspaceId AND b.workspaceId = $workspaceId AND r.workspaceId = $workspaceId
           AND a.generation = $generation AND b.generation = $generation AND r.generation = $generation
           AND (r.active IS NULL OR r.active = true)
         RETURN ${SEMANTIC_REL_RETURN}`,
    scoped ? { ...scope, repoIds: [...repoIds!] } : scope
  );

  // Collect all unique spec IDs from the edges — load ALL referenced specs
  // regardless of repo so that cross-repo peer specs are not dropped.
  const specIds = new Set<string>();
  for (const row of semanticRows) {
    specIds.add(row.fromSpecId);
    specIds.add(row.toSpecId);
  }

  if (specIds.size === 0) {
    return { edges: [], specs: [] };
  }

  const specRows = await db.query<SpecRow>(
    `MATCH (s:ContractSpec)
     WHERE s.workspaceId = $workspaceId AND s.generation = $generation
       AND s.id IN $specIds AND (s.active IS NULL OR s.active = true)
     RETURN ${SPEC_RETURN}`,
    { ...scope, specIds: [...specIds] }
  );

  return {
    edges: semanticRows.map(rowToSemanticRel),
    specs: specRows.filter((row) => isKnownSpecKind(row.specKind)).map(rowToContractSpec)
  };
}


export async function rebuildRepoDependencies(db: GraphDB, options: { scope: PublicGraphGenerationScope; repoIds?: string[]; batchId?: string; logger?: RebuildRepoDependenciesLogger }): Promise<RepoDependencyEdge[]> {
  const targetRepoIds = options.repoIds && options.repoIds.length > 0 ? new Set(options.repoIds) : undefined;

  // Phase 4.1: Resolve and write SEMANTIC_REL edges with full cross-repo
  // visibility.  This must run BEFORE Phase 4.2 so the freshly-written
  // edges are visible to loadSemanticRelations.
  await resolveAndWriteSemanticRelations(db, options.scope, targetRepoIds);

  // Phase 4.2: Materialize API + event dependencies from SEMANTIC_REL edges.
  const { edges: semanticEdges, specs } = await loadSemanticRelations(db, options.scope, targetRepoIds);
  const semanticDeps = materializeDependenciesFromSemanticRelations(semanticEdges, specs);

  // Phase 4.2: Legacy matcher runs for ALL kinds as fallback.
  // Load participants in two steps: first for target repos, then for their
  // contracts (which pulls in peer repos sharing the same contracts).
  const targetParticipants = targetRepoIds
    ? await loadContractParticipantsForRepos(db, [...targetRepoIds], options.scope)
    : undefined;
  const targetContractIds = targetParticipants
    ? [...new Set(targetParticipants.map((p) => p.contractId))]
    : undefined;
  const allParticipants = targetContractIds
    ? await loadContractParticipantsForContracts(db, targetContractIds, options.scope)
    : await loadContractParticipants(db, options.scope);
  const legacyDeps = buildRepoDependenciesFromParticipants(allParticipants, targetRepoIds);

  // Merge: semantic deps first → legacy deps fill gaps (structural dedup).
  const dependencies = mergeAndDedupeDeps(semanticDeps, legacyDeps);

  await db.clearRepoDependencies(options.repoIds, options.scope);

  const progress = options.logger?.createProgressBar?.("Rebuilding dependencies", dependencies.length);
  const batchSize = 5000;
  for (let i = 0; i < dependencies.length; i += batchSize) {
    const chunk = dependencies.slice(i, i + batchSize).map((d) => ({
      ...d,
      batchId: options.batchId ?? "",
      active: true
    }));
    await db.addRepoDependenciesBatch(chunk, options.scope);
    progress?.update(Math.min(i + batchSize, dependencies.length));
  }
  progress?.complete();

  if (targetRepoIds) {
    options.logger?.log?.(
      `Targeted dependency rebuild: repos=${targetRepoIds.size} contracts=${targetContractIds?.length ?? 0} participants=${allParticipants.length} dependencies=${dependencies.length} (semantic=${semanticDeps.length} legacy=${legacyDeps.length})`
    );
  }
  return dependencies;
}

export interface IncrementalSchemaDependencyDelta {
  upsertSpecs: readonly ContractSpecNode[];
  deleteSpecIds: readonly string[];
  upsertRelations: readonly SemanticRelationEdge[];
  deleteRelations: ReadonlyArray<Pick<SemanticRelationEdge, "fromSpecId" | "toSpecId" | "kind">>;
}

/**
 * A complete dependency replacement prepared while the active revision is
 * still immutable. The stable spec/contract IDs are selectors, not batch
 * ownership: final publication deletes only incident logical relations and
 * dependencies, then writes their already validated next values.
 */
export interface IncrementalDependencyMutation {
  affectedSpecIds: string[];
  affectedContractIds: string[];
  upsertSemanticRelations: SemanticRelationEdge[];
  upsertRepoDependencies: RepoDependencyEdge[];
}

export interface PrepareIncrementalDependencyMutationInput {
  scope: PublicGraphGenerationScope;
  batchId: string;
  affectedFileIds: readonly string[];
  graphFacts: readonly GraphFactsBatch[];
  schema: IncrementalSchemaDependencyDelta;
}

const RECOMPUTED_SEMANTIC_KINDS = new Set<SemanticRelationEdge["kind"]>([
  "CALLS_HTTP",
  "CALLS_DUBBO",
  "CALLS_GRPC",
  "CALLS_GRAPHQL",
  "INTERNAL_CALL",
  "PUBLISHES_EVENT",
  "SUBSCRIBES_EVENT"
]);

function semanticIdentity(edge: Pick<SemanticRelationEdge, "fromSpecId" | "toSpecId" | "kind">): string {
  return JSON.stringify([edge.fromSpecId, edge.toSpecId, edge.kind]);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function activeSpecWhere(extra: string): string {
  return [
    "s.workspaceId = $workspaceId",
    "s.generation = $generation",
    "(s.active IS NULL OR s.active = true)",
    extra
  ].filter(Boolean).join(" AND ");
}

async function activeSpecs(
  db: GraphDB,
  scope: PublicGraphGenerationScope,
  extra: string,
  params: Record<string, GraphValue>
): Promise<ContractSpecNode[]> {
  const rows = await db.query<SpecRow>(
    `MATCH (s:ContractSpec) WHERE ${activeSpecWhere(extra)} RETURN ${SPEC_RETURN}`,
    { ...scope, ...params }
  );
  return rows.filter((row) => isKnownSpecKind(row.specKind)).map(rowToContractSpec);
}

async function activeSemanticRelationsForSpecs(
  db: GraphDB,
  scope: PublicGraphGenerationScope,
  specIds: readonly string[]
): Promise<SemanticRelationEdge[]> {
  if (specIds.length === 0) return [];
  const rows = await db.query<SemanticRelRow>(
    `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
     WHERE a.workspaceId = $workspaceId AND a.generation = $generation
       AND b.workspaceId = $workspaceId AND b.generation = $generation
       AND r.workspaceId = $workspaceId AND r.generation = $generation
       AND (r.active IS NULL OR r.active = true)
       AND (a.id IN $specIds OR b.id IN $specIds)
     RETURN ${SEMANTIC_REL_RETURN}`,
    { ...scope, specIds: [...specIds] }
  );
  return rows.map(rowToSemanticRel);
}

async function activeEvidenceIdsForFiles(
  db: GraphDB,
  scope: PublicGraphGenerationScope,
  fileIds: readonly string[]
): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const rows = await db.query<{ id: string }>(
    `MATCH (e:Evidence)
     WHERE e.workspaceId = $workspaceId AND e.generation = $generation
       AND (e.active IS NULL OR e.active = true) AND e.fileId IN $fileIds
     RETURN e.id AS id`,
    { ...scope, fileIds: [...fileIds] }
  );
  return uniqueSorted(rows.map((row) => row.id));
}

function safeSpecJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringProperty(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** Loads only resolver buckets touched by old/new affected specs. */
async function loadResolverCandidates(
  db: GraphDB,
  scope: PublicGraphGenerationScope,
  seeds: readonly ContractSpecNode[]
): Promise<ContractSpecNode[]> {
  if (seeds.length === 0) return [];
  const results: ContractSpecNode[] = [];
  const httpBuckets = uniqueSorted(seeds
    .filter((spec) => spec.specKind === "http-endpoint")
    .map((spec) => bucketKey(spec.pathTemplate ?? spec.canonicalKey.replace(/^[A-Z]+:/u, ""))));
  if (httpBuckets.includes("*")) {
    results.push(...await activeSpecs(db, scope, "s.specKind = 'http-endpoint'", {}));
  } else if (httpBuckets.length > 0) {
    const conditions: string[] = [];
    const params: Record<string, GraphValue> = {};
    for (const [index, bucket] of [...httpBuckets, "*"].entries()) {
      const key = `httpPrefix${index}`;
      if (bucket === "/") {
        const emptyKey = `${key}Empty`;
        params[key] = "/";
        params[emptyKey] = "";
        conditions.push(`s.pathTemplate = $${key}`, `s.pathTemplate = $${emptyKey}`);
      } else if (bucket === "*") {
        params[key] = "/{";
        conditions.push(`s.pathTemplate STARTS WITH $${key}`);
      } else {
        const exactKey = `${key}Exact`;
        params[key] = `${bucket}/`;
        params[exactKey] = bucket;
        conditions.push(`s.pathTemplate STARTS WITH $${key}`, `s.pathTemplate = $${exactKey}`);
      }
    }
    results.push(...await activeSpecs(
      db,
      scope,
      `s.specKind = 'http-endpoint' AND (${conditions.join(" OR ")})`,
      params
    ));
  }

  const eventTopics = uniqueSorted(seeds
    .filter((spec) => spec.specKind === "event")
    .flatMap((spec) => spec.eventTopic ? [spec.eventTopic] : []));
  if (eventTopics.length > 0) {
    results.push(...await activeSpecs(
      db,
      scope,
      "s.specKind = 'event' AND s.eventTopic IN $eventTopics",
      { eventTopics }
    ));
  }

  const graphqlKeys = uniqueSorted(seeds
    .filter((spec) => spec.specKind === "graphql-operation")
    .map((spec) => spec.canonicalKey));
  if (graphqlKeys.length > 0) {
    results.push(...await activeSpecs(
      db,
      scope,
      "s.specKind = 'graphql-operation' AND s.canonicalKey IN $graphqlKeys",
      { graphqlKeys }
    ));
  }

  const grpcSuffixes = uniqueSorted(seeds
    .filter((spec) => spec.specKind === "grpc-method")
    .flatMap((spec) => {
      const parsed = safeSpecJson(spec.specJson);
      const service = stringProperty(parsed, "service");
      const method = stringProperty(parsed, "method");
      return service && method ? [`${service}/${method}`] : [];
    }));
  if (grpcSuffixes.length > 0) {
    const params: Record<string, GraphValue> = {};
    const conditions = grpcSuffixes.flatMap((suffix, index) => {
      const exact = `grpcExact${index}`;
      const qualified = `grpcQualified${index}`;
      params[exact] = suffix;
      params[qualified] = `.${suffix}`;
      return [`s.canonicalKey = $${exact}`, `s.canonicalKey ENDS WITH $${qualified}`];
    });
    results.push(...await activeSpecs(
      db,
      scope,
      `s.specKind = 'grpc-method' AND (${conditions.join(" OR ")})`,
      params
    ));
  }

  const dubboInterfaces = uniqueSorted(seeds
    .filter((spec) => spec.specKind === "dubbo-method")
    .flatMap((spec) => {
      const interfaceName = stringProperty(safeSpecJson(spec.specJson), "interfaceName");
      return interfaceName ? [interfaceName.replace(/\s+/gu, "").toLowerCase()] : [];
    }));
  if (dubboInterfaces.length > 0) {
    const params: Record<string, GraphValue> = {};
    const conditions = dubboInterfaces.flatMap((interfaceName, index) => {
      const exact = `dubboExact${index}`;
      const prefix = `dubboPrefix${index}`;
      params[exact] = interfaceName;
      params[prefix] = `${interfaceName}#`;
      return [`s.canonicalKey = $${exact}`, `s.canonicalKey STARTS WITH $${prefix}`];
    });
    results.push(...await activeSpecs(
      db,
      scope,
      `s.specKind = 'dubbo-method' AND (${conditions.join(" OR ")})`,
      params
    ));
  }

  const sourceSymbolIds = uniqueSorted(seeds.flatMap((spec) => spec.sourceSymbolId ? [spec.sourceSymbolId] : []));
  if (sourceSymbolIds.length > 0) {
    results.push(...await activeSpecs(db, scope, "s.sourceSymbolId IN $sourceSymbolIds", { sourceSymbolIds }));
  }
  return [...new Map(results.map((spec) => [spec.id, spec])).values()];
}

function pendingParticipants(facts: readonly GraphFactsBatch[]): ContractParticipant[] {
  const contracts = new Map<string, ContractNode>();
  const evidence = new Map<string, EvidenceNode>();
  const edges: RepoContractEdge[] = [];
  for (const batch of facts) {
    for (const node of batch.contracts) contracts.set(node.id, node);
    for (const node of batch.evidence) evidence.set(node.id, node);
    edges.push(...batch.repoContracts);
  }
  return edges.flatMap((edge) => {
    const contract = contracts.get(edge.contractId);
    const proof = evidence.get(edge.evidenceId);
    return contract && proof ? [{ ...edge, contract, evidence: proof }] : [];
  });
}

function relationOverlay(
  active: readonly SemanticRelationEdge[],
  explicit: readonly SemanticRelationEdge[],
  resolved: readonly SemanticRelationEdge[]
): SemanticRelationEdge[] {
  const relations = new Map<string, SemanticRelationEdge>();
  for (const edge of active) relations.set(semanticIdentity(edge), edge);
  for (const edge of explicit) relations.set(semanticIdentity(edge), edge);
  for (const edge of resolved) relations.set(semanticIdentity(edge), edge);
  return [...relations.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, edge]) => edge);
}

/**
 * Prepares a changed-only semantic/dependency replacement without modifying
 * the active graph. All reads are anchored by affected source/spec/contract
 * IDs or resolver keys; only a wildcard HTTP root expands to all HTTP specs,
 * because that root semantically affects every path bucket.
 */
export async function prepareIncrementalDependencyMutation(
  db: GraphDB,
  input: PrepareIncrementalDependencyMutationInput
): Promise<IncrementalDependencyMutation> {
  const affectedFileIds = uniqueSorted(input.affectedFileIds);
  const pendingSpecs = [
    ...input.graphFacts.flatMap((facts) => facts.contractSpecs),
    ...input.schema.upsertSpecs
  ];
  const pendingSpecById = new Map(pendingSpecs.map((spec) => [spec.id, spec]));
  const oldSourceSpecs = affectedFileIds.length > 0
    ? await activeSpecs(db, input.scope, "s.fileId IN $fileIds", { fileIds: affectedFileIds })
    : [];
  const affectedSpecIds = new Set<string>([
    ...oldSourceSpecs.map((spec) => spec.id),
    ...pendingSpecs.map((spec) => spec.id),
    ...input.schema.deleteSpecIds,
    ...input.schema.upsertRelations.flatMap((edge) => [edge.fromSpecId, edge.toSpecId]),
    ...input.schema.deleteRelations.flatMap((edge) => [edge.fromSpecId, edge.toSpecId])
  ]);
  const activeIncidentRelations = await activeSemanticRelationsForSpecs(
    db,
    input.scope,
    [...affectedSpecIds]
  );
  const explicitRelations = collapseSemanticRelations([
    ...input.graphFacts.flatMap((facts) => facts.semanticRelations),
    ...input.schema.upsertRelations
  ]);
  for (const edge of explicitRelations) {
    affectedSpecIds.add(edge.fromSpecId);
    affectedSpecIds.add(edge.toSpecId);
  }

  const referencedSpecIds = uniqueSorted([
    ...activeIncidentRelations.flatMap((edge) => [edge.fromSpecId, edge.toSpecId]),
    ...explicitRelations.flatMap((edge) => [edge.fromSpecId, edge.toSpecId])
  ]);
  const directActiveSpecs = referencedSpecIds.length > 0
    ? await activeSpecs(db, input.scope, "s.id IN $specIds", { specIds: referencedSpecIds })
    : [];
  const resolverSeeds = [...new Map([...oldSourceSpecs, ...pendingSpecs].map((spec) => [spec.id, spec])).values()];
  const resolverCandidates = await loadResolverCandidates(db, input.scope, resolverSeeds);
  const activeCandidateById = new Map(
    [...oldSourceSpecs, ...directActiveSpecs, ...resolverCandidates].map((spec) => [spec.id, spec])
  );
  const removedSpecIds = new Set<string>([
    ...oldSourceSpecs.map((spec) => spec.id),
    ...input.schema.deleteSpecIds
  ]);
  const finalSpecById = new Map<string, ContractSpecNode>();
  for (const [id, spec] of activeCandidateById) {
    if (!removedSpecIds.has(id)) finalSpecById.set(id, spec);
  }
  for (const [id, spec] of pendingSpecById) finalSpecById.set(id, spec);

  const staleEvidenceIds = new Set(await activeEvidenceIdsForFiles(db, input.scope, affectedFileIds));
  const explicitlyDeletedRelations = new Set(input.schema.deleteRelations.map(semanticIdentity));
  const retainedActiveRelations = activeIncidentRelations.filter((edge) =>
    finalSpecById.has(edge.fromSpecId)
    && finalSpecById.has(edge.toSpecId)
    && !staleEvidenceIds.has(edge.evidenceId)
    && !explicitlyDeletedRelations.has(semanticIdentity(edge))
    && !RECOMPUTED_SEMANTIC_KINDS.has(edge.kind));
  const finalExplicitRelations = explicitRelations.filter((edge) =>
    finalSpecById.has(edge.fromSpecId) && finalSpecById.has(edge.toSpecId));

  const oldAffectedParticipantRows = affectedFileIds.length > 0
    ? await participantRows(db, input.scope, "e.fileId IN $fileIds", { fileIds: affectedFileIds })
    : [];
  const pending = pendingParticipants(input.graphFacts);
  const affectedContractIds = new Set<string>([
    ...oldSourceSpecs.map((spec) => spec.contractId),
    ...pendingSpecs.map((spec) => spec.contractId),
    ...oldAffectedParticipantRows.map((row) => row.contractId),
    ...pending.map((participant) => participant.contractId)
  ]);
  for (const specId of affectedSpecIds) {
    const spec = finalSpecById.get(specId) ?? activeCandidateById.get(specId);
    if (spec) affectedContractIds.add(spec.contractId);
  }
  const candidateContractIds = uniqueSorted([
    ...affectedContractIds,
    ...[...finalSpecById.values()].map((spec) => spec.contractId)
  ]);
  const activeParticipants = candidateContractIds.length > 0
    ? await loadContractParticipantsForContracts(db, candidateContractIds, input.scope)
    : [];
  const participantMap = new Map<string, ContractParticipant>();
  for (const participant of activeParticipants) {
    if (staleEvidenceIds.has(participant.evidenceId)) continue;
    participantMap.set(
      `${participant.repoId}\0${participant.contractId}\0${participant.role}\0${participant.evidenceId}`,
      participant
    );
  }
  for (const participant of pending) {
    participantMap.set(
      `${participant.repoId}\0${participant.contractId}\0${participant.role}\0${participant.evidenceId}`,
      participant
    );
  }
  const participants = [...participantMap.values()];
  const repoContracts = participants.map((participant) => ({
    repoId: participant.repoId,
    contractId: participant.contractId,
    role: participant.role,
    evidenceId: participant.evidenceId,
    confidence: participant.confidence
  }));
  const resolvedRelations = resolveSemanticRelations({
    contractSpecs: [...finalSpecById.values()],
    repoContracts,
    existingSemanticRelations: finalExplicitRelations
  }).filter((edge) => affectedSpecIds.has(edge.fromSpecId) || affectedSpecIds.has(edge.toSpecId));
  const finalRelations = relationOverlay(
    retainedActiveRelations,
    finalExplicitRelations,
    resolvedRelations
  ).filter((edge) => affectedSpecIds.has(edge.fromSpecId) || affectedSpecIds.has(edge.toSpecId));

  const semanticDependencies = materializeDependenciesFromSemanticRelations(
    finalRelations,
    [...finalSpecById.values()]
  ).filter((edge) => affectedContractIds.has(edge.sourceContractId)
    || affectedContractIds.has(edge.targetContractId));
  const legacyDependencies = buildRepoDependenciesFromParticipants(participants)
    .filter((edge) => affectedContractIds.has(edge.sourceContractId)
      || affectedContractIds.has(edge.targetContractId));
  const dependencies = mergeAndDedupeDeps(semanticDependencies, legacyDependencies)
    .map((edge) => ({ ...edge, batchId: input.batchId, active: true }))
    .sort((left, right) => materializedDependencyIdentity(left)
      .localeCompare(materializedDependencyIdentity(right)));
  const semanticRelations = finalRelations
    .map((edge) => ({ ...edge, batchId: input.batchId, active: true }))
    .sort((left, right) => semanticRelationDedupKey(left).localeCompare(semanticRelationDedupKey(right)));
  return {
    affectedSpecIds: uniqueSorted(affectedSpecIds),
    affectedContractIds: uniqueSorted(affectedContractIds),
    upsertSemanticRelations: semanticRelations,
    upsertRepoDependencies: dependencies
  };
}

function materializedDependencyIdentity(edge: RepoDependencyEdge): string {
  return JSON.stringify([
    edge.fromRepoId,
    edge.toRepoId,
    edge.dependencyType,
    edge.sourceContractId,
    edge.targetContractId,
    edge.evidenceId
  ]);
}

/** Applies a precomputed delta. This function performs no graph reads. */
export async function applyIncrementalDependencyMutation(
  db: GraphDB,
  input: {
    scope: PublicGraphGenerationScope;
    mutation: IncrementalDependencyMutation;
  }
): Promise<void> {
  await db.clearSemanticRelationsForSpecs(input.mutation.affectedSpecIds, input.scope);
  if (input.mutation.upsertSemanticRelations.length > 0) {
    await db.addSemanticRelationsBatch(input.mutation.upsertSemanticRelations, input.scope);
  }
  await db.clearRepoDependenciesForContracts(input.mutation.affectedContractIds, input.scope);
  if (input.mutation.upsertRepoDependencies.length > 0) {
    await db.addRepoDependenciesBatch(input.mutation.upsertRepoDependencies, input.scope);
  }
}
