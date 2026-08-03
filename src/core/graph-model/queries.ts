import { GraphDatabaseOperationalError, type GraphDB, type GraphValue, type ContractSummaryRow } from "./db.js";
export type { ContractSummaryRow } from "./db.js";
import { repoId } from "../../shared/path.js";
import { confidenceBand, type ConfidenceBand } from "../../shared/confidence.js";
import { BRAND } from "../../shared/branding.js";
import { canonicalContractKey } from "../contracts/extraction/crossRepoContracts.js";
import {
  DEP_EDGE_RETURN,
  SEMANTIC_REL_RETURN,
  SPEC_RETURN,
  rowToContractSpec,
  rowToDepEdge,
  rowToReadableContractSpec,
  rowToSemanticRel,
  type DepEdgeRow,
  type SemanticRelRow,
  type SpecRow
} from "../contracts/specRows.js";
import type {
  ContractKind,
  ContractRole,
  ContractSpecNode,
  ReadableContractSpecNode,
  RepoDependencyEdge,
  SemanticRelationEdge
} from "../parsing/types.js";
import { isKnownSpecKind } from "../parsing/types.js";
import { publicGraphActivePredicate, publicGraphGenerationPredicate, withPublicGraphSnapshotParams, type PublicGraphReadSnapshot } from "./readSnapshot.js";

export interface DependencyQueryOptions {
  limit?: number;
  strength?: "strong" | "weak";
  type?: string;
  repo?: string;
  target?: string;
  direction?: "outgoing" | "incoming";
}

export type CodeSearchRow = {
  repoName: string;
  filePath: string;
  codeId: string;
  kind: string;
  name: string;
  qualifiedName: string;
  summary: string;
  signature: string;
};

export type SectionSearchRow = {
  repoName: string;
  filePath: string;
  sectionId: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  summary: string;
  text: string;
};

/**
 * Represents a row in a contract trace query result, identifying a code usage or production of a contract.
 */
export type ContractTraceRow = {
  /** The unique ID of the contract */
  contractId: string;
  /** The contract kind (e.g. 'api', 'event', 'package') */
  kind: string;
  /** The canonical contract key */
  key: string;
  /** The human-readable name of the contract */
  name: string;
  /** The role played by this reference (either 'producer' or 'consumer') */
  role: ContractRole;
  /** The name of the repository where the contract reference is located */
  repoName: string;
  /** The relative file path where the contract reference is located */
  filePath: string;
  /** The 1-based line number of the reference */
  line: number;
  /** The evidence identity used by the lexical contract projection. */
  evidenceId: string;
  /** The raw code or text snippet matching the contract reference */
  raw: string;
  /** The extractor rule name that identified the contract */
  rule: string;
  /** Confidence score of the extraction (between 0 and 1) */
  confidence: number;
  /** Coarse parsing strength derived from confidence for query consumers */
  resolution: ConfidenceBand;
};

/**
 * Represents a dependency edge between repositories, detailing the contract that forms the dependency.
 */
export type DependencyRow = {
  /** The name of the consuming/dependent repository */
  fromRepo: string;
  /** The name of the producing/target repository */
  toRepo: string;
  /** The dependency relationship type (e.g., 'package', 'api', 'event') */
  dependencyType: string;
  /** The kind of the contract defining the dependency */
  contractKind: string;
  /** The key of the contract defining the dependency */
  contractKey: string;
  /** The file path in the dependent repository where the contract is used */
  filePath: string;
  /** The 1-based line number of the usage */
  line: number;
  /** The raw source code snippet of the usage */
  raw: string;
  /** The extractor rule that discovered the usage */
  rule: string;
  /** Confidence score of the dependency match (between 0 and 1) */
  confidence: number;
  /** Coarse parsing strength derived from confidence for query consumers */
  resolution: ConfidenceBand;
};

export type UnresolvedEvidenceRow = {
  repoName: string;
  filePath: string;
  line: number;
  raw: string;
  rule: string;
  reason: string;
  resolution: "dynamic-unresolved";
};

export type LowConfidenceRelationRow = {
  evidenceId: string;
  repoName: string;
  contractKind: string;
  contractKey: string;
  role: ContractRole;
  confidence: number;
  filePath: string;
  line: number;
  rule: string;
  raw: string;
};

export type ProducerContractRow = {
  contractKind: string;
  contractKey: string;
  repoName: string;
};

export type ContractKeyRow = {
  key: string;
};

export type RepoContractKeyRow = {
  repoName: string;
  key: string;
};

export type RepoContractCountRow = {
  repoName: string;
  count: number;
};

export type ActiveSemanticGraph = {
  specs: ReadableContractSpecNode[];
  relations: SemanticRelationEdge[];
};

export type RepoScopedPath = Readonly<{ repoId: string; path: string }>;

export type CountedQueryResult<Row> = Readonly<{
  rows: Row[];
  queryCount: number;
}>;

export class CountedGraphQueryError extends GraphDatabaseOperationalError {
  readonly attemptedQueryCount: number;

  constructor(attemptedQueryCount: number, options?: ErrorOptions) {
    super(options);
    this.name = "CountedGraphQueryError";
    this.attemptedQueryCount = attemptedQueryCount;
  }
}

/**
 * Represents a row in an entity trace query result, identifying how an entity relates to a source node.
 */
export type EntityTraceRow = {
  /** The unique ID of the entity */
  entityId: string;
  /** The name of the entity */
  entityName: string;
  /** The name of the repository containing the match */
  repoName: string;
  /** The kind of source node (e.g., 'code', 'section', 'contract') */
  sourceKind: "code" | "section" | "contract" | "operation" | "workflow";
  /** The name of the code symbol or section title where the entity was found */
  name: string;
  /** The relative file path of the source node */
  filePath: string;
  /** The 1-based line number of the match */
  line: number;
  /** The role played by the source node relative to the entity */
  role: string;
  /** The raw text evidence supporting the entity match */
  evidence: string;
  /** Confidence score of the entity mapping (between 0 and 1) */
  confidence: number;
  /** Stable identity of the source node when supplied by an exact query. */
  sourceId?: string;
  /** Stable identity of the supporting evidence when supplied by an exact query. */
  evidenceId?: string;
};

