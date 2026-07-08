import { createClient } from "../sdk/client.js";
import type { SemanticTraceEdge, SemanticTraceGraph, SemanticTraceNode } from "../../core/contracts/semanticTrace.js";
import { BRAND } from "../../shared/branding.js";

export type TraceCommandOptions = {
  maxHops?: number;
  direction?: "outgoing" | "incoming" | "both";
  json?: boolean;
};

export async function traceCommand(
  target: string,
  rest: string[] = [],
  options: TraceCommandOptions = {},
  cwd = process.cwd()
): Promise<void> {
  // `trace` is single-purpose, so extra positional tokens are simply
  // joined onto the target (e.g. `trace http "POST /orders"`). No mode
  // detection - both this and `trace "http POST /orders"` are equivalent.
  const full = [target, ...(rest ?? [])].join(" ").trim();

  const client = await createClient({ cwd });
  try {
    const graph = await client.trace(full, {
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

  console.log(`Semantic Trace: ${target}`);
  console.log("");

  console.log("Target Specs:");
  for (const t of graph.targets) {
    console.log(`  [${roleLabel(graph, t)}] ${repoOf(t.repoId)} ${fileOf(t.fileId)}${t.framework ? ` [${t.framework}]` : ""}`);
    console.log(`      ${t.summary}`);
  }

  const targetIds = new Set(graph.targets.map((t) => t.specId));
  const discovered = graph.nodes.filter((n) => !targetIds.has(n.specId));

  if (discovered.length > 0) {
    console.log("");
    console.log("Discovered Specs:");
    for (const n of discovered) {
      console.log(`  [${roleLabel(graph, n)}] ${repoOf(n.repoId)} ${fileOf(n.fileId)}${n.framework ? ` [${n.framework}]` : ""}`);
      console.log(`      ${n.summary}`);
    }
  }

  console.log("");
  console.log("Relation Paths:");
  const pathRoots = relationRoots(graph);
  if (pathRoots.length === 0) console.log("  No relation paths found.");
  for (const root of pathRoots) {
    printRelationRoot(graph, root);
  }

  if (graph.truncated) {
    console.log("");
    console.log(`(traversal stopped at max hops - more nodes may be reachable; raise --max-hops to expand)`);
  }

  console.log("");
  console.log("Need change impact assessment?");
  console.log(`  ${BRAND.cliName} impact ${quoteIfNeeded(target)}`);
}



function relationRoots(graph: SemanticTraceGraph): SemanticTraceNode[] {
  const targetIds = new Set(graph.targets.map((t) => t.specId));
  const preferred = graph.targets.filter((t) =>
    graph.edges.some((e) => e.toSpecId === t.specId && e.kind === "CALLS_ENDPOINT") ||
    graph.edges.some((e) => e.fromSpecId === t.specId && e.kind === "INTERNAL_CALL")
  );
  const roots = preferred.length > 0 ? preferred : graph.targets;
  return roots.filter((r, index) => roots.findIndex((x) => x.specId === r.specId) === index && targetIds.has(r.specId));
}

function printRelationRoot(graph: SemanticTraceGraph, root: SemanticTraceNode): void {
  console.log(`  [Target] ${root.summary} (${repoOf(root.repoId)})`);
  console.log(`    file: ${fileOf(root.fileId)}`);

  const incoming = graph.edges
    .filter((e) => e.toSpecId === root.specId)
    .sort(byEdgeKindThenRepo(graph));
  for (const edge of incoming) {
    const from = nodeById(graph, edge.fromSpecId);
    if (!from) continue;
    console.log("");
    console.log(`    <- [${edgeLabel(edge)}]`);
    console.log(`       ${from.summary} (${repoOf(from.repoId)})`);
    console.log(`       file: ${fileOf(from.fileId)}`);
    console.log(`       reason: ${edge.reason || "n/a"}`);
    const incomingSeen = new Set<string>([root.specId, from.specId]);
    printIncoming(graph, from, 1, incomingSeen);
  }

  const seen = new Set<string>([root.specId]);
  printOutgoing(graph, root, 1, seen);
}

function printIncoming(
  graph: SemanticTraceGraph,
  node: SemanticTraceNode,
  depth: number,
  seen: Set<string>
): void {
  const incoming = graph.edges
    .filter((e) => e.toSpecId === node.specId)
    .sort(byEdgeKindThenRepo(graph));
  for (const edge of incoming) {
    const from = nodeById(graph, edge.fromSpecId);
    if (!from || seen.has(from.specId)) continue;
    const indent = "  ".repeat(depth + 2);
    console.log("");
    console.log(`${indent}<- [${edgeLabel(edge)}]`);
    console.log(`${indent}   ${from.summary} (${repoOf(from.repoId)})`);
    console.log(`${indent}   file: ${fileOf(from.fileId)}`);
    console.log(`${indent}   reason: ${edge.reason || "n/a"}`);
    seen.add(from.specId);
    printIncoming(graph, from, depth + 1, seen);
  }
}

function printOutgoing(
  graph: SemanticTraceGraph,
  node: SemanticTraceNode,
  depth: number,
  seen: Set<string>
): void {
  const outgoing = graph.edges
    .filter((e) => e.fromSpecId === node.specId)
    .sort(byEdgeKindThenRepo(graph));
  for (const edge of outgoing) {
    const to = nodeById(graph, edge.toSpecId);
    if (!to || seen.has(to.specId)) continue;
    const indent = "  ".repeat(depth + 2);
    console.log("");
    console.log(`${indent}-> [${edgeLabel(edge)}]`);
    console.log(`${indent}   ${to.summary} (${repoOf(to.repoId)})`);
    console.log(`${indent}   file: ${fileOf(to.fileId)}`);
    console.log(`${indent}   reason: ${edge.reason || "n/a"}`);
    seen.add(to.specId);
    printOutgoing(graph, to, depth + 1, seen);
  }
}

function byEdgeKindThenRepo(graph: SemanticTraceGraph): (a: SemanticTraceEdge, b: SemanticTraceEdge) => number {
  return (a, b) => {
    const ak = `${a.kind}:${repoOf(nodeById(graph, a.fromSpecId)?.repoId ?? "")}:${repoOf(nodeById(graph, a.toSpecId)?.repoId ?? "")}`;
    const bk = `${b.kind}:${repoOf(nodeById(graph, b.fromSpecId)?.repoId ?? "")}:${repoOf(nodeById(graph, b.toSpecId)?.repoId ?? "")}`;
    return ak.localeCompare(bk);
  };
}

function edgeLabel(edge: SemanticTraceEdge): string {
  const materialization = edge.materialization ?? "materialized";
  return `${edge.kind} ${materialization} confidence=${formatConfidence(edge.confidence)}`;
}

function roleLabel(graph: SemanticTraceGraph, node: SemanticTraceNode): string {
  if (graph.edges.some((e) => e.toSpecId === node.specId && e.kind === "INTERNAL_CALL")) return "internal-reference inferred";
  if (graph.edges.some((e) => e.fromSpecId === node.specId && e.kind === "CALLS_ENDPOINT")) return "consumer";
  if (graph.edges.some((e) => e.toSpecId === node.specId && e.kind === "CALLS_ENDPOINT")) {
    if (node.specKind === "dubbo-method" || node.specKind === "grpc-method") return "provider";
    return "producer";
  }
  return node.role;
}

function nodeById(graph: SemanticTraceGraph, specId: string): SemanticTraceNode | undefined {
  return graph.nodes.find((n) => n.specId === specId);
}

function formatConfidence(confidence: number): string {
  return Number.isFinite(confidence) ? confidence.toFixed(2) : "n/a";
}

function repoOf(repoId?: string): string {
  return (repoId ?? "").replace(/^repo:/, "");
}

function fileOf(fileId: string): string {
  // fileId: "file:repoName:relative/path"
  const parts = fileId.split(":");
  if (parts[0] === "file" && parts[1] === "repo") return parts.slice(3).join(":");
  return parts.slice(2).join(":") || fileId;
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}
