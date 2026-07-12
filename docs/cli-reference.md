# CLI Command Reference

LogicLens provides a complete command-line tool for managing the construction, querying, and analysis of cross-repository semantic dependency graphs. This document covers all built-in commands and their parameter descriptions.

## Basic Usage

```bash
logiclens <command> [arguments] [options]
```

View version:

```bash
logiclens --version
```

View global help:

```bash
logiclens --help
```

View help for a specific command:

```bash
logiclens <command> --help
```

---

## Command Overview

| Command | Description |
|---------|-------------|
| [`init`](#logiclens-init) | Initialize LogicLens workspace |
| [`uninit`](#logiclens-uninit) | Remove LogicLens workspace |
| [`add-repo`](#logiclens-add-repo-path) | Add a single repository |
| [`add-repos`](#logiclens-add-repos-directory) | Batch-add Git repositories from a directory |
| [`index`](#logiclens-index) | Index configured repositories |
| [`stats`](#logiclens-stats) | Print graph statistics |
| [`deps`](#logiclens-deps) | List cross-repository dependencies |
| [`contracts`](#logiclens-contracts) | List contracts with producer/consumer counts |
| [`trace`](#logiclens-trace-target) | Multi-hop semantic trace of a contract spec |
| [`ask`](#logiclens-ask-question) | Natural language Q&A |
| [`impact`](#logiclens-impact-symbolorentity) | Change impact analysis |
| [`quality`](#logiclens-quality-action) | Audit and govern relation/contract quality |
| [`rebuild-relations`](#logiclens-rebuild-relations) | Rebuild cross-repository dependency edges |
| [`frameworks`](#logiclens-frameworks) | List detected frameworks |
| [`plugin`](#logiclens-plugin) | Install, list, diagnose, and remove plugins |
| [`mcp`](#logiclens-mcp) | Start MCP server |
| [`watch`](#logiclens-watch) | Start file watcher for auto-indexing |
| [`install`](#logiclens-install) | Install MCP into AI agents |
| [`uninstall`](#logiclens-uninstall) | Remove MCP from AI agents |

---

## Project Initialization

### `logiclens init`

Create a `.logiclens/` workspace in the current directory, including default configuration file and graph database directory.

```bash
logiclens init
```

**Parameters**: None

**Behavior**: Generates `.logiclens/config.yaml` with a default system name and empty repository list.

---

### `logiclens uninit`

Remove all contents of the LogicLens workspace, including configuration, graph database, cache, and semantic index, and stop any running MCP server.

```bash
logiclens uninit
```

**Parameters**: None

> [!CAUTION]
> This operation is irreversible and will delete all indexed data.

---

## Repository Management

### `logiclens add-repo <path>`

Add a single repository to `.logiclens/config.yaml`.

```bash
logiclens add-repo ../my-service
logiclens add-repo ../my-service --name my-service
```

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<path>` | Yes | Repository directory path |

**Options**:

| Option | Description |
|--------|-------------|
| `--name <name>` | Custom name for the repository (defaults to directory name) |

---

### `logiclens add-repos <directory>`

Scan all top-level Git repositories in the specified directory and batch-add them to the configuration.

```bash
logiclens add-repos ../all-services
logiclens add-repos ../all-services --index
logiclens add-repos ../all-services --index --changed-only
```

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<directory>` | Yes | Parent directory containing Git repositories |

**Options**:

| Option | Description |
|--------|-------------|
| `--index` | Index newly discovered repositories immediately after adding |
| `--changed-only` | Index only changed files |
| `--max-files <number>` | Maximum number of files to index per repository |
| `--batch-size <number>` | Number of repositories to index per batch during bulk import |

---

## Indexing & Building

### `logiclens index`

Index configured repositories, parse source code, and build the semantic dependency graph.

Before parsing, this command detects and activates installed plugins that match each repository. See the [Plugin Guide](plugins.md).

```bash
logiclens index
logiclens index --repo service-a
logiclens index --changed-only
logiclens index --max-files 1000
logiclens index --batch-size 3
```

**Options**:

| Option | Description |
|--------|-------------|
| `--repo <name>` | Index only the repository with the specified name |
| `--changed-only` | Index only changed files |
| `--max-files <number>` | Maximum number of files to index |
| `--batch-size <number>` | Number of repositories to index per batch |

---

### `logiclens rebuild-relations`

Rebuild cross-repository dependency edges based on indexed contract evidence.

```bash
logiclens rebuild-relations
logiclens rebuild-relations --repo service-a # Recommended
logiclens rebuild-relations --full # Not recommended
```

**Options**:

| Option | Description |
|--------|-------------|
| `--repo <name>` | Rebuild relations only for the specified repository |
| `--full` | Force full rebuild (ignores repository filter) |

---

## Query & Analysis

### `logiclens stats`

Print basic statistics about the graph.

```bash
logiclens stats
```

**Parameters**: None

**Output**: Repository count, file count, code node count, call edge count, import edge count, entity count.

---

### `logiclens deps`

List structured cross-repository dependencies.

```bash
logiclens deps
logiclens deps --strength strong
logiclens deps --type api --limit 20

# All dependencies involving order-service (outgoing + incoming)
logiclens deps --repo order-service

# What does order-service depend on?
logiclens deps --repo order-service --direction outgoing

# What depends on order-service?
logiclens deps --repo order-service --direction incoming

# Does order-service directly depend on payment-service?
logiclens deps --repo order-service --target payment-service --direction outgoing

# Combine with existing filters
logiclens deps --repo order-service --target payment-service --direction outgoing --strength strong --type api
```

**Options**:

| Option | Description |
|--------|-------------|
| `--strength <strong\|weak>` | Filter by dependency strength |
| `--type <type>` | Filter by dependency type. Options: `package`, `import`, `api`, `event`, `shared-contract` |
| `--limit <number>` | Maximum number of results to return |
| `--repo <name>` | Filter dependencies involving a specific repository |
| `--target <name>` | Filter dependencies targeting a specific repository (requires `--repo`) |
| `--direction <outgoing\|incoming>` | Direction: `outgoing` (repo as consumer) or `incoming` (repo as producer). Requires `--repo` |

> [!NOTE]
> `--direction` and `--target` both require `--repo`. If `--repo` is not specified, the command will error out.
> A non-existent repository name returns empty results rather than an error, consistent with `explain-deps` behavior.

---

### `logiclens contracts`

List all contracts with their producer/consumer counts.

```bash
# All contracts
logiclens contracts

# Filter by contract kind
logiclens contracts --kind api
logiclens contracts --kind event --limit 10

# What contracts does order-service participate in?
logiclens contracts --repo order-service

# What does order-service produce?
logiclens contracts --repo order-service --direction outgoing

# What does order-service consume?
logiclens contracts --repo order-service --direction incoming

# Combine filters
logiclens contracts --repo order-service --kind api --direction incoming
```

**Options**:

| Option | Description |
|--------|-------------|
| `--kind <kind>` | Filter by contract kind. Options: `package`, `api`, `event`, `dto`, `schema`, `enum`, `config` |
| `--limit <number>` | Maximum number of results to return |
| `--repo <name>` | Filter contracts involving a specific repository |
| `--direction <outgoing\|incoming>` | Direction: `outgoing` (repo as producer) or `incoming` (repo as consumer). Requires `--repo` |

> [!NOTE]
> `--direction` requires `--repo`. Producer/consumer/shared counts are always global — `--repo` only scopes which contracts are listed, not the aggregate counts.

---

### `logiclens trace <target>`

Resolve a natural contract identifier to its `ContractSpec` and walk `SEMANTIC_REL`
edges **multi-hop in both directions**, returning the connected sub-graph: downstream
request/response/payload schemas and upstream consumers. No internal spec IDs required.

```bash
logiclens trace "http POST /orders"
logiclens trace "api GET /users/:id"
logiclens trace "event OrderCreated"
logiclens trace "schema CreateOrderRequest"
logiclens trace "grpc OrderService/CreateOrder"
logiclens trace "grpc acme.order.v1.OrderService/CreateOrder"
logiclens trace "dubbo com.acme.OrderService#createOrder"
logiclens trace "graphql Query.user"
logiclens trace "graphql Mutation.createOrder"
logiclens trace "graphql Subscription.orderCreated"
logiclens trace http "POST /orders"            # extra tokens are joined too
logiclens trace "http POST /orders" --json     # structured output
logiclens trace "http POST /orders" --max-hops 5
logiclens trace "http POST /orders" --direction incoming   # consumers only
```

Example output:

```text
Semantic Trace: http POST /orders

Target Specs:
  [producer] order-service src/main/java/.../OrderController.java [spring-mvc]
      POST /orders  request=CreateOrderRequest  response=CreateOrderResponse

Discovered Specs:
  [upstream] web-app src/api/order.ts
      POST /orders  request=OrderInput  response=OrderResult

Relation Paths:
  [Target] POST /orders  request=CreateOrderRequest  response=CreateOrderResponse (order-service)
    file: src/main/java/.../OrderController.java

    <- [CALLS_ENDPOINT materialized] confidence=0.95
       POST /orders  request=OrderInput  response=OrderResult (web-app)
       file: src/api/order.ts
       reason: Exact method+path match: POST /orders
```

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<target>` | Yes | Natural contract identifier: a contract kind (`http`, `api`, `event`, `schema`, `dto`, `grpc`, `dubbo`, `graphql`, `package`, `config`) plus its key, e.g. `"http POST /orders"` or `"graphql Query.user"` |
| `[rest...]` | No | Extra tokens, joined onto `target` — so `trace http "POST /orders"` is equivalent to `trace "http POST /orders"` |

> RPC service/method names and GraphQL fields are matched case-sensitively. Use
> the same casing as the source definition, e.g. `OrderService/CreateOrder` and
> `Query.user`.

**Options**:

| Option | Description |
|--------|-------------|
| `--max-hops <number>` | Maximum hops per direction (default `3`) |
| `--direction <direction>` | `outgoing`, `incoming`, or `both` (default) |
| `--json` | Emit the structured trace graph as JSON |

> The same capability is exposed to agents via the MCP tool `logiclens_trace`
> using its `target` parameter (e.g. `{ "target": "http POST /orders" }` or `{ "target": "grpc OrderService/CreateOrder" }`).

---

### `logiclens impact <symbolOrEntity>`

Perform change impact analysis on a specified symbol or entity.

```bash
logiclens impact UserService
logiclens impact /api/order/:id
logiclens impact "schema CreateOrderRequest"
logiclens impact "http POST /orders" --max-hops 5
logiclens impact "schema CreateOrderRequest" --change field-removed:couponCode
logiclens impact Order --legacy
```

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<symbolOrEntity>` | Yes | Symbol, entity, or natural contract target |

**Options**:

| Option | Description |
|--------|-------------|
| `--change <change>` | Structured contract change, e.g. `field-removed:couponCode`, `endpoint-removed`, or `event-payload-change` |
| `--max-hops <number>` | Maximum semantic impact propagation depth (default: `3`) |
| `--legacy` | Show legacy symbol/call graph context even when a semantic contract match is found |
| `--verbose` | Show verbose output, including legacy context for semantic matches |

When the target resolves to a `ContractSpec`, `impact` follows the semantic
contract graph in the impact-propagation direction and prints affected
repositories, transitive impact chains, and recommended files. If no contract
spec is found for a bare symbol, it falls back to the legacy symbol/call graph
impact output. Explicit contract targets such as `schema Order` or
`http POST /orders` do not fall back silently when no contract spec exists.

---

### `logiclens ask <question>`

Answer natural language questions using an LLM based on graph data. This command first retrieves relevant context from the graph, then calls the configured LLM to generate an answer.

```bash
logiclens ask "Which services depend on OrderService?"
logiclens ask "What modules would be affected by modifying PaymentEvent?"
```

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<question>` | Yes | Natural language question |

> [!NOTE]
> This command requires LLM configuration (see the `llm` section in the [Configuration Guide](./configuration.md)). All other commands run locally and do not depend on LLM.
>
> If LLM is not configured (missing `apiKey` or `OPENAI_API_KEY` environment variable not set), the command will not error out. Instead, it returns the raw structured results from graph retrieval, including: question type, matching code nodes, matching document segments, entity/contract context, repository dependencies, semantic match results, and call edge information.

---

## Quality Governance

### `logiclens quality [action]`

Audit and govern relation quality and contract quality.

```bash
# Audit low-confidence relations and conflicting producers
logiclens quality

# Audit contract quality rules
logiclens quality contracts

# Filter by confidence
logiclens quality --min-confidence 0.8 --limit 50

# Mark false positives
logiclens quality --reject-evidence ev-123 --reason "false positive"

# Set manual alias
logiclens quality --alias my-service --target-repo service-a
```

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `[action]` | No | `contracts` to audit contract quality; omit to audit relation quality |

**Options**:

| Option | Description |
|--------|-------------|
| `--min-confidence <number>` | Minimum acceptable confidence |
| `--limit <number>` | Maximum number of rows to audit |
| `--reject-evidence <id>` | Mark the specified evidence ID as a false positive |
| `--reason <text>` | Reason for rejection or alias override |
| `--alias <alias>` | Alias override name (requires `--target-repo`) |
| `--target-repo <name>` | Target repository for alias override (requires `--alias`) |

---

## Frameworks

### `logiclens frameworks`

List detected frameworks for each repository.

Plugin framework detectors run as part of indexing. Run `logiclens index` after installing or updating a plugin, then use this command to view the detected frameworks.

```bash
logiclens frameworks
```

**Output**: Detected frameworks per repository (language, confidence, evidence).

---

## Plugin Management

### `logiclens plugin`

Install, inspect, diagnose, and remove external LogicLens plugins. Run `logiclens index` after installation to activate matching language plugins.

```bash
# npm package, local directory, or npm package tarball
logiclens plugin install @logiclens/plugin-csharp
logiclens plugin install ../my-plugin --global
logiclens plugin install ./my-plugin.tgz

logiclens plugin list --all
logiclens plugin doctor --all
logiclens plugin remove @logiclens/plugin-csharp --yes
```

#### `plugin install <source>`

| Option | Description |
|---|---|
| `--global` | Install under the current user's `~/.logiclens/plugins/`. |
| `--force` | Atomically replace a plugin with the same manifest name. |

Without an explicit scope, LogicLens installs under the current workspace's `.logiclens/plugins/`. Language detection determines which configured repositories activate the plugin. npm lifecycle scripts may run while production dependencies are installed; install only trusted plugins.

#### `plugin list` and `plugin doctor`

Both commands accept `--global`, `--all`, and `--json`. `list` reports installed versions, sources, paths, and `valid`/`invalid` status. `doctor` performs full validation, reports errors, and exits non-zero when an invalid or duplicate plugin is found. Run `doctor` only for plugins you trust.

#### `plugin remove <name>`

Accepts `--global`; otherwise removes from the current workspace. Removal prompts for confirmation; pass `--yes` for CI or other non-interactive use. Restart `watch` or MCP and re-index after installing, replacing, or removing a plugin.

See the [Plugin Guide](plugins.md) for package requirements and security details.

---

## MCP Server

### `logiclens mcp`

Start the Model Context Protocol (MCP) server via stdio for AI agent integration.

```bash
logiclens mcp
logiclens mcp --path /path/to/workspace
```

**Options**:

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Workspace root path (defaults to current directory) |

> [!NOTE]
> The MCP server uses stdout for JSON-RPC communication and outputs logs to stderr.

---

### `logiclens watch`

Start a file watcher that automatically indexes repository changes.

Restart the watcher after installing, replacing, or removing a plugin. The watcher automatically includes active plugin source extensions while respecting `exclude` and `.gitignore` rules.

```bash
logiclens watch
logiclens watch --repo service-a
logiclens watch --debounce-ms 1000
```

**Options**:

| Option | Description |
|--------|-------------|
| `--debounce-ms <number>` | Debounce time in milliseconds for file events |
| `--repo <name>` | Watch only the specified repository |

**Behavior**: On startup, performs an initial incremental index (changed-only, merge mode), then enters continuous watch mode. Press `Ctrl+C` to stop.

---

## Agent Integration

### `logiclens install`

Install the LogicLens MCP server into one or more AI agents.

Supported agents: Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE.

```bash
# Interactive selection
logiclens install

# Non-interactive: auto-detect and install globally
logiclens install -y

# Specify target agents
logiclens install -t claude-code,cursor

# Specify install location
logiclens install -t claude-code --location local

# Print config snippet only, do not write to file
logiclens install --print-config claude-code
```

**Options**:

| Option | Description |
|--------|-------------|
| `-t, --target <ids>` | Target agents, comma-separated IDs, or `auto`, `all`, `none` (default: interactive selection) |
| `-l, --location <where>` | Install location: `global` or `local` (default: interactive selection) |
| `-y, --yes` | Non-interactive mode, defaults to `--location=global --target=auto` |
| `--no-permissions` | Skip writing to auto-approve list (Claude Code only) |
| `--print-config <id>` | Print MCP config snippet for the specified agent only |

---

### `logiclens uninstall`

Remove the LogicLens MCP server from AI agents.

```bash
# Remove from all agents
logiclens uninstall

# Non-interactive
logiclens uninstall -y

# Specify target
logiclens uninstall -t claude-code
```

**Options**:

| Option | Description |
|--------|-------------|
| `-t, --target <ids>` | Target agents, comma-separated IDs or `all` (default: `all`) |
| `-l, --location <where>` | Uninstall location: `global` or `local` (default: interactive selection) |
| `-y, --yes` | Non-interactive mode, defaults to `--location=global --target=all` |
