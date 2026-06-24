# LogicLens

**LogicLens is a local-first Code Graph tool that builds a semantic dependency graph for cross-repository codebases.**

Modern systems are often spread across many services, packages, frontends, jobs, SDKs, and shared libraries. A single repository view is not enough when you need to answer questions like:

- Which repositories consume this API, event, package, DTO, schema, or config key?
- If I change this handler, symbol, or contract, what files should I inspect first?
- Which services are connected by imports, package metadata, HTTP calls, events, or shared contract evidence?
- What code and documentation should an AI assistant read before it answers a codebase question?

LogicLens indexes your configured repositories, extracts source symbols, call chains, and cross-repository contract evidence, and **builds a knowledge graph that covers your entire code system**. The graph is stored in a local Kuzu database. You can query it from the CLI, integrate it via the Node.js SDK, or expose it to AI coding assistants through a stdio MCP server — making complex codebase relationships visible at a glance.

> [!IMPORTANT]
> **LogicLens is currently in active Beta development.** While the core indexing engine, CLI, SDK, watcher, and MCP server are fully functional and ready for use, language and framework coverage is intentionally incremental. Expect occasional changes as we refine the APIs and schema.

## The Code Graph: What It Builds

At its core, LogicLens **builds a code graph** — a structured knowledge graph that connects code entities, dependency relationships, and contract evidence scattered across multiple repositories.

### Graph Data Sources

- Repositories declared in `.logiclens/config.yaml`.
- Files selected by `include` and `exclude` glob patterns.
- Parsed code symbols, imports, calls, and documentation sections.
- Detected frameworks and language facts.
- Contract evidence such as packages, imports, APIs, events, DTOs, schemas, enums, and config keys.
- Optional semantic summaries and embeddings when configured.

### Graph Capabilities

The code graph supports workflows such as:

- **Cross-repository dependency discovery** — see the dependency topology across services at a glance.
- **Contract tracing** — start from an API, event, or package contract and find all producers and consumers.
- **Change impact analysis** — assess the blast radius before making changes to reduce deployment risk.
- **Graph-grounded natural-language retrieval** — query code relationships using natural language.
- **AI Agent context enrichment** — provide structured codebase context to coding assistants via MCP.
- **Quality governance** — audit and correct low-confidence or conflicting dependency evidence locally.

## Features

- **Local-first code graph**: builds a code knowledge graph on Kuzu, stored locally under `.logiclens/graph` — your data never leaves your machine.
- **Cross-repository workspace**: manage one workspace that points at many repositories, building a unified graph across your entire code system.
- **Static code intelligence**: extracts symbols, imports, calls, docs, language facts, and framework signals as graph nodes and edges.
- **Contract model**: normalizes cross-repository evidence into contract kinds such as `api`, `event`, `package`, `dto`, `schema`, `enum`, and `config`, enriching graph semantics.
- **Dependency views**: lists repo-to-repo dependencies with strength, type, evidence location, rule, and resolution metadata.
- **Trace and impact analysis**: starts from a contract or symbol and follows graph paths to return producers, consumers, related code, calls, docs, and files to inspect.
- **CLI, SDK, MCP**: query the graph manually, integrate via Node.js, or connect to AI coding assistants.
- **File watcher**: performs changed-file indexing to keep the graph up to date, and exposes freshness metadata to MCP clients.
- **Quality controls**: audit low-confidence evidence, reject false positives, and register alias overrides to ensure graph accuracy.
- **Optional LLM/embedding layer**: supports OpenAI-compatible chat and embedding providers when enabled, enhancing graph semantics.
- **Plugin API**: register custom parsers, framework detectors, contract extractors, and CLI commands to extend graph coverage.

## Installation

### From npm

```bash
npm install -g logiclens
logiclens --version
```

Without a global install:

```bash
npx logiclens --help
```

### From source

```bash
git clone https://github.com/arnofeng/logiclens.git
cd logiclens
npm install
npm run build
npm link
logiclens --help
```

For local development without linking:

```bash
npm run dev -- --help
npm run dev -- init
```

## Quick Start

Create a workspace. The workspace can be a parent directory containing repositories, or a separate directory that references repositories elsewhere.

```bash
mkdir my-workspace
cd my-workspace
logiclens init
```

Add one repository:

```bash
logiclens add-repo ../service-a --name service-a
```

Add all first-level Git repositories under a directory:

```bash
logiclens add-repos ../services
```

Index everything:

```bash
logiclens index
```

