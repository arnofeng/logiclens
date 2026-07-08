// ---------------------------------------------------------------------------
// Multi-hop semantic trace
//
// Resolves a natural-language contract identifier (e.g. "http POST /orders",
// "event OrderCreated", "schema CreateOrderRequest") to its ContractSpec
// node(s), then walks SEMANTIC_REL edges in both directions up to `maxHops`
// hops to produce the full picture of how that contract is connected:
//   - downstream (outgoing): request/response/payload schemas it uses
//   - upstream   (incoming): consumers that call/subscribe to it
//
// Both the natural-key resolution (findTargetSpecs) and the traversal mirror
// what the impact engine does internally, but without requiring a change
// intent — this is a read-only "show me the chain" view usable from the CLI
// and MCP without knowing internal spec IDs.
// ---------------------------------------------------------------------------

import type {
  ReadableContractSpecNode,
  SemanticRelationEdge
} from "../parsing/types.js";
import { isKnownContractSpecNode } from "../parsing/types.js";
import { deserializeSpec } from "./spec.js";
import { findTargetSpecs } from "./impact/impactEngine.js";
import {
  canonicalDubboContractKey,
  canonicalGraphqlContractKey,
  canonicalGrpcContractKey,
  canonicalHttpContractKey
} from "./apiPath.js";
import { canonicalEventContractKey } from "./event.js";
import type { GraphDB } from "../graph-model/db.js";
import {
  SEMANTIC_REL_RETURN,
  SPEC_RETURN,
  rowToReadableContractSpec,
  rowToSemanticRel,
  type SemanticRelRow,
  type SpecRow
} from "./specRows.js";
import {
  inferInternalCallEdges,
  type TraceRelationKind
} from "./inferredBridge.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SemanticTraceDirection = "outgoing" | "incoming" | "both";

/** Whether a node is the trace origin, reached downstream, or upstream. */
export type SemanticTraceNodeRole = "target" | "downstream" | "upstream";

export type SemanticTraceNode = {
  specId: string;
  contractId: string;
  specKind: string;
  canonicalKey: string;
  repoId: string;
  fileId: string;
  framework?: string;
  confidence: number;
  /** Distance in hops from the nearest target spec (0 for targets). */
  hop: number;
  role: SemanticTraceNodeRole;
  /** Human-readable one-line description derived from the spec payload. */
  summary: string;
};

export type SemanticTraceEdge = {
  fromSpecId: string;
  toSpecId: string;
  kind: TraceRelationKind;
  materialization?: "materialized" | "inferred";
  sourceEdgeKind?: SemanticRelationEdge["kind"];
  reason: string;
  confidence: number;
  /** Distance in hops of the deeper endpoint of this edge from a target. */
  hop: number;
  direction: "outgoing" | "incoming";
};

type TraversableTraceEdge = {
  fromSpecId: string;
  toSpecId: string;
  kind: TraceRelationKind;
  materialization: "materialized" | "inferred";
  sourceEdgeKind?: SemanticRelationEdge["kind"];
  reason: string;
  confidence: number;
};

export type SemanticTraceGraph = {
  /** The parsed target identifier. */
  target: string;
  /** Resolved target specs (hop 0). Empty if nothing matched. */
  targets: SemanticTraceNode[];
  /** All reachable nodes, including the targets, deduplicated by specId. */
  nodes: SemanticTraceNode[];
  /** All traversed edges, deduplicated. */
  edges: SemanticTraceEdge[];
  /** True if traversal stopped at maxHops with more nodes potentially reachable. */
  truncated: boolean;
};

export type SemanticTraceOptions = {
  /** Maximum hops to traverse in each direction. Default 3. */
  maxHops?: number;
  /** Which directions to walk. Default "both". */
  direction?: SemanticTraceDirection;
};

// ---------------------------------------------------------------------------
// Target normalization
// ---------------------------------------------------------------------------

/** Contract kinds recognized as the leading token of a semantic target. */
const SEMANTIC_KINDS = new Set([
  "http", "api", "event", "schema", "dto", "grpc", "dubbo", "graphql", "package", "config"
]);

const HTTP_VERBS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"
]);