export function entityTraceRowKey(row: EntityTraceRow): string {
  return JSON.stringify([
    row.entityId, row.repoName, row.sourceKind, row.sourceId ?? "", row.name,
    row.filePath, row.line, row.role, row.evidenceId ?? "", row.evidence
  ]);
}

export async function searchCode(db: GraphDB, snapshot: PublicGraphReadSnapshot, term: string, limit = 20): Promise<CodeSearchRow[]> {
  const lowered = term.toLowerCase();
  return db.query<CodeSearchRow>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fc:CONTAINS]->(c:Code)
     WHERE (lower(c.name) CONTAINS $term OR lower(c.qualifiedName) CONTAINS $term OR lower(c.summary) CONTAINS $term OR lower(f.path) CONTAINS $term)
       AND ${publicGraphGenerationPredicate("r", "rf", "f", "fc", "c")}
       AND ${publicGraphActivePredicate("f", "c")}
     RETURN r.name AS repoName, f.path AS filePath, c.id AS codeId, c.kind AS kind, c.name AS name, c.qualifiedName AS qualifiedName, c.summary AS summary, c.signature AS signature
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { term: lowered })
  );
}

export async function searchSections(db: GraphDB, snapshot: PublicGraphReadSnapshot, term: string, limit = 20): Promise<SectionSearchRow[]> {
  const lowered = term.toLowerCase();
  return db.query<SectionSearchRow>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fs:CONTAINS]->(s:Section)
     WHERE (lower(s.heading) CONTAINS $term OR lower(s.summary) CONTAINS $term OR lower(s.text) CONTAINS $term OR lower(f.path) CONTAINS $term)
       AND ${publicGraphGenerationPredicate("r", "rf", "f", "fs", "s")}
       AND ${publicGraphActivePredicate("f", "s")}
     RETURN r.name AS repoName, f.path AS filePath, s.id AS sectionId, s.heading AS heading, s.level AS level, s.startLine AS startLine, s.endLine AS endLine, s.summary AS summary, s.text AS text
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { term: lowered })
  );
}

export async function findExactCode(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  input: { identifiers: readonly string[]; paths: readonly string[]; scopedPaths?: readonly RepoScopedPath[]; limit: number }
): Promise<CodeSearchRow[]> {
  if (input.limit < 1 || (input.identifiers.length === 0 && input.paths.length === 0 && !input.scopedPaths?.length)) return [];
  const conditions: string[] = [];
  const params: Record<string, GraphValue> = {};
  if (input.identifiers.length > 0) {
    conditions.push("(c.id IN $identifiers OR c.name IN $identifiers OR c.qualifiedName IN $identifiers)");
    params.identifiers = [...input.identifiers];
  }
  if (input.paths.length > 0) {
    conditions.push("f.path IN $paths");
    params.paths = [...input.paths];
  }
  for (const [index, target] of (input.scopedPaths ?? []).entries()) {
    conditions.push(`(r.id = $scopedRepo${index} AND f.path = $scopedPath${index})`);
    params[`scopedRepo${index}`] = target.repoId;
    params[`scopedPath${index}`] = target.path;
  }
  return db.query<CodeSearchRow>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fc:CONTAINS]->(c:Code)
     WHERE (${conditions.join(" OR ")})
       AND ${publicGraphGenerationPredicate("r", "rf", "f", "fc", "c")}
       AND ${publicGraphActivePredicate("f", "c")}
     RETURN r.name AS repoName, f.path AS filePath, c.id AS codeId, c.kind AS kind, c.name AS name, c.qualifiedName AS qualifiedName, c.summary AS summary, c.signature AS signature
     ORDER BY r.name, f.path, c.qualifiedName, c.id
     LIMIT ${input.limit};`,
    withPublicGraphSnapshotParams(snapshot, params)
  );
}

export async function findSectionsAtExactPaths(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  paths: readonly string[],
  limit: number,
  scopedPaths: readonly RepoScopedPath[] = []
): Promise<SectionSearchRow[]> {
  if (limit < 1 || (paths.length === 0 && scopedPaths.length === 0)) return [];
  const conditions: string[] = [];
  const params: Record<string, GraphValue> = {};
  if (paths.length > 0) {
    conditions.push("f.path IN $paths");
    params.paths = [...paths];
  }
  for (const [index, target] of scopedPaths.entries()) {
    conditions.push(`(r.id = $scopedRepo${index} AND f.path = $scopedPath${index})`);
    params[`scopedRepo${index}`] = target.repoId;
    params[`scopedPath${index}`] = target.path;
  }
  return db.query<SectionSearchRow>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fs:CONTAINS]->(s:Section)
     WHERE (${conditions.join(" OR ")})
       AND ${publicGraphGenerationPredicate("r", "rf", "f", "fs", "s")}
       AND ${publicGraphActivePredicate("f", "s")}
     RETURN r.name AS repoName, f.path AS filePath, s.id AS sectionId, s.heading AS heading, s.level AS level, s.startLine AS startLine, s.endLine AS endLine, s.summary AS summary, s.text AS text
     ORDER BY r.name, f.path, s.startLine, s.id
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, params)
  );
}

export async function findImpactSections(db: GraphDB, snapshot: PublicGraphReadSnapshot, term: string, limit = 50): Promise<SectionSearchRow[]> {
  const lowered = term.toLowerCase();
  return db.query<SectionSearchRow>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fs:CONTAINS]->(s:Section)
     WHERE (lower(s.heading) CONTAINS $term OR lower(s.summary) CONTAINS $term OR lower(s.text) CONTAINS $term OR lower(f.path) CONTAINS $term)
       AND ${publicGraphGenerationPredicate("r", "rf", "f", "fs", "s")}
       AND ${publicGraphActivePredicate("f", "s")}
     RETURN r.name AS repoName, f.path AS filePath, s.id AS sectionId, s.heading AS heading, s.level AS level, s.startLine AS startLine, s.endLine AS endLine, s.summary AS summary, s.text AS text
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { term: lowered })
  );
}

export async function sectionsDocumentingCode(db: GraphDB, snapshot: PublicGraphReadSnapshot, codeIds: string[], limit = 50): Promise<SectionSearchRow[]> {
  if (codeIds.length === 0) return [];
  return db.query<SectionSearchRow>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fs:CONTAINS]->(s:Section)-[sc:DOCUMENTS]->(c:Code)
     WHERE c.id IN $codeIds
       AND ${publicGraphGenerationPredicate("r", "rf", "f", "fs", "s", "sc", "c")}
       AND ${publicGraphActivePredicate("f", "s", "c")}
     RETURN r.name AS repoName, f.path AS filePath, s.id AS sectionId, s.heading AS heading, s.level AS level, s.startLine AS startLine, s.endLine AS endLine, s.summary AS summary, s.text AS text
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { codeIds })
  );
}

export async function findImpact(db: GraphDB, snapshot: PublicGraphReadSnapshot, term: string): Promise<CodeSearchRow[]> {
  const lowered = term.toLowerCase();
  return db.query<CodeSearchRow>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fc:CONTAINS]->(c:Code)
     WHERE (lower(c.name) CONTAINS $term OR lower(c.qualifiedName) CONTAINS $term OR lower(c.signature) CONTAINS $term OR lower(f.path) CONTAINS $term)
       AND ${publicGraphGenerationPredicate("r", "rf", "f", "fc", "c")}
       AND ${publicGraphActivePredicate("f", "c")}
     RETURN r.name AS repoName, f.path AS filePath, c.id AS codeId, c.kind AS kind, c.name AS name, c.qualifiedName AS qualifiedName, c.summary AS summary, c.signature AS signature
     LIMIT 50;`,
    withPublicGraphSnapshotParams(snapshot, { term: lowered })
  );
}

