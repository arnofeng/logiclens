import type { GraphDB, ContractSummaryRow } from "./db.js";
export type { ContractSummaryRow } from "./db.js";
import { repoId } from "../../shared/path.js";
import { confidenceBand, type ConfidenceBand } from "../../shared/confidence.js";
import { canonicalContractKey } from "../contracts/extraction/crossRepoContracts.js";
import type { ContractKind, ContractRole } from "../parsing/types.js";

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
};

export async function searchCode(db: GraphDB, term: string, limit = 20): Promise<CodeSearchRow[]> {
  const lowered = term.toLowerCase();
  return db.query<CodeSearchRow>(
    `MATCH (r:Repo)-[:CONTAINS]->(f:File)-[:CONTAINS]->(c:Code)
     WHERE (lower(c.name) CONTAINS $term OR lower(c.qualifiedName) CONTAINS $term OR lower(c.summary) CONTAINS $term OR lower(f.path) CONTAINS $term)
       AND (f.active IS NULL OR f.active = true) AND (c.active IS NULL OR c.active = true)
     RETURN r.name AS repoName, f.path AS filePath, c.id AS codeId, c.kind AS kind, c.name AS name, c.qualifiedName AS qualifiedName, c.summary AS summary, c.signature AS signature
     LIMIT ${limit};`,
    { term: lowered }
  );
}

export async function searchSections(db: GraphDB, term: string, limit = 20): Promise<SectionSearchRow[]> {
  const lowered = term.toLowerCase();
  return db.query<SectionSearchRow>(
    `MATCH (r:Repo)-[:CONTAINS]->(f:File)-[:CONTAINS]->(s:Section)
     WHERE (lower(s.heading) CONTAINS $term OR lower(s.summary) CONTAINS $term OR lower(s.text) CONTAINS $term OR lower(f.path) CONTAINS $term)
       AND (f.active IS NULL OR f.active = true) AND (s.active IS NULL OR s.active = true)
     RETURN r.name AS repoName, f.path AS filePath, s.id AS sectionId, s.heading AS heading, s.level AS level, s.startLine AS startLine, s.endLine AS endLine, s.summary AS summary, s.text AS text
     LIMIT ${limit};`,
    { term: lowered }
  );
}

export async function findImpactSections(db: GraphDB, term: string, limit = 50): Promise<SectionSearchRow[]> {
  const lowered = term.toLowerCase();
  return db.query<SectionSearchRow>(
    `MATCH (r:Repo)-[:CONTAINS]->(f:File)-[:CONTAINS]->(s:Section)
     WHERE (lower(s.heading) CONTAINS $term OR lower(s.summary) CONTAINS $term OR lower(s.text) CONTAINS $term OR lower(f.path) CONTAINS $term)
       AND (f.active IS NULL OR f.active = true) AND (s.active IS NULL OR s.active = true)
     RETURN r.name AS repoName, f.path AS filePath, s.id AS sectionId, s.heading AS heading, s.level AS level, s.startLine AS startLine, s.endLine AS endLine, s.summary AS summary, s.text AS text
     LIMIT ${limit};`,
    { term: lowered }
  );
}

export async function sectionsDocumentingCode(db: GraphDB, codeIds: string[], limit = 50): Promise<SectionSearchRow[]> {
  if (codeIds.length === 0) return [];
  return db.query<SectionSearchRow>(
    `MATCH (r:Repo)-[:CONTAINS]->(f:File)-[:CONTAINS]->(s:Section)-[:DOCUMENTS]->(c:Code)
     WHERE c.id IN $codeIds
       AND (f.active IS NULL OR f.active = true) AND (s.active IS NULL OR s.active = true) AND (c.active IS NULL OR c.active = true)
     RETURN r.name AS repoName, f.path AS filePath, s.id AS sectionId, s.heading AS heading, s.level AS level, s.startLine AS startLine, s.endLine AS endLine, s.summary AS summary, s.text AS text
     LIMIT ${limit};`,
    { codeIds }
  );
}

export async function findImpact(db: GraphDB, term: string): Promise<CodeSearchRow[]> {
  const lowered = term.toLowerCase();
  return db.query<CodeSearchRow>(
    `MATCH (r:Repo)-[:CONTAINS]->(f:File)-[:CONTAINS]->(c:Code)
     WHERE (lower(c.name) CONTAINS $term OR lower(c.qualifiedName) CONTAINS $term OR lower(c.signature) CONTAINS $term OR lower(f.path) CONTAINS $term)
       AND (f.active IS NULL OR f.active = true) AND (c.active IS NULL OR c.active = true)
     RETURN r.name AS repoName, f.path AS filePath, c.id AS codeId, c.kind AS kind, c.name AS name, c.qualifiedName AS qualifiedName, c.summary AS summary, c.signature AS signature
     LIMIT 50;`,
    { term: lowered }
  );
}

