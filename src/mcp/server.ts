import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogicLens, LogicLensClient } from "../sdk/client.js";
import { schemaStatements } from "../graph/schema.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { PendingFile, WatchStatus } from "../watch/watcher.js";
import { assertReadOnlyCypher } from "../utils/cypherSafety.js";
import { logicLensVersion } from "../version.js";
import { z } from "zod";

type CatchUpState = WatchStatus["catchUp"];

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

  const server = new McpServer({
    name: "logiclens-mcp-server",
    version: logicLensVersion,
  });

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
      description: "Evaluate the downstream impact of changing a code symbol or contract",
      inputSchema: {
        target: z.string().describe("The target symbol or entity name to analyze (e.g. 'OrderCreatedEvent' or 'event:OrderCreatedEvent')"),
      },
    },
    async ({ target }) => {
      return wrapWithFreshness("logiclens_impact_analysis", { target }, async () => {
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
      description: "Run a raw Cypher query against the Kuzu graph database in the workspace",
      inputSchema: {
        cypher: z.string().describe("The Cypher query to run (e.g. 'MATCH (r:Repo) RETURN r.name LIMIT 5')"),
      },
    },
    async ({ cypher }) => {
      return wrapWithFreshness("logiclens_query_cypher", { cypher }, async () => {
        if (!client.getConfig().mcp.allowUnsafeCypher) assertReadOnlyCypher(cypher);
        const queryResult = await client.query(cypher);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(queryResult, null, 2) }],
        };
      });
    }
  );

  // Phase 4.1: Semantic trace over SEMANTIC_REL edges (single-hop)
  server.registerTool(
    "logiclens_semantic_trace",
    {
      description:
        "Trace single-hop SEMANTIC_REL edges from a ContractSpec to discover directly " +
        "related specs across repos. Useful for understanding why two services are connected " +
        "(which endpoint calls which, which event is published/subscribed, which schema backs " +
        "a request body, etc.). NOTE: single-hop only — multi-hop transitive tracing is not yet available.",
      inputSchema: {
        specId: z.string().describe("The ContractSpec ID to trace from"),
        direction: z
          .enum(["outgoing", "incoming", "both"])
          .optional()
          .describe("Direction: outgoing (from→to), incoming (to→from), or both (default)"),
      },
    },
    async ({ specId, direction }) => {
      return wrapWithFreshness(
        "logiclens_semantic_trace",
        { specId, direction },
        async () => {
          const result = await client.semanticTrace(specId, {
            direction: (direction as "outgoing" | "incoming" | "both") ?? "both",
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    specId,
                    direction: direction ?? "both",
                    relations: result,
                  },
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
