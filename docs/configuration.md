# Configuration Guide

RepoHelix reads `.repohelix/config.yaml`. One RepoHelix workspace corresponds to one configuration and its `repos` collection. `systemName` identifies the logical workspace; all configured repositories share one graph provider and one semantic contract graph.

Configuration loading replaces `${ENV_VAR}` placeholders with environment-variable values before validation. Use placeholders for credentials instead of committing secrets.

Deterministic contract-driven schema discovery adds no YAML keys. Language/framework adapters derive typed contract roots from source and plugins, and the shared core materializes bounded reachable schemas. See [Deterministic contract-driven schema release](contract-schema-release.md).

## Kuzu local profile

Kuzu is the default local provider. It stores the workspace graph locally, with no external service or API key.

```yaml
systemName: commerce-workspace

repos:
  - name: orders
    path: ../orders
  - name: payments
    path: ../payments

graph:
  provider: kuzu
  path: .repohelix/graph
```

## Neo4j cloud profile

Neo4j can host the workspace graph. Supply a dedicated database and inject credentials through the environment:

```yaml
systemName: commerce-workspace

repos:
  - name: orders
    path: ../orders
  - name: payments
    path: ../payments

graph:
  provider: neo4j
  url: ${NEO4J_URL}
  username: ${NEO4J_USERNAME}
  password: ${NEO4J_PASSWORD}
  database: ${NEO4J_DATABASE}
```

The `REPOHELIX_TEST_NEO4J_*` names used by repository tests are CI/test controls, not production credential conventions.

## Full reference configuration

The following example shows the main supported settings and defaults. Provider credentials and API keys are intentionally omitted.

```yaml
systemName: default-system

repos: []

graph:
  provider: kuzu
  path: .repohelix/graph

llm:
  provider: openai
  model: gpt-4.1-mini

mcp:
  logCalls: false

plugins:
  enabled: []
  failFast: false

indexing:
  concurrency: 4
  maxFilesPerRun: 5000
  batchSize: 0
```

## Options reference

### Workspace and repositories

- `systemName`: Logical workspace identifier; defaults to `default-system`.
- `repos`: Repositories indexed into the shared workspace. Each entry has a `name` and `path`.

### Graph database (`graph`)

- `graph.provider`: Registered graph provider ID. Built-in profiles are `kuzu` and `neo4j`; the default is `kuzu`.
- `graph.path`: Kuzu database directory; defaults to `.repohelix/graph`.
- `graph.url`, `graph.username`, `graph.password`, `graph.database`: Neo4j connection and database settings.

### LLM

- `llm.provider`, `llm.model`, and `llm.apiKey`: Optional graph, repository, file, and code summary provider configuration.
- `indexing.llmSummaryLevel`: Summary granularity (`off`, `repo`, `file`, or `node`); defaults to `off`.

For a fully offline run, use the local Kuzu graph and do not configure an LLM key:

```yaml
graph:
  provider: kuzu
  path: .repohelix/graph
```

Also omit `llm.apiKey`, ensure `OPENAI_API_KEY` is unset in the process environment, and leave `indexing.llmSummaryLevel` set to `off`. When summaries are enabled, RepoHelix reads either `llm.apiKey` or `OPENAI_API_KEY` and can send source excerpts and graph facts to the configured LLM endpoint.

Only explicitly configured remote Neo4j or LLM services cause the corresponding network access. Therefore RepoHelix is local-first, but not every possible configuration is offline.

### MCP, plugins, and indexing

- `mcp.logCalls`: Log MCP invocations; defaults to `false`.
- `plugins.failFast`: Stop on the first plugin discovery/loading error when `true`.
- `indexing.concurrency`, `indexing.maxFilesPerRun`, and `indexing.batchSize`: Indexing controls.

See the [Plugin Guide](plugins.md) and [Plugin SDK Reference](plugin-sdk.md) for plugin configuration.

## Generated database compatibility

Schema index version 10 removes the former search projections and requires a fresh generated database. RepoHelix rejects a non-empty version 9 database instead of modifying or dropping its data automatically. `init` and `uninit` remain available so that the workspace can be prepared for a clean rebuild.

- Kuzu: remove the generated directory configured by `graph.path`, then run a full `repohelix index`.
- Neo4j: clear the dedicated RepoHelix database, or configure a new database name, then run a full `repohelix index`.

Legacy `retrieval`, `embedding`, and vector-oriented `semantic` configuration keys are ignored as unknown fields. Remove them from the configuration rather than relying on compatibility aliases.
