// ---------------------------------------------------------------------------
// Phase 5: Impact Analysis Engine
//
// Walks the SEMANTIC_REL graph transitively from a changed ContractSpec to
// find all directly and indirectly affected consumers. For schema field
// changes, performs memory-level regex search in consumer files to locate
// field references (avoids SchemaField node explosion in the graph).
// ---------------------------------------------------------------------------

import type {
  ContractSpecNode,
  SemanticRelationEdge,
  SemanticRelationKind
} from "../../parsing/types.js";
import { deserializeSpec, type HttpEndpointSpec, type EventSpec, type SchemaSpec } from "../spec.js";
import {
  CONSUMER_TO_PRODUCER_KINDS,
  SCHEMA_TO_USE_KINDS
} from "../semanticRelations.js";
import {
  type ChangeIntent,
  type ImpactItem,
  type ImpactReport,
  type ImpactSeverity
} from "./types.js";
import { assessHttpEndpointChange } from "./rules/httpImpactRules.js";
import { assessEventChange } from "./rules/eventImpactRules.js";
import { assessSchemaFieldChange } from "./rules/schemaImpactRules.js";

// ---------------------------------------------------------------------------
// Graph traversal helpers
// ---------------------------------------------------------------------------

/** Builds an adjacency list from SEMANTIC_REL edges (outgoing direction). */
function buildAdjacency(
  edges: SemanticRelationEdge[]
): Map<string, { toSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number }[]> {
  const adj = new Map<string, { toSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number }[]>();
  for (const e of edges) {
    const list = adj.get(e.fromSpecId);
    if (list) {
      list.push({ toSpecId: e.toSpecId, kind: e.kind, reason: e.reason, confidence: e.confidence });
    } else {
      adj.set(e.fromSpecId, [{ toSpecId: e.toSpecId, kind: e.kind, reason: e.reason, confidence: e.confidence }]);
    }
  }
  return adj;
}

/** Builds a reverse adjacency list (incoming direction). */
function buildReverseAdjacency(
  edges: SemanticRelationEdge[]
): Map<string, { fromSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number }[]> {
  const adj = new Map<string, { fromSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number }[]>();
  for (const e of edges) {
    const list = adj.get(e.toSpecId);
    if (list) {
      list.push({ fromSpecId: e.fromSpecId, kind: e.kind, reason: e.reason, confidence: e.confidence });
    } else {
      adj.set(e.toSpecId, [{ fromSpecId: e.fromSpecId, kind: e.kind, reason: e.reason, confidence: e.confidence }]);
    }
  }
  return adj;
}

/**
 * Finds all specs reachable from `startSpecIds` by following outgoing edges
 * up to `maxHops` hops. Returns a map of specId → hop distance.
 */
