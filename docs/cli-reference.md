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
| [`trace`](#logiclens-trace-contractorentity) | Trace a contract or entity |
| [`ask`](#logiclens-ask-question) | Natural language Q&A |
| [`impact`](#logiclens-impact-symbolorentity) | Change impact analysis |
| [`quality`](#logiclens-quality-action) | Audit and govern relation/contract quality |
| [`rebuild-relations`](#logiclens-rebuild-relations) | Rebuild cross-repository dependency edges |
| [`plugin`](#logiclens-plugin) | Add, remove, and list plugins |
| [`frameworks`](#logiclens-frameworks) | List detected frameworks and contract extractors |
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
```

**Options**:

| Option | Description |
|--------|-------------|
| `--strength <strong\|weak>` | Filter by dependency strength |
| `--type <type>` | Filter by dependency type. Options: `package`, `import`, `api`, `event`, `shared-contract` |
| `--limit <number>` | Maximum number of results to return |

---

### `logiclens contracts`

List all contracts with their producer/consumer counts.

```bash
logiclens contracts
logiclens contracts --kind api
logiclens contracts --kind event --limit 10
```

**Options**:

| Option | Description |
|--------|-------------|
| `--kind <kind>` | Filter by contract kind. Options: `package`, `api`, `event`, `dto`, `schema`, `enum`, `config` |
| `--limit <number>` | Maximum number of results to return |

---

### `logiclens trace <contractOrEntity>`

Trace the full chain of a specified contract or entity.

```bash
logiclens trace api:/api/order/:id
logiclens trace event:OrderCreatedEvent
logiclens trace UserService
```

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<contractOrEntity>` | Yes | Contract identifier (format: `kind:value`) or entity name |

---

### `logiclens impact <symbolOrEntity>`

Perform change impact analysis on a specified symbol or entity.

```bash
logiclens impact UserService
logiclens impact /api/order/:id
```

**Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<symbolOrEntity>` | Yes | Symbol or entity name |

**Output**: Contract producers/consumers, entity graph context, matching code, related call edges, related documents, recommended files to review.

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

## Plugins & Frameworks

### `logiclens plugin`

Manage LogicLens plugins. Plugins are recorded in `.logiclens/config.yaml` and loaded at startup.

#### `logiclens plugin add <name>`

Install a plugin package and register it in the configuration. `<name>` is either an npm package (optionally with a version, e.g. `my-plugin@1.2.3`, `@scope/my-plugin`) or a local path (e.g. `./plugins/my-plugin.mjs`).

```bash
logiclens plugin add my-logiclens-plugin
logiclens plugin add my-logiclens-plugin@1.2.0 --options '{"team":"platform"}'
logiclens plugin add ./plugins/internal.mjs
```

For npm packages, the package is installed into LogicLens's private plugin store at `.logiclens/plugins/` (using the detected package manager — pnpm / yarn / npm, by lockfile), so it never pollutes your project's or analyzed repos' dependencies. The plugin is then imported and validated, and the entry is written to config. Local paths skip installation. The plugin store is removed together with the workspace on `logiclens uninit`.

**Options**:

| Option | Description |
| --- | --- |
| `--options <json>` | JSON options object stored with the plugin entry and passed to its `setup`. |
| `--no-install` | Only write config; skip installing the package. |
| `--skip-verify` | Skip importing and validating the plugin after install. |

Re-adding an existing plugin (matched by name) updates its entry instead of duplicating it.

#### `logiclens plugin remove <name>`

Remove a plugin entry from the configuration (alias: `rm`). The installed package, if any, is left in place.

```bash
logiclens plugin remove my-logiclens-plugin
```

#### `logiclens plugin list`

List all configured and loaded plugins along with their registered extension hooks.

```bash
logiclens plugin list
```

**Output**: Configured plugin count, loaded plugin details (name, version, path, load time), registered parsers, framework detectors, contract extractors, CLI hook count.

---

### `logiclens frameworks`

List detected frameworks and enabled contract extractors for each repository.

```bash
logiclens frameworks
```

**Output**: Detected frameworks per repository (language, confidence, evidence) and list of enabled contract extractors.

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

---

## Plugin Extensions

LogicLens supports extending CLI commands through plugins. Plugins configured in `.logiclens/config.yaml` can register custom subcommands via the `registerCliCommand` hook.

**Example**:

```ts
// my-plugin.ts
export function setup(context) {
  context.registerCliCommand((program) => {
    program
      .command("hello")
      .description("My custom command")
      .action(() => console.log("hello from plugin"));
  });
}
```

After registration, use it as:

```bash
logiclens hello
# Output: hello from plugin
```

For more plugin development details, see the `plugins` section in the [Configuration Guide](./configuration.md).
