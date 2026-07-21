# Configuration Guide

LogicLens reads `.logiclens/config.yaml`. One LogicLens workspace corresponds to one configuration and its `repos` collection. `systemName` identifies the logical workspace; all configured repositories share one graph provider and one workspace-wide lexical retrieval scope. Retrieval evidence retains its repository, path, and render reference so callers can locate the original source.

Configuration loading replaces `${ENV_VAR}` placeholders with environment-variable values before validation. Use placeholders for credentials instead of committing secrets.

## Kuzu local profile

Kuzu is the default local graph provider. Its graph and native workspace lexical index use local storage and need no external service or API key.

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

retrieval:
  lexical:
    provider: auto
    scope: workspace

embedding:
  provider: off
  level: off

indexing:
  llmSummaryLevel: off
```

## Neo4j cloud profile

Neo4j can host both the workspace graph and its native lexical index. Supply a dedicated database and inject credentials through the environment:

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

retrieval:
  lexical:
    provider: auto
    scope: workspace
```

The `LOGICLENS_TEST_NEO4J_*` names used by repository tests are CI/test controls, not production credential conventions.

## Workspace retrieval

`retrieval.lexical.provider` defaults to `auto`, and `retrieval.lexical.scope` currently accepts only `workspace`. `auto` selects the native lexical capability declared by the configured graph provider. A retrieval performs one global top-k lexical query against the unified workspace index; it does not loop over repositories or maintain per-repository full-text indexes.

The lexical provider gate checks the provider capability and version, projection schema, tokenizer version, and index health. A mismatch is reported as an unavailable or unhealthy lexical route. Exact, contract, entity, graph, and any user-enabled semantic routes can still run, so lexical provider unavailability does not necessarily fail the overall retrieval.

Full indexing, changed-only indexing, and watch updates all maintain the lexical projection. Queries load only active workspace evidence. Graph and lexical writes share transaction/recovery boundaries, and committed lexical writes must be synchronously visible for both Kuzu and Neo4j.

## Full reference configuration

The following example shows the main supported settings and defaults. Provider credentials and API keys are intentionally omitted.

```yaml
systemName: default-system

repos: []

graph:
  provider: kuzu
  path: .logiclens/graph

retrieval:
  lexical:
    provider: auto
    scope: workspace

llm:
  provider: openai
  model: gpt-4.1-mini
  maxSourceCharsPerNode: 6000
  retry:
    maxRetries: 2
    initialDelayMs: 500
    maxDelayMs: 8000
    jitterRatio: 0.2
    timeoutMs: 60000
  budget: {}
  rateLimit:
    minDelayMs: 0

embedding:
  provider: off
  level: off
  batchSize: 64
  concurrency: 2
  retry:
    maxRetries: 2
    initialDelayMs: 500
    maxDelayMs: 8000
    jitterRatio: 0.2
    timeoutMs: 60000
  budget: {}
  rateLimit:
    minDelayMs: 0

semantic:
  provider: json
  jsonPath: .logiclens/semantic-index.json
  chroma:
    mode: local
    url: http://localhost:8000
    collection: logiclens

mcp:
  logCalls: false

plugins:
  enabled: []
  failFast: false

indexing:
  concurrency: 4
  summarizeChangedOnly: true
  maxFilesPerRun: 5000
  batchSize: 0
  llmSummaryLevel: off
```

## Options reference

### Workspace and repositories

- `systemName`: Logical workspace identifier; defaults to `default-system`.
- `repos`: Repositories indexed into the shared workspace. Each entry has a `name` and `path`.

### Graph database (`graph`)

- `graph.provider`: Registered graph provider ID. Built-in profiles are `kuzu` and `neo4j`; the default is `kuzu`.
- `graph.path`: Kuzu database directory; defaults to `.logiclens/graph`.
- `graph.url`, `graph.username`, `graph.password`, `graph.database`: Neo4j connection and database settings.

### Retrieval (`retrieval.lexical`)

- `provider`: Defaults to `auto`; currently resolves the graph provider's native lexical capability.
- `scope`: Must be `workspace`.

Companion lexical providers and per-repository lexical indexes are not currently implemented.

### LLM and embeddings

- `llm.provider`, `llm.model`, and `llm.apiKey`: Answer-generation provider configuration.
- `embedding.provider`, `embedding.model`, `embedding.apiKey`, and `embedding.level`: Semantic embedding configuration. `level` accepts `off`, `repo`, `docs`, `file`, `node`, or `all`.
- `indexing.llmSummaryLevel`: Controls indexing summaries; accepts `off`, `repo`, `file`, or `node`.

For a fully offline run, use the local Kuzu graph and local JSON semantic storage, disable embeddings and indexing summaries, and do not configure an LLM key:

```yaml
graph:
  provider: kuzu
  path: .logiclens/graph

embedding:
  provider: off
  level: off

semantic:
  provider: json
  jsonPath: .logiclens/semantic-index.json

indexing:
  llmSummaryLevel: off
```

Also omit `llm.apiKey`, ensure `OPENAI_API_KEY` is unset in the process environment, and do not configure remote LLM or embedding endpoints. `ask` reads either `llm.apiKey` or `OPENAI_API_KEY`; if either is present, it can send selected evidence to that LLM endpoint. Without an LLM key, `ask` can still produce a deterministic citation fallback when reliable evidence exists. If no reliable evidence is available, it returns `no_reliable_evidence`.

Only explicitly configured remote Neo4j, LLM, embedding, or Chroma services cause the corresponding network access. Therefore LogicLens is local-first, but not every possible configuration is offline.

### Semantic index (`semantic`)

- `semantic.provider`: `json` or `chroma`; local JSON storage is the default.
- `semantic.jsonPath`: Local JSON index path.
- `semantic.chroma`: Chroma mode, URL, collection, and optional authentication/database settings.

### MCP, plugins, and indexing

- `mcp.logCalls`: Log MCP invocations; defaults to `false`.
- `plugins.enabled`: Compatibility setting for existing configurations.
- `plugins.failFast`: Stop on the first plugin discovery/loading error when `true`.
- `indexing.concurrency`, `indexing.maxFilesPerRun`, and `indexing.batchSize`: Indexing controls.
- `indexing.summarizeChangedOnly`: Request summaries only for new or changed files.

See the [Plugin Guide](plugins.md) and [Plugin SDK Reference](plugin-sdk.md) for plugin configuration.