export async function hasCodeSymbolMatch(db: GraphDB, snapshot: PublicGraphReadSnapshot, term: string): Promise<boolean> {
  const rows = await db.query<{ found: boolean }>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fc:CONTAINS]->(c:Code)
     WHERE (c.name = $term OR c.qualifiedName = $term)
       AND ${publicGraphGenerationPredicate("r", "rf", "f", "fc", "c")}
       AND ${publicGraphActivePredicate("f", "c")}
     RETURN true AS found
     LIMIT 1;`,
    withPublicGraphSnapshotParams(snapshot, { term })
  );
  return rows.length > 0;
}

export async function findContractSourceSymbols(db: GraphDB, snapshot: PublicGraphReadSnapshot, contractIds: string[], limit = 100): Promise<CodeSearchRow[]> {
  if (contractIds.length === 0 || limit < 1) return [];
  return db.query<CodeSearchRow>(
    `MATCH (c:Contract)-[hs:HAS_SPEC]->(s:ContractSpec), (r:Repo)-[rf:CONTAINS]->(f:File)-[fc:CONTAINS]->(code:Code)
     WHERE c.id IN $contractIds AND s.sourceSymbolId = code.id
       AND ${publicGraphGenerationPredicate("c", "hs", "s", "r", "rf", "f", "fc", "code")}
       AND ${publicGraphActivePredicate("hs", "s", "f", "code")}
     RETURN r.name AS repoName, f.path AS filePath, code.id AS codeId, code.kind AS kind, code.name AS name, code.qualifiedName AS qualifiedName, code.summary AS summary, code.signature AS signature
     ORDER BY r.name, f.path, code.qualifiedName, code.id
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { contractIds })
  );
}

export async function listCode(db: GraphDB, snapshot: PublicGraphReadSnapshot, limit = 50): Promise<CodeSearchRow[]> {
  return db.query<CodeSearchRow>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fc:CONTAINS]->(c:Code)
     WHERE ${publicGraphGenerationPredicate("r", "rf", "f", "fc", "c")}
       AND ${publicGraphActivePredicate("f", "c")}
     RETURN r.name AS repoName, f.path AS filePath, c.id AS codeId, c.kind AS kind, c.name AS name, c.qualifiedName AS qualifiedName, c.summary AS summary, c.signature AS signature
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot)
  );
}

