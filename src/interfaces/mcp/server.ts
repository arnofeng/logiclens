import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogicLens, LogicLensClient } from "../sdk/client.js";
import { schemaStatements } from "../../core/graph-model/schema.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { PendingFile, WatchStatus } from "../../features/watch/watcher.js";
import { assertReadOnlyCypher } from "../../shared/cypherSafety.js";
import { logicLensVersion } from "../../shared/version.js";
import { z } from "zod";

type CatchUpState = WatchStatus["catchUp"];

// Guardrails for the raw-Cypher escape hatch. The structured tools are the
// primary interface; query_cypher is a last resort, so bound both the wall-clock
// time and the response size to keep one bad query from stalling the server or
// flooding the model's context.
const CYPHER_TIMEOUT_MS = 15_000;
const CYPHER_MAX_ROWS = 1000;

export type FreshnessMetadata = {
  stale: boolean;
  generatedAt: string;
  reasons: string[];
  pendingFiles: PendingFile[];
  watcher: {
    active: boolean;
    degraded: boolean;
    degradedReason: string | null;
  };
  catchUp?: CatchUpState;
  indexQueue: WatchStatus["indexQueue"];
};

export function buildFreshnessWarning(input: {
  content: Array<{ type: string; text?: string }>;
  pending: PendingFile[];
  degradedReason?: string | null;
  catchUpError?: unknown;
  catchUp?: CatchUpState;
}): string {
  let prefix = "";

  if (input.catchUp?.running) {
    prefix += `[WARNING] LogicLens startup catch-up indexing is still running for ${input.catchUp.pendingRepos.length} repo(s). The graph may be stale for repos not yet completed.\n\n`;
  }

  if (input.catchUpError) {
    const message = input.catchUpError instanceof Error ? input.catchUpError.message : String(input.catchUpError);
    prefix += `[WARNING] LogicLens startup catch-up indexing failed: ${message}. The graph may be stale; run 'logiclens index --changed-only' manually.\n\n`;
  }

  if (input.degradedReason !== undefined) {
    prefix += `[WARNING] LogicLens file watcher has degraded: ${input.degradedReason || "unknown error"}. Automatic index synchronization is stopped. Please run 'logiclens index --changed-only' manually.\n\n`;
  }

  if (input.pending.length > 0) {
    const referenced: string[] = [];
    for (const item of input.content) {
      if (item.type === "text" && item.text) {
        for (const file of input.pending) {
          const relPath = file.path.replace(/\\/g, "/");
          const fullPath = `${file.repoName}/${relPath}`;
          if (item.text.includes(relPath) || item.text.includes(fullPath)) {
            referenced.push(fullPath);
          }
        }
      }
    }

    if (referenced.length > 0) {
      const uniqueReferenced = [...new Set(referenced)];
      prefix += `[WARNING] The index for the following files might be lagging behind: ${uniqueReferenced.join(", ")}. Please check the actual source code on disk for the most up-to-date content.\n\n`;
    }
  }

  return prefix;
}

export function buildFreshnessMetadata(input: {
  pending: PendingFile[];
  watcherActive: boolean;
  degradedReason?: string | null;
  catchUp?: CatchUpState;
  indexQueue: WatchStatus["indexQueue"];
}): FreshnessMetadata {
  const reasons: string[] = [];
  if (input.catchUp?.running) reasons.push("catch-up-running");
  if (input.catchUp?.failed) reasons.push("catch-up-failed");
  if (input.degradedReason !== undefined) reasons.push("watcher-degraded");
  if (input.pending.length > 0) reasons.push("pending-file-changes");
  if (input.indexQueue.running) reasons.push("index-queue-running");
  if (input.indexQueue.pendingJobs.length > 0) reasons.push("index-queue-pending");

  return {
    stale: reasons.length > 0,
    generatedAt: new Date().toISOString(),
    reasons,
    pendingFiles: input.pending,
    watcher: {
      active: input.watcherActive,
      degraded: input.degradedReason !== undefined,
      degradedReason: input.degradedReason ?? null
    },
    catchUp: input.catchUp,
    indexQueue: input.indexQueue
  };
}