Inspect the graph:

```bash
logiclens stats
logiclens deps --limit 20
logiclens contracts --limit 20
```

Trace a contract:

```bash
logiclens trace api:/api/order/:id
logiclens trace event:OrderCreatedEvent
```

Analyze impact:

```bash
logiclens impact OrderCreatedEvent
logiclens impact api:/api/order/:id
```

Ask a graph-grounded question:

```bash
logiclens ask "Which repositories are involved in order creation?"
```

Keep the graph updated while you edit code:

```bash
logiclens watch --debounce-ms 2000
```

## Example Workflows

### Analyze A Set Of Services

```bash
logiclens init
logiclens add-repos ../company-services --index --batch-size 10 --write-mode auto
logiclens stats
logiclens deps --strength strong --limit 50
logiclens contracts --kind api --limit 50
```

Use this when you are onboarding a group of repositories and want a first dependency map.

### Check An API Migration

```bash
logiclens index --changed-only
logiclens trace api:/api/order/:id
logiclens impact api:/api/order/:id
logiclens deps --type api --limit 100
```

Use this before changing an endpoint, route, generated client, or HTTP client wrapper.

### Review Event Consumers

```bash
logiclens contracts --kind event --limit 100
logiclens trace event:OrderCreatedEvent
logiclens impact OrderCreatedEvent
```

Use this when changing a published event name, payload, topic, DTO, or handler.

### Keep A Workspace Fresh For AI Assistants

```bash
logiclens index
logiclens mcp
```

Then connect your MCP-compatible client to the workspace. The MCP server starts a file watcher and background changed-file catch-up so tool responses can include freshness metadata.

## Configuration

`logiclens init` creates `.logiclens/config.yaml`. This file is the source of truth for repositories, indexing behavior, graph storage, semantic search, LLM providers, MCP safety, and watcher behavior.

### Configuration Template

By default, `logiclens init` generates a minimal, clean configuration file:

```yaml
systemName: default-system

repos:
  - name: service-a
    path: ../service-a
  - name: service-b
    path: ../service-b
```

### Advanced Configuration

LogicLens supports a variety of advanced configuration options for performance tuning, indexing settings, custom LLM retries, and semantic storage providers.

To see all available options and their default values, refer to the [Configuration Guide](docs/configuration.md).

### Environment Variables

```bash
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
LOGICLENS_NO_WATCH=1
LOGICLENS_FORCE_WATCH=1
```

| Variable | Description |
| --- | --- |
| `OPENAI_API_KEY` | Used when `llm.apiKey` or `embedding.apiKey` is not set. |
| `OPENAI_BASE_URL` | Used when `llm.baseUrl` or `embedding.baseUrl` is not set. |
| `LOGICLENS_NO_WATCH=1` | Disables file watching. |
| `LOGICLENS_FORCE_WATCH=1` | Forces watcher enablement even when policy would normally block it. |

### Cost And Privacy Notes

Indexing, graph writes, `stats`, `deps`, `contracts`, `trace`, `impact`, and raw graph queries are local graph operations. They do not require an LLM provider by default.

`ask` uses graph retrieval and then calls the configured LLM to write an answer. Optional LLM summaries and embeddings can also send selected source or document text to your configured provider. Keep `embedding.level: off` and `indexing.llmSummaryLevel: off` if you want purely local indexing.

## CLI Usage

Run:

```bash
logiclens --help
logiclens <command> --help
```

### Workspace Commands

#### `logiclens init`

Creates `.logiclens/config.yaml`, `.logiclens/graph`, and `.logiclens/cache`.

```bash
logiclens init
```

#### `logiclens uninit`

Removes `.logiclens` workspace state and tries to stop a running MCP process recorded in `.logiclens/mcp.pid`.

```bash
logiclens uninit
```

#### `logiclens add-repo <path>`

Adds one repository to `.logiclens/config.yaml`.

```bash
logiclens add-repo ../service-a
logiclens add-repo ../service-a --name order-service
```

| Option | Description |
| --- | --- |
| `--name <name>` | Store the repository under a custom name. Defaults to the directory basename. |

#### `logiclens add-repos <directory>`

Discovers first-level Git repositories under a directory and adds them to the workspace config.

```bash
logiclens add-repos ../services
logiclens add-repos ../services --index --changed-only
logiclens add-repos ../services --index --batch-size 10 --write-mode auto
```