export async function listDependencies(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  limitOrOptions?: number | DependencyQueryOptions
): Promise<DependencyRow[]> {
  const options: DependencyQueryOptions =
    typeof limitOrOptions === "number" ? { limit: limitOrOptions } : (limitOrOptions ?? {});
  const limit = options.limit ?? 20;

  const conditions = [
    "d.sourceContractId = c.id",
    "d.evidenceId = e.id",
    publicGraphGenerationPredicate("from", "d", "to", "c", "e"),
    publicGraphActivePredicate("d", "e")
  ];
  const params: Record<string, GraphValue> = {};

  if (options.type) {
    conditions.push("d.dependencyType = $type");
    params.type = options.type;
  }

  if (options.strength) {
    if (options.strength === "strong") {
      conditions.push("d.dependencyType IN ['package', 'import', 'api']");
    } else if (options.strength === "weak") {
      conditions.push("d.dependencyType IN ['event', 'shared-contract']");
    }
  }

  // --repo / --target / --direction filtering
  if (options.repo && options.target) {
    const repoIdVal = repoId(options.repo);
    const targetIdVal = repoId(options.target);
    if (options.direction === "outgoing") {
      conditions.push("from.id = $repoId");
      conditions.push("to.id = $targetId");
    } else if (options.direction === "incoming") {
      conditions.push("from.id = $targetId");
      conditions.push("to.id = $repoId");
    } else {
      conditions.push(
        "((from.id = $repoId AND to.id = $targetId) OR (from.id = $targetId AND to.id = $repoId))"
      );
    }
    params.repoId = repoIdVal;
    params.targetId = targetIdVal;
  } else if (options.repo) {
    const repoIdVal = repoId(options.repo);
    params.repoId = repoIdVal;
    if (options.direction === "outgoing") {
      conditions.push("from.id = $repoId");
    } else if (options.direction === "incoming") {
      conditions.push("to.id = $repoId");
    } else {
      conditions.push("(from.id = $repoId OR to.id = $repoId)");
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await db.query<Omit<DependencyRow, "resolution">>(
    `MATCH (from:Repo)-[d:DEPENDS_ON]->(to:Repo), (c:Contract), (e:Evidence)
     ${whereClause}
     RETURN from.name AS fromRepo, to.name AS toRepo, d.dependencyType AS dependencyType, c.kind AS contractKind, c.key AS contractKey, e.filePath AS filePath, e.line AS line, e.raw AS raw, e.rule AS rule, e.confidence AS confidence
     ORDER BY CASE WHEN d.dependencyType IN ['package', 'import', 'api'] THEN 0 ELSE 1 END, from.name, to.name, d.dependencyType, c.kind, c.key, e.filePath, e.line
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, params)
  );
  return rows.map((row) => ({ ...row, resolution: confidenceBand(row.confidence) }));
}

export async function listContracts(db: GraphDB, snapshot: PublicGraphReadSnapshot, options: { limit?: number; kind?: ContractKind; repo?: string; direction?: "outgoing" | "incoming" } = {}): Promise<ContractSummaryRow[]> {
  if (options.direction && !options.repo) {
    throw new Error("direction requires repo");
  }
  if (options.direction && options.direction !== "outgoing" && options.direction !== "incoming") {
    throw new Error(`Unsupported direction "${options.direction}". Expected one of: outgoing, incoming`);
  }
  const dbOptions: { limit?: number; kind?: ContractKind; repo?: string; direction?: "outgoing" | "incoming" } = {
    limit: options.limit,
    kind: options.kind,
    direction: options.direction,
  };
  if (options.repo) {
    dbOptions.repo = repoId(options.repo);
  }
  return db.listContracts(snapshot, dbOptions);
}

async function traceContractRole(db: GraphDB, snapshot: PublicGraphReadSnapshot, contractIds: string[], rel: string, role: ContractRole, limit: number): Promise<ContractTraceRow[]> {
  if (contractIds.length === 0 || limit < 1) return [];
  const rows = await db.query<Omit<ContractTraceRow, "resolution">>(
    `MATCH (r:Repo)-[edge:${rel}]->(c:Contract), (e:Evidence)
     WHERE c.id IN $contractIds AND edge.evidenceId = e.id
       AND ${publicGraphGenerationPredicate("r", "edge", "c", "e")}
       AND ${publicGraphActivePredicate("edge", "e")}
     RETURN c.id AS contractId, c.kind AS kind, c.key AS key, c.name AS name, '${role}' AS role, r.name AS repoName, e.filePath AS filePath, e.line AS line, edge.evidenceId AS evidenceId, e.raw AS raw, e.rule AS rule, e.confidence AS confidence
     ORDER BY r.name, e.filePath, e.line, c.id
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { contractIds })
  );
  return rows.map((row) => ({ ...row, resolution: confidenceBand(row.confidence) }));
}

export async function traceContractWithQueryCount(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  kind: ContractKind,
  value: string,
  method?: string,
  limit = 100
): Promise<CountedQueryResult<ContractTraceRow>> {
  if (limit < 1) return { rows: [], queryCount: 0 };
  let queryCount = 0;
  try {
  const key = canonicalContractKey(kind, value);
  const normalizedMethod = method?.trim().toUpperCase();
  const methodKey = normalizedMethod && kind === "api" ? canonicalContractKey(kind, value, normalizedMethod) : undefined;
  queryCount = 1;
  let contracts = methodKey
    ? await db.query<{ id: string }>(
      `MATCH (c:Contract) WHERE c.kind = $kind AND (c.key = $key OR c.key = $methodKey) AND ${publicGraphGenerationPredicate("c")} RETURN c.id AS id;`,
      withPublicGraphSnapshotParams(snapshot, { kind, key, methodKey })
    )
    : await db.query<{ id: string }>(
      `MATCH (c:Contract) WHERE c.kind = $kind AND c.key = $key AND ${publicGraphGenerationPredicate("c")} RETURN c.id AS id;`,
      withPublicGraphSnapshotParams(snapshot, { kind, key })
    );
  // Fallback for API contracts: if no exact match, try matching by path suffix
  // because storage keys may include an HTTP method prefix (e.g.
  // "POST:/mp/promotion/adapter/savepromotion") while the trace target
  // may omit the method (e.g. "api:/mp/promotion/adapter/savepromotion").
  // Both are lowercased by canonicalContractKey, so ENDS WITH matches
  // across HTTP methods (e.g. GET, POST) — acceptable for an interactive
  // trace fallback.  If a path is served by multiple methods this returns
  // all of them.
  if (contracts.length === 0 && kind === "api" && !methodKey) {
    queryCount += 1;
    contracts = await db.query<{ id: string }>(
      `MATCH (c:Contract) WHERE c.kind = $kind AND c.key ENDS WITH $suffix AND ${publicGraphGenerationPredicate("c")} RETURN c.id AS id;`,
      withPublicGraphSnapshotParams(snapshot, { kind, suffix: `:${key}` })
    );
  }
  const contractIds = contracts.map((contract) => contract.id);
  if (contractIds.length === 0) return { rows: [], queryCount };
  const rows: ContractTraceRow[] = [];
  for (const [rel, role] of [["OWNS_PACKAGE", "owner"], ["PRODUCES", "producer"], ["CONSUMES", "consumer"], ["SHARES_CONTRACT", "shared"]] as const) {
    queryCount += 1;
    rows.push(...await traceContractRole(db, snapshot, contractIds, rel, role, limit));
  }
  return {
    rows: rows.sort((a, b) => a.repoName.localeCompare(b.repoName) || a.role.localeCompare(b.role) || a.line - b.line).slice(0, limit),
    queryCount
  };
  } catch (error) {
    if (!(error instanceof GraphDatabaseOperationalError)) throw error;
    throw new CountedGraphQueryError(queryCount, { cause: error });
  }
}

export async function traceContract(db: GraphDB, snapshot: PublicGraphReadSnapshot, kind: ContractKind, value: string, method?: string, limit = 100): Promise<ContractTraceRow[]> {
  return (await traceContractWithQueryCount(db, snapshot, kind, value, method, limit)).rows;
}

export async function listUnresolvedEvidence(db: GraphDB, snapshot: PublicGraphReadSnapshot, limit = 100): Promise<UnresolvedEvidenceRow[]> {
  const rows = await db.query<Omit<UnresolvedEvidenceRow, "reason" | "resolution">>(
    `MATCH (r:Repo)-[re:HAS_EVIDENCE]->(e:Evidence)
     WHERE e.rule = 'dynamic-unresolved' AND ${publicGraphGenerationPredicate("r", "re", "e")}
       AND ${publicGraphActivePredicate("e")}
     RETURN r.name AS repoName, e.filePath AS filePath, e.line AS line, e.raw AS raw, e.rule AS rule
     ORDER BY r.name, e.filePath, e.line
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot)
  );
  return rows.map((row) => ({
    ...row,
    reason: row.raw.match(/unresolved:\s*(.+)$/)?.[1] ?? "dynamic expression could not be resolved statically",
    resolution: "dynamic-unresolved"
  }));
}

export async function listLowConfidenceRelations(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  options: { minConfidence: number; limit: number }
): Promise<LowConfidenceRelationRow[]> {
  const rels = [
    ["PRODUCES", "producer"],
    ["CONSUMES", "consumer"],
    ["SHARES_CONTRACT", "shared"],
    ["OWNS_PACKAGE", "owner"]
  ] as const;

  const results = await Promise.all(
    rels.map(([rel, role]) => db.query<LowConfidenceRelationRow>(
      `MATCH (r:Repo)-[edge:${rel}]->(c:Contract), (e:Evidence)
       WHERE edge.evidenceId = e.id
         AND ${publicGraphGenerationPredicate("r", "edge", "c", "e")}
         AND ${publicGraphActivePredicate("edge", "e")}
         AND edge.confidence < $minConfidence
       RETURN e.id AS evidenceId, r.name AS repoName, c.kind AS contractKind, c.key AS contractKey,
              '${role}' AS role, edge.confidence AS confidence, e.filePath AS filePath,
              e.line AS line, e.rule AS rule, e.raw AS raw
       LIMIT $limit;`,
      withPublicGraphSnapshotParams(snapshot, options)
    ))
  );
  return results.flat();
}

export async function listProducerContracts(db: GraphDB, snapshot: PublicGraphReadSnapshot): Promise<ProducerContractRow[]> {
  return db.query<ProducerContractRow>(
    `MATCH (r:Repo)-[p:PRODUCES]->(c:Contract)
     WHERE ${publicGraphGenerationPredicate("r", "p", "c")}
       AND ${publicGraphActivePredicate("p")}
     RETURN c.kind AS contractKind, c.key AS contractKey, r.name AS repoName;`,
    withPublicGraphSnapshotParams(snapshot)
  );
}

export async function listContractKeysByKind(db: GraphDB, snapshot: PublicGraphReadSnapshot, kind: ContractKind): Promise<ContractKeyRow[]> {
  return db.query<ContractKeyRow>(
    `MATCH (c:Contract) WHERE c.kind = $kind AND ${publicGraphGenerationPredicate("c")} RETURN c.key AS key;`,
    withPublicGraphSnapshotParams(snapshot, { kind })
  );
}

export async function listRepoContractKeysByRole(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  input: { kind: ContractKind; role: Extract<ContractRole, "producer" | "consumer" | "owner" | "shared"> }
): Promise<RepoContractKeyRow[]> {
  const rel = input.role === "owner"
    ? "OWNS_PACKAGE"
    : input.role === "producer"
      ? "PRODUCES"
      : input.role === "consumer"
        ? "CONSUMES"
        : "SHARES_CONTRACT";
  return db.query<RepoContractKeyRow>(
    `MATCH (r:Repo)-[edge:${rel}]->(c:Contract)
     WHERE c.kind = $kind AND ${publicGraphGenerationPredicate("r", "edge", "c")}
       AND ${publicGraphActivePredicate("edge")}
     RETURN r.name AS repoName, c.key AS key;`,
    withPublicGraphSnapshotParams(snapshot, { kind: input.kind })
  );
}

export async function listRepoContractCountsByRole(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  input: { kind: ContractKind; role: Extract<ContractRole, "producer" | "consumer" | "owner" | "shared"> }
): Promise<RepoContractCountRow[]> {
  const rel = input.role === "owner"
    ? "OWNS_PACKAGE"
    : input.role === "producer"
      ? "PRODUCES"
      : input.role === "consumer"
        ? "CONSUMES"
        : "SHARES_CONTRACT";
  return db.query<RepoContractCountRow>(
    `MATCH (r:Repo)-[edge:${rel}]->(c:Contract)
     WHERE c.kind = $kind AND ${publicGraphGenerationPredicate("r", "edge", "c")}
       AND ${publicGraphActivePredicate("edge")}
     RETURN r.name AS repoName, count(c) AS count;`,
    withPublicGraphSnapshotParams(snapshot, { kind: input.kind })
  );
}

export async function loadActiveSemanticGraph(db: GraphDB, snapshot: PublicGraphReadSnapshot): Promise<ActiveSemanticGraph> {
  const [specRows, relRows] = await Promise.all([
    db.query<SpecRow>(
      `MATCH (s:ContractSpec)
       WHERE s.workspaceId = $workspaceId AND s.generation = $generation
         AND ${publicGraphActivePredicate("s")}
       RETURN ${SPEC_RETURN}`,
      withPublicGraphSnapshotParams(snapshot)
    ),
    db.query<SemanticRelRow>(
      `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
       WHERE a.workspaceId = $workspaceId AND a.generation = $generation
         AND r.workspaceId = $workspaceId AND r.generation = $generation
         AND b.workspaceId = $workspaceId AND b.generation = $generation
         AND ${publicGraphActivePredicate("a", "r", "b")}
       RETURN ${SEMANTIC_REL_RETURN}`,
      withPublicGraphSnapshotParams(snapshot)
    )
  ]);

  if (relRows.some((row) => row.kind === "CALLS_ENDPOINT")) {
    throw new Error(
      `Legacy CALLS_ENDPOINT relations detected. Run a full \`${BRAND.cliName} index\` with this version; \`rebuild-relations\` alone cannot repair legacy caller symbols.`
    );
  }

  return {
    specs: specRows.map(rowToReadableContractSpec),
    relations: relRows.map(rowToSemanticRel)
  };
}

