import { buildRepoDependenciesFromParticipants, materializeDependenciesFromSemanticRelations, type ContractParticipant } from "../contracts/extraction/crossRepoContracts.js";
import type { ContractKind, ContractRole, ContractSpecNode, RepoContractEdge, RepoDependencyEdge, SemanticRelationEdge } from "../parsing/types.js";
import type { GraphDB } from "./db.js";
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
    "(edge.active IS NULL OR edge.active = true)",
    "(e.active IS NULL OR e.active = true)",
    extra
  ].filter(Boolean).join(" AND ");
}

async function roleRows(db: GraphDB, rel: string, role: ContractRole, extraWhere?: string, params: Record<string, any> = {}): Promise<ParticipantRow[]> {
  return db.query<ParticipantRow>(
    `MATCH (r:Repo)-[edge:${rel}]->(c:Contract)-[:HAS_EVIDENCE]->(e:Evidence)
     WHERE ${activeParticipantWhere(extraWhere)}
     RETURN r.id AS repoId, c.id AS contractId, '${role}' AS role, edge.evidenceId AS evidenceId, edge.confidence AS confidence,
            c.kind AS kind, c.key AS key, c.name AS name, c.description AS description,
            e.repoId AS evidenceRepoId, e.fileId AS fileId, e.filePath AS filePath, e.line AS line,
            e.raw AS raw, e.rule AS rule, e.confidence AS evidenceConfidence;`,
    params
  );
}

async function participantRows(db: GraphDB, extraWhere?: string, params: Record<string, any> = {}): Promise<ParticipantRow[]> {
  const roles: ContractRole[] = ["owner", "producer", "consumer", "shared"];
  const rels = ["OWNS_PACKAGE", "PRODUCES", "CONSUMES", "SHARES_CONTRACT"];
  
  const promises = rels.map((rel, i) => roleRows(db, rel, roles[i]!, extraWhere, params));
  const results = await Promise.all(promises);
  return results.flat();
}

export async function loadContractParticipants(db: GraphDB): Promise<ContractParticipant[]> {
  return toContractParticipants(await participantRows(db));
}

export async function loadContractParticipantsForRepos(db: GraphDB, repoIds: string[]): Promise<ContractParticipant[]> {
  if (repoIds.length === 0) return [];
  return toContractParticipants(await participantRows(db, "r.id IN $repoIds", { repoIds }));
}

