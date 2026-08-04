# CLI Command Reference

RepoHelix provides a complete command-line tool for managing the construction, querying, and analysis of cross-repository semantic dependency graphs. This document covers all built-in commands and their parameter descriptions.

## Basic Usage

```bash
repohelix <command> [arguments] [options]
```

View version:

```bash
repohelix --version
```

View global help:

```bash
repohelix --help
```

View help for a specific command:

```bash
repohelix <command> --help
```

---

## Command Overview

| Command | Description |
|---------|-------------|
| [`init`](#repohelix-init) | Initialize RepoHelix workspace |
| [`uninit`](#repohelix-uninit) | Remove RepoHelix workspace |
| [`add-repo`](#repohelix-add-repo-path) | Add a single repository |
| [`add-repos`](#repohelix-add-repos-directory) | Batch-add Git repositories from a directory |
| [`index`](#repohelix-index) | Index configured repositories |
| [`stats`](#repohelix-stats) | Print graph statistics |
| [`deps`](#repohelix-deps) | List cross-repository dependencies |
| [`contracts`](#repohelix-contracts) | List contracts with producer/consumer counts |
| [`trace`](#repohelix-trace-target) | Multi-hop semantic trace of a contract spec |
| [`ask`](#repohelix-ask-question) | Natural language Q&A |
| [`impact`](#repohelix-impact-symbolorentity) | Change impact analysis |
| [`quality`](#repohelix-quality-action) | Audit and govern relation/contract quality |
| [`rebuild-relations`](#repohelix-rebuild-relations) | Rebuild cross-repository dependency edges |
| [`frameworks`](#repohelix-frameworks) | List detected frameworks |
| [`plugin`](#repohelix-plugin) | Install, list, diagnose, and remove plugins |
| [`mcp`](#repohelix-mcp) | Start MCP server |
| [`watch`](#repohelix-watch) | Start file watcher for auto-indexing |
| [`install`](#repohelix-install) | Install MCP into AI agents |
| [`uninstall`](#repohelix-uninstall) | Remove MCP from AI agents |

---

## Project Initialization

### `repohelix init`

Create a `.repohelix/` workspace in the current directory, including default configuration file and graph database directory.

```bash
repohelix init
```

**Parameters**: None

**Behavior**: Generates `.repohelix/config.yaml` with a default system name and empty repository list.

---

### `repohelix uninit`

Remove all contents of the RepoHelix workspace, including configuration, graph database, and cache, and stop any running MCP server.

```bash
repohelix uninit
```

**Parameters**: None

> [!CAUTION]
> This operation is irreversible and will delete all indexed data.

---

## Repository Management

### `repohelix add-repo <path>`

Add a single repository to `.repohelix/config.yaml`.

```bash
repohelix add-repo ../my-service
repohelix add-repo ../my-service --name my-service
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

### `repohelix add-repos <directory>`

Scan all top-level Git repositories in the specified directory and batch-add them to the configuration.

```bash
repohelix add-repos ../all-services
repohelix add-repos ../all-services --index
repohelix add-repos ../all-services --index --changed-only
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

### `repohelix index`

Index configured repositories, parse source code, and build the semantic dependency graph.

Before parsing, this command detects and activates installed plugins that match each repository. See the [Plugin Guide](plugins.md).

```bash
repohelix index
repohelix index --repo service-a
repohelix index --changed-only
repohelix index --max-files 1000
repohelix index --batch-size 3
```

**Options**:

| Option | Description |
|--------|-------------|
| `--repo <name>` | Index only the repository with the specified name |
| `--changed-only` | Index only changed files |
| `--max-files <number>` | Maximum number of files to index |
| `--batch-size <number>` | Number of repositories to index per batch |

---

### `repohelix rebuild-relations`

Rebuild cross-repository dependency edges based on indexed contract evidence.

```bash
repohelix rebuild-relations
repohelix rebuild-relations --repo service-a # Recommended
repohelix rebuild-relations --full # Not recommended
```

**Options**:

| Option | Description |
|--------|-------------|
| `--repo <name>` | Rebuild relations only for the specified repository |
| `--full` | Force full rebuild (ignores repository filter) |

---

## Query & Analysis

### `repohelix stats`

Print basic statistics about the graph.

```bash
repohelix stats
```

**Parameters**: None

**Output**: Repository count, file count, code node count, call edge count, import edge count, entity count.

---

### `repohelix deps`

List structured cross-repository dependencies.

```bash
repohelix deps
repohelix deps --strength strong
repohelix deps --type api --limit 20

# All dependencies involving order-service (outgoing + incoming)
repohelix deps --repo order-service

# What does order-service depend on?
repohelix deps --repo order-service --direction outgoing

# What depends on order-service?
repohelix deps --repo order-service --direction incoming

# Does order-service directly depend on payment-service?
repohelix deps --repo order-service --target payment-service --direction outgoing

# Combine with existing filters
repohelix deps --repo order-service --target payment-service --direction outgoing --strength strong --type api
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

### `repohelix explain-deps <sourceRepo> <targetRepo>`

Explain the protocol-specific semantic relations from one repository to another.

```bash
repohelix explain-deps order-service payment-service
repohelix explain-deps order-service payment-service --kind CALLS_HTTP
```

**Arguments**:

| Argument | Description |
|----------|-------------|
| `sourceRepo` | Repository that owns the consuming or calling contract |
| `targetRepo` | Repository that owns the producing or called contract |

**Options**:

| Option | Description |
|--------|-------------|
| `--kind <kind>` | Filter results by exact `SEMANTIC_REL` kind |

The command prints the contract keys, reason, confidence, spec kinds, and spec IDs for each matching relation. A missing repository or an empty relation set returns a “No semantic relations found” message.

---

### `repohelix contracts`

List all contracts with their producer/consumer counts.

```bash
# All contracts
repohelix contracts

# Filter by contract kind
repohelix contracts --kind api
repohelix contracts --kind event --limit 10

# What contracts does order-service participate in?
repohelix contracts --repo order-service

# What does order-service produce?
repohelix contracts --repo order-service --direction outgoing

# What does order-service consume?
repohelix contracts --repo order-service --direction incoming

# Combine filters
repohelix contracts --repo order-service --kind api --direction incoming
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

### `repohelix trace <target>`

Resolve a natural contract identifier to its `ContractSpec` and walk `SEMANTIC_REL`
edges **multi-hop in both directions**, returning the connected sub-graph: downstream
request/response/payload schemas and upstream consumers. No internal spec IDs required.

```bash
repohelix trace "http POST /orders"
repohelix trace "api GET /users/:id"
repohelix trace "event OrderCreated"
repohelix trace "schema CreateOrderRequest"
repohelix trace "grpc OrderService/CreateOrder"
repohelix trace "grpc acme.order.v1.OrderService/CreateOrder"
repohelix trace "dubbo com.acme.OrderService#createOrder"
repohelix trace "graphql Query.user"
repohelix trace "graphql Mutation.createOrder"
repohelix trace "graphql Subscription.orderCreated"
repohelix trace http "POST /orders"            # extra tokens are joined too
repohelix trace "http POST /orders" --json     # structured output
repohelix trace "http POST /orders" --max-hops 5
repohelix trace "http POST /orders" --direction incoming   # consumers only
```

Example output:

```text
Semantic Trace: http POST /orders

Target Specs:
  [http-producer] order-service src/main/java/.../OrderController.java [spring-mvc]
      POST /orders  request=CreateOrderRequest  response=CreateOrderResponse

Discovered Specs:
  [http-consumer] web-app src/api/order.ts
      POST /orders  request=OrderInput  response=OrderResult

Relation Paths:
  [Target] POST /orders  request=CreateOrderRequest  response=CreateOrderResponse (order-service)
    file: src/main/java/.../OrderController.java

    <- [CALLS_HTTP exact confidence=0.95]
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

Trace call edges are protocol-specific (`CALLS_HTTP`, `CALLS_DUBBO`,
`CALLS_GRPC`, or `CALLS_GRAPHQL`). A handler-to-RPC hop is reported as
`INTERNAL_CALL` only when the index contains a real invocation in that handler;
its source line, raw expression, and extraction rule are included in JSON and
shown in text output when available.

**Options**:

| Option | Description |
|--------|-------------|
| `--max-hops <number>` | Maximum hops per direction (default `3`) |
| `--direction <direction>` | `outgoing`, `incoming`, or `both` (default) |
| `--json` | Emit the structured trace graph as JSON |

> The same capability is exposed to agents via the MCP tool `repohelix_trace`
> using its `target` parameter (e.g. `{ "target": "http POST /orders" }` or `{ "target": "grpc OrderService/CreateOrder" }`).

---

### `repohelix impact <symbolOrEntity>`

Perform change impact analysis on a specified symbol or entity.

```bash
repohelix impact UserService
repohelix impact /api/order/:id
repohelix impact "schema CreateOrderRequest"
repohelix impact "http POST /orders" --max-hops 5
repohelix impact "schema CreateOrderRequest" --change field-removed:couponCode
repohelix impact Order --legacy
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

### `repohelix ask <question>`

Ask a natural-language question about the indexed workspace.

```bash
repohelix ask "Which services depend on OrderService?"
repohelix ask "What modules would be affected by modifying PaymentEvent?"
repohelix ask "/mall/mgr/groupon/activity/createActivity"
repohelix ask "Analyze the workflow for /mall/mgr/groupon/activity/createActivity"
repohelix ask "Analyze the workflow for POST /mall/mgr/groupon/activity/createActivity"
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<question>` | Yes | A natural-language question, API path, or question containing an API path |

If no reliable evidence is found, the command returns `no_reliable_evidence`.

---

## Quality Governance

### `repohelix quality [action]`

Audit and govern relation quality and contract quality.

```bash
# Audit low-confidence relations and conflicting producers
repohelix quality

# Audit contract quality rules
repohelix quality contracts

# Audit deterministic schema roots and diagnostics
repohelix quality schemas --group-by framework
repohelix quality schemas --details unresolved,external,ambiguous,unsupported,truncated
repohelix quality schemas --group-by repo --details ambiguous,truncated --json

# Filter by confidence
repohelix quality --min-confidence 0.8 --limit 50

# Mark false positives
repohelix quality --reject-evidence ev-123 --reason "false positive"

# Set manual alias
repohelix quality --alias my-service --target-repo service-a
```

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `[action]` | No | `contracts` for contract quality, `schemas` for schema root/diagnostic quality; omit for relation quality |

**Options**:

| Option | Description |
|--------|-------------|
| `--min-confidence <number>` | Minimum acceptable confidence |
| `--limit <number>` | Maximum number of rows to audit |
| `--reject-evidence <id>` | Mark the specified evidence ID as a false positive |
| `--reason <text>` | Reason for rejection or alias override |
| `--alias <alias>` | Alias override name (requires `--target-repo`) |
| `--target-repo <name>` | Target repository for alias override (requires `--alias`) |
| `--group-by <dimension>` | Group schema results by `language`, `framework`, `relation-kind`, or `repo` |
| `--details <outcomes>` | Include comma-separated `unresolved`, `external`, `ambiguous`, `unsupported`, or `truncated` evidence |
| `--json` | Emit stable grouped schema JSON |

Schema details identify the owner/root/source, raw symbol/type, field and type path, semantic relation, candidate evidence, and truncation limit.

---

## Frameworks

### `repohelix frameworks`

List detected frameworks for each repository.

Plugin framework detectors run as part of indexing. Run `repohelix index` after installing or updating a plugin, then use this command to view the detected frameworks.

```bash
repohelix frameworks
```

**Output**: Detected frameworks per repository (language, confidence, evidence).

---

## Plugin Management

### `repohelix plugin`

Install, inspect, diagnose, and remove external RepoHelix plugins. Run `repohelix index` after installation to activate matching language plugins.

```bash
# npm package, local directory, or npm package tarball
repohelix plugin install @repohelix/plugin-csharp
repohelix plugin install ../my-plugin --global
repohelix plugin install ./my-plugin.tgz

repohelix plugin list --all
repohelix plugin doctor --all
repohelix plugin remove @repohelix/plugin-csharp --yes
```

#### `plugin install <source>`

| Option | Description |
|---|---|
| `--global` | Install under the current user's `~/.repohelix/plugins/`. |
| `--force` | Atomically replace a plugin with the same manifest name. |

Without an explicit scope, RepoHelix installs under the current workspace's `.repohelix/plugins/`. Language detection determines which configured repositories activate the plugin. npm lifecycle scripts may run while production dependencies are installed; install only trusted plugins.

#### `plugin list` and `plugin doctor`

Both commands accept `--global`, `--all`, and `--json`. `list` reports installed versions, sources, paths, and `valid`/`invalid` status. `doctor` performs full validation, reports errors, and exits non-zero when an invalid or duplicate plugin is found. Run `doctor` only for plugins you trust.

#### `plugin remove <name>`

Accepts `--global`; otherwise removes from the current workspace. Removal prompts for confirmation; pass `--yes` for CI or other non-interactive use. Restart `watch` or MCP and re-index after installing, replacing, or removing a plugin.

See the [Plugin Guide](plugins.md) for package requirements and security details.

---

## MCP Server

### `repohelix mcp`

Start the Model Context Protocol (MCP) server via stdio for AI agent integration.

```bash
repohelix mcp
repohelix mcp --path /path/to/workspace
```

**Options**:

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Workspace root path (defaults to current directory) |

> [!NOTE]
> The MCP server uses stdout for JSON-RPC communication and outputs logs to stderr.

---

### `repohelix watch`

Start a file watcher that automatically indexes repository changes.

Restart the watcher after installing, replacing, or removing a plugin. The watcher automatically includes active plugin source extensions while respecting `exclude` and `.gitignore` rules.

```bash
repohelix watch
repohelix watch --repo service-a
repohelix watch --debounce-ms 1000
```

**Options**:

| Option | Description |
|--------|-------------|
| `--debounce-ms <number>` | Debounce time in milliseconds for file events |
| `--repo <name>` | Watch only the specified repository |

**Behavior**: On startup, performs an initial incremental index (changed-only, merge mode), then enters continuous watch mode. Press `Ctrl+C` to stop.

---

## Agent Integration

### `repohelix install`

Install the RepoHelix MCP server into one or more AI agents.

Supported agents: Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE, Kiro.

```bash
# Interactive selection
repohelix install

# Non-interactive: auto-detect and install globally
repohelix install -y

# Specify target agents
repohelix install -t claude-code,cursor

# Specify install location
repohelix install -t claude-code --location local

# Print config snippet only, do not write to file
repohelix install --print-config claude-code
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

### `repohelix uninstall`

Remove the RepoHelix MCP server from AI agents.

```bash
# Remove from all agents
repohelix uninstall

# Non-interactive
repohelix uninstall -y

# Specify target
repohelix uninstall -t claude-code
```

**Options**:

| Option | Description |
|--------|-------------|
| `-t, --target <ids>` | Target agents, comma-separated IDs or `all` (default: `all`) |
| `-l, --location <where>` | Uninstall location: `global` or `local` (default: interactive selection) |
| `-y, --yes` | Non-interactive mode, defaults to `--location=global --target=all` |