| Option | Description |
| --- | --- |
| `--index` | Index discovered repositories after adding them. |
| `--changed-only` | When indexing, process changed files only where previous file state exists. |
| `--max-files <number>` | Maximum files to index per repository. |
| `--batch-size <number>` | Number of repositories per batch for large full imports. |
| `--write-mode <mode>` | Graph write mode: `auto`, `merge`, `bulk`, or `bulk-upsert`. Default: `auto`. |

### Indexing Commands

#### `logiclens index`

Indexes configured repositories. This is the main command that scans files, parses source, extracts contracts, writes graph nodes and edges, updates semantic data when configured, and rebuilds repo-to-repo dependency edges.

```bash
logiclens index
logiclens index --repo service-a
logiclens index --changed-only
logiclens index --max-files 2000
logiclens index --batch-size 10 --write-mode auto
logiclens index --write-mode merge
```

| Option | Description |
| --- | --- |
| `--repo <name>` | Index one configured repository by name. |
| `--changed-only` | Re-index only files that have changed since the last recorded state. Best for daily use after an initial full index. |
| `--max-files <number>` | Limit the number of files processed in the run. Useful for smoke tests or very large repos. |
| `--batch-size <number>` | Split a large full import into repository batches. Works with `auto` or `bulk` write modes. |
| `--write-mode <mode>` | `auto`, `merge`, `bulk`, or `bulk-upsert`. Default: `auto`. |

Write mode guidance:

| Mode | Use When |
| --- | --- |
| `auto` | You want LogicLens to choose the safest available path. Recommended default. |
| `merge` | You are updating an existing graph or running `--changed-only`. |
| `bulk` | You are importing into an empty graph and want a full-copy bulk path. |
| `bulk-upsert` | You want bulk-oriented upsert behavior for existing graph data. |

#### `logiclens rebuild-relations`

Rebuilds repo-to-repo dependency edges from already indexed contract evidence.

```bash
logiclens rebuild-relations
logiclens rebuild-relations --repo service-a
logiclens rebuild-relations --full
```

| Option | Description |
| --- | --- |
| `--repo <name>` | Rebuild dependency edges for one repository. |
| `--full` | Rebuild all dependency edges. |

#### `logiclens watch`

Runs an initial changed-only catch-up index and then watches files for changes.

```bash
logiclens watch
logiclens watch --repo service-a
logiclens watch --debounce-ms 3000
```

| Option | Description |
| --- | --- |
| `--debounce-ms <number>` | Delay after file events before indexing. |
| `--repo <name>` | Watch and index a single configured repository. |

### Query And Analysis Commands

#### `logiclens stats`

Prints graph counts such as repositories, files, code nodes, section nodes, entities, and edges.

```bash
logiclens stats
```

#### `logiclens deps`

Lists structured cross-repository dependencies and evidence.

```bash
logiclens deps
logiclens deps --limit 50
logiclens deps --strength strong
logiclens deps --strength weak
logiclens deps --type api --limit 100
logiclens deps --type event --limit 100
```

| Option | Description |
| --- | --- |
| `--strength <strong|weak>` | Filter by dependency strength. Package, import, and API are treated as strong; event and shared-contract are treated as weak. |
| `--type <type>` | Filter by dependency type, for example `package`, `import`, `api`, `event`, or `shared-contract`. |
| `--limit <number>` | Maximum dependencies to print. |

#### `logiclens contracts`

Lists recognized contracts with producer, consumer, and shared counts.

```bash
logiclens contracts
logiclens contracts --kind api --limit 50
logiclens contracts --kind event --limit 50
logiclens contracts --kind package --limit 50
```

| Option | Description |
| --- | --- |
| `--kind <kind>` | Filter by `package`, `api`, `event`, `dto`, `schema`, `enum`, or `config`. |
| `--limit <number>` | Maximum contracts to print. |

#### `logiclens trace <contractOrEntity>`

Traces a contract or entity.

```bash
logiclens trace api:/api/order/:id
logiclens trace event:OrderCreatedEvent
logiclens trace package:@internal/order-sdk
logiclens trace OrderService
```

Targets with a known `kind:value` prefix are treated as contracts. Other targets are treated as entity or symbol names.

#### `logiclens impact <symbolOrEntity>`

Shows potential downstream impact for a contract, entity, or symbol.

```bash
logiclens impact OrderCreatedEvent
logiclens impact api:/api/order/:id
logiclens impact OrderService
```

The output includes contract producers/consumers, entity graph context, matched code, related call edges, related docs, and recommended files to inspect.

#### `logiclens ask <question>`