function createCatchUpState(mode: CatchUpState["mode"], repos: string[]): CatchUpState {
  return {
    mode,
    running: false,
    completed: mode === "off",
    failed: false,
    pendingRepos: mode === "off" ? [] : [...repos],
    completedRepos: [],
    currentRepos: []
  };
}

function startCatchUp(client: LogicLensClient, mode: CatchUpState["mode"], batchSize = 10): CatchUpState {
  const repoNames = client.getConfig().repos.map((repo) => repo.name);
  const state = createCatchUpState(mode, repoNames);
  if (mode === "off" || repoNames.length === 0) return state;

  const run = async () => {
    state.running = true;
    state.lastStartedAt = new Date().toISOString();
    for (let index = 0; index < repoNames.length; index += batchSize) {
      const batch = repoNames.slice(index, index + batchSize);
      state.currentRepos = [...batch];
      try {
        await client.index({ repos: batch, changedOnly: true, writeMode: "merge", queueSource: "catch-up", queueLabel: `catch-up:${batch.join(",")}` });
        state.completedRepos.push(...batch);
        state.pendingRepos = state.pendingRepos.filter((repo) => !batch.includes(repo));
        state.currentRepos = [];
      } catch (error) {
        state.failed = true;
        state.error = error instanceof Error ? error.message : String(error);
        state.lastFailedAt = new Date().toISOString();
        break;
      }
    }
    state.running = false;
    state.completed = !state.failed && state.pendingRepos.length === 0;
    if (state.completed) state.lastCompletedAt = new Date().toISOString();
  };

  const promise = run();
  if (mode === "blocking") {
    (state as CatchUpState & { promise?: Promise<void> }).promise = promise;
  } else {
    promise.catch(() => {
      // Error is captured in state.
    });
  }
  return state;
}

/**
 * Starts the Model Context Protocol (MCP) server.
 */