export async function loadContractParticipantsForContracts(db: GraphDB, contractIds: string[]): Promise<ContractParticipant[]> {
  if (contractIds.length === 0) return [];
  return toContractParticipants(await participantRows(db, "c.id IN $contractIds", { contractIds }));
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
 * Resolves SEMANTIC_REL edges (CALLS_ENDPOINT, REQUEST_SCHEMA,
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
         WHERE (s.active IS NULL OR s.active = true)
           AND s.repoId IN $repoIds
         RETURN ${SPEC_RETURN}`,
        { repoIds: repoIdsArray }
      )
    : await db.query<SpecRow>(
        `MATCH (s:ContractSpec)
         WHERE (s.active IS NULL OR s.active = true)
         RETURN ${SPEC_RETURN}`
      );
  const targetSpecs = targetSpecRows.map(rowToContractSpec);
  if (targetSpecs.length === 0) return;

  // Always load all schema specs — negligible count even at scale.
  const schemaRows = await db.query<SpecRow>(
    `MATCH (s:ContractSpec)
     WHERE s.specKind = 'schema'
       AND (s.active IS NULL OR s.active = true)
     RETURN ${SPEC_RETURN}`
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

    const participantRowsAll = await participantRows(db);
    repoContracts = participantRowsAll.map((row) => ({
      repoId: row.repoId,
      contractId: row.contractId,
      role: row.role,
      evidenceId: row.evidenceId,
      confidence: row.confidence
    }));

    const semanticRelRows = await db.query<SemanticRelRow>(
      `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
       WHERE (r.active IS NULL OR r.active = true)
       RETURN ${SEMANTIC_REL_RETURN}`
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
      const allHttpParams: Record<string, unknown> = { ...excludeParams };
      const allHttpRows = await db.query<SpecRow>(
        `MATCH (s:ContractSpec)
         WHERE s.specKind = 'http-endpoint'
           AND (s.active IS NULL OR s.active = true)
           AND ${excludeClauses}
         RETURN ${SPEC_RETURN}`,
        allHttpParams as Record<string, import("./db.js").GraphValue>
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

      const httpParams: Record<string, unknown> = { ...excludeParams, ...prefixParams };
      const httpCandidateRows = await db.query<SpecRow>(
        `MATCH (s:ContractSpec)
         WHERE s.specKind = 'http-endpoint'
           AND (s.active IS NULL OR s.active = true)
           AND ${excludeClauses}
           AND (${prefixConditions.join(" OR ")})
         RETURN ${SPEC_RETURN}`,
        httpParams as Record<string, import("./db.js").GraphValue>
      );
      candidateHttpSpecs = httpCandidateRows.map(rowToContractSpec);
    }

    // Step 4: Load candidate event specs — same topic, different repos.
    let candidateEventSpecs: ContractSpecNode[] = [];
    if (eventTopics.size > 0) {
      const evParams: Record<string, unknown> = { ...excludeParams, topics: [...eventTopics] };
      const eventCandidateRows = await db.query<SpecRow>(
        `MATCH (s:ContractSpec)
         WHERE s.specKind = 'event'
           AND (s.active IS NULL OR s.active = true)
           AND ${excludeClauses}
           AND s.eventTopic IN $topics
         RETURN ${SPEC_RETURN}`,
        evParams as Record<string, import("./db.js").GraphValue>
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
      ? await participantRows(db, "c.id IN $contractIds", { contractIds })
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
           WHERE (r.active IS NULL OR r.active = true)
             AND (a.id IN $specIds OR b.id IN $specIds)
           RETURN ${SEMANTIC_REL_RETURN}`,
          { specIds }
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
  const edges = scoped
    ? resolvedEdges.filter((edge) => {
        const fromRepo = specRepoMap.get(edge.fromSpecId);
        const toRepo = specRepoMap.get(edge.toSpecId);
        return (fromRepo && targetRepoIds!.has(fromRepo)) ||
               (toRepo && targetRepoIds!.has(toRepo));
      })
    : resolvedEdges;

  if (edges.length === 0) return;

  // Write in 5000-edge batches.
  const batchSize = 5000;
  for (let i = 0; i < edges.length; i += batchSize) {
    const chunk = edges.slice(i, i + batchSize).map((edge) => ({
      ...edge,
      batchId: "",
      active: true
    }));
    await db.addSemanticRelationsBatch(chunk);
  }
}

// ---------------------------------------------------------------------------
// Phase 4.2: SEMANTIC_REL loading for dependency materialization
// ---------------------------------------------------------------------------

async function loadSemanticRelations(db: GraphDB, repoIds?: Set<string>): Promise<{
  edges: SemanticRelationEdge[];
  specs: ContractSpecNode[];
}> {
  // Load active SEMANTIC_REL edges. When target repos are specified, only
  // load edges that involve specs in those repos (either endpoint).
  const scoped = repoIds !== undefined && repoIds.size > 0;

  const semanticRows = await db.query<SemanticRelRow>(
    scoped
      ? `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
         WHERE (r.active IS NULL OR r.active = true)
           AND (a.repoId IN $repoIds OR b.repoId IN $repoIds)
         RETURN ${SEMANTIC_REL_RETURN}`
      : `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
         WHERE (r.active IS NULL OR r.active = true)
         RETURN ${SEMANTIC_REL_RETURN}`,
    scoped ? { repoIds: [...repoIds!] } : undefined
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
     WHERE s.id IN $specIds AND (s.active IS NULL OR s.active = true)
     RETURN ${SPEC_RETURN}`,
    { specIds: [...specIds] }
  );

  return {
    edges: semanticRows.map(rowToSemanticRel),
    specs: specRows.map(rowToContractSpec)
  };
}


export async function rebuildRepoDependencies(db: GraphDB, options: { repoIds?: string[]; batchId?: string; logger?: RebuildRepoDependenciesLogger } = {}): Promise<RepoDependencyEdge[]> {
  const targetRepoIds = options.repoIds && options.repoIds.length > 0 ? new Set(options.repoIds) : undefined;

  // Phase 4.1: Resolve and write SEMANTIC_REL edges with full cross-repo
  // visibility.  This must run BEFORE Phase 4.2 so the freshly-written
  // edges are visible to loadSemanticRelations.
  await resolveAndWriteSemanticRelations(db, targetRepoIds);

  // Phase 4.2: Materialize API + event dependencies from SEMANTIC_REL edges.
  const { edges: semanticEdges, specs } = await loadSemanticRelations(db, targetRepoIds);
  const semanticDeps = materializeDependenciesFromSemanticRelations(semanticEdges, specs);

  // Phase 4.2: Legacy matcher runs for ALL kinds as fallback.
  // Load participants in two steps: first for target repos, then for their
  // contracts (which pulls in peer repos sharing the same contracts).
  const targetParticipants = targetRepoIds
    ? await loadContractParticipantsForRepos(db, [...targetRepoIds])
    : undefined;
  const targetContractIds = targetParticipants
    ? [...new Set(targetParticipants.map((p) => p.contractId))]
    : undefined;
  const allParticipants = targetContractIds
    ? await loadContractParticipantsForContracts(db, targetContractIds)
    : await loadContractParticipants(db);
  const legacyDeps = buildRepoDependenciesFromParticipants(allParticipants, targetRepoIds);

  // Merge: semantic deps first → legacy deps fill gaps (structural dedup).
  const dependencies = mergeAndDedupeDeps(semanticDeps, legacyDeps);

  await db.clearRepoDependencies(options.repoIds);

  const progress = options.logger?.createProgressBar?.("Rebuilding dependencies", dependencies.length);
  const batchSize = 5000;
  for (let i = 0; i < dependencies.length; i += batchSize) {
    const chunk = dependencies.slice(i, i + batchSize).map((d) => ({
      ...d,
      batchId: options.batchId ?? "",
      active: true
    }));
    await db.addRepoDependenciesBatch(chunk);
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
