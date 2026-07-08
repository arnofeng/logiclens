import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, GraphClient } from "../sdk/client.js";
import { schemaStatements } from "../../core/graph-model/schema.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { PendingFile, WatchStatus } from "../../features/watch/watcher.js";
import { appVersion } from "../../shared/version.js";
import { BRAND, BRAND_DEFAULTS, BRAND_PATHS, brandedMcpToolName, configFilePath } from "../../shared/branding.js";
import { startMcpOwnerRpcServer } from "./ownerRpc.js";
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

export function buildFreshnessNotice(metadata: FreshnessMetadata): string {
  if (!metadata.stale) return "";
  return `Freshness: stale (${metadata.reasons.join(", ")}). Call ${MCP_TOOLS.getWatchStatus} for full details.`;
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
  const ownerRpc = await startMcpOwnerRpcServer({
    client,
    cwd,
    getCatchUp: () => catchUpState,
    defaultWatchOptions: { catchUp: "background" }
  });

  const mcpPidPath = path.resolve(cwd, BRAND_PATHS.mcpPid);
  await fs.mkdir(path.dirname(mcpPidPath), { recursive: true });
  await fs.writeFile(
    mcpPidPath,
    JSON.stringify({ pid: process.pid, cwd: path.resolve(cwd), version: appVersion, startedAt: Date.now(), rpc: ownerRpc.info }, null, 2),
    "utf8"
  );

  const cleanup = async () => {
    client.unwatch();
    try {
      await ownerRpc.close();
    } catch {}
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
        `Reach for ${BRAND.displayName} whenever you are about to change code that other repositories may depend on. ` +
        "Prefer precise graph tools over broad retrieval:\n" +
        `  - ${MCP_TOOLS.impactAnalysis}: FIRST choice before editing an API endpoint, event, DTO/schema, RPC, ` +
        "GraphQL field, or widely-used symbol. Pass `change` when the proposed change is known.\n" +
        `  - ${MCP_TOOLS.trace}: FIRST choice for a known contract identifier such as "http POST /orders", ` +
        "\"event OrderCreated\", \"schema CreateOrderRequest\", \"grpc OrderService/CreateOrder\", " +
        "or \"graphql Mutation.createOrder\".\n" +
        `  - ${MCP_TOOLS.listContracts}: use to discover exact contract targets before tracing or impact analysis.\n` +
        `  - ${MCP_TOOLS.listDependencies}: use to inspect repository-to-repository dependency evidence.\n` +
        `  - ${MCP_TOOLS.askQuestion}: LAST resort only for broad exploratory questions when no known contract, ` +
        "repo, or symbol can be named. Do not use it for impact analysis, dependency listing, or contract tracing.",
    }
  );

  // Log MCP call to stderr and local file if enabled in config
  const logMcpCall = async (type: "tool" | "resource" | "prompt", name: string, args: any) => {
    if (!client.getConfig().mcp.logCalls) return;
    const timestamp = new Date().toISOString();
    const sanitizedType = String(type).replace(/[\r\n]/g, " ");
    const sanitizedName = String(name).replace(/[\r\n]/g, " ");
    const serializedArgs = JSON.stringify(args).replace(/[\r\n]/g, " ");
    const message = `[${timestamp}] [MCP Call] Type: ${sanitizedType}, Name: ${sanitizedName}, Args: ${serializedArgs}\n`;

    // Write to stderr so AI Client logs capture it
    process.stderr.write(message);

    // Append to local log file with size-based rotation (max 5 MB)
    try {
      const logsDir = path.resolve(cwd, BRAND_PATHS.logs);
      await fs.mkdir(logsDir, { recursive: true });
      const logFilePath = path.join(logsDir, "mcp.log");
      try {
        const stat = await fs.stat(logFilePath);
        if (stat.size > 5242880) {
          const backupPath = path.join(logsDir, "mcp.log.1");
          try {
            await fs.rename(logFilePath, backupPath);
          } catch {
            // Keep appending to avoid data loss if rename fails
          }
        }
      } catch {}
      await fs.appendFile(logFilePath, message, "utf8");
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
        const metadata = buildFreshnessMetadata({
          pending,
          watcherActive: client.isWatching(),
          degradedReason,
          catchUp: catchUpState,
          indexQueue: client.getIndexQueueStatus()
        });

        const notice = buildFreshnessNotice(metadata);
        if (notice) {
          response.content.push({
            type: "text",
            text: notice
          });
        }
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
      description: "Use for a quick health/coverage overview only. Returns graph database summary counts such as repositories, files, code nodes, calls, contracts, and dependencies. Do not use for dependency analysis, impact analysis, or contract tracing.",
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
      description: `Use when a tool response says freshness is stale, or when checking whether ${BRAND.displayName} indexing/watch coverage is current. Returns file watcher status, startup catch-up status, partial coverage, pending files, and index queue details. Do not use for code relationship analysis.`,
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
      description: "Use to answer which repositories depend on which other repositories, with evidence. Best for repo-level dependency questions and surveys before structural changes. Do not use for tracing one API/event/schema; use logiclens_trace for known contracts. Do not use for change risk; use logiclens_impact_analysis.",
      inputSchema: {
        strength: z.enum(["strong", "weak"]).optional().describe("Optional filter. strong = package/import/api dependencies; weak = event/shared-contract style dependencies."),
        type: z.string().min(1).max(256).optional().describe("Optional dependency type filter, for example package, import, api, event, shared-contract, grpc, graphql, or dubbo."),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum dependencies to retrieve. Use a small value such as 50 for exploration; maximum 1000."),
        repo: z.string().min(1).max(256).optional().describe("Repository name to focus on. With direction=outgoing, this repo is the consumer. With direction=incoming, this repo is the producer."),
        target: z.string().min(1).max(256).optional().describe("Optional other repository name for a repo-to-repo dependency pair. Requires repo. Example: repo='frontend', target='orders-service'."),
        direction: z.enum(["outgoing", "incoming"]).optional().describe("Use with repo. outgoing = dependencies from repo to other repos (repo consumes/depends on them). incoming = dependencies from other repos to repo (repo is produced/depended on)."),
      },
    },
    async ({ strength, type, limit, repo, target, direction }) => {
      return wrapWithFreshness(MCP_TOOLS.listDependencies, { strength, type, limit, repo, target, direction }, async () => {
        if (target && !repo) {
          throw new Error("`target` requires `repo`. Example: { \"repo\": \"frontend\", \"target\": \"orders-service\" }.");
        }
        if (direction && !repo) {
          throw new Error("`direction` requires `repo`. Use repo plus direction=outgoing for dependencies from that repo, or direction=incoming for dependencies into that repo.");
        }
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
      description: "Use to discover exact API/event/schema/RPC/GraphQL/package contract identifiers before calling logiclens_trace or logiclens_impact_analysis. Returns contracts with producer/consumer/share counts. Do not use for broad natural-language code search; use only to enumerate or filter known contract surfaces.",
      inputSchema: {
        kind: z.string().min(1).max(256).optional().describe("Optional contract kind filter, for example package, api, event, dto, schema, enum, config, grpc, graphql, or dubbo."),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum contracts to retrieve. Use a small value such as 50 for exploration; maximum 1000."),
        repo: z.string().min(1).max(256).optional().describe("Repository name to focus on. With direction=outgoing, this repo produces the contracts. With direction=incoming, this repo consumes the contracts."),
        direction: z.enum(["outgoing", "incoming"]).optional().describe("Use with repo. outgoing = contracts produced by repo. incoming = contracts consumed by repo."),
      },
    },
    async ({ kind, limit, repo, direction }) => {
      return wrapWithFreshness(MCP_TOOLS.listContracts, { kind, limit, repo, direction }, async () => {
        if (direction && !repo) {
          throw new Error("`direction` requires `repo`. Use repo plus direction=outgoing for contracts produced by that repo, or direction=incoming for contracts consumed by that repo.");
        }
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
      description: "Use FIRST before editing or proposing changes to an API endpoint, event, schema/DTO field, enum, RPC, GraphQL field, package contract, or widely-used symbol. Evaluates downstream blast radius and rates impacts as breaking/risky/compatible with file:line evidence. If the exact contract name is unknown, call logiclens_list_contracts first. Do not use logiclens_ask_question for change risk.",
      inputSchema: {
        target: z.string().min(1).max(512).describe("Required target symbol, entity, or contract. Prefer exact contract identifiers from logiclens_list_contracts, for example 'http POST /orders', 'event OrderCreated', 'schema CreateOrderRequest', 'grpc OrderService/CreateOrder', or 'graphql Mutation.createOrder'."),
        change: z.string().min(1).max(512).optional().describe("Optional proposed change in '<changeType>:<detail>' format. Valid change types: field-added, field-removed, field-type-changed, endpoint-removed, endpoint-renamed, endpoint-schema-change, topic-removed, topic-renamed, event-payload-change, rpc-removed, rpc-renamed, rpc-signature-change. Examples: 'field-removed:couponCode', 'endpoint-schema-change:request body changed'. Omit only for a broad impact survey."),
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
      description: "LAST RESORT broad retrieval. Use only when the user asks an exploratory natural-language question and no exact repository, contract, API/event/schema/RPC/GraphQL target, or symbol is known. Accuracy is lower than graph-specific tools. Do not use for dependency lists, contract discovery, contract tracing, or change impact; prefer logiclens_list_dependencies, logiclens_list_contracts, logiclens_trace, and logiclens_impact_analysis.",
      inputSchema: {
        question: z.string().min(1).max(1024).describe("Broad natural-language question only. If the question names a contract or change, use logiclens_trace or logiclens_impact_analysis instead."),
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
        "Use FIRST when the user names a known API endpoint, event, schema/DTO, RPC, GraphQL operation, package, or other contract and wants producers, consumers, request/response/payload schemas, or cross-repo flow. Prefer `target` natural identifiers; call logiclens_list_contracts first if the exact target is unknown. Do not use logiclens_ask_question for known contracts.\n" +
        "Modes:\n" +
        "  - target: natural identifier, for example \"http POST /orders\", \"event OrderCreated\", \"schema CreateOrderRequest\", \"grpc OrderService/CreateOrder\", \"dubbo com.acme.OrderService#createOrder\", \"graphql Mutation.createOrder\". Multi-hop trace returning the connected subgraph.\n" +
        "  - specId: internal ContractSpec ID only when already present in previous tool output. Single-hop trace of direct edges.\n" +
        "Provide exactly one of `target` or `specId`.",
      inputSchema: {
        target: z
          .string()
          .min(1)
          .max(512)
          .optional()
          .describe("Preferred. Natural contract identifier, for example \"http POST /orders\", \"event OrderCreated\", \"schema CreateOrderRequest\", \"grpc OrderService/CreateOrder\", \"dubbo com.acme.OrderService#createOrder\", or \"graphql Mutation.createOrder\"."),
        specId: z.string().min(1).max(256).optional().describe("Internal ContractSpec ID from prior tool output. Do not guess this. Use only when target is not provided."),
        maxHops: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Optional max hops per direction for target mode. Default 3. Use 2-5 for most analysis; maximum 20."),
        direction: z
          .enum(["outgoing", "incoming", "both"])
          .optional()
          .describe("Optional edge direction for trace. both = producers, consumers, and schemas when available (default). outgoing = downstream edges from the target. incoming = upstream edges into the target."),
      },
    },
    async ({ target, specId, maxHops, direction }) => {
      return wrapWithFreshness(
        MCP_TOOLS.trace,
        { target, specId, maxHops, direction },
        async () => {
          if (target && specId) {
            throw new Error("Provide exactly one of `target` or `specId`, not both. Prefer `target` unless you are reusing an internal ContractSpec ID from previous output.");
          }
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
              `For contract discovery, use ${MCP_TOOLS.listContracts}. Use ${MCP_TOOLS.askQuestion} only as a last resort for broad exploratory questions.`
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
              text: `Identify all cross-repository workflows and actions involving the domain entity '${entity}'. First use '${MCP_TOOLS.listContracts}' to discover relevant contracts, events, APIs, schemas, RPCs, and GraphQL operations. Use '${MCP_TOOLS.listDependencies}' if repository-level producer/consumer relationships are needed. Then use '${MCP_TOOLS.trace}' with specific contract identifiers (e.g. "event OrderCreated", "http POST /orders") to trace the full semantic dependency chain. Use '${MCP_TOOLS.askQuestion}' only as a last resort if the structured tools do not reveal a usable target. Construct a detailed sequential description showing how services consume and produce events/APIs related to this entity.`,
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