export async function loadActiveKnownContractSpecs(db: GraphDB, snapshot: PublicGraphReadSnapshot): Promise<ContractSpecNode[]> {
  const rows = await db.query<SpecRow>(
    `MATCH (s:ContractSpec)
     WHERE s.workspaceId = $workspaceId AND s.generation = $generation
       AND ${publicGraphActivePredicate("s")}
     RETURN ${SPEC_RETURN}`,
    withPublicGraphSnapshotParams(snapshot)
  );
  return rows.filter((row) => isKnownSpecKind(row.specKind)).map(rowToContractSpec);
}

export async function loadActiveRepoDependencies(db: GraphDB, snapshot: PublicGraphReadSnapshot): Promise<RepoDependencyEdge[]> {
  const rows = await db.query<DepEdgeRow>(
    `MATCH (from:Repo)-[d:DEPENDS_ON]->(to:Repo)
     WHERE from.workspaceId = $workspaceId AND from.generation = $generation
       AND d.workspaceId = $workspaceId AND d.generation = $generation
       AND to.workspaceId = $workspaceId AND to.generation = $generation
       AND ${publicGraphActivePredicate("d")}
     RETURN ${DEP_EDGE_RETURN}`,
    withPublicGraphSnapshotParams(snapshot)
  );
  return rows.map(rowToDepEdge);
}

