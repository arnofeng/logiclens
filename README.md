# LogicLens

<center>

[![npm version](https://img.shields.io/npm/v/logiclens.svg)](https://www.npmjs.com/package/logiclens)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</center>

**Local-first semantic contract graph for AI coding agents to reason about cross-repository interfaces and change impact.**

**English** · [中文](README-ZH.md)

> [!IMPORTANT]
> **LogicLens is currently in active Beta development.** While the core indexing engine, CLI, SDK, watcher, and MCP server are fully functional, language and framework coverage is incrementally expanding. Expect occasional changes as APIs and schema are refined.

---

## Table of Contents

- [⚡ Quick Start](#-quick-start)
- [🧠 Why LogicLens](#-why-logiclens)
- [🧬 Core Concept: Code Graph](#-core-concept-code-graph)
- [🔍 CLI Usage Examples](#-cli-usage-examples)
- [🤖 MCP Integration (AI Coding Agents)](#-mcp-integration-ai-coding-agents)
- [🧠 SDK (Programmatic Access)](#-sdk-programmatic-access)
- [Plugin System](#plugin-system)
- [⚙️ Configuration](#️-configuration)
- [👍 Current Language and Framework Support](#-current-language-and-framework-support)
- [🧑‍💻 Contributing](#contributing)
- [🛡️ Security](#security)
- [📄 License](#license)

---

## ⚡ Quick Start

### 1. Install LogicLens

```bash
npm install -g logiclens
logiclens --version
```

### 2. Initialize Workspace

Initialize the workspace. This workspace can be a parent directory containing multiple repositories, or a standalone directory that references other repository paths.

```bash
logiclens init

# Add first-level Git repositories under a directory
logiclens add-repos ../services
# Add a single repository
logiclens add-repo ../service-a --name service-a

logiclens index # Index all repositories
```

### 3. Ask Questions Based on Graph Context

```bash
logiclens ask "Which repositories are involved in the order creation flow?"
```

Example expected output:

```
Based on the code graph, the following repositories are involved
in the order creation flow:

1. service-a — exposes POST /api/order (producer)
2. service-b — consumes OrderCreatedEvent (consumer)
3. gateway — routes /api/order to service-a (router)
```

---

## 🧠 Why LogicLens

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

### LogicLens vs Traditional Tools

| | Traditional Tools | LogicLens |
|---|---|---|
| Scope | Single repository | Cross-repository workspace |
| Granularity | File-level | Symbol / Contract-level |
| Dependency Discovery | Manual grep | Automatic graph traversal |
| AI Friendly | ❌ | ✅ MCP native integration |
| Change Impact | Guess from experience | Graph path tracing |

---

## 🧬 Core Concept: Code Graph

LogicLens automatically analyzes your multi-repository system and models the entire code system as a **graph structure**:

### 📦 Nodes

- Repository
- File
- Symbol
- Contract — API / Event / DTO / Schema / RPC / GraphQL / Dubbo / Package and other contractual relationships

### 🔗 Edges

- Cross-repository dependency graph
- Symbol-level call chains
- Produce / Consume relationships
- Service connection relationships (depends-on)
- Change impact paths (impact)

### 🚀 Capabilities

- **Local-first**: Builds code knowledge graph on Kuzu graph database, stored locally in `.logiclens/graph` by default — data stays entirely on your machine.
- **Cross-repository workspace**: One workspace can point to multiple repositories, building a unified graph covering the entire code system.
- **Static code intelligence**: Extracts symbols, imports, calls, documentation, language facts, and framework signals as graph nodes and edges.
- **Contract model**: Normalizes cross-repository evidence into contract types like `api`, `event`, `package`, `dto`, `schema`, `grpc-method`, `dubbo-method`, `graphql-operation`, `enum`, `config`, enriching graph semantics.
- **Dependency views**: Displays inter-repository dependency strength, type, evidence location, rules, and resolution information.
- **Trace and impact analysis**: Starting from contracts or symbols, follows graph paths to return producers, consumers, related code, calls, documentation, and recommended files to inspect.
- **CLI / SDK / MCP**: Supports manual graph queries, Node.js integration, and AI coding assistant connectivity.
- **Quality governance**: Audits low-confidence evidence, rejects false positives, registers alias overrides to ensure graph accuracy.
- **Optional LLM / embedding layer**: When needed, integrates OpenAI-compatible chat and embedding providers to enhance graph semantics.

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
logiclens stats
logiclens deps --limit 20
logiclens contracts --kind api
logiclens contracts --repo order-service --direction outgoing
```

### 💥 Semantic Contract Trace

```bash
logiclens trace "http GET /api/order/:id"
logiclens trace "event OrderCreatedEvent"
```

### 🔎 Impact Analysis

```bash
logiclens impact OrderCreatedEvent
logiclens impact api:/api/order/:id
```

---

## 🤖 MCP Integration (AI Coding Agents)

LogicLens exposes the code graph to AI Agents through **Model Context Protocol (MCP)**.

### One-Click Installation

```bash
logiclens install
```

You can use the interactive installer to automatically register the LogicLens MCP server in multiple AI agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE, Kiro).

### MCP Tools

| Tool Name | Description |
|---|---|
| `logiclens_get_stats` | Get summary statistics of the graph database (repository count, file count, code node count, call count, etc.) |
| `logiclens_get_watch_status` | Get graph/index freshness and a safely trimmed lexical-provider readiness summary; pass `refresh: true` to rerun the provider health check |
| `logiclens_list_dependencies` | List cross-repository dependencies with evidence (filterable by strength/type) |
| `logiclens_list_contracts` | List identified contracts with producer/consumer/shared counts (filterable by kind, repo, direction) |
| `logiclens_trace` | Multi-hop semantic trace — find the producers, consumers, and request/response/payload schemas connected to a contract |
| `logiclens_impact_analysis` | Evaluate downstream impact scope when modifying code symbols or contracts |
| `logiclens_ask_question` | Return structured workspace retrieval (`outcome`, `selectedEvidence`, and `diagnostics`); it does not generate LLM answer text |

`logiclens_ask_question` accepts `question` plus the same retrieval controls as the SDK: `lexical` and `semantic` booleans, `topK` (`1..100`), `graphHops` (`0..5`), and `contextBudget` (`256..65536`). Its `selectedEvidence` exposes safe canonical/document identity, repository, path/line, confidence, match reasons, and render reference. Within ordinary Ask diagnostics, `providers.lexical` exposes only `status`; the response still includes routes, timings, queries, compatibility, source loading, and semantic provider diagnostics. Use `logiclens_get_watch_status` for the full safely trimmed lexical provider gate summary. Graph/index freshness and lexical provider readiness are independent states. LogicLens exposes neither a raw graph-query tool nor internal database query details.

### MCP Configuration Example

```json
{
  "mcpServers": {
    "logiclens": {
      "command": "logiclens",
      "args": ["mcp"]
    }
  }
}
```

---

## 🧠 SDK (Programmatic Access)

LogicLens provides a Node.js SDK for building automation systems and AI toolchains. `retrieve()` and `ask()` share the same retrieval pipeline.

```ts
import { createClient } from "logiclens";

const client = await createClient({ cwd: process.cwd() });

try {
  // addRepo updates this client's in-memory config only (not persisted to disk).
  // To persist workspace config, use the CLI: `logiclens init` / `logiclens add-repo`.
  await client.addRepo("../service-a", { name: "service-a" });
  await client.index({ changedOnly: false, writeMode: "auto" });

  const stats = await client.stats();
  const dependencies = await client.dependencies({ strength: "strong", limit: 20 });
  const contracts = await client.contracts({ kind: "api", limit: 20 });
  const contractsForRepo = await client.contracts({ repo: "order-service", direction: "outgoing" });
  const trace = await client.trace("http GET /api/order/:id");
  const impact = await client.impact("OrderCreatedEvent");
  const retrieval = await client.retrieve("Where is order validation implemented?", {
    lexical: true,
    semantic: false,
    topK: 20,
    graphHops: 1,
    contextBudget: 16_000,
  });
  const answer = await client.ask("Where is order validation implemented?", {
    lexical: true,
    semantic: true,
  });
  const lexicalStatus = await client.getLexicalProviderStatus({ refresh: true });

  console.log({ stats, dependencies, contracts, trace, impact, retrieval, answer, lexicalStatus });
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
| `client.retrieve(question, options)` | Return a structured `RetrievalResult` without generating an answer. |
| `client.ask(question, options)` | Generate an answer or deterministic citation fallback from the same retrieval pipeline. |
| `client.getLexicalProviderStatus(options)` | Return a safely trimmed lexical provider gate summary; `{ refresh: true }` reruns health checks instead of using the cache. |
| `client.watch(options)` | Enable automatic changed-file indexing. |
| `client.unwatch()` | Stop the watcher. |
| `client.getWatchStatus()` | Check watcher, catch-up, pending files, and queue status. |
| `client.close()` | Close watcher, queue, and graph database resources. |

`RetrieveOptions` and `AskOptions` have the same fields and validation:

| Option | Default | Range / meaning |
|---|---:|---|
| `lexical?: boolean` | `true` | Enable workspace lexical retrieval. |
| `semantic?: boolean` | `true` | Enable configured semantic retrieval. |
| `topK?: number` | `20` | Integer `1..100`. |
| `graphHops?: number` | `1` | Integer `0..5`. |
| `contextBudget?: number` | `16000` | Integer `256..65536` characters. |

`RetrievalResult` contains `outcome`, fused and selected candidates, loaded evidence, selection and source-loading rejections, and diagnostics. `ask()` uses that same result: with an LLM key it generates a grounded answer; without a key it returns a deterministic `[C1]`-style citation fallback; without reliable evidence it returns `no_reliable_evidence`. The provider status API returns only a public gate summary. Do not depend on internal stores, Cypher, Kuzu SQL, `sourceHash`, `batchId`, or other storage details.

### Retrieval diagnostics

The `RetrievalDiagnostics` object contains the stable public layers `routes`, `timings`, `queries`, `providers`, `sourceLoading`, and `compatibility`. The retrieval response carries `outcome` as a separate top-level field. Every route reports `status`, `executed`, and `queryCount`. Timings cover planning, lexical provider search, fusion, selection, source loading, and total execution (alongside other route stages). A successful workspace lexical route performs one native lexical query per retrieval.

`outcome` is `succeeded`, `degraded`, `no_results`, or `failed`. Unavailable and unhealthy routes are represented structurally and can coexist with evidence from other routes. Diagnostics are deliberately trimmed: they are not a container for full source text, secrets, raw database exceptions, or untrimmed provider metadata.

### Retrieval performance measurement

Run the repository's fixed quality corpus against a local Kuzu fixture with networking disabled:

```bash
pnpm exec tsx scripts/retrieval-benchmark.ts
```

The benchmark warms up once, measures three times, and writes one line of JSON. It reports provider search, fusion, selection, source loading, end-to-end retrieval, full-rebuild indexing, and changed-only indexing. P50/P95 use the nearest-rank method. The script reports measurements but does not itself run a Vitest threshold assertion. When publishing measurements, record the machine, operating system, Node version, provider, workspace/document size, and warm/cold cache conditions.

The commands have distinct roles:

```bash
pnpm run test:retrieval-release # lexical contracts, quality, Kuzu lifecycle, and Kuzu E2E
pnpm test                       # full suite; includes the fixed-fixture P95 assertion
pnpm run test:neo4j-integration # optional; requires explicit test-environment configuration
```

`tests/retrievalBenchmark.test.ts`, collected by the full `pnpm test` command, enforces warmed end-to-end P95 of at most 500 ms for the fixed fixture. This is a regression gate, not a general promise for every machine or production workspace. The Neo4j gate is opt-in. Its CI test credential variables must not be reused as production database configuration.

---

## Plugin System

LogicLens plugins add external languages, contract extractors, and framework detectors. Install from npm, a local directory, or a package tarball; plugins are validated before they become visible:

```bash
logiclens plugin install @logiclens/plugin-csharp --repo service-a
logiclens plugin list --all
logiclens plugin doctor --all
```

Use `--global` instead of `--repo` for a user-level installation. `logiclens index`, `watch`, SDK indexing, and MCP indexing discover installed plugins and activate them automatically when their manifest's language rules match the repository.

After installation, run `logiclens index` to detect and activate the plugin for matching repositories. See the [Plugin Guide](docs/plugins.md) for installation, activation, removal, and troubleshooting, and the [Plugin SDK Reference](docs/plugin-sdk.md) to build a plugin. The external [C# plugin](packages/plugin-csharp/README.md) is the reference implementation.

---

## ⚙️ Configuration

`logiclens init` creates `.logiclens/config.yaml`. This file is the source of truth for repository lists, indexing behavior, graph storage, semantic retrieval, LLM providers, MCP safety policies, and watcher behavior.

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

LogicLens supports various advanced configuration options for performance tuning, indexing settings, custom LLM retries, and semantic storage providers.

For the complete list of supported parameters and their default values, see the [Configuration Guide](docs/configuration.md).

### Cost and Privacy Notes

For a fully offline run, use the local Kuzu graph and local JSON semantic storage, set `embedding.provider: off`, `embedding.level: off`, and `indexing.llmSummaryLevel: off`, omit `llm.apiKey`, ensure `OPENAI_API_KEY` is unset, and do not configure remote LLM or embedding endpoints. Without an LLM key, `ask` still returns a citation fallback when reliable evidence exists.

Only explicitly configured remote Neo4j, LLM, embedding, or Chroma services produce the corresponding network access. LogicLens is local-first, but not every configuration is necessarily offline.

---

## 👍 Current Language and Framework Support

LogicLens currently scans and parses:

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
| C# plugin | External `@logiclens/plugin-csharp`: C# parsing plus ASP.NET HTTP, schema, event, gRPC, package, and framework facts. See the [plugin guide](docs/plugins.md). |

More languages, frameworks, and generated client patterns will be supported over time.

### Current Limitations

- LogicLens is still in Beta — graph structure and extractor behavior may change.
- Static analysis is conservative. Dynamic API paths, reflection, runtime dependency injection, generated code, and framework magic may be incompletely extracted, or reported as unresolved evidence.
- Built-in framework support is focused. Unsupported frameworks can still be parsed as source code, but contract extraction may be shallow until the corresponding detector or extractor is added.
- Cross-repository dependency quality depends on repository names, package metadata, imports, aliases, and contract evidence.
- Large workspaces may need `--changed-only`, `--batch-size`, `--max-files`, watcher tuning, or Chroma semantic storage.
- LLM answers depend on retrieval context and provider behavior. For auditable evidence, prefer using `trace`, `deps`, `contracts`, and `impact`.
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

LogicLens indexes local source code and exposes graph context through structured CLI, SDK, and MCP interfaces. Raw graph-query entry points are not exposed through these public interfaces; be especially cautious when connecting the MCP Server to third-party tools.

Security issue reporting instructions can be found in [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