export async function hasCodeSymbolMatch(db: GraphDB, term: string): Promise<boolean> {
  const rows = await db.query<{ found: boolean }>(
    `MATCH (:Repo)-[:CONTAINS]->(f:File)-[:CONTAINS]->(c:Code)
     WHERE (c.name = $term OR c.qualifiedName = $term)
       AND (f.active IS NULL OR f.active = true) AND (c.active IS NULL OR c.active = true)
     RETURN true AS found
     LIMIT 1;`,
    { term }
  );
  return rows.length > 0;
}

export async function findContractSourceSymbols(db: GraphDB, contractIds: string[]): Promise<CodeSearchRow[]> {
  if (contractIds.length === 0) return [];
  return db.query<CodeSearchRow>(
    `MATCH (c:Contract)-[hs:HAS_SPEC]->(s:ContractSpec), (r:Repo)-[:CONTAINS]->(f:File)-[:CONTAINS]->(code:Code)
     WHERE c.id IN $contractIds AND s.sourceSymbolId = code.id
       AND (hs.active IS NULL OR hs.active = true)
       AND (s.active IS NULL OR s.active = true)
       AND (f.active IS NULL OR f.active = true) AND (code.active IS NULL OR code.active = true)
     RETURN r.name AS repoName, f.path AS filePath, code.id AS codeId, code.kind AS kind, code.name AS name, code.qualifiedName AS qualifiedName, code.summary AS summary, code.signature AS signature;`,
    { contractIds }
  );
}

export async function listCode(db: GraphDB, limit = 50): Promise<CodeSearchRow[]> {
  return db.query<CodeSearchRow>(
    `MATCH (r:Repo)-[:CONTAINS]->(f:File)-[:CONTAINS]->(c:Code)
     WHERE (f.active IS NULL OR f.active = true) AND (c.active IS NULL OR c.active = true)
     RETURN r.name AS repoName, f.path AS filePath, c.id AS codeId, c.kind AS kind, c.name AS name, c.qualifiedName AS qualifiedName, c.summary AS summary, c.signature AS signature
     LIMIT ${limit};`
  );
}

export async function listDependencies(
  db: GraphDB,
  limitOrOptions?: number | DependencyQueryOptions
): Promise<DependencyRow[]> {
  const options: DependencyQueryOptions =
    typeof limitOrOptions === "number" ? { limit: limitOrOptions } : (limitOrOptions ?? {});
  const limit = options.limit ?? 20;

  const conditions = [
    "d.sourceContractId = c.id",
    "d.evidenceId = e.id",
    "(d.active IS NULL OR d.active = true)",
    "(e.active IS NULL OR e.active = true)"
  ];
  const params: Record<string, any> = {};

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
    Object.keys(params).length > 0 ? params : undefined
  );
  return rows.map((row) => ({ ...row, resolution: confidenceBand(row.confidence) }));
}

export async function listContracts(db: GraphDB, options: { limit?: number; kind?: ContractKind; repo?: string; direction?: "outgoing" | "incoming" } = {}): Promise<ContractSummaryRow[]> {
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
  return db.listContracts(dbOptions);
}

async function traceContractRole(db: GraphDB, contractIds: string[], rel: string, role: ContractRole): Promise<ContractTraceRow[]> {
  if (contractIds.length === 0) return [];
  const rows = await db.query<Omit<ContractTraceRow, "resolution">>(
    `MATCH (r:Repo)-[edge:${rel}]->(c:Contract), (e:Evidence)
     WHERE c.id IN $contractIds AND edge.evidenceId = e.id
       AND (edge.active IS NULL OR edge.active = true) AND (e.active IS NULL OR e.active = true)
     RETURN c.id AS contractId, c.kind AS kind, c.key AS key, c.name AS name, '${role}' AS role, r.name AS repoName, e.filePath AS filePath, e.line AS line, e.raw AS raw, e.rule AS rule, e.confidence AS confidence;`,
    { contractIds }
  );
  return rows.map((row) => ({ ...row, resolution: confidenceBand(row.confidence) }));
}