export async function traceEntity(db: GraphDB, snapshot: PublicGraphReadSnapshot, value: string, limit = 100): Promise<EntityTraceRow[]> {
  const lowered = value.toLowerCase();
  const rows: EntityTraceRow[] = [];
  rows.push(...await db.query<EntityTraceRow>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fc:CONTAINS]->(c:Code)-[m:MENTIONS]->(e:Entity)
     WHERE (lower(e.name) CONTAINS $term OR lower(c.name) CONTAINS $term OR lower(c.qualifiedName) CONTAINS $term)
       AND ${publicGraphGenerationPredicate("r", "rf", "f", "fc", "c", "m", "e")}
       AND ${publicGraphActivePredicate("f", "c")}
     RETURN e.id AS entityId, e.name AS entityName, r.name AS repoName, 'code' AS sourceKind, c.qualifiedName AS name, f.path AS filePath, c.startLine AS line, 'mentions' AS role, c.signature AS evidence, m.confidence AS confidence
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { term: lowered })
  ));
  rows.push(...await db.query<EntityTraceRow>(
    `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fs:CONTAINS]->(s:Section)-[m:MENTIONS]->(e:Entity)
     WHERE (lower(e.name) CONTAINS $term OR lower(s.heading) CONTAINS $term OR lower(s.text) CONTAINS $term)
       AND ${publicGraphGenerationPredicate("r", "rf", "f", "fs", "s", "m", "e")}
       AND ${publicGraphActivePredicate("f", "s")}
     RETURN e.id AS entityId, e.name AS entityName, r.name AS repoName, 'section' AS sourceKind, s.heading AS name, f.path AS filePath, s.startLine AS line, 'mentions' AS role, s.text AS evidence, m.confidence AS confidence
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { term: lowered })
  ));
  for (const [rel, role] of [["OWNS_PACKAGE", "owner"], ["PRODUCES", "producer"], ["CONSUMES", "consumer"], ["SHARES_CONTRACT", "shared"]] as const) {
    rows.push(...await db.query<EntityTraceRow>(
      `MATCH (r:Repo)-[edge:${rel}]->(c:Contract)-[m:CONTRACT_MENTIONS]->(e:Entity), (ev:Evidence)
       WHERE m.evidenceId = ev.id AND ev.repoId = r.id
         AND (lower(e.name) CONTAINS $term OR lower(c.name) CONTAINS $term OR lower(c.key) CONTAINS $term)
         AND ${publicGraphGenerationPredicate("r", "edge", "c", "m", "e", "ev")}
         AND ${publicGraphActivePredicate("edge", "m", "ev")}
       RETURN e.id AS entityId, e.name AS entityName, r.name AS repoName, 'contract' AS sourceKind, c.kind + ':' + c.key AS name, ev.filePath AS filePath, ev.line AS line, '${role}' AS role, ev.raw AS evidence, m.confidence AS confidence
       LIMIT ${limit};`,
      withPublicGraphSnapshotParams(snapshot, { term: lowered })
    ));
  }
  rows.push(...await db.query<EntityTraceRow>(
    `MATCH (r:Repo)-[p:PARTICIPATES_IN]->(o:Operation)
     WHERE (lower(o.entityName) CONTAINS $term OR lower(o.description) CONTAINS $term)
       AND ${publicGraphGenerationPredicate("r", "p", "o")}
       AND ${publicGraphActivePredicate("p")}
     RETURN 'entity:' + lower(o.entityName) AS entityId, o.entityName AS entityName, r.name AS repoName, 'operation' AS sourceKind, o.verb AS name, '' AS filePath, 0 AS line, p.role AS role, o.description AS evidence, p.confidence AS confidence
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { term: lowered })
  ));
  rows.push(...await db.query<EntityTraceRow>(
    `MATCH (w:Workflow)-[s:WORKFLOW_STEP]->(o:Operation)<-[p:PARTICIPATES_IN]-(r:Repo)
     WHERE (lower(w.name) CONTAINS $term OR lower(o.entityName) CONTAINS $term OR lower(w.description) CONTAINS $term)
       AND ${publicGraphGenerationPredicate("w", "s", "o", "p", "r")}
       AND ${publicGraphActivePredicate("s", "p")}
     RETURN 'entity:' + lower(o.entityName) AS entityId, o.entityName AS entityName, r.name AS repoName, 'workflow' AS sourceKind, w.name AS name, '' AS filePath, s.step AS line, p.role AS role, w.description AS evidence, s.confidence AS confidence
     LIMIT ${limit};`,
    withPublicGraphSnapshotParams(snapshot, { term: lowered })
  ));
  return [...new Map(rows.map((row) => [`${row.repoName}:${row.sourceKind}:${row.name}:${row.line}:${row.role}`, row])).values()].slice(0, limit);
}