Retrieves graph context and asks the configured LLM to answer.

```bash
logiclens ask "Which services create orders?"
logiclens ask "What should I inspect before changing OrderCreatedEvent?"
logiclens ask "Which repositories depend on the payment API?"
```

If no API key is configured, retrieval can still provide fallback graph context, but full answer generation requires an OpenAI-compatible provider.

#### `logiclens query <cypher>`

Runs a raw Kuzu Cypher query against the local graph.

```bash
logiclens query "MATCH (r:Repo) RETURN r.name AS name LIMIT 10"
logiclens query "MATCH (c:Contract) RETURN c.kind AS kind, c.key AS key LIMIT 20"
```

This CLI command is intended for local trusted use. In MCP, raw Cypher is read-only by default unless `mcp.allowUnsafeCypher` is enabled.

### Quality And Diagnostics Commands

#### `logiclens quality`

Audits low-confidence relations and conflicting producers.

```bash
logiclens quality
logiclens quality --min-confidence 0.7 --limit 50
```

| Option | Description |
| --- | --- |
| `--min-confidence <number>` | Minimum accepted confidence before evidence appears in the low-confidence audit. |
| `--limit <number>` | Maximum audit rows. |

Reject false-positive evidence:

```bash
logiclens quality --reject-evidence <evidence-id> --reason "false positive"
```

Register an alias override:

```bash
logiclens quality --alias order-api --target-repo service-a --reason "internal service alias"
```

| Option | Description |
| --- | --- |
| `--reject-evidence <id>` | Mark evidence as rejected. |
| `--reason <text>` | Reason for rejection or alias override. |
| `--alias <alias>` | Alias name to map to a repository. |
| `--target-repo <name>` | Repository name used as the alias target. |

#### `logiclens quality contracts`

Audits contract quality rules.

```bash
logiclens quality contracts
```

#### `logiclens frameworks`

Prints detected frameworks and enabled extractors per repository.

```bash
logiclens frameworks
```

Use this when contract extraction does not behave as expected and you want to see whether a framework detector or extractor is active.

#### `logiclens plugins`

Lists configured plugins and registered extension hooks.

```bash
logiclens plugins
```

## SDK Usage

LogicLens exposes a Node.js ESM SDK from the package root.

```ts
import { createLogicLens } from "logiclens";

const client = await createLogicLens({ cwd: process.cwd() });

try {
  await client.init();
  await client.addRepo("../service-a", { name: "service-a" });
  await client.index({ changedOnly: false, writeMode: "auto" });

  const stats = await client.stats();
  const dependencies = await client.dependencies({ strength: "strong", limit: 20 });
  const contracts = await client.contracts({ kind: "api", limit: 20 });
  const trace = await client.trace("api:/api/order/:id");
  const impact = await client.impact("OrderCreatedEvent");

  console.log({ stats, dependencies, contracts, trace, impact });
} finally {
  await client.close();
}
```

### Create A Client With A Custom Config

```ts
import { createLogicLens } from "logiclens";

const client = await createLogicLens({
  cwd: "/absolute/path/to/workspace",
  config: {
    systemName: "demo",
    repos: [{ name: "service-a", path: "../service-a" }],
    plugins: [],
    frameworks: { include: [], exclude: [] },
    include: ["**/*.ts", "**/*.md"],
    exclude: ["**/node_modules/**", "**/.git/**"],
    graph: { provider: "kuzu", path: ".logiclens/graph" },
    llm: {
      provider: "openai",
      model: "gpt-4.1-mini",
      maxSourceCharsPerNode: 6000,
      retry: { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 8000, jitterRatio: 0.2, timeoutMs: 60000 },
      budget: {},
      rateLimit: { minDelayMs: 0 }
    },
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      level: "off",
      batchSize: 64,
      concurrency: 2,
      retry: { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 8000, jitterRatio: 0.2, timeoutMs: 60000 },
      budget: {},
      rateLimit: { minDelayMs: 0 }
    },
    semantic: {
      provider: "json",
      jsonPath: ".logiclens/semantic-index.json",
      chroma: { mode: "local", url: "http://localhost:8000", collection: "logiclens" }
    },
    mcp: { allowUnsafeCypher: false, logCalls: false },
    watch: {
      enabled: true,
      mode: "auto",
      debounceMs: 2000,
      maxRoots: 256,
      maxLinuxDirs: 20000,
      syncConcurrency: 1,
      catchUp: "background"
    },
    indexing: {
      concurrency: 4,
      summarizeChangedOnly: true,
      maxFilesPerRun: 5000,
      batchSize: 0,
      llmSummaryLevel: "off"
    }
  }
});

await client.close();
```