export async function traceContract(db: GraphDB, kind: ContractKind, value: string): Promise<ContractTraceRow[]> {
  const key = canonicalContractKey(kind, value);
  let contracts = await db.query<{ id: string }>(
    "MATCH (c:Contract) WHERE c.kind = $kind AND c.key = $key RETURN c.id AS id;",
    { kind, key }
  );
  // Fallback for API contracts: if no exact match, try matching by path suffix
  // because storage keys may include an HTTP method prefix (e.g.
  // "POST:/mp/promotion/adapter/savepromotion") while the trace target
  // may omit the method (e.g. "api:/mp/promotion/adapter/savepromotion").
  // Both are lowercased by canonicalContractKey, so ENDS WITH matches
  // across HTTP methods (e.g. GET, POST) — acceptable for an interactive
  // trace fallback.  If a path is served by multiple methods this returns
  // all of them.
  if (contracts.length === 0 && kind === "api") {
    contracts = await db.query<{ id: string }>(
      "MATCH (c:Contract) WHERE c.kind = $kind AND c.key ENDS WITH $suffix RETURN c.id AS id;",
      { kind, suffix: `:${key}` }
    );
  }
  const contractIds = contracts.map((contract) => contract.id);
  if (contractIds.length === 0) return [];
  const rows = (await Promise.all([
    traceContractRole(db, contractIds, "OWNS_PACKAGE", "owner"),
    traceContractRole(db, contractIds, "PRODUCES", "producer"),
    traceContractRole(db, contractIds, "CONSUMES", "consumer"),
    traceContractRole(db, contractIds, "SHARES_CONTRACT", "shared")
  ])).flat();
  return rows.sort((a, b) => a.repoName.localeCompare(b.repoName) || a.role.localeCompare(b.role) || a.line - b.line);
}

export async function listUnresolvedEvidence(db: GraphDB, limit = 100): Promise<UnresolvedEvidenceRow[]> {
  const rows = await db.query<Omit<UnresolvedEvidenceRow, "reason" | "resolution">>(
    `MATCH (r:Repo)-[:HAS_EVIDENCE]->(e:Evidence)
     WHERE e.rule = 'dynamic-unresolved' AND (e.active IS NULL OR e.active = true)
     RETURN r.name AS repoName, e.filePath AS filePath, e.line AS line, e.raw AS raw, e.rule AS rule
     ORDER BY r.name, e.filePath, e.line
     LIMIT ${limit};`
  );
  return rows.map((row) => ({
    ...row,
    reason: row.raw.match(/unresolved:\s*(.+)$/)?.[1] ?? "dynamic expression could not be resolved statically",
    resolution: "dynamic-unresolved"
  }));
}