export async function runMcpServer(cwd = process.cwd()): Promise<void> {
  const client: LogicLensClient = await createLogicLens({ cwd });
  await client.watch({ catchUp: "background" });
  const catchUpState = startCatchUp(client, "background");

  const mcpPidPath = path.join(cwd, ".logiclens", "mcp.pid");
  await fs.mkdir(path.dirname(mcpPidPath), { recursive: true });
  await fs.writeFile(
    mcpPidPath,
    JSON.stringify({ pid: process.pid, version: logicLensVersion, startedAt: Date.now() }, null, 2),
    "utf8"
  );

  const cleanup = async () => {
    client.unwatch();
    await client.close();
    try {
      await fs.rm(mcpPidPath, { force: true });
    } catch {}

    const stopMessage = `[${new Date().toISOString()}] [MCP Server] Stopped logiclens-mcp-server\n`;
    process.stderr.write(stopMessage);
    if (client.getConfig().mcp.logCalls) {
      try {
        const logsDir = path.resolve(cwd, ".logiclens/logs");
        await fs.appendFile(path.join(logsDir, "mcp.log"), stopMessage, "utf8");
      } catch {}
    }
  };

  // Track whether cleanup has already been triggered to avoid double-invocation
  let cleanupTriggered = false;
  const triggerCleanup = () => {
    if (cleanupTriggered) return;
    cleanupTriggered = true;
    cleanup().catch(() => {}).finally(() => process.exit(0));
  };

  process.on("SIGINT", triggerCleanup);
  process.on("SIGTERM", triggerCleanup);

  // When the MCP host process exits, it closes the stdin pipe (EOF).
  // StdioServerTransport does not listen for stdin 'end', so we must
  // detect it ourselves and trigger cleanup.
  process.stdin.on("end", () => {
    triggerCleanup();
  });

  const server = new McpServer(
    {
      name: "logiclens-mcp-server",
      version: logicLensVersion,
    },
    {
      instructions:
        "LogicLens is a local-first, cross-repository contract graph. It knows which repositories " +
        "produce and consume each API, event, and schema, and can reason about the downstream impact " +
        "of a change. The graph is derived statically from source code and every answer carries " +
        "evidence (file:line), so treat it as ground truth instead of guessing cross-repo relationships.\n\n" +
        "Reach for LogicLens whenever you are about to change code that other repositories may depend on — " +
        "before editing an API endpoint, event, DTO/schema, or a widely-used symbol:\n" +
        "  • logiclens_impact_analysis — before proposing an edit, check what it breaks. Pass the proposed " +
        "`change` (e.g. \"field-removed:couponCode\") to get a severity-rated blast radius (breaking/risky/" +
        "compatible) with file/line evidence.\n" +
        "  • logiclens_trace / logiclens_semantic_trace — find the producers, consumers, and request/" +
        "response/payload schemas connected to a contract.\n" +
        "  • logiclens_list_contracts / logiclens_list_dependencies — survey cross-repo contracts and " +
        "dependencies before making structural changes.",
    }
  );

  // Log MCP call to stderr and local file if enabled in config
  const logMcpCall = async (type: "tool" | "resource" | "prompt", name: string, args: any) => {
    if (!client.getConfig().mcp.logCalls) return;
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] [MCP Call] Type: ${type}, Name: ${name}, Args: ${JSON.stringify(args)}\n`;

    // Write to stderr so AI Client logs capture it
    process.stderr.write(message);

    // Append to local log file
    try {
      const logsDir = path.resolve(cwd, ".logiclens/logs");
      await fs.mkdir(logsDir, { recursive: true });
      await fs.appendFile(path.join(logsDir, "mcp.log"), message, "utf8");
    } catch (e) {
      process.stderr.write(`[MCP Error] Failed to write call log to file: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };

  // Helper to append freshness warning to tool responses
  const wrapWithFreshness = async (
    name: string,
    args: any,
    action: () => Promise<{ content: Array<{ type: "text"; text: string }> }>
  ) => {
    await logMcpCall("tool", name, args);
    try {
      const response = await action();
      if (name !== "logiclens_get_watch_status" && response && Array.isArray(response.content)) {
        const pending = client.getPendingFiles();
        const degradedReason = client.isWatcherDegraded() ? client.getWatcherDegradedReason() : undefined;
        const prefix = buildFreshnessWarning({
          content: response.content,
          pending,
          degradedReason,
          catchUpError: catchUpState.failed ? catchUpState.error : undefined,
          catchUp: catchUpState,
        });

        if (prefix) {
          for (const item of response.content) {
            if (item.type === "text" && item.text) {
              item.text = prefix + item.text;
            }
          }
        }
        response.content.push({
          type: "text",
          text: `LogicLens freshness metadata:\n${JSON.stringify(buildFreshnessMetadata({
            pending,
            watcherActive: client.isWatching(),
            degradedReason,
            catchUp: catchUpState,
            indexQueue: client.getIndexQueueStatus()
          }), null, 2)}`
        });
      }
      return response;
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  };

  // Define Tools
  server.registerTool(
    "logiclens_get_stats",
    {
      description: "Get summary statistics of the graph database (number of repos, files, code nodes, calls, etc.)",
    },
    async () => {
      return wrapWithFreshness("logiclens_get_stats", {}, async () => {
        const stats = await client.stats();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    "logiclens_get_watch_status",
    {
      description: "Get LogicLens file watcher and startup catch-up status, including partial coverage and pending files",
    },
    async () => {
      return wrapWithFreshness("logiclens_get_watch_status", {}, async () => {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(client.getWatchStatus(catchUpState), null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    "logiclens_list_dependencies",
    {
      description: "List cross-repository dependencies and their evidence in the workspace",
      inputSchema: {
        strength: z.enum(["strong", "weak"]).optional().describe("Filter dependencies by strength (strong: package/import/api, weak: event/shared-contract)"),
        type: z.string().optional().describe("Filter by dependency type (package, import, api, event, shared-contract)"),
        limit: z.number().optional().describe("Maximum number of dependencies to retrieve"),
      },
    },
    async ({ strength, type, limit }) => {
      return wrapWithFreshness("logiclens_list_dependencies", { strength, type, limit }, async () => {
        const deps = await client.dependencies({ strength, type, limit });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(deps, null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    "logiclens_list_contracts",
    {
      description: "List recognized contracts and their producer/consumer/shares counts",
      inputSchema: {
        kind: z.string().optional().describe("Filter by contract kind (package, api, event, dto, schema, enum, config)"),
        limit: z.number().optional().describe("Maximum number of contracts to retrieve"),
      },
    },
    async ({ kind, limit }) => {
      return wrapWithFreshness("logiclens_list_contracts", { kind, limit }, async () => {
        const contracts = await client.contracts({ kind, limit });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(contracts, null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    "logiclens_trace",
    {
      description: "Trace a specific contract (e.g. kind:value) or entity to find all producers, consumers, and references",
      inputSchema: {
        target: z.string().describe("The contract or entity to trace (e.g. 'event:OrderCreatedEvent' or 'Order')"),
      },
    },
    async ({ target }) => {
      return wrapWithFreshness("logiclens_trace", { target }, async () => {
        const traceResult = await client.trace(target);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(traceResult, null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    "logiclens_impact_analysis",
    {
      description: "Before editing an API, event, schema, or cross-repo symbol, check what your change will break. Evaluates the downstream blast radius of changing a code symbol or contract and rates each impact (breaking/risky/compatible) with file/line evidence. Pass `change` in '<changeType>:<detail>' format (e.g. 'field-removed:couponCode') for structured, severity-rated analysis; omit it for a broad symbol/entity impact survey.",
      inputSchema: {
        target: z.string().describe("The target symbol, entity, or contract to analyze (e.g. 'OrderCreatedEvent', 'event:OrderCreatedEvent', or 'schema:CreateOrderRequest')"),
        change: z.string().optional().describe("Optional proposed change in '<changeType>:<detail>' format. Change types: field-added, field-removed, field-type-changed, endpoint-removed, endpoint-renamed, endpoint-schema-change, topic-removed, topic-renamed, event-payload-change, rpc-removed, rpc-renamed, rpc-signature-change. Example: 'field-removed:couponCode'"),
      },
    },
    async ({ target, change }) => {
      return wrapWithFreshness("logiclens_impact_analysis", { target, change }, async () => {
        // Phase 5: Use change-based impact analysis when --change is provided
        if (change) {
          const VALID_CHANGE_TYPES = new Set([
            "field-added", "field-removed", "field-type-changed",
            "endpoint-removed", "endpoint-renamed", "endpoint-schema-change",
            "topic-removed", "topic-renamed", "event-payload-change",
            "rpc-removed", "rpc-renamed", "rpc-signature-change",
          ]);
          const colonIdx = change.indexOf(":");
          const changeType = colonIdx === -1 ? change : change.slice(0, colonIdx);
          const detail = colonIdx === -1 ? undefined : change.slice(colonIdx + 1) || undefined;

          if (!VALID_CHANGE_TYPES.has(changeType)) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: `Invalid change type: "${changeType}". Valid types: ${[...VALID_CHANGE_TYPES].join(", ")}`
              }, null, 2) }]
            };
          }

          const report = await client.analyzeChangeImpact({
            target,
            changeType,
            detail,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
          };
        }

        // Legacy: symbol/entity search-based impact
        const impactResult = await client.impact(target);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(impactResult, null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    "logiclens_ask_question",
    {
      description: "Retrieve structured codebase context (matching code symbols, markdown sections, contracts, dependencies, semantic matches, and call edges) for a query",
      inputSchema: {
        question: z.string().describe("The question to ask (e.g. 'Which code is involved in order creation?')"),
      },
    },
    async ({ question }) => {
      return wrapWithFreshness("logiclens_ask_question", { question }, async () => {
        const retrieval = await client.retrieve(question);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(retrieval, null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    "logiclens_query_cypher",
    {
      description:
        "LAST RESORT. Run a raw, read-only Cypher query against the Kuzu graph database. Prefer the " +
        "structured tools first — logiclens_trace / logiclens_semantic_trace (producers/consumers/schemas), " +
        "logiclens_impact_analysis (blast radius), logiclens_list_contracts / logiclens_list_dependencies " +
        "(surveys), logiclens_ask_question (free-form retrieval). Those return evidence-carrying, schema-stable " +
        "answers; raw Cypher couples you to the internal graph schema and bypasses that framing. Only reach for " +
        "this when no structured tool can express the question. Writes are rejected; queries are capped at " +
        `${CYPHER_TIMEOUT_MS / 1000}s and ${CYPHER_MAX_ROWS} rows, so add WHERE filters and LIMIT for large graphs.`,
      inputSchema: {
        cypher: z.string().describe("The read-only Cypher query to run (e.g. 'MATCH (r:Repo) RETURN r.name LIMIT 5')"),
      },
    },
    async ({ cypher }) => {
      return wrapWithFreshness("logiclens_query_cypher", { cypher }, async () => {
        assertReadOnlyCypher(cypher);

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Cypher query exceeded the ${CYPHER_TIMEOUT_MS / 1000}s limit. Add WHERE filters / LIMIT, ` +
                    "or use a structured tool (logiclens_trace, logiclens_impact_analysis, …)."
                )
              ),
            CYPHER_TIMEOUT_MS
          );
        });

        let rows: Awaited<ReturnType<typeof client.query>>;
        try {
          rows = await Promise.race([client.query(cypher), timeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }

        const truncated = rows.length > CYPHER_MAX_ROWS;
        const payload = {
          ...(truncated
            ? {
                truncated: true,
                rowsReturned: CYPHER_MAX_ROWS,
                totalRows: rows.length,
                note: `Result truncated to the first ${CYPHER_MAX_ROWS} rows. Add a LIMIT or tighter WHERE clause for complete results.`,
              }
            : {}),
          rows: truncated ? rows.slice(0, CYPHER_MAX_ROWS) : rows,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        };
      });
    }
  );

  // Phase 4.1: Semantic trace over SEMANTIC_REL edges (single-hop)
  server.registerTool(
    "logiclens_semantic_trace",
    {
      description:
        "Trace SEMANTIC_REL edges between ContractSpecs to discover how services are connected " +
        "(which endpoint calls which, which event is published/subscribed, which schema backs a " +
        "request/response/payload). Two modes:\n" +
        "  • target — natural identifier (e.g. \"http POST /orders\", \"event OrderCreated\", " +
        "\"schema CreateOrderRequest\"): multi-hop trace returning the full connected sub-graph " +
        "(downstream schemas + upstream consumers). PREFERRED — no internal IDs needed.\n" +
        "  • specId — an internal ContractSpec ID: single-hop trace of direct edges.\n" +
        "Provide exactly one of `target` or `specId`.",
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe("Natural contract identifier, e.g. \"http POST /orders\", \"event OrderCreated\", \"schema CreateOrderRequest\""),
        specId: z.string().optional().describe("Internal ContractSpec ID (single-hop mode)"),
        maxHops: z
          .number()
          .optional()
          .describe("Max hops per direction for target mode (default 3)"),
        direction: z
          .enum(["outgoing", "incoming", "both"])
          .optional()
          .describe("Direction: outgoing (from→to), incoming (to→from), or both (default)"),
      },
    },
    async ({ target, specId, maxHops, direction }) => {
      return wrapWithFreshness(
        "logiclens_semantic_trace",
        { target, specId, maxHops, direction },
        async () => {
          if (target) {
            const graph = await client.semanticTraceGraph(target, {
              maxHops,
              direction: (direction as "outgoing" | "incoming" | "both") ?? "both",
            });
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(graph, null, 2) },
              ],
            };
          }
          if (!specId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { error: "Provide either `target` (natural identifier) or `specId`." },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          const result = await client.semanticTrace(specId, {
            direction: (direction as "outgoing" | "incoming" | "both") ?? "both",
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { specId, direction: direction ?? "both", relations: result },
                  null,
                  2
                ),
              },
            ],
          };
        }
      );
    }
  );

  // Register Resources
  server.registerResource(
    "LogicLens Configuration",
    "logiclens://config",
    {
      description: "Exposes the active .logiclens/config.yaml workspace settings",
      mimeType: "application/yaml",
    },
    async (uri) => {
      await logMcpCall("resource", "LogicLens Configuration", { uri: uri.href });
      const configPath = path.resolve(cwd, ".logiclens", "config.yaml");
      const content = await fs.readFile(configPath, "utf-8");
      return {
        contents: [{ uri: uri.href, mimeType: "application/yaml", text: content }],
      };
    }
  );

  server.registerResource(
    "LogicLens Graph DB Schema",
    "logiclens://schema",
    {
      description: "Exposes the Node and Relationship tables configured in Kuzu DB",
      mimeType: "text/markdown",
    },
    async (uri) => {
      await logMcpCall("resource", "LogicLens Graph DB Schema", { uri: uri.href });
      const formattedSchema = [
        "# Kuzu Schema Statements",
        "This is the current graph structure of Logiclens database:",
        "",
        "```cypher",
        ...schemaStatements,
        "```",
      ].join("\n");
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: formattedSchema }],
      };
    }
  );

  server.registerResource(
    "LogicLens Database Statistics",
    "logiclens://stats",
    {
      description: "Database node and edge counts in JSON",
      mimeType: "application/json",
    },
    async (uri) => {
      await logMcpCall("resource", "LogicLens Database Statistics", { uri: uri.href });
      const stats = await client.stats();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(stats, null, 2) }],
      };
    }
  );

  server.registerResource(
    "LogicLens Dependency Summary",
    "logiclens://dependencies",
    {
      description: "A summary table of cross-repository dependencies",
      mimeType: "application/json",
    },
    async (uri) => {
      await logMcpCall("resource", "LogicLens Dependency Summary", { uri: uri.href });
      const deps = await client.dependencies({ limit: 200 });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(deps, null, 2) }],
      };
    }
  );

  server.registerResource(
    "LogicLens Contracts Summary",
    "logiclens://contracts",
    {
      description: "A summary of all registered contract endpoints/packages",
      mimeType: "application/json",
    },
    async (uri) => {
      await logMcpCall("resource", "LogicLens Contracts Summary", { uri: uri.href });
      const contracts = await client.contracts({ limit: 200 });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(contracts, null, 2) }],
      };
    }
  );

  // Register Prompts
  server.registerPrompt(
    "change-impact-assessment",
    {
      description: "Assess the blast radius and downstream effects of modifying a contract or code symbol",
      argsSchema: {
        target: z.string().describe("The name of the contract or entity to evaluate (e.g. 'event:OrderCreatedEvent')"),
      },
    },
    async ({ target }) => {
      await logMcpCall("prompt", "change-impact-assessment", { target });
      return {
        description: `Guides impact assessment for ${target}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `You are performing a change impact assessment for '${target}'. Use the 'logiclens_impact_analysis' tool to retrieve seeds, calls, and documents, then write a structured report outlining:\n1. The blast radius (which repositories/files/symbols are affected).\n2. Integration risks (which contracts are broken or consumer systems impacted).\n3. Recommended migration or upgrade steps.`,
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "cross-repo-flow-analysis",
    {
      description: "Trace and map workflows or API contracts involving a specific business entity across multiple repositories",
      argsSchema: {
        entity: z.string().describe("The name of the domain entity (e.g. 'Order')"),
      },
    },
    async ({ entity }) => {
      await logMcpCall("prompt", "cross-repo-flow-analysis", { entity });
      return {
        description: `Guides cross-repo workflow analysis for ${entity}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Identify all cross-repository workflows and actions involving the domain entity '${entity}'. Use 'logiclens_trace' to find contract/evidence mentions, and construct a detailed sequential description showing how services consume and produce events/APIs related to this entity.`,
            },
          },
        ],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const startMessage = `[${new Date().toISOString()}] [MCP Server] Started logiclens-mcp-server version ${logicLensVersion}\n`;
  process.stderr.write(startMessage);
  if (client.getConfig().mcp.logCalls) {
    try {
      const logsDir = path.resolve(cwd, ".logiclens/logs");
      await fs.mkdir(logsDir, { recursive: true });
      await fs.appendFile(path.join(logsDir, "mcp.log"), startMessage, "utf8");
    } catch (e) {
      process.stderr.write(`[MCP Error] Failed to write start log to file: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}