### Common SDK Calls

```ts
await client.addRepos("../services", { index: true, changedOnly: true });
await client.index({ repo: "service-a", changedOnly: true, writeMode: "merge" });
await client.rebuildRelations({ full: true });

const deps = await client.dependencies({ type: "api", limit: 100 });
const unresolved = await client.unresolvedEvidence({ limit: 50 });
const retrieval = await client.retrieve("Where is order creation implemented?");
const answer = await client.ask("Which services consume OrderCreatedEvent?");
const rows = await client.query("MATCH (r:Repo) RETURN r.name AS name LIMIT 10");
```

### SDK Method Reference

| Method | Purpose |
| --- | --- |
| `client.init()` | Initialize `.logiclens` directories and default config. |
| `client.uninit()` | Remove workspace state and stop a recorded MCP process where possible. |
| `client.addRepo(path, options)` | Add one repository. |
| `client.addRepos(directory, options)` | Discover and add first-level Git repositories. |
| `client.ensurePlugins()` | Load configured and inline plugins. |
| `client.index(options)` | Index repositories. |
| `client.getIndexQueueStatus()` | Inspect SDK/MCP indexing queue state. |
| `client.rebuildRelations(options)` | Rebuild dependency edges from indexed evidence. |
| `client.stats()` | Return graph counts. |
| `client.dependencies(options)` | List cross-repository dependencies. |
| `client.unresolvedEvidence(options)` | List extraction sites that could not be reduced to stable contract keys. |
| `client.contracts(options)` | List recognized contracts. |
| `client.trace(target)` | Trace a contract or entity. |
| `client.impact(target)` | Analyze downstream impact. |
| `client.retrieve(question)` | Return structured retrieval context without generating an answer. |
| `client.ask(question)` | Generate an answer from retrieved context. |
| `client.query(cypher, params)` | Run a Kuzu query. |
| `client.watch(options)` | Start automatic changed-file indexing. |
| `client.unwatch()` | Stop the watcher. |
| `client.getWatchStatus()` | Inspect watcher, catch-up, pending files, and queue state. |
| `client.close()` | Close watcher, queue, and graph resources. |

### SDK Plugins

```ts
import { createLogicLens, definePlugin } from "logiclens";

const plugin = definePlugin({
  name: "my-plugin",
  version: "1.0.0",
  pluginApiVersion: "1",
  setup(context) {
    context.registerCliCommand((program) => {
      program.command("hello").action(() => console.log("hello from plugin"));
    });
  }
});

const client = await createLogicLens({
  cwd: process.cwd(),
  plugins: [plugin]
});

await client.ensurePlugins();
await client.close();
```

Plugins can register:

- `registerParser(parser)` for custom language parsing.
- `registerFrameworkDetector(detector)` for repository-level framework detection.
- `registerContractExtractor(extractor)` for API, event, package, DTO, schema, enum, config, or custom contract evidence.
- `registerCliCommand(registerFn)` for additional CLI commands.

## MCP Usage

LogicLens can run as a stdio Model Context Protocol server. You can configure it automatically (recommended) or manually.

### Automatic Setup (Recommended)

You can automatically register the LogicLens MCP server in one or more AI agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE, Kiro) using the interactive installer:

```bash
logiclens install
```

For non-interactive installation (defaults to global, auto-allow permissions where applicable):
```bash
# Auto-detect installed agents and configure globally
logiclens install -y

# Configure specifically for Claude Code and Cursor locally in this project
logiclens install -y -t claude,cursor --location local
```

To remove configurations:
```bash
# Interactive uninstaller
logiclens uninstall

# Non-interactive global removal
logiclens uninstall -y
```

### Manual Setup

To run the MCP server manually over stdio:

```bash
logiclens mcp
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "logiclens": {
      "command": "logiclens",
      "args": ["mcp"],
      "cwd": "/absolute/path/to/your/logiclens-workspace"
    }
  }
}
```

From a source checkout:

```json
{
  "mcpServers": {
    "logiclens": {
      "command": "node",
      "args": ["/absolute/path/to/logiclens/bin/logiclens.js", "mcp"],
      "cwd": "/absolute/path/to/your/logiclens-workspace"
    }
  }
}
```

### MCP Tools