export async function traceEntity(db: GraphDB, value: string, limit = 100): Promise<EntityTraceRow[]> {
  const lowered = value.toLowerCase();
  const rows: EntityTraceRow[] = [];
  rows.push(...await db.query<EntityTraceRow>(
    `MATCH (r:Repo)-[:CONTAINS]->(f:File)-[:CONTAINS]->(c:Code)-[m:MENTIONS]->(e:Entity)
     WHERE (lower(e.name) CONTAINS $term OR lower(c.name) CONTAINS $term OR lower(c.qualifiedName) CONTAINS $term)
       AND (f.active IS NULL OR f.active = true) AND (c.active IS NULL OR c.active = true)
     RETURN e.id AS entityId, e.name AS entityName, r.name AS repoName, 'code' AS sourceKind, c.qualifiedName AS name, f.path AS filePath, c.startLine AS line, 'mentions' AS role, c.signature AS evidence, m.confidence AS confidence
     LIMIT ${limit};`,
    { term: lowered }
  ));
  rows.push(...await db.query<EntityTraceRow>(
    `MATCH (r:Repo)-[:CONTAINS]->(f:File)-[:CONTAINS]->(s:Section)-[m:MENTIONS]->(e:Entity)
     WHERE (lower(e.name) CONTAINS $term OR lower(s.heading) CONTAINS $term OR lower(s.text) CONTAINS $term)
       AND (f.active IS NULL OR f.active = true) AND (s.active IS NULL OR s.active = true)
     RETURN e.id AS entityId, e.name AS entityName, r.name AS repoName, 'section' AS sourceKind, s.heading AS name, f.path AS filePath, s.startLine AS line, 'mentions' AS role, s.text AS evidence, m.confidence AS confidence
     LIMIT ${limit};`,
    { term: lowered }
  ));
  for (const [rel, role] of [["OWNS_PACKAGE", "owner"], ["PRODUCES", "producer"], ["CONSUMES", "consumer"], ["SHARES_CONTRACT", "shared"]] as const) {
    rows.push(...await db.query<EntityTraceRow>(
      `MATCH (r:Repo)-[:${rel}]->(c:Contract)-[m:CONTRACT_MENTIONS]->(e:Entity), (ev:Evidence)
       WHERE m.evidenceId = ev.id AND ev.repoId = r.id
         AND (lower(e.name) CONTAINS $term OR lower(c.name) CONTAINS $term OR lower(c.key) CONTAINS $term)
         AND (m.active IS NULL OR m.active = true) AND (ev.active IS NULL OR ev.active = true)
       RETURN e.id AS entityId, e.name AS entityName, r.name AS repoName, 'contract' AS sourceKind, c.kind + ':' + c.key AS name, ev.filePath AS filePath, ev.line AS line, '${role}' AS role, ev.raw AS evidence, m.confidence AS confidence
       LIMIT ${limit};`,
      { term: lowered }
    ));
  }
  rows.push(...await db.query<EntityTraceRow>(
    `MATCH (r:Repo)-[p:PARTICIPATES_IN]->(o:Operation)
     WHERE (lower(o.entityName) CONTAINS $term OR lower(o.description) CONTAINS $term)
       AND (p.active IS NULL OR p.active = true)
     RETURN 'entity:' + lower(o.entityName) AS entityId, o.entityName AS entityName, r.name AS repoName, 'operation' AS sourceKind, o.verb AS name, '' AS filePath, 0 AS line, p.role AS role, o.description AS evidence, p.confidence AS confidence
     LIMIT ${limit};`,
    { term: lowered }
  ));
  rows.push(...await db.query<EntityTraceRow>(
    `MATCH (w:Workflow)-[s:WORKFLOW_STEP]->(o:Operation)<-[p:PARTICIPATES_IN]-(r:Repo)
     WHERE (lower(w.name) CONTAINS $term OR lower(o.entityName) CONTAINS $term OR lower(w.description) CONTAINS $term)
       AND (s.active IS NULL OR s.active = true) AND (p.active IS NULL OR p.active = true)
     RETURN 'entity:' + lower(o.entityName) AS entityId, o.entityName AS entityName, r.name AS repoName, 'workflow' AS sourceKind, w.name AS name, '' AS filePath, s.step AS line, p.role AS role, w.description AS evidence, s.confidence AS confidence
     LIMIT ${limit};`,
    { term: lowered }
  ));
  return [...new Map(rows.map((row) => [`${row.repoName}:${row.sourceKind}:${row.name}:${row.line}:${row.role}`, row])).values()].slice(0, limit);
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
  specId: string,
  direction: "outgoing" | "incoming" | "both" = "both"
): Promise<SemanticTraceRow[]> {
  let cypher: string;
  if (direction === "outgoing") {
    cypher = `
      MATCH (a:ContractSpec {id: $specId})-[r:SEMANTIC_REL]->(b:ContractSpec)
      WHERE r.active IS NULL OR r.active = true
      RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind,
             r.reason AS reason, r.confidence AS confidence,
             a.canonicalKey AS fromContractKey, a.specKind AS fromSpecKind, a.repoId AS fromRepoId,
             b.canonicalKey AS toContractKey, b.specKind AS toSpecKind, b.repoId AS toRepoId
    `;
  } else if (direction === "incoming") {
    cypher = `
      MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec {id: $specId})
      WHERE r.active IS NULL OR r.active = true
      RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind,
             r.reason AS reason, r.confidence AS confidence,
             a.canonicalKey AS fromContractKey, a.specKind AS fromSpecKind, a.repoId AS fromRepoId,
             b.canonicalKey AS toContractKey, b.specKind AS toSpecKind, b.repoId AS toRepoId
    `;
  } else {
    cypher = `
      MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
      WHERE (a.id = $specId OR b.id = $specId)
        AND (r.active IS NULL OR r.active = true)
      RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind,
             r.reason AS reason, r.confidence AS confidence,
             a.canonicalKey AS fromContractKey, a.specKind AS fromSpecKind, a.repoId AS fromRepoId,
             b.canonicalKey AS toContractKey, b.specKind AS toSpecKind, b.repoId AS toRepoId
    `;
  }

  return db.query<SemanticTraceRow>(cypher, { specId });
}

export async function explainSemanticRelationsBetweenRepos(
  db: GraphDB,
  fromRepoId: string,
  toRepoId: string
): Promise<SemanticTraceRow[]> {
  return db.query<SemanticTraceRow>(
    `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
     WHERE a.repoId = $fromRepoId AND b.repoId = $toRepoId
       AND (a.active IS NULL OR a.active = true)
       AND (b.active IS NULL OR b.active = true)
       AND (r.active IS NULL OR r.active = true)
     RETURN a.id AS fromSpecId, b.id AS toSpecId, r.kind AS kind,
            r.reason AS reason, r.confidence AS confidence,
            a.canonicalKey AS fromContractKey, a.specKind AS fromSpecKind, a.repoId AS fromRepoId,
            b.canonicalKey AS toContractKey, b.specKind AS toSpecKind, b.repoId AS toRepoId;`,
    { fromRepoId, toRepoId }
  );
}
