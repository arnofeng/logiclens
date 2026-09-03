# RepoHelix

<center>

[![npm version](https://img.shields.io/npm/v/repohelix.svg)](https://www.npmjs.com/package/repohelix)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</center>

**Local-first semantic contract graph for AI coding agents to reason about cross-repository interfaces and change impact.**

**English** · [中文](README-ZH.md)

---

## Table of Contents

- [⚡ Quick Start](#-quick-start)
- [🧠 Why RepoHelix](#-why-repohelix)
- [🧬 Core Concept: Code Graph](#-core-concept-code-graph)
- [🔍 CLI Usage Examples](#-cli-usage-examples)
- [🤖 MCP Integration (AI Coding Agents)](#-mcp-integration-ai-coding-agents)
- [🧠 SDK (Programmatic Access)](#-sdk-programmatic-access)
- [🧩 Plugin System](#plugin-system)
- [⚙️ Configuration](#️-configuration)
- [👍 Current Language and Framework Support](#-current-language-and-framework-support)
- [🧑‍💻 Contributing](#contributing)
- [🛡️ Security](#security)
- [📄 License](#license)

---

## ⚡ Quick Start

### 1. Install RepoHelix

```bash
npm install -g repohelix
repohelix --version
```

RepoHelix requires Node.js 20.19.0 or later.

### 2. Initialize Workspace

Initialize the workspace. This workspace can be a parent directory containing multiple repositories, or a standalone directory that references other repository paths.

```bash
repohelix init

# Add first-level Git repositories under a directory
repohelix add-repos ../services
# Add a single repository
repohelix add-repo ../service-a --name service-a

repohelix index # Index all repositories
```

### 3. Trace a Contract Across Repositories

```bash
repohelix trace "http POST /orders"
```

Example expected output:

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
    <- [CALLS_HTTP exact confidence=0.95]
       POST /orders  request=OrderInput  response=OrderResult (web-app)
```

---

## 🧠 Why RepoHelix

Modern software systems are no longer monolithic repositories — they consist of multiple parts:

- Services
- Frontend applications
- SDKs / Clients
- Event systems
- Shared packages

But most tools still operate at file-level understanding and single-repository perspective, leading to fundamental problems:

- Change an API without knowing who uses it
- Change an event without knowing the impact scope
- AI Agents cannot understand the overall system structure

### RepoHelix vs Traditional Tools

| | Traditional Tools | RepoHelix |
|---|---|---|
| Scope | Single repository | Cross-repository workspace |
| Granularity | File-level | Symbol / Contract-level |
| Dependency Discovery | Manual grep | Automatic graph traversal |
| AI Friendly | ❌ | ✅ MCP native integration |
| Change Impact | Guess from experience | Graph path tracing |

---

## 🧬 Core Concept: Code Graph

RepoHelix automatically analyzes your multi-repository system and models the entire code system as a **graph structure**:

### 📦 Nodes

- Repository
- File
- Symbol
- Contract — HTTP API / Event / Schema / gRPC / GraphQL / Dubbo / Package and other contractual relationships

### 🔗 Edges

- Cross-repository dependency graph
- Symbol-level call chains
- Produce / Consume relationships
- Service connection relationships (depends-on)
- Change impact paths (impact)

### 🚀 Capabilities

- **Local-first**: Builds code knowledge graph on Kuzu graph database, stored locally in `.repohelix/graph` by default — data stays entirely on your machine.
- **Cross-repository workspace**: One workspace can point to multiple repositories, building a unified graph covering the entire code system.
- **Static code intelligence**: Extracts symbols, imports, calls, documentation, language facts, and framework signals as graph nodes and edges.
- **Contract model**: Normalizes cross-repository evidence into contract types like `api`, `event`, `package`, `dto`, `schema`, `grpc-method`, `dubbo-method`, `graphql-operation`, `enum`, `config`, enriching graph semantics.
- **Dependency views**: Displays inter-repository dependency strength, type, evidence location, rules, and resolution information.
- **Trace and impact analysis**: Starting from contracts or symbols, follows graph paths to return producers, consumers, related code, calls, documentation, and recommended files to inspect.
- **CLI / SDK / MCP**: Supports manual graph queries, Node.js integration, and AI coding assistant connectivity.
- **Quality governance**: Audits low-confidence evidence, rejects false positives, registers alias overrides to ensure graph accuracy.
- **Optional LLM summaries**: When configured, an OpenAI-compatible chat provider can summarize indexed files, repositories, and the graph.

**Upgrade from "code search" to "graph traversal + reasoning".**

### 🏗️ System Architecture

```text
Repositories
        ↓
Parser & Extractor
        ↓
Contract Model (API / Event / Schema / RPC / GraphQL / Dubbo / Package)
        ↓
Code Graph Builder
        ↓
Local Graph Database (Kuzu)
        ↓
┌────────────┬────────────┬────────────┐
│   CLI      │    SDK     │    MCP     │
└─────┬──────┴─────┬──────┴─────┬──────┘
      ↓            ↓            ↓
 Developers    Apps /       AI Coding
   / CI       Automation     Agents
```

---

## 🔍 CLI Usage Examples

> For the full list of CLI commands and their options, see the [CLI Command Reference](docs/cli-reference.md).

```bash
repohelix stats
repohelix deps --limit 20
repohelix contracts --kind api
repohelix contracts --repo order-service --direction outgoing
```

### 💥 Semantic Contract Trace

```bash
repohelix trace "http GET /api/order/:id"
repohelix trace "event OrderCreatedEvent"
```

### 🔎 Impact Analysis

```bash
repohelix impact OrderCreatedEvent
repohelix impact api:/api/order/:id
```

---

## 🤖 MCP Integration (AI Coding Agents)

RepoHelix exposes the code graph to AI Agents through **Model Context Protocol (MCP)**.

### One-Click Installation

```bash
repohelix install
```

You can use the interactive installer to automatically register the RepoHelix MCP server in multiple AI agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE, Kiro).

### MCP Tools

| Tool Name | Description |
|---|---|
| `repohelix_get_stats` | Get summary statistics of the graph database (repository count, file count, code node count, call count, etc.) |
| `repohelix_get_watch_status` | Check watcher activity, pending files, queue state, and catch-up status |
| `repohelix_list_dependencies` | List cross-repository dependencies with evidence (filterable by strength/type) |
| `repohelix_list_contracts` | List identified contracts with producer/consumer/shared counts (filterable by kind, repo, direction) |
| `repohelix_trace` | Multi-hop semantic trace — find the producers, consumers, and request/response/payload schemas connected to a contract |
| `repohelix_impact_analysis` | Evaluate downstream impact scope when modifying code symbols or contracts |

Use the coding host's native file search for free-text source exploration. RepoHelix MCP tools are intentionally scoped to contracts, dependencies, traces, impact analysis, indexing, and watcher state.

### MCP Configuration Example

```json
{
  "mcpServers": {
    "repohelix": {
      "command": "repohelix",
      "args": ["mcp"]
    }
  }
}
```

---

## 🧠 SDK (Programmatic Access)

RepoHelix provides a Node.js SDK for building graph-aware automation systems and AI toolchains.

```ts
import { createClient } from "repohelix";

const client = await createClient({ cwd: process.cwd() });

try {
  // addRepo updates this client's in-memory config only (not persisted to disk).
  // To persist workspace config, use the CLI: `repohelix init` / `repohelix add-repo`.
  await client.addRepo("../service-a", { name: "service-a" });
  await client.index({ changedOnly: false, writeMode: "auto" });

  const stats = await client.stats();
  const dependencies = await client.dependencies({ strength: "strong", limit: 20 });
  const contracts = await client.contracts({ kind: "api", limit: 20 });
  const contractsForRepo = await client.contracts({ repo: "order-service", direction: "outgoing" });
  const trace = await client.trace("http GET /api/order/:id");
  const impact = await client.impact("OrderCreatedEvent");

  console.log({ stats, dependencies, contracts, trace, impact });
} finally {
  await client.close();
}
```

### SDK Method Reference

| Method | Purpose |
|---|---|
| `client.addRepo(path, options)` | Add a single repository to this client's in-memory config (not persisted). |
| `client.addRepos(directory, options)` | Discover and add first-level Git repositories to in-memory config (not persisted). |
| `client.index(options)` | Index repositories. |
| `client.getIndexQueueStatus()` | Check SDK/MCP indexing queue status. |
| `client.rebuildRelations(options)` | Rebuild dependency edges from indexed evidence. |
| `client.stats()` | Return graph statistics. |
| `client.dependencies(options)` | List cross-repository dependencies. |
| `client.unresolvedEvidence(options)` | List extraction points that cannot be reduced to stable contract keys. |
| `client.contracts(options)` | List identified contracts (filterable by kind, repo, direction). |
| `client.trace(target)` | Multi-hop semantic trace of a contract spec. |
| `client.impact(target)` | Analyze downstream impact scope. |
| `client.watch(options)` | Enable automatic changed-file indexing. |
| `client.unwatch()` | Stop the watcher. |
| `client.getWatchStatus()` | Check watcher, catch-up, pending files, and queue status. |
| `client.close()` | Close watcher, queue, and graph database resources. |

---

## 🧩 Plugin System

RepoHelix plugins add external languages, contract extractors, and framework detectors. Install from npm, a local directory, or a package tarball; plugins are validated before they become visible:

```bash
repohelix plugin install @repohelix/plugin-csharp --repo service-a
repohelix plugin list --all
repohelix plugin doctor --all
```

Use `--global` instead of `--repo` for a user-level installation. `repohelix index`, `watch`, SDK indexing, and MCP indexing discover installed plugins and activate them automatically when their manifest's language rules match the repository.

After installation, run `repohelix index` to detect and activate the plugin for matching repositories. See the [Plugin Guide](docs/plugins.md) for installation, activation, removal, and troubleshooting, and the [Plugin SDK Reference](docs/plugin-sdk.md) to build a plugin. The external [C# plugin](packages/plugin-csharp/README.md) is the reference implementation.

---

## ⚙️ Configuration

`repohelix init` creates `.repohelix/config.yaml`. This file is the source of truth for repository lists, indexing behavior, graph storage, LLM providers, MCP safety policies, and watcher behavior.

### Configuration Template

By default, `repohelix init` generates a minimal, clean configuration file:

```yaml
systemName: default-system

repos:
  - name: service-a
    path: ../service-a
  - name: service-b
    path: ../service-b
```

### Advanced Configuration

RepoHelix supports various advanced configuration options for performance tuning, indexing settings, and custom LLM retries.

For the complete list of supported parameters and their default values, see the [Configuration Guide](docs/configuration.md).

### Cost and Privacy Notes

For a fully offline run, use the local Kuzu graph, omit `llm.apiKey`, ensure `OPENAI_API_KEY` is unset, and do not configure a remote LLM endpoint. LLM configuration is used only for optional graph summaries.

Only explicitly configured remote Neo4j or LLM services produce the corresponding network access. RepoHelix is local-first, but not every configuration is necessarily offline.

---

## 👍 Current Language and Framework Support

RepoHelix currently scans and parses:

| Type | Extensions |
|---|---|
| TypeScript | `.ts`, `.tsx` |
| JavaScript | `.js`, `.jsx` |
| Vue | `.vue` |
| Java | `.java` |
| Python | `.py` |
| Go | `.go` |
| Markdown / MDX | `.md`, `.mdx` |
| Config files | `.yml`, `.yaml`, `.toml`, `.properties` |

Built-in framework and contract extraction currently mainly covers:

| Type | Current Coverage |
|---|---|
| JavaScript / TypeScript | `package.json`, imports, common HTTP client request patterns, statically visible generated client evidence. |
| Java | Maven/Gradle metadata, package facts, Spring MVC annotations and imports. |
| Python | Generic Python parsing, and FastAPI detection from dependency metadata. |
| Go | Go modules, generic Go parsing, Gin detection. |
| Documentation | Markdown/MDX sections that can be linked to code and impact output. |
| Config | YAML, TOML, properties, and environment/config-style contract evidence. |
| C# plugin | External `@repohelix/plugin-csharp`: C# parsing plus ASP.NET HTTP, schema, event, gRPC, package, and framework facts. See the [plugin guide](docs/plugins.md). |

More languages, frameworks, and generated client patterns will be supported over time.

### Current Limitations

- Static analysis is conservative. Dynamic API paths, reflection, runtime dependency injection, generated code, and framework magic may be incompletely extracted, or reported as unresolved evidence.
- Built-in framework support is focused. Unsupported frameworks can still be parsed as source code, but contract extraction may be shallow until the corresponding detector or extractor is added.
- Cross-repository dependency quality depends on repository names, package metadata, imports, aliases, and contract evidence.
- Large workspaces may need `--changed-only`, `--batch-size`, `--max-files`, or watcher tuning.
- LLM summaries depend on provider behavior. Contract, dependency, trace, and impact results remain graph-derived and auditable.
- MCP Server has local workspace access capability. Only connect it to clients you trust.

---

## Contributing

Contributions are very welcome and appreciated! Whether submitting bug reports, optimizing documentation, or developing new features and adding language/framework support, your help is very important to us.

**Quick start:**

1. Fork this repository
2. Create your feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Submit a Pull Request

For more detailed steps, see the [Contributing Guide](CONTRIBUTING.md).

## Security

RepoHelix indexes local source code and exposes graph context through structured CLI, SDK, and MCP interfaces. Raw graph-query entry points are not exposed through these public interfaces; be especially cautious when connecting the MCP Server to third-party tools.

Security issue reporting instructions can be found in [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