/**
 * Normalizes a free-form trace target into the `kind:key` form understood by
 * {@link findTargetSpecs}, where `key` matches a ContractSpec's stored
 * `canonicalKey` (or schema name).
 *
 * Accepted forms (all equivalent for an endpoint):
 *   - "http POST /orders"      (space-separated kind + method + path)
 *   - "http:POST /orders"
 *   - "api POST /orders"
 *   - "POST /orders"           (bare method + path → inferred as http)
 *   - "event OrderCreated"
 *   - "schema CreateOrderRequest"
 *   - "grpc OrderService/CreateOrder"
 *   - "dubbo com.acme.OrderService#createOrder"
 *   - "graphql Query.user"
 *   - "schema:CreateOrderRequest" / "event:order.created" (existing colon form)
 */
export function normalizeSemanticTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // Split leading kind token. Support both "kind key..." and "kind:key...".
  let kind: string | undefined;
  let rest = trimmed;

  const colonIdx = trimmed.indexOf(":");
  const firstSpace = trimmed.search(/\s/);
  const colonKindCandidate = colonIdx > 0 ? trimmed.slice(0, colonIdx).toLowerCase() : "";
  const spaceKindCandidate = firstSpace > 0 ? trimmed.slice(0, firstSpace).toLowerCase() : "";

  if (colonIdx > 0 && SEMANTIC_KINDS.has(colonKindCandidate) && (colonIdx < firstSpace || firstSpace === -1)) {
    kind = colonKindCandidate;
    rest = trimmed.slice(colonIdx + 1).trim();
  } else if (firstSpace > 0 && SEMANTIC_KINDS.has(spaceKindCandidate)) {
    kind = spaceKindCandidate;
    rest = trimmed.slice(firstSpace + 1).trim();
  } else {
    // No explicit kind. Infer http if it looks like "VERB /path".
    const tokens = trimmed.split(/\s+/);
    if (tokens.length >= 2 && HTTP_VERBS.has(tokens[0]!.toUpperCase())) {
      kind = "http";
    }
  }

  if (kind === "http" || kind === "api") {
    const { method, path } = splitMethodPath(rest);
    const key = canonicalHttpContractKey({ method, path });
    return `http:${key}`;
  }
  if (kind === "event") {
    return `event:${canonicalEventContractKey(rest)}`;
  }
  if (kind === "dto" || kind === "schema") {
    return `schema:${rest}`; // schema names match case-sensitively by name
  }
  if (kind === "grpc") {
    return `grpc:${canonicalGrpcContractKey(rest)}`;
  }
  if (kind === "dubbo") {
    const { interfaceName, method } = splitDubboTarget(rest);
    return `dubbo:${canonicalDubboContractKey(interfaceName, method)}`;
  }
  if (kind === "graphql") {
    const { operationType, field } = splitGraphqlTarget(rest);
    return `graphql:${canonicalGraphqlContractKey(operationType, field)}`;
  }
  if (kind === "package" || kind === "config") {
    return `${kind}:${rest}`;
  }

  // Fall back: pass through unchanged (findTargetSpecs handles bare schema /
  // existing kind:key forms).
  return trimmed;
}

/** Splits "POST /orders" or "POST:/orders" into method + path. */
function splitMethodPath(rest: string): { method?: string; path: string } {
  const sep = rest.search(/[\s:]/);
  if (sep > 0) {
    const head = rest.slice(0, sep);
    if (HTTP_VERBS.has(head.toUpperCase())) {
      return { method: head.toUpperCase(), path: rest.slice(sep + 1).trim() };
    }
  }
  return { path: rest };
}

/** Splits "com.acme.OrderService#createOrder" into interface + method. */
function splitDubboTarget(rest: string): { interfaceName: string; method?: string } {
  const hashIdx = rest.indexOf("#");
  if (hashIdx === -1) return { interfaceName: rest.trim() };
  return {
    interfaceName: rest.slice(0, hashIdx).trim(),
    method: rest.slice(hashIdx + 1).trim() || undefined
  };
}

