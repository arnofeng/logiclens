# Configuration Guide

LogicLens reads `.logiclens/config.yaml`. One LogicLens workspace corresponds to one configuration and its `repos` collection. `systemName` identifies the logical workspace; all configured repositories share one graph provider and one workspace-wide lexical search scope.

Configuration loading replaces `${ENV_VAR}` placeholders with environment-variable values before validation. Use placeholders for credentials instead of committing secrets.

## Kuzu local profile

Kuzu is the default local provider. It stores the workspace graph and full-text search data locally, with no external service or API key.

```yaml
systemName: commerce-workspace

repos:
  - name: orders
    path: ../orders
  - name: payments
    path: ../payments

graph:
  provider: kuzu
  path: .logiclens/graph
```

## Neo4j cloud profile

Neo4j can host both the workspace graph and full-text search data. Supply a dedicated database and inject credentials through the environment:

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

The `LOGICLENS_TEST_NEO4J_*` names used by repository tests are CI/test controls, not production credential conventions.

## Full reference configuration

The following example shows the main supported settings and defaults. Provider credentials and API keys are intentionally omitted.

```yaml
systemName: default-system

repos: []

graph:
  provider: kuzu
  path: .logiclens/graph

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
- `graph.path`: Kuzu database directory; defaults to `.logiclens/graph`.
- `graph.url`, `graph.username`, `graph.password`, `graph.database`: Neo4j connection and database settings.

### LLM

- `llm.provider`, `llm.model`, and `llm.apiKey`: Answer-generation provider configuration.

For a fully offline run, use the local Kuzu graph and do not configure an LLM key:

```yaml
graph:
  provider: kuzu
  path: .logiclens/graph
```

Also omit `llm.apiKey`, ensure `OPENAI_API_KEY` is unset in the process environment, and do not configure a remote LLM endpoint. `ask` reads either `llm.apiKey` or `OPENAI_API_KEY`; if either is present, it can send selected evidence to that LLM endpoint. Without an LLM key, `ask` can still produce a deterministic citation fallback when reliable evidence exists. If no reliable evidence is available, it returns `no_reliable_evidence`.

Only explicitly configured remote Neo4j or LLM services cause the corresponding network access. Therefore LogicLens is local-first, but not every possible configuration is offline.

### MCP, plugins, and indexing

- `mcp.logCalls`: Log MCP invocations; defaults to `false`.
- `plugins.failFast`: Stop on the first plugin discovery/loading error when `true`.
- `indexing.concurrency`, `indexing.maxFilesPerRun`, and `indexing.batchSize`: Indexing controls.

See the [Plugin Guide](plugins.md) and [Plugin SDK Reference](plugin-sdk.md) for plugin configuration.