function traverseOutgoing(
  startSpecIds: Set<string>,
  adjacency: Map<string, { toSpecId: string; kind: SemanticRelationKind; confidence: number }[]>,
  maxHops: number
): Map<string, number> {
  const visited = new Map<string, number>();
  let frontier = new Set(startSpecIds);
  for (const id of frontier) visited.set(id, 0);

  for (let hop = 1; hop <= maxHops; hop++) {
    const next = new Set<string>();
    for (const id of frontier) {
      const neighbors = adjacency.get(id);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!visited.has(n.toSpecId)) {
          visited.set(n.toSpecId, hop);
          next.add(n.toSpecId);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  return visited;
}

/**
 * Finds all specs that reach `startSpecIds` by following incoming edges
 * up to `maxHops` hops.
 */
function traverseIncoming(
  startSpecIds: Set<string>,
  reverseAdj: Map<string, { fromSpecId: string; kind: SemanticRelationKind; confidence: number }[]>,
  maxHops: number
): Map<string, number> {
  const visited = new Map<string, number>();
  let frontier = new Set(startSpecIds);
  for (const id of frontier) visited.set(id, 0);

  for (let hop = 1; hop <= maxHops; hop++) {
    const next = new Set<string>();
    for (const id of frontier) {
      const neighbors = reverseAdj.get(id);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (!visited.has(n.fromSpecId)) {
          visited.set(n.fromSpecId, hop);
          next.add(n.fromSpecId);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  return visited;
}

// ---------------------------------------------------------------------------
// Edge collection — finds the specific edges on shortest paths
// ---------------------------------------------------------------------------

/** Collects the incoming edges that connect visited specs to their predecessors. */
function collectIncomingEdgesOnPaths(
  visited: Map<string, number>,
  reverseAdj: Map<string, { fromSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number }[]>
): { fromSpecId: string; toSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number; hop: number }[] {
  const result: { fromSpecId: string; toSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number; hop: number }[] = [];

  for (const [toId, hop] of visited) {
    if (hop === 0) continue; // starting nodes
    const incoming = reverseAdj.get(toId);
    if (!incoming) continue;
    // Find the incoming edge that gives the shortest path
    let bestHop = Infinity;
    let bestEdge: { fromSpecId: string; kind: SemanticRelationKind; reason: string; confidence: number } | null = null;
    for (const e of incoming) {
      const fromHop = visited.get(e.fromSpecId);
      if (fromHop !== undefined && fromHop < bestHop) {
        bestHop = fromHop;
        bestEdge = e;
      }
    }
    if (bestEdge && bestHop === hop - 1) {
      result.push({ ...bestEdge, toSpecId: toId, hop });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// File-based field search (memory-level, avoids SchemaField node explosion)
// ---------------------------------------------------------------------------

/**
 * Searches source text for references to a field name.
 * Uses regex to find field access patterns like `.fieldName`, `["fieldName"]`,
 * `getFieldName()`, `setFieldName(...)`.
 */
export function findFieldReferences(
  sourceText: string,
  fieldName: string
): { line: number; raw: string }[] {
  const results: { line: number; raw: string }[] = [];
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    // .fieldName (dot access) — case-sensitive to avoid false matches like .ID matching .id
    new RegExp(`\\.${escaped}\\b`, "g"),
    // ["fieldName"] or ['fieldName'] (bracket access)
    new RegExp(`\\[["']${escaped}["']\\]`, "g"),
    // getFieldName() / setFieldName() (Java-style accessors, case-insensitive prefix)
    new RegExp(`\\b(get|set)${escaped.charAt(0).toUpperCase()}${escaped.slice(1)}\\b`, "g"),
  ];

  const seenLines = new Set<number>();
  const lines = sourceText.split("\n");

  for (const pattern of patterns) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Reset lastIndex for global regex
      pattern.lastIndex = 0;
      if (pattern.test(line) && !seenLines.has(i + 1)) {
        seenLines.add(i + 1);
        results.push({ line: i + 1, raw: line.trim() });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Spec resolution
// ---------------------------------------------------------------------------

/**
 * Parses a target string like "schema:CreateOrderRequest" or
 * "api:POST:/api/orders" into { kind, key } components.
 */
export function parseTarget(target: string): { kind: string; key: string } | null {
  const colonIdx = target.indexOf(":");
  if (colonIdx === -1) {
    // Could be a bare schema name — treat as schema kind
    return { kind: "schema", key: target };
  }
  const kind = target.slice(0, colonIdx);
  const key = target.slice(colonIdx + 1);
  return { kind, key };
}

/**
 * Finds ContractSpec nodes matching a target string.
 */
export function findTargetSpecs(
  target: string,
  specs: ContractSpecNode[]
): ContractSpecNode[] {
  const parsed = parseTarget(target);
  if (!parsed) return [];

  // Map user-facing kind to specKind
  const specKindMap: Record<string, string> = {
    api: "http-endpoint",
    http: "http-endpoint",
    event: "event",
    schema: "schema",
    dto: "schema",
    package: "package",
    config: "config",
  };
  const targetSpecKind = specKindMap[parsed.kind] ?? parsed.kind;

  return specs.filter((s) => {
    if (s.specKind !== targetSpecKind) return false;
    // Match by canonicalKey, contractId, or name within specJson
    if (s.canonicalKey === parsed.key) return true;
    if (s.contractId.endsWith(`:${parsed.key}`)) return true;
    // For schema, also match by name in specJson
    if (s.specKind === "schema") {
      try {
        const spec = deserializeSpec(s.specJson);
        if (spec.kind === "schema" && spec.name === parsed.key) return true;
      } catch { /* ignore parse errors */ }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function worstSeverity(a: ImpactSeverity, b: ImpactSeverity): ImpactSeverity {
  const order: ImpactSeverity[] = ["compatible", "risky", "breaking"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Main analysis entry point
// ---------------------------------------------------------------------------

export type ImpactAnalysisOptions = {
  /**
   * Optional function to read file contents for field-level search.
   * Takes a `repoId/filePath` string and returns the file contents.
   * If omitted, field-level search is skipped and impacts are reported
   * at the contract level only.
   */
  readFile?: (repoId: string, filePath: string) => string | undefined;
  /** Maximum BFS depth for transitive impact traversal (default 3). */
  maxHops?: number;
};

/**
 * Analyzes the downstream impact of a contract change.
 *
 * Algorithm:
 * 1. Resolve the target change to matching ContractSpec node(s)
 * 2. Phase 1 (schema changes): walk outgoing edges to find endpoints/events
 *    that use the schema, then walk incoming edges to find consumers
 * 3. Phase 1 (endpoint/event changes): walk incoming edges to find consumers
 * 4. For each reachable dependent spec, apply the appropriate impact rule
 * 5. For schema field changes, search consumer files for field references
 * 6. Aggregate into a structured ImpactReport
 */
export function analyzeImpact(
  change: ChangeIntent,
  specs: ContractSpecNode[],
  relations: SemanticRelationEdge[],
  options: ImpactAnalysisOptions = {}
): ImpactReport {
  const maxHops = options.maxHops ?? 3;

  // -- Step 1: Resolve target specs ------------------------------------------
  const targetSpecs = findTargetSpecs(change.target, specs);
  if (targetSpecs.length === 0) {
    return {
      change,
      overallSeverity: "compatible",
      impacts: [],
      summary: { breaking: 0, risky: 0, compatible: 0 },
      recommendedFiles: [],
      traversedEdgeCount: 0,
      inspectedSpecCount: 0,
    };
  }

  const targetSpecIds = new Set(targetSpecs.map((s) => s.id));
  const specMap = new Map(specs.map((s) => [s.id, s]));
  const isSchemaChange = targetSpecs[0]?.specKind === "schema";
  const isEventChange = targetSpecs[0]?.specKind === "event";

  const adjacency = buildAdjacency(relations);
  const reverseAdj = buildReverseAdjacency(relations);

  // -- Step 2: Traverse the graph --------------------------------------------
  const impacts: ImpactItem[] = [];
  const seenEdges = new Set<string>();
  let inspectedSpecIds = new Set(targetSpecIds);

  // For the target specs themselves, produce an "intended change" item
  for (const ts of targetSpecs) {
    const targetItem = classifyTargetChange(change, ts);
    if (targetItem) impacts.push(targetItem);
  }

  if (isSchemaChange) {
    // Phase 1a: Outgoing from schema → endpoints/events that use it
    const outgoingVisited = traverseOutgoing(targetSpecIds, adjacency, maxHops);

    for (const [specId, hop] of outgoingVisited) {
      if (hop === 0) continue; // skip the schema itself
      const spec = specMap.get(specId);
      if (!spec) continue;
      inspectedSpecIds.add(specId);

      // Find the edge that connects this spec to its predecessor
      const incoming = reverseAdj.get(specId);
      if (incoming) {
        for (const e of incoming) {
          if (outgoingVisited.has(e.fromSpecId) && SCHEMA_TO_USE_KINDS.has(e.kind)) {
            const edgeKey = `${e.fromSpecId}:${specId}:${e.kind}`;
            if (seenEdges.has(edgeKey)) continue;
            seenEdges.add(edgeKey);

            const items = classifyImpact(change, spec, e.kind, e.reason, e.confidence, options);
            impacts.push(...items);
          }
        }
      }

      // Phase 1b: From endpoints/events, follow incoming consumer edges
      if (incoming) {
        for (const ce of incoming) {
          if (CONSUMER_TO_PRODUCER_KINDS.has(ce.kind)) {
            const consumerSpec = specMap.get(ce.fromSpecId);
            if (!consumerSpec) continue;
            const edgeKey = `${ce.fromSpecId}:${specId}:${ce.kind}`;
            if (seenEdges.has(edgeKey)) continue;
            seenEdges.add(edgeKey);
            inspectedSpecIds.add(ce.fromSpecId);

            const items = classifyImpact(change, consumerSpec, ce.kind, ce.reason, ce.confidence, options);
            impacts.push(...items);
          }
        }
      }
    }
  } else if (isEventChange) {
    // For event changes: walk incoming edges to find consumers.
    // SUBSCRIBES_EVENT 是 consumer → producer, CALLS_ENDPOINT 也是 consumer → producer,
    // 因此与 HTTP 分支一致使用 traverseIncoming.
    const visited = traverseIncoming(targetSpecIds, reverseAdj, maxHops);
    const pathEdges = collectIncomingEdgesOnPaths(visited, reverseAdj);

    for (const pe of pathEdges) {
      const fromSpec = specMap.get(pe.fromSpecId);
      if (!fromSpec || targetSpecIds.has(pe.fromSpecId)) continue;
      inspectedSpecIds.add(pe.fromSpecId);
      inspectedSpecIds.add(pe.toSpecId);

      const edgeKey = `${pe.fromSpecId}:${pe.toSpecId}:${pe.kind}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);

      const items = classifyImpact(change, fromSpec, pe.kind, pe.reason, pe.confidence, options);
      impacts.push(...items);
    }
  } else {
    // For HTTP endpoint changes: walk incoming edges to find consumers
    const visited = traverseIncoming(targetSpecIds, reverseAdj, maxHops);
    const pathEdges = collectIncomingEdgesOnPaths(visited, reverseAdj);

    for (const pe of pathEdges) {
      const fromSpec = specMap.get(pe.fromSpecId);
      if (!fromSpec || targetSpecIds.has(pe.fromSpecId)) continue;
      inspectedSpecIds.add(pe.fromSpecId);
      inspectedSpecIds.add(pe.toSpecId);

      const edgeKey = `${pe.fromSpecId}:${pe.toSpecId}:${pe.kind}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);

      const items = classifyImpact(change, fromSpec, pe.kind, pe.reason, pe.confidence, options);
      impacts.push(...items);
    }
  }

  // -- Step 3: Field-level search in consumer files (schema changes only) ----
  if (isSchemaChange && options.readFile && change.detail) {
    const consumerSpecIds = new Set<string>();
    // Collect all consumer specs from the impacts so far
    for (const edge of relations) {
      if (CONSUMER_TO_PRODUCER_KINDS.has(edge.kind)) {
        consumerSpecIds.add(edge.fromSpecId);
      }
    }

    for (const specId of consumerSpecIds) {
      const spec = specMap.get(specId);
      if (!spec || !spec.fileId) continue;
      const content = options.readFile(spec.repoId, spec.fileId);
      if (!content) continue;

      const refs = findFieldReferences(content, change.detail);
      if (refs.length > 0) {
        for (const ref of refs) {
          impacts.push({
            repoId: spec.repoId,
            specId: spec.id,
            filePath: spec.fileId,
            line: ref.line,
            symbol: `${change.target.split(":").pop() ?? change.target}.${change.detail}`,
            relationKind: "USES_SCHEMA",
            severity: schemaFieldChangeSeverity(change.changeType),
            description: `Field '${change.detail}' referenced in ${spec.repoId}/${spec.fileId}`,
            evidence: ref.raw,
            confidence: spec.confidence,
          });
        }
      }
    }
  }

  // -- Step 4: Deduplicate and aggregate ------------------------------------
  const deduped = deduplicateImpacts(impacts);

  let overallSeverity: ImpactSeverity = "compatible";
  let breaking = 0, risky = 0, compatible = 0;
  for (const imp of deduped) {
    if (imp.severity === "breaking") breaking++;
    else if (imp.severity === "risky") risky++;
    else compatible++;
    overallSeverity = worstSeverity(overallSeverity, imp.severity);
  }

  const recommendedFiles = [...new Set(
    deduped.filter((i) => i.filePath).map((i) => `${i.repoId}/${i.filePath}`)
  )].sort();

  return {
    change,
    overallSeverity,
    impacts: deduped.sort(bySeverityThenRepo),
    summary: { breaking, risky, compatible },
    recommendedFiles,
    traversedEdgeCount: seenEdges.size,
    inspectedSpecCount: inspectedSpecIds.size,
  };
}

// ---------------------------------------------------------------------------
// Impact classification
// ---------------------------------------------------------------------------

function classifyTargetChange(
  change: ChangeIntent,
  spec: ContractSpecNode
): ImpactItem | null {
  const base = {
    repoId: spec.repoId,
    filePath: spec.fileId,
    specId: spec.id,
  };

  if (spec.specKind === "http-endpoint") {
    const httpSpec = deserializeSpec(spec.specJson) as HttpEndpointSpec;
    if (httpSpec.kind !== "http-endpoint") return null;
    if (change.changeType === "endpoint-removed") {
      return {
        ...base,
        severity: "breaking",
        symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        relationKind: "IMPACTS",
        description: `HTTP endpoint ${httpSpec.method ?? "ANY"} ${httpSpec.path} will be removed`,
        evidence: `endpoint: ${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate}`,
        confidence: spec.confidence,
      };
    }
    if (change.changeType === "endpoint-renamed" && change.detail) {
      return {
        ...base,
        severity: "breaking",
        symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        relationKind: "IMPACTS",
        description: `HTTP endpoint renamed to ${change.detail}`,
        evidence: `endpoint: ${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate}`,
        confidence: spec.confidence,
      };
    }
    if (change.changeType === "endpoint-schema-change") {
      return {
        ...base,
        severity: "risky",
        symbol: `${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        relationKind: "IMPACTS",
        description: `Request/response schema changed for ${httpSpec.method ?? "ANY"} ${httpSpec.path}`,
        evidence: `endpoint: ${httpSpec.method ?? "ANY"} ${httpSpec.pathTemplate}`,
        confidence: spec.confidence,
      };
    }
  }

  if (spec.specKind === "event") {
    const eventSpec = deserializeSpec(spec.specJson) as EventSpec;
    if (eventSpec.kind !== "event") return null;
    if (change.changeType === "topic-removed") {
      return {
        ...base,
        severity: "breaking",
        symbol: eventSpec.topic,
        relationKind: "IMPACTS",
        description: `Event topic ${eventSpec.topic} will be removed`,
        evidence: `event: ${eventSpec.topic}${eventSpec.broker ? ` (${eventSpec.broker})` : ""}`,
        confidence: spec.confidence,
      };
    }
    if (change.changeType === "topic-renamed" && change.detail) {
      return {
        ...base,
        severity: "breaking",
        symbol: eventSpec.topic,
        relationKind: "IMPACTS",
        description: `Event topic renamed to ${change.detail}`,
        evidence: `event: ${eventSpec.topic} → ${change.detail}`,
        confidence: spec.confidence,
      };
    }
    if (change.changeType === "event-payload-change") {
      return {
        ...base,
        severity: "risky",
        symbol: eventSpec.topic,
        relationKind: "IMPACTS",
        description: `Event payload changed for ${eventSpec.topic}`,
        evidence: `event: ${eventSpec.topic} payload: ${eventSpec.payloadType ?? "unknown"}`,
        confidence: spec.confidence,
      };
    }
  }

  if (spec.specKind === "schema") {
    const schemaSpec = deserializeSpec(spec.specJson) as SchemaSpec;
    if (schemaSpec.kind !== "schema") return null;
    const fieldName = change.detail ?? "unknown field";
    // Check if the field is optional to adjust severity
    const field = schemaSpec.fields.find((f) => f.name === fieldName);
    const severity = field?.optional && change.changeType === "field-removed"
      ? "risky" : schemaFieldChangeSeverity(change.changeType);
    return {
      ...base,
      severity,
      symbol: `${schemaSpec.name}.${fieldName}`,
      relationKind: "IMPACTS",
      description: `${change.changeType}: ${fieldName} in ${schemaSpec.name}`,
      evidence: `schema: ${schemaSpec.name}.${fieldName}${field ? ` (${field.type}${field.optional ? ", optional" : ""})` : ""}`,
      confidence: spec.confidence,
    };
  }

  return null;
}

function classifyImpact(
  change: ChangeIntent,
  dependentSpec: ContractSpecNode,
  relationKind: SemanticRelationKind,
  reason: string,
  confidence: number,
  options: ImpactAnalysisOptions
): ImpactItem[] {
  if (dependentSpec.specKind === "http-endpoint") {
    return assessHttpEndpointChange(change, dependentSpec, relationKind, reason, confidence);
  }
  if (dependentSpec.specKind === "event") {
    return assessEventChange(change, dependentSpec, relationKind, reason, confidence);
  }
  if (dependentSpec.specKind === "schema") {
    return assessSchemaFieldChange(change, dependentSpec, relationKind, reason, confidence, options);
  }
  return [];
}

function schemaFieldChangeSeverity(
  changeType: ChangeIntent["changeType"]
): ImpactSeverity {
  switch (changeType) {
    case "field-removed": return "breaking";
    case "field-type-changed": return "risky";
    case "field-added": return "compatible";
    default: return "risky";
  }
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function deduplicateImpacts(impacts: ImpactItem[]): ImpactItem[] {
  const seen = new Map<string, ImpactItem>();
  for (const imp of impacts) {
    const key = `${imp.repoId}:${imp.filePath}:${imp.symbol}:${imp.relationKind}:${imp.line ?? 0}`;
    const existing = seen.get(key);
    // Keep the one with higher confidence, or worst severity on tie
    if (!existing || imp.confidence > existing.confidence ||
        (imp.confidence === existing.confidence && severityRank(imp.severity) > severityRank(existing.severity))) {
      seen.set(key, imp);
    }
  }
  return [...seen.values()];
}

function severityRank(s: ImpactSeverity): number {
  return s === "breaking" ? 3 : s === "risky" ? 2 : 1;
}

function bySeverityThenRepo(a: ImpactItem, b: ImpactItem): number {
  const sa = severityRank(a.severity);
  const sb = severityRank(b.severity);
  if (sa !== sb) return sb - sa; // breaking first
  return a.repoId.localeCompare(b.repoId) || a.filePath.localeCompare(b.filePath);
}

// ---------------------------------------------------------------------------
// Graph-DB backed analysis (for runtime use)
// ---------------------------------------------------------------------------

import type { GraphDB } from "../../graph-model/db.js";
import {
  SEMANTIC_REL_RETURN,
  SPEC_RETURN,
  rowToContractSpec,
  rowToSemanticRel,
  type SemanticRelRow,
  type SpecRow
} from "../specRows.js";

/**
 * Analyzes impact by querying the graph database for ContractSpec nodes and
 * SEMANTIC_REL edges, then delegating to the in-memory {@link analyzeImpact}.
 */
export async function analyzeImpactFromDB(
  change: ChangeIntent,
  db: GraphDB,
  options: ImpactAnalysisOptions = {}
): Promise<ImpactReport> {
  const specRows = await db.query<SpecRow>(
    `MATCH (s:ContractSpec)
     WHERE (s.active IS NULL OR s.active = true)
     RETURN ${SPEC_RETURN}`
  );

  const relRows = await db.query<SemanticRelRow>(
    `MATCH (a:ContractSpec)-[r:SEMANTIC_REL]->(b:ContractSpec)
     WHERE (r.active IS NULL OR r.active = true)
     RETURN ${SEMANTIC_REL_RETURN}`
  );

  const specs = specRows.map(rowToContractSpec);
  const relations = relRows.map(rowToSemanticRel);

  return analyzeImpact(change, specs, relations, options);
}