/** Splits "Query.user" / "Mutation.createOrder" into root type + field. */
function splitGraphqlTarget(rest: string): { operationType: string; field: string } {
  const dotIdx = rest.indexOf(".");
  if (dotIdx === -1) return { operationType: "query", field: rest.trim() };
  return {
    operationType: rest.slice(0, dotIdx).trim(),
    field: rest.slice(dotIdx + 1).trim()
  };
}

// ---------------------------------------------------------------------------
// Core (in-memory) implementation
// ---------------------------------------------------------------------------

/**
 * Traces the semantic-relation graph around the contract(s) matching `target`.
 *
 * @param target    Natural-key identifier, e.g. "http POST /orders",
 *                  "event OrderCreated", "schema CreateOrderRequest". Also
 *                  accepts the `kind:key` forms understood by findTargetSpecs.
 * @param specs     All ContractSpec nodes.
 * @param relations All SEMANTIC_REL edges.
 */
export function traceSemanticGraph(
  target: string,
  specs: ReadableContractSpecNode[],
  relations: SemanticRelationEdge[],
  options: SemanticTraceOptions = {}
): SemanticTraceGraph {
  const maxHops = options.maxHops ?? 3;
  const direction = options.direction ?? "both";

  const normalizedTarget = normalizeSemanticTarget(target);
  const knownSpecs = specs.filter(isKnownContractSpecNode);
  const targetSpecs = findTargetSpecs(normalizedTarget, knownSpecs);
  if (targetSpecs.length === 0) {
    return { target, targets: [], nodes: [], edges: [], truncated: false };
  }

  const specMap = new Map(specs.map((s) => [s.id, s]));
  const targetIds = new Set(targetSpecs.map((s) => s.id));

  const traceEdges: TraversableTraceEdge[] = [
    ...relations.map((e) => ({
      fromSpecId: e.fromSpecId,
      toSpecId: e.toSpecId,
      kind: e.kind,
      materialization: "materialized" as const,
      reason: e.reason,
      confidence: e.confidence
    })),
    ...inferInternalCallEdges(specs, relations)
  ];

  // Adjacency lists keyed by specId.
  const outAdj = new Map<string, TraversableTraceEdge[]>();
  const inAdj = new Map<string, TraversableTraceEdge[]>();
  for (const e of traceEdges) {
    const outList = outAdj.get(e.fromSpecId);
    if (outList) outList.push(e); else outAdj.set(e.fromSpecId, [e]);
    const inList = inAdj.get(e.toSpecId);
    if (inList) inList.push(e); else inAdj.set(e.toSpecId, [e]);
  }

  const nodeHop = new Map<string, number>();
  const nodeRole = new Map<string, SemanticTraceNodeRole>();
  for (const id of targetIds) {
    nodeHop.set(id, 0);
    nodeRole.set(id, "target");
  }

  const edges: SemanticTraceEdge[] = [];
  const seenEdges = new Set<string>();
  let truncated = false;

  const walk = (dir: "outgoing" | "incoming") => {
    const adj = dir === "outgoing" ? outAdj : inAdj;
    const role: SemanticTraceNodeRole = dir === "outgoing" ? "downstream" : "upstream";
    let frontier = new Set(targetIds);
    const visited = new Set(targetIds);

    for (let hop = 1; hop <= maxHops; hop++) {
      const next = new Set<string>();
      for (const id of frontier) {
        const neighbors = adj.get(id);
        if (!neighbors) continue;
        for (const e of neighbors) {
          const otherId = dir === "outgoing" ? e.toSpecId : e.fromSpecId;
          const edgeKey = `${e.fromSpecId}->${e.toSpecId}:${e.kind}:${e.materialization}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            edges.push({
              fromSpecId: e.fromSpecId,
              toSpecId: e.toSpecId,
              kind: e.kind,
              materialization: e.materialization,
              sourceEdgeKind: e.sourceEdgeKind,
              reason: e.reason,
              confidence: e.confidence,
              hop,
              direction: dir
            });
          }
          if (!visited.has(otherId)) {
            visited.add(otherId);
            if (!nodeRole.has(otherId)) {
              nodeHop.set(otherId, hop);
              nodeRole.set(otherId, role);
            }
            next.add(otherId);
          }
        }
      }
      if (next.size === 0) break;
      if (hop === maxHops && next.size > 0) {
        // There may be deeper nodes we didn't reach.
        for (const id of next) {
          if ((dir === "outgoing" ? outAdj : inAdj).get(id)?.length) {
            truncated = true;
            break;
          }
        }
      }
      frontier = next;
    }
  };

  if (direction === "outgoing" || direction === "both") walk("outgoing");
  if (direction === "incoming" || direction === "both") walk("incoming");

  const nodes: SemanticTraceNode[] = [];
  for (const [id, hop] of nodeHop) {
    const spec = specMap.get(id);
    if (!spec) continue;
    nodes.push({
      specId: spec.id,
      contractId: spec.contractId,
      specKind: spec.specKind,
      canonicalKey: spec.canonicalKey,
      repoId: spec.repoId,
      fileId: spec.fileId,
      framework: spec.framework,
      confidence: spec.confidence,
      hop,
      role: nodeRole.get(id) ?? "target",
      summary: summarizeSpec(spec)
    });
  }
  nodes.sort((a, b) => a.hop - b.hop || a.repoId.localeCompare(b.repoId) || a.canonicalKey.localeCompare(b.canonicalKey));

  const targets = nodes.filter((n) => n.role === "target");

  return { target, targets, nodes, edges, truncated };
}

// ---------------------------------------------------------------------------
// Spec summarization
// ---------------------------------------------------------------------------

/** Produces a compact human-readable description from a ContractSpec node. */
export function summarizeSpec(node: ReadableContractSpecNode): string {
  if ("opaque" in node) return `${node.canonicalKey} (${node.warning})`;
  try {
    const spec = deserializeSpec(node.specJson);
    if (spec.kind === "http-endpoint") {
      const method = spec.method ?? "ANY";
      const parts = [`${method} ${spec.path}`];
      if (spec.requestBodyType) parts.push(`request=${spec.requestBodyType}`);
      if (spec.responseBodyType) parts.push(`response=${spec.responseBodyType}`);
      return parts.join("  ");
    }
    if (spec.kind === "event") {
      const parts = [`topic=${spec.topic}`];
      if (spec.payloadType) parts.push(`payload=${spec.payloadType}`);
      if (spec.broker && spec.broker !== "unknown") parts.push(`broker=${spec.broker}`);
      return parts.join("  ");
    }
    if (spec.kind === "schema") {
      return `${spec.name} (${spec.fields.length} field${spec.fields.length === 1 ? "" : "s"})`;
    }
    if (spec.kind === "grpc-method") {
      const parts = [spec.fullName];
      if (spec.requestType) parts.push(`request=${spec.requestType}`);
      if (spec.responseType) parts.push(`response=${spec.responseType}`);
      parts.push(`streaming=${spec.streaming}`);
      return parts.join("  ");
    }
    if (spec.kind === "dubbo-method") {
      const parts = [spec.fullName];
      if (spec.requestTypes?.length) parts.push(`request=${spec.requestTypes.join(",")}`);
      if (spec.responseType) parts.push(`response=${spec.responseType}`);
      if (spec.group) parts.push(`group=${spec.group}`);
      if (spec.version) parts.push(`version=${spec.version}`);
      return parts.join("  ");
    }
    if (spec.kind === "graphql-operation") {
      const parts = [spec.fullName];
      if (spec.requestType) parts.push(`request=${spec.requestType}`);
      if (spec.responseType) parts.push(`response=${spec.responseType}`);
      parts.push(`source=${spec.source}`);
      return parts.join("  ");
    }
  } catch {
    /* fall through to canonicalKey */
  }
  return node.canonicalKey;
}

// ---------------------------------------------------------------------------
// Graph-DB backed wrapper (for runtime use)
// ---------------------------------------------------------------------------

/**
 * Loads ContractSpec nodes and SEMANTIC_REL edges from the graph database and
 * delegates to {@link traceSemanticGraph}.
 */
export async function traceSemanticGraphFromDB(
  target: string,
  db: GraphDB,
  options: SemanticTraceOptions = {}
): Promise<SemanticTraceGraph> {
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

  const specs = specRows.map(rowToReadableContractSpec);
  const relations = relRows.map(rowToSemanticRel);

  return traceSemanticGraph(target, specs, relations, options);
}
