import { createLogicLens } from "../sdk/client.js";
import type { SemanticTraceGraph } from "../../core/contracts/semanticTrace.js";

export type SpecTraceCommandOptions = {
  maxHops?: number;
  direction?: "outgoing" | "incoming" | "both";
  json?: boolean;
};

export async function specTraceCommand(
  target: string,
  rest: string[] = [],
  options: SpecTraceCommandOptions = {},
  cwd = process.cwd()
): Promise<void> {
  // `spec-trace` is single-purpose, so extra positional tokens are simply
  // joined onto the target (e.g. `spec-trace http "POST /orders"`). No mode
  // detection — both this and `spec-trace "http POST /orders"` are equivalent.
  const full = [target, ...(rest ?? [])].join(" ").trim();

  const client = await createLogicLens({ cwd });
  try {
    const graph = await client.semanticTraceGraph(full, {
      maxHops: options.maxHops,
      direction: options.direction,
    });
    if (options.json) {
      console.log(JSON.stringify(graph, null, 2));
    } else {
      printSemanticTrace(full, graph);
    }
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function relationVerb(kind: string): string {
  switch (kind) {
    case "IMPLEMENTS":
      return "implements";
    case "CALLS_ENDPOINT":
      return "calls";
    case "PUBLISHES_EVENT":
      return "publishes";
    case "SUBSCRIBES_EVENT":
      return "subscribes to";
    case "USES_SCHEMA":
      return "uses";
    case "REQUEST_SCHEMA":
      return "requests schema";
    case "RESPONSE_SCHEMA":
      return "responds with schema";
    case "EVENT_PAYLOAD":
      return "event payload schema";
    case "COMPATIBLE_WITH":
      return "compatible with";
    case "BREAKS":
      return "breaks";
    case "IMPACTS":
      return "impacts";
    default:
      return "relates to";
  }
}

export function printSemanticTrace(target: string, graph: SemanticTraceGraph): void {
  if (graph.targets.length === 0) {
    console.log(`No contract spec matched "${target}".`);
    console.log(`Hints: try "http POST /orders", "event OrderCreated", "schema CreateOrderRequest", "grpc OrderService/CreateOrder", "dubbo com.acme.OrderService#createOrder", or "graphql Query.user". RPC methods and GraphQL fields are case-sensitive.`);
    return;
  }

  console.log(`Semantic trace for ${target}:`);
  console.log("");

  // Target(s)
  for (const t of graph.targets) {
    console.log(`Target: ${t.summary}`);
    console.log(`  ${repoOf(t.repoId)} ${fileOf(t.fileId)}${t.framework ? ` [${t.framework}]` : ""}`);
  }

  const targetIds = new Set(graph.targets.map((t) => t.specId));
  const targetEdges = graph.edges.filter(
    (e) => targetIds.has(e.fromSpecId) && targetIds.has(e.toSpecId)
  );

  const downstream = graph.nodes.filter((n) => n.role === "downstream");
  const upstream = graph.nodes.filter((n) => n.role === "upstream");

  if (targetEdges.length > 0) {
    console.log("");
    console.log("Connections between targets:");
    for (const e of targetEdges) {
      const fromNode = graph.targets.find((t) => t.specId === e.fromSpecId);
      const toNode = graph.targets.find((t) => t.specId === e.toSpecId);
      if (fromNode && toNode) {
        console.log(`- ${fromNode.summary} (${repoOf(fromNode.repoId)})`);
        console.log(`    ➔ ${relationVerb(e.kind)} ${toNode.summary} (${repoOf(toNode.repoId)})`);
        console.log(`    via ${e.kind} confidence=${formatConfidence(e.confidence)} reason=${e.reason || "n/a"}`);
      }
    }
  }

  if (downstream.length > 0) {
    console.log("");
    console.log("Downstream (schemas / payloads it uses):");
    for (const n of downstream) {
      console.log(`- [hop ${n.hop}] ${n.summary}  (${kindHint(graph, n.specId)})`);
      for (const e of reachingEdges(graph, n.specId, "downstream")) {
        console.log(`    via ${e.kind} confidence=${formatConfidence(e.confidence)} reason=${e.reason || "n/a"}`);
      }
      console.log(`    ${repoOf(n.repoId)} ${fileOf(n.fileId)}`);
    }
  }

  if (upstream.length > 0) {
    console.log("");
    console.log("Upstream (consumers / callers):");
    for (const n of upstream) {
      console.log(`- [hop ${n.hop}] ${n.summary}  (${kindHint(graph, n.specId)})`);
      for (const e of reachingEdges(graph, n.specId, "upstream")) {
        console.log(`    via ${e.kind} confidence=${formatConfidence(e.confidence)} reason=${e.reason || "n/a"}`);
      }
      console.log(`    ${repoOf(n.repoId)} ${fileOf(n.fileId)}`);
    }
  }

  if (downstream.length === 0 && upstream.length === 0 && targetEdges.length === 0) {
    console.log("");
    console.log("No connected specs found (no semantic relations from this contract).");
  }

  if (graph.truncated) {
    console.log("");
    console.log(`(traversal stopped at max hops — more nodes may be reachable; raise --max-hops to expand)`);
  }
}

/** Returns a hint of the relation kind(s) that connect a node into the trace. */
function kindHint(graph: SemanticTraceGraph, specId: string): string {
  const kinds = new Set<string>();
  for (const e of graph.edges) {
    if (e.fromSpecId === specId || e.toSpecId === specId) kinds.add(e.kind);
  }
  return kinds.size > 0 ? [...kinds].join(", ") : "—";
}

function reachingEdges(
  graph: SemanticTraceGraph,
  specId: string,
  role: "downstream" | "upstream"
): SemanticTraceGraph["edges"] {
  if (role === "downstream") {
    return graph.edges.filter((e) => e.direction === "outgoing" && e.toSpecId === specId);
  }
  return graph.edges.filter((e) => e.direction === "incoming" && e.fromSpecId === specId);
}

function formatConfidence(confidence: number): string {
  return Number.isFinite(confidence) ? confidence.toFixed(2) : "n/a";
}

function repoOf(repoId: string): string {
  return repoId.replace(/^repo:/, "");
}

function fileOf(fileId: string): string {
  // fileId: "file:repoName:relative/path"
  const parts = fileId.split(":");
  return parts.slice(2).join(":") || fileId;
}