export async function traceEntitiesExactWithQueryCount(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  values: readonly string[],
  limit = 100
): Promise<CountedQueryResult<EntityTraceRow>> {
  if (values.length === 0 || limit < 1) return { rows: [], queryCount: 0 };
  let attemptedQueryCount = 0;
  try {
  const normalizedValues = [...new Set(values.map((value) => value.normalize("NFC").toLowerCase()))].sort();
  const params = withPublicGraphSnapshotParams(snapshot, { values: normalizedValues });
  const perQueryLimit = limit;
  const queries: Array<() => Promise<EntityTraceRow[]>> = [
    () => db.query<EntityTraceRow>(
      `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fc:CONTAINS]->(c:Code)-[m:MENTIONS]->(e:Entity)
       WHERE (lower(e.name) IN $values OR lower(c.name) IN $values OR lower(c.qualifiedName) IN $values OR c.id IN $values)
         AND ${publicGraphGenerationPredicate("r", "rf", "f", "fc", "c", "m", "e")}
         AND ${publicGraphActivePredicate("f", "c")}
       RETURN e.id AS entityId, e.name AS entityName, r.name AS repoName, 'code' AS sourceKind, c.qualifiedName AS name, f.path AS filePath, c.startLine AS line, 'mentions' AS role, c.signature AS evidence, m.confidence AS confidence, c.id AS sourceId, '' AS evidenceId
       ORDER BY r.id, c.id, e.id, f.path, c.startLine, m.confidence
       LIMIT ${perQueryLimit};`, params),
    () => db.query<EntityTraceRow>(
      `MATCH (r:Repo)-[rf:CONTAINS]->(f:File)-[fs:CONTAINS]->(s:Section)-[m:MENTIONS]->(e:Entity)
       WHERE (lower(e.name) IN $values OR lower(s.heading) IN $values OR s.id IN $values)
         AND ${publicGraphGenerationPredicate("r", "rf", "f", "fs", "s", "m", "e")}
         AND ${publicGraphActivePredicate("f", "s")}
       RETURN e.id AS entityId, e.name AS entityName, r.name AS repoName, 'section' AS sourceKind, s.heading AS name, f.path AS filePath, s.startLine AS line, 'mentions' AS role, s.text AS evidence, m.confidence AS confidence, s.id AS sourceId, '' AS evidenceId
       ORDER BY r.id, s.id, e.id, f.path, s.startLine, m.confidence
       LIMIT ${perQueryLimit};`, params)
  ];
  for (const [rel, role] of [["OWNS_PACKAGE", "owner"], ["PRODUCES", "producer"], ["CONSUMES", "consumer"], ["SHARES_CONTRACT", "shared"]] as const) {
    queries.push(() => db.query<EntityTraceRow>(
      `MATCH (r:Repo)-[edge:${rel}]->(c:Contract)-[m:CONTRACT_MENTIONS]->(e:Entity), (ev:Evidence)
       WHERE m.evidenceId = ev.id AND ev.repoId = r.id
         AND (lower(e.name) IN $values OR lower(c.name) IN $values OR lower(c.key) IN $values OR lower(c.id) IN $values)
         AND ${publicGraphGenerationPredicate("r", "edge", "c", "m", "e", "ev")}
         AND ${publicGraphActivePredicate("edge", "m", "ev")}
       RETURN e.id AS entityId, e.name AS entityName, r.name AS repoName, 'contract' AS sourceKind, c.kind + ':' + c.key AS name, ev.filePath AS filePath, ev.line AS line, '${role}' AS role, ev.raw AS evidence, m.confidence AS confidence, c.id AS sourceId, ev.id AS evidenceId
       ORDER BY r.id, c.id, e.id, ev.id, ev.filePath, ev.line, m.confidence
       LIMIT ${perQueryLimit};`, params));
  }
  queries.push(
    () => db.query<EntityTraceRow>(
      `MATCH (r:Repo)-[p:PARTICIPATES_IN]->(o:Operation)
       WHERE (lower(o.entityName) IN $values OR lower(o.verb) IN $values OR o.id IN $values)
         AND ${publicGraphGenerationPredicate("r", "p", "o")}
         AND ${publicGraphActivePredicate("p")}
       RETURN 'entity:' + lower(o.entityName) AS entityId, o.entityName AS entityName, r.name AS repoName, 'operation' AS sourceKind, o.verb AS name, '' AS filePath, 0 AS line, p.role AS role, o.description AS evidence, p.confidence AS confidence, o.id AS sourceId, p.evidenceId AS evidenceId
       ORDER BY r.id, o.id, p.evidenceId, p.role, p.confidence
       LIMIT ${perQueryLimit};`, params),
    () => db.query<EntityTraceRow>(
      `MATCH (w:Workflow)-[s:WORKFLOW_STEP]->(o:Operation)<-[p:PARTICIPATES_IN]-(r:Repo)
       WHERE (lower(w.name) IN $values OR lower(o.entityName) IN $values OR w.id IN $values OR o.id IN $values)
         AND ${publicGraphGenerationPredicate("w", "s", "o", "p", "r")}
         AND ${publicGraphActivePredicate("s", "p")}
       RETURN 'entity:' + lower(o.entityName) AS entityId, o.entityName AS entityName, r.name AS repoName, 'workflow' AS sourceKind, w.name AS name, '' AS filePath, s.step AS line, p.role AS role, w.description AS evidence, s.confidence AS confidence, w.id AS sourceId, s.evidenceId AS evidenceId
       ORDER BY w.id, s.step, o.id, r.id, s.evidenceId, p.evidenceId, p.role
       LIMIT ${perQueryLimit};`, params)
  );
  const rows: EntityTraceRow[] = [];
  for (const query of queries) {
    attemptedQueryCount += 1;
    rows.push(...await query());
  }
  return { rows: [...new Map(rows
    .sort((left, right) => entityTraceRowKey(left).localeCompare(entityTraceRowKey(right)))
    .map((row) => [entityTraceRowKey(row), row])).values()].slice(0, limit), queryCount: attemptedQueryCount };
  } catch (error) {
    if (!(error instanceof GraphDatabaseOperationalError)) throw error;
    throw new CountedGraphQueryError(attemptedQueryCount, { cause: error });
  }
}

