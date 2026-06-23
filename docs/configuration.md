# Configuration Guide

This document describes all available configuration options in LogicLens. 

LogicLens uses sensible defaults for all settings. You do not need to specify most of these options in `.logiclens/config.yaml` unless you want to customize the behavior of the system.

## Full Reference Configuration

Below is a complete configuration file showing all supported properties and their default values:

```yaml
systemName: default-system

repos:
  - name: service-a
    path: ../service-a
  - name: service-b
    path: ../service-b

plugins:
  - name: ./plugins/internal-contract-plugin.mjs
    options:
      team: platform

frameworks:
  include: []
  exclude: []

include:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.java"
  - "**/*.py"
  - "**/*.go"
  - "**/*.md"
  - "**/*.mdx"
  - "**/*.yml"
  - "**/*.yaml"
  - "**/*.toml"
  - "**/*.properties"
  - "**/*.vue"

exclude:
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/build/**"
  - "**/.next/**"
  - "**/coverage/**"
  - "**/target/**"
  - "**/.git/**"

graph:
  provider: kuzu
  path: .logiclens/graph

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
  provider: openai
  model: text-embedding-3-small
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
  allowUnsafeCypher: false
  logCalls: false

watch:
  enabled: true
  mode: auto
  debounceMs: 2000
  maxRoots: 256
  maxLinuxDirs: 20000
  syncConcurrency: 1
  catchUp: background

indexing:
  concurrency: 4
  summarizeChangedOnly: true
  maxFilesPerRun: 5000
  batchSize: 0
  llmSummaryLevel: off
```

## Options Reference

### Global Settings

- `systemName`: The unique name for this logiclens project system (defaults to `"default-system"`).
- `repos`: List of repositories to index and analyze. Each repo contains a `name` and relative/absolute `path`.
- `plugins`: List of custom plugin configurations.

### File Matching

- `include`: Glob patterns of files to include in parsing.
- `exclude`: Glob patterns of files or directories to ignore.

### Frameworks

- `frameworks.include`: Specific frameworks to explicitly enable.
- `frameworks.exclude`: Specific frameworks to explicitly ignore.

### Graph Database (`graph`)

- `graph.provider`: Currently only supports `"kuzu"`.
- `graph.path`: The directory path where the Kuzu graph database is persisted.

### Large Language Model (`llm`)

- `llm.provider`: The provider for LLM requests (defaults to `"openai"`).
- `llm.model`: The specific LLM model to use (defaults to `"gpt-4.1-mini"`).
- `llm.maxSourceCharsPerNode`: Maximum source code character count per graph node.
- `llm.retry`: Network request retry policy configuration (exponential backoff parameters).

### Code Embedding (`embedding`)

- `embedding.provider`: The provider for embedding requests.
- `embedding.model`: The specific embedding model.
- `embedding.level`: Controls the scope of embedding generation (`off`, `repo`, `docs`, `file`, `node`, `all`).

### Semantic Index (`semantic`)

- `semantic.provider`: The storage provider for the semantic vector index (`json` or `chroma`).
- `semantic.jsonPath`: The path to store the index when using the local JSON-based vector index.

### MCP Settings (`mcp`)

- `mcp.allowUnsafeCypher`: If set to `true`, permits write/mutate queries in LLM Cypher actions.
- `mcp.logCalls`: Logs MCP tool invocations.

### Watcher (`watch`)

- `watch.enabled`: Enables real-time file system watching and hot-reloads.
- `watch.mode`: The watching path aggregation strategy (`auto`, `repo-roots`, `common-root`, `off`).

### Indexing (`indexing`)

- `indexing.concurrency`: Concurrency for file scanner and indexing phases.
- `indexing.summarizeChangedOnly`: Only request LLM summaries for modified/new files.