| Tool | Arguments | Description |
| --- | --- | --- |
| `logiclens_get_stats` | none | Return graph statistics as JSON. |
| `logiclens_get_watch_status` | none | Return watcher, startup catch-up, pending file, and indexing queue status. |
| `logiclens_list_dependencies` | `strength?`, `type?`, `limit?` | List cross-repository dependencies. |
| `logiclens_list_contracts` | `kind?`, `limit?` | List recognized contracts and producer/consumer/shared counts. |
| `logiclens_trace` | `target` | Trace a contract such as `api:/v1/users` or an entity such as `OrderService`. |
| `logiclens_impact_analysis` | `target` | Return downstream impact context for a symbol, entity, or contract. |
| `logiclens_ask_question` | `question` | Retrieve structured codebase context for a natural-language question. |
| `logiclens_query_cypher` | `cypher` | Run a raw Kuzu Cypher query. Read-only by default when `mcp.allowUnsafeCypher` is false. |

### MCP Examples

Ask your AI assistant to:

```text
Use logiclens_get_stats to summarize the indexed workspace.
```

```text
Use logiclens_trace with target "event:OrderCreatedEvent" and tell me which repositories produce or consume it.
```

```text
Use logiclens_impact_analysis for "api:/api/order/:id" and produce a migration checklist.
```

```text
Use logiclens_list_dependencies with type "api" and limit 50, then identify risky cross-repository API dependencies.
```

### Freshness Behavior

When the MCP server starts, LogicLens starts a watcher and background changed-file catch-up. Normal tool responses include freshness metadata so clients can see whether indexing may be stale because:

- Startup catch-up is still running.
- Catch-up failed.
- The watcher degraded.
- Files have pending changes.
- The indexing queue is running or has pending jobs.

## Current Language And Framework Coverage

LogicLens currently scans and parses:

| Area | Extensions |
| --- | --- |
| TypeScript | `.ts`, `.tsx` |
| JavaScript | `.js`, `.jsx` |
| Vue | `.vue` |
| Java | `.java` |
| Python | `.py` |
| Go | `.go` |
| Markdown / MDX | `.md`, `.mdx` |
| Config files | `.yml`, `.yaml`, `.toml`, `.properties` |

Built-in framework and contract extraction currently focuses on:

| Area | Current Coverage |
| --- | --- |
| JavaScript / TypeScript | `package.json`, imports, common HTTP client request patterns, generated-client evidence where statically visible. |
| Java | Maven/Gradle metadata, package facts, Spring MVC annotations/imports. |
| Python | Generic Python parsing and FastAPI detection from dependency metadata. |
| Go | Go modules, generic Go parsing, Gin detection. |
| Documentation | Markdown/MDX sections that can be linked to code and impact output. |
| Config | YAML, TOML, properties, and environment/config-style contract evidence. |

More languages, frameworks, and generated-client patterns will be added over time. For project-specific conventions, use plugins instead of waiting for built-in support.

## Limitations

- LogicLens is beta software. Graph shape, extractor behavior, and plugin APIs may still evolve.
- Static analysis is conservative. Dynamic API paths, reflection, runtime dependency injection, generated code, and framework magic may be incomplete or reported as unresolved evidence.
- Built-in framework support is focused. Unsupported frameworks may still be parsed as source, but contract extraction may be shallow until a detector or extractor exists.
- Cross-repository dependency quality depends on repository names, package metadata, imports, aliases, and contract evidence.
- Large workspaces may need `--changed-only`, `--batch-size`, `--max-files`, watcher tuning, or Chroma-backed semantic storage.
- LLM answers are only as good as retrieved context and provider behavior. Use `trace`, `deps`, `contracts`, and `impact` for inspectable evidence.
- The MCP server has local workspace access. Connect it only to clients you trust.

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

Useful development commands:

```bash
npm run dev -- --help
npm run bench:scale
npm run audit:prod
```

Package verification:

```bash
npm pack --dry-run --ignore-scripts
```

## Contributing

We welcome and appreciate contributions of all kinds! Whether you are filing bug reports, improving documentation, or proposing new features and framework integrations, your help is highly valued.

For details on how to get started, set up your local environment, and submit a Pull Request, please refer to the [Contributing Guide](CONTRIBUTING.md).

## Security

LogicLens indexes local source code and can expose graph-derived context to CLI users, SDK callers, and MCP clients. Be careful when connecting the MCP server to third-party tools or enabling raw Cypher writes.

See `SECURITY.md` for reporting security issues.

## License

MIT. See `LICENSE`.