export async function traceEntitiesExact(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  values: readonly string[],
  limit = 100
): Promise<EntityTraceRow[]> {
  return (await traceEntitiesExactWithQueryCount(db, snapshot, values, limit)).rows;
}

// ---------------------------------------------------------------------------
// Phase 4.1: Semantic trace over SEMANTIC_REL edges
// ---------------------------------------------------------------------------

export type SemanticTraceRow = {
  fromSpecId: string;
  toSpecId: string;
  kind: string;
  reason: string;
  confidence: number;
  fromContractKey: string;
  fromSpecKind: string;
  fromRepoId: string;
  toContractKey: string;
  toSpecKind: string;
  toRepoId: string;
};

/**
 * Traces single-hop SEMANTIC_REL edges from/to a given ContractSpec.
 *
 * NOTE: This is a single-hop query only. Multi-hop transitive tracing is
 * not yet implemented. If you need transitive closure, call this function
 * recursively at the application layer.
 *
 * @param db        The graph database connection.
 * @param specId    The ContractSpec ID to start tracing from.
 * @param direction "outgoing" (from → to), "incoming" (to → from), or "both".
 *                  Defaults to "both".
 */
export async function semanticTrace(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  specId: string,
  direction: "outgoing" | "incoming" | "both" = "both"
): Promise<SemanticTraceRow[]> {
  let cypher: string;
  if (direction === "outgoing") {
    cypher = `
      MATCH (a:ContractSpec {id: $specId})-[r:SEMANTIC_REL]->(b:ContractSpec)
      WHERE a.workspaceId = $workspaceId AND a.generation = $generation
        AND r.workspaceId = $workspaceId AND r.generation = $generation
        AND b.workspaceId = $workspaceId AND b.generation = $generation
        AND ${publicGraphActivePredicate("a", "r", "b")}
      RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind,
             r.reason AS reason, r.confidence AS confidence,
             a.canonicalKey AS fromContractKey, a.specKind AS fromSpecKind, a.repoId AS fromRepoId,
             b.canonicalKey AS toContractKey, b.specKind AS toSpecKind, b.repoId AS toRepoId
    `;
  } else if (direction === "incoming") {
    cypher = `
      MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec {id: $specId})
      WHERE a.workspaceId = $workspaceId AND a.generation = $generation
        AND r.workspaceId = $workspaceId AND r.generation = $generation
        AND b.workspaceId = $workspaceId AND b.generation = $generation
        AND ${publicGraphActivePredicate("a", "r", "b")}
      RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind,
             r.reason AS reason, r.confidence AS confidence,
             a.canonicalKey AS fromContractKey, a.specKind AS fromSpecKind, a.repoId AS fromRepoId,
             b.canonicalKey AS toContractKey, b.specKind AS toSpecKind, b.repoId AS toRepoId
    `;
  } else {
    cypher = `
      MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
      WHERE (a.id = $specId OR b.id = $specId)
        AND a.workspaceId = $workspaceId AND a.generation = $generation
        AND r.workspaceId = $workspaceId AND r.generation = $generation
        AND b.workspaceId = $workspaceId AND b.generation = $generation
        AND ${publicGraphActivePredicate("a", "r", "b")}
      RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind,
             r.reason AS reason, r.confidence AS confidence,
             a.canonicalKey AS fromContractKey, a.specKind AS fromSpecKind, a.repoId AS fromRepoId,
             b.canonicalKey AS toContractKey, b.specKind AS toSpecKind, b.repoId AS toRepoId
    `;
  }

  return db.query<SemanticTraceRow>(cypher, withPublicGraphSnapshotParams(snapshot, { specId }));
}

export async function explainSemanticRelationsBetweenRepos(
  db: GraphDB,
  snapshot: PublicGraphReadSnapshot,
  fromRepoId: string,
  toRepoId: string
): Promise<SemanticTraceRow[]> {
  return db.query<SemanticTraceRow>(
    `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
     WHERE a.repoId = $fromRepoId AND b.repoId = $toRepoId
       AND a.workspaceId = $workspaceId AND a.generation = $generation
       AND r.workspaceId = $workspaceId AND r.generation = $generation
       AND b.workspaceId = $workspaceId AND b.generation = $generation
       AND ${publicGraphActivePredicate("a", "r", "b")}
     RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind,
            r.reason AS reason, r.confidence AS confidence,
            a.canonicalKey AS fromContractKey, a.specKind AS fromSpecKind, a.repoId AS fromRepoId,
            b.canonicalKey AS toContractKey, b.specKind AS toSpecKind, b.repoId AS toRepoId;`,
    withPublicGraphSnapshotParams(snapshot, { fromRepoId, toRepoId })
  );
}
