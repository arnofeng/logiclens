import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, GraphClient } from "../sdk/client.js";
import { schemaStatements } from "../../core/graph-model/schema.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { PendingFile, WatchStatus } from "../../features/watch/watcher.js";
import { appVersion } from "../../shared/version.js";
import { BRAND, BRAND_DEFAULTS, BRAND_PATHS, brandedMcpToolName, configFilePath } from "../../shared/branding.js";
import { z } from "zod";

type CatchUpState = WatchStatus["catchUp"];

const MCP_TOOLS = {
  getStats: brandedMcpToolName("get_stats"),
  getWatchStatus: brandedMcpToolName("get_watch_status"),
  listDependencies: brandedMcpToolName("list_dependencies"),
  listContracts: brandedMcpToolName("list_contracts"),
  trace: brandedMcpToolName("trace"),
  impactAnalysis: brandedMcpToolName("impact_analysis"),
  askQuestion: brandedMcpToolName("ask_question"),
} as const;
const MCP_RESOURCE_URIS = {
  config: `${BRAND.mcpServerName}://config`,
  schema: `${BRAND.mcpServerName}://schema`,
  stats: `${BRAND.mcpServerName}://stats`,
  dependencies: `${BRAND.mcpServerName}://dependencies`,
  contracts: `${BRAND.mcpServerName}://contracts`
} as const;

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
    prefix += `[WARNING] ${BRAND.displayName} startup catch-up indexing is still running for ${input.catchUp.pendingRepos.length} repo(s). The graph may be stale for repos not yet completed.\n\n`;
  }

  if (input.catchUpError) {
    const message = input.catchUpError instanceof Error ? input.catchUpError.message : String(input.catchUpError);
    prefix += `[WARNING] ${BRAND.displayName} startup catch-up indexing failed: ${message}. The graph may be stale; run '${BRAND.cliName} index --changed-only' manually.\n\n`;
  }

  if (input.degradedReason !== undefined) {
    prefix += `[WARNING] ${BRAND.displayName} file watcher has degraded: ${input.degradedReason || "unknown error"}. Automatic index synchronization is stopped. Please run '${BRAND.cliName} index --changed-only' manually.\n\n`;
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

function startCatchUp(client: InstanceType<typeof GraphClient>, mode: CatchUpState["mode"], batchSize = 10): CatchUpState {
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
  const client: InstanceType<typeof GraphClient> = await createClient({ cwd });
  await client.watch({ catchUp: "background" });
  const catchUpState = startCatchUp(client, "background");

  const mcpPidPath = path.resolve(cwd, BRAND_PATHS.mcpPid);
  await fs.mkdir(path.dirname(mcpPidPath), { recursive: true });
  await fs.writeFile(
    mcpPidPath,
    JSON.stringify({ pid: process.pid, cwd: path.resolve(cwd), version: appVersion, startedAt: Date.now() }, null, 2),
    "utf8"
  );

  const cleanup = async () => {
    client.unwatch();
    await client.close();
    try {
      await fs.rm(mcpPidPath, { force: true });
    } catch {}

    const stopMessage = `[${new Date().toISOString()}] [MCP Server] Stopped ${BRAND_DEFAULTS.mcpProcessName}\n`;
    process.stderr.write(stopMessage);
    if (client.getConfig().mcp.logCalls) {
      try {
        const logsDir = path.resolve(cwd, BRAND_PATHS.logs);
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
      name: BRAND_DEFAULTS.mcpProcessName,
      version: appVersion,
    },
    {
      instructions:
        `${BRAND.displayName} is a local-first, cross-repository contract graph. It knows which repositories ` +
        "produce and consume each API, event, and schema, and can reason about the downstream impact " +
        "of a change. The graph is derived statically from source code and every answer carries " +
        "evidence (file:line), so treat it as ground truth instead of guessing cross-repo relationships.\n\n" +
        `Reach for ${BRAND.displayName} whenever you are about to change code that other repositories may depend on - ` +
        "before editing an API endpoint, event, DTO/schema, or a widely-used symbol:\n" +
        `  - ${MCP_TOOLS.impactAnalysis}: before proposing an edit, check what it breaks. Pass the proposed ` +
        "`change` (e.g. \"field-removed:couponCode\") to get a severity-rated blast radius (breaking/risky/" +
        "compatible) with file/line evidence.\n" +
        `  - ${MCP_TOOLS.trace}: multi-hop semantic trace — find the producers, consumers, and request/` +
        "response/payload schemas connected to a contract.\n" +
        `  - ${MCP_TOOLS.listContracts} / ${MCP_TOOLS.listDependencies}: survey cross-repo contracts and ` +
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
      const logsDir = path.resolve(cwd, BRAND_PATHS.logs);
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
      if (name !== MCP_TOOLS.getWatchStatus && response && Array.isArray(response.content)) {
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
          text: `${BRAND.displayName} freshness metadata:\n${JSON.stringify(buildFreshnessMetadata({
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
    MCP_TOOLS.getStats,
    {
      description: "Get summary statistics of the graph database (number of repos, files, code nodes, calls, etc.)",
    },
    async () => {
      return wrapWithFreshness(MCP_TOOLS.getStats, {}, async () => {
        const stats = await client.stats();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    MCP_TOOLS.getWatchStatus,
    {
      description: `Get ${BRAND.displayName} file watcher and startup catch-up status, including partial coverage and pending files`,
    },
    async () => {
      return wrapWithFreshness(MCP_TOOLS.getWatchStatus, {}, async () => {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(client.getWatchStatus(catchUpState), null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    MCP_TOOLS.listDependencies,
    {
      description: "List cross-repository dependencies and their evidence in the workspace",
      inputSchema: {
        strength: z.enum(["strong", "weak"]).optional().describe("Filter dependencies by strength (strong: package/import/api, weak: event/shared-contract)"),
        type: z.string().optional().describe("Filter by dependency type (package, import, api, event, shared-contract)"),
        limit: z.number().optional().describe("Maximum number of dependencies to retrieve"),
        repo: z.string().optional().describe("Filter dependencies involving a specific repository"),
        target: z.string().optional().describe("Filter dependencies targeting a specific repository (requires repo)"),
        direction: z.enum(["outgoing", "incoming"]).optional().describe("Direction: outgoing (repo as consumer) or incoming (repo as producer)"),
      },
    },
    async ({ strength, type, limit, repo, target, direction }) => {
      return wrapWithFreshness(MCP_TOOLS.listDependencies, { strength, type, limit, repo, target, direction }, async () => {
        const deps = await client.dependencies({ strength, type, limit, repo, target, direction });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(deps, null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    MCP_TOOLS.listContracts,
    {
      description: "List recognized contracts and their producer/consumer/shares counts",
      inputSchema: {
        kind: z.string().optional().describe("Filter by contract kind (package, api, event, dto, schema, enum, config)"),
        limit: z.number().optional().describe("Maximum number of contracts to retrieve"),
        repo: z.string().optional().describe("Filter contracts involving a specific repository name"),
        direction: z.enum(["outgoing", "incoming"]).optional().describe("Direction: outgoing (repo as producer) or incoming (repo as consumer). Requires repo."),
      },
    },
    async ({ kind, limit, repo, direction }) => {
      return wrapWithFreshness(MCP_TOOLS.listContracts, { kind, limit, repo, direction }, async () => {
        const contracts = await client.contracts({ kind, limit, repo, direction });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(contracts, null, 2) }],
        };
      });
    }
  );

  server.registerTool(
    MCP_TOOLS.impactAnalysis,
    {
      description: "Before editing an API, event, schema, or cross-repo symbol, check what your change will break. Evaluates the downstream blast radius of changing a code symbol or contract and rates each impact (breaking/risky/compatible) with file/line evidence. Pass `change` in '<changeType>:<detail>' format (e.g. 'field-removed:couponCode') for structured, severity-rated analysis; omit it for a broad symbol/entity impact survey.",
      inputSchema: {
        target: z.string().describe("The target symbol, entity, or contract to analyze (e.g. 'OrderCreatedEvent', 'event:OrderCreatedEvent', or 'schema:CreateOrderRequest')"),
        change: z.string().optional().describe("Optional proposed change in '<changeType>:<detail>' format. Change types: field-added, field-removed, field-type-changed, endpoint-removed, endpoint-renamed, endpoint-schema-change, topic-removed, topic-renamed, event-payload-change, rpc-removed, rpc-renamed, rpc-signature-change. Example: 'field-removed:couponCode'"),
      },
    },
    async ({ target, change }) => {
      return wrapWithFreshness(MCP_TOOLS.impactAnalysis, { target, change }, async () => {
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
            throw new Error(`Invalid change type: "${changeType}". Valid types: ${[...VALID_CHANGE_TYPES].join(", ")}`);
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
    MCP_TOOLS.askQuestion,
    {
      description: "Retrieve structured codebase context (matching code symbols, markdown sections, contracts, dependencies, semantic matches, and call edges) for a query",
      inputSchema: {
        question: z.string().describe("The question to ask (e.g. 'Which code is involved in order creation?')"),
      },
    },
    async ({ question }) => {
      return wrapWithFreshness(MCP_TOOLS.askQuestion, { question }, async () => {
        const retrieval = await client.retrieve(question);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(retrieval, null, 2) }],
        };
      });
    }
  );

  // Phase 4.1: Semantic trace over SEMANTIC_REL edges
  server.registerTool(
    MCP_TOOLS.trace,
    {
      description:
        "Trace SEMANTIC_REL edges between ContractSpecs to discover how services are connected " +
        "(which endpoint calls which, which event is published/subscribed, which schema backs a " +
        "request/response/payload). Two modes:\n" +
        "  - target: natural identifier (e.g. \"http POST /orders\", \"event OrderCreated\", " +
        "\"schema CreateOrderRequest\"): multi-hop trace returning the full connected sub-graph " +
        "(downstream schemas + upstream consumers). PREFERRED - no internal IDs needed.\n" +
        "  - specId: an internal ContractSpec ID: single-hop trace of direct edges.\n" +
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
          .describe("Direction: outgoing (from -> to), incoming (to -> from), or both (default)"),
      },
    },
    async ({ target, specId, maxHops, direction }) => {
      return wrapWithFreshness(
        MCP_TOOLS.trace,
        { target, specId, maxHops, direction },
        async () => {
          if (target) {
            const graph = await client.trace(target, {
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
            throw new Error(
              "Provide either `target` (natural identifier) or `specId`. " +
              "For free-form questions, use the `ask_question` tool instead."
            );
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
    `${BRAND.displayName} Configuration`,
    MCP_RESOURCE_URIS.config,
    {
      description: `Exposes the active ${BRAND.configDirName}/${BRAND.configFileName} workspace settings`,
      mimeType: "application/yaml",
    },
    async (uri) => {
      await logMcpCall("resource", `${BRAND.displayName} Configuration`, { uri: uri.href });
      const content = await fs.readFile(configFilePath(cwd), "utf-8");
      return {
        contents: [{ uri: uri.href, mimeType: "application/yaml", text: content }],
      };
    }
  );

  server.registerResource(
    `${BRAND.displayName} Graph DB Schema`,
    MCP_RESOURCE_URIS.schema,
    {
      description: "Exposes the Node and Relationship tables configured in Kuzu DB",
      mimeType: "text/markdown",
    },
    async (uri) => {
      await logMcpCall("resource", `${BRAND.displayName} Graph DB Schema`, { uri: uri.href });
      const formattedSchema = [
        "# Kuzu Schema Statements",
        `This is the current graph structure of ${BRAND.displayName} database:`,
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
    `${BRAND.displayName} Database Statistics`,
    MCP_RESOURCE_URIS.stats,
    {
      description: "Database node and edge counts in JSON",
      mimeType: "application/json",
    },
    async (uri) => {
      await logMcpCall("resource", `${BRAND.displayName} Database Statistics`, { uri: uri.href });
      const stats = await client.stats();
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(stats, null, 2) }],
      };
    }
  );

  server.registerResource(
    `${BRAND.displayName} Dependency Summary`,
    MCP_RESOURCE_URIS.dependencies,
    {
      description: "A summary table of cross-repository dependencies",
      mimeType: "application/json",
    },
    async (uri) => {
      await logMcpCall("resource", `${BRAND.displayName} Dependency Summary`, { uri: uri.href });
      const deps = await client.dependencies({ limit: 200 });
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(deps, null, 2) }],
      };
    }
  );

  server.registerResource(
    `${BRAND.displayName} Contracts Summary`,
    MCP_RESOURCE_URIS.contracts,
    {
      description: "A summary of all registered contract endpoints/packages",
      mimeType: "application/json",
    },
    async (uri) => {
      await logMcpCall("resource", `${BRAND.displayName} Contracts Summary`, { uri: uri.href });
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
              text: `You are performing a change impact assessment for '${target}'. Use the '${MCP_TOOLS.impactAnalysis}' tool to retrieve seeds, calls, and documents, then write a structured report outlining:\n1. The blast radius (which repositories/files/symbols are affected).\n2. Integration risks (which contracts are broken or consumer systems impacted).\n3. Recommended migration or upgrade steps.`,
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
              text: `Identify all cross-repository workflows and actions involving the domain entity '${entity}'. First use '${MCP_TOOLS.askQuestion}' or '${MCP_TOOLS.impactAnalysis}' with the entity name to discover relevant contracts, events, and APIs. Then use '${MCP_TOOLS.trace}' with specific contract identifiers (e.g. "event OrderCreated", "http POST /orders") to trace the full semantic dependency chain. Construct a detailed sequential description showing how services consume and produce events/APIs related to this entity.`,
            },
          },
        ],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const startMessage = `[${new Date().toISOString()}] [MCP Server] Started ${BRAND_DEFAULTS.mcpProcessName} version ${appVersion}\n`;
  process.stderr.write(startMessage);
  if (client.getConfig().mcp.logCalls) {
    try {
      const logsDir = path.resolve(cwd, BRAND_PATHS.logs);
      await fs.mkdir(logsDir, { recursive: true });
      await fs.appendFile(path.join(logsDir, "mcp.log"), startMessage, "utf8");
    } catch (e) {
      process.stderr.write(`[MCP Error] Failed to write start log to file: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}
