import { createLogicLens } from "../sdk/client.js";
import type { SemanticTraceGraph } from "../contracts/semanticTrace.js";

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

function printSemanticTrace(target: string, graph: SemanticTraceGraph): void {
  if (graph.targets.length === 0) {
    console.log(`No contract spec matched "${target}".`);
    console.log(`Hints: try a method+path ("http POST /orders"), an event topic ("event OrderCreated"), or a schema name ("schema CreateOrderRequest").`);
    return;
  }

  console.log(`Semantic trace for ${target}:`);
  console.log("");

  // Target(s)
  for (const t of graph.targets) {
    console.log(`Target: ${t.summary}`);
    console.log(`  ${repoOf(t.repoId)} ${fileOf(t.fileId)}${t.framework ? ` [${t.framework}]` : ""}`);
  }

  const downstream = graph.nodes.filter((n) => n.role === "downstream");
  const upstream = graph.nodes.filter((n) => n.role === "upstream");

  if (downstream.length > 0) {
    console.log("");
    console.log("Downstream (schemas / payloads it uses):");
    for (const n of downstream) {
      console.log(`- [hop ${n.hop}] ${n.summary}  (${kindHint(graph, n.specId)})`);
      console.log(`    ${repoOf(n.repoId)} ${fileOf(n.fileId)}`);
    }
  }

  if (upstream.length > 0) {
    console.log("");
    console.log("Upstream (consumers / callers):");
    for (const n of upstream) {
      console.log(`- [hop ${n.hop}] ${n.summary}  (${kindHint(graph, n.specId)})`);
      console.log(`    ${repoOf(n.repoId)} ${fileOf(n.fileId)}`);
    }
  }

  if (downstream.length === 0 && upstream.length === 0) {
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

function repoOf(repoId: string): string {
  return repoId.replace(/^repo:/, "");
}

function fileOf(fileId: string): string {
  // fileId: "file:repoName:relative/path"
  const parts = fileId.split(":");
  return parts.slice(2).join(":") || fileId;
}
