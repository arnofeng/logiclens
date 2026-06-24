# LogicLens

LogicLens 是一个本地优先的跨仓库语义依赖图工具。

现代代码系统通常分散在很多服务、包、前端、任务、SDK 和共享库里。只看单个仓库，很难回答下面这些问题：

- 哪些仓库消费了这个 API、事件、包、DTO、schema 或配置键？
- 如果我要修改这个 handler、符号或契约，应该优先检查哪些文件？
- 服务之间是通过 import、package metadata、HTTP 调用、事件还是共享契约连接起来的？
- AI 编程助手在回答代码问题之前，应该先读取哪些代码和文档上下文？

LogicLens 会索引你配置的多个仓库，提取源码符号和跨仓库证据，并把结果写入本地 Kuzu 图数据库。你可以通过 CLI 查询图，也可以通过 Node.js SDK 集成到自己的工具里，或者通过 stdio MCP Server 暴露给 AI 编程助手。

> [!IMPORTANT]
> **LogicLens 目前处于活跃的 Beta 开发阶段。** 虽然核心索引引擎、CLI、SDK、文件监听器（watcher）和 MCP 服务都已完全可用，但对语言和框架的覆盖仍是逐步增量的。在 API 和 Schema 结构不断完善的过程中，可能会发生一些调整。

## 它会构建什么

LogicLens 会从以下内容构建本地图：

- `.logiclens/config.yaml` 中声明的仓库。
- 由 `include` 和 `exclude` glob 选择的文件。
- 代码符号、import、调用关系和文档章节。
- 框架识别结果和语言事实。
- package、import、API、event、DTO、schema、enum、config 等契约证据。
- 可选的语义摘要和 embedding。

这个图可以支持：

- 跨仓库依赖发现。
- API、事件、包等契约追踪。
- 变更影响面分析。
- 基于图上下文的自然语言检索。
- 通过 MCP 给 Agent 提供代码上下文。
- 对低置信度或冲突依赖证据做本地质量治理。

## 特点

- **本地优先图数据库**：默认将 Kuzu 图数据存储在 `.logiclens/graph`。
- **跨仓库工作区**：一个工作区可以指向多个仓库。
- **静态代码智能**：提取符号、import、调用、文档、语言事实和框架信号。
- **契约模型**：将跨仓库证据归一为 `api`、`event`、`package`、`dto`、`schema`、`enum`、`config` 等契约类型。
- **依赖视图**：展示仓库间依赖的强度、类型、证据位置、规则和解析信息。
- **追踪和影响面分析**：从契约或符号出发，返回生产者、消费者、相关代码、调用、文档和建议检查文件。
- **CLI / SDK / MCP**：支持手动使用、Node.js 集成和 AI 编程助手接入。
- **文件监听**：支持变更文件索引，并向 MCP 客户端暴露新鲜度元数据。
- **质量治理**：审计低置信度证据、拒绝误报、注册 alias override。
- **可选 LLM / embedding 层**：需要时可接入 OpenAI 兼容 chat 和 embedding provider。
- **插件 API**：可注册自定义解析器、框架探测器、契约提取器和 CLI 命令。

## 安装

### 通过 npm 安装

```bash
npm install -g logiclens
logiclens --version
```

不全局安装也可以直接使用：

```bash
npx logiclens --help
```

### 从源码安装

```bash
git clone https://github.com/arnofeng/logiclens.git
cd logiclens
npm install
npm run build
npm link
logiclens --help
```

本地开发时也可以不 link：

```bash
npm run dev -- --help
npm run dev -- init
```

## 快速开始

创建一个工作区。这个工作区可以是多个仓库的父目录，也可以只是一个引用其他仓库路径的独立目录。

```bash
mkdir my-workspace
cd my-workspace
logiclens init
```

添加单个仓库：

```bash
logiclens add-repo ../service-a --name service-a
```

添加某个目录下第一层 Git 仓库：

```bash
logiclens add-repos ../services
```

索引所有仓库：

```bash
logiclens index
```

查看图：

```bash
logiclens stats
logiclens deps --limit 20
logiclens contracts --limit 20
```

追踪契约：

```bash
logiclens trace api:/api/order/:id
logiclens trace event:OrderCreatedEvent
```

分析影响面：

```bash
logiclens impact OrderCreatedEvent
logiclens impact api:/api/order/:id
```

基于图上下文提问：

```bash
logiclens ask "哪些仓库参与了订单创建流程？"
```

编辑代码时保持图数据更新：

```bash
logiclens watch --debounce-ms 2000
```

## 使用场景示例

### 分析一组服务

```bash
logiclens init
logiclens add-repos ../company-services --index --batch-size 10 --write-mode auto
logiclens stats
logiclens deps --strength strong --limit 50
logiclens contracts --kind api --limit 50
```

适合在接手一组仓库时，快速得到第一版依赖视图。

### 检查 API 迁移影响

```bash
logiclens index --changed-only
logiclens trace api:/api/order/:id
logiclens impact api:/api/order/:id
logiclens deps --type api --limit 100
```

适合在修改 endpoint、route、生成客户端或 HTTP client wrapper 之前使用。

### 查看事件消费者

```bash
logiclens contracts --kind event --limit 100
logiclens trace event:OrderCreatedEvent
logiclens impact OrderCreatedEvent
```

适合在修改事件名、payload、topic、DTO 或 handler 前使用。

### 给 AI 助手提供新鲜上下文

```bash
logiclens index
logiclens mcp
```

然后把 MCP 兼容客户端连接到这个工作区。MCP Server 会启动文件监听和后台 changed-file catch-up，工具响应中会携带新鲜度元数据。

## 配置

`logiclens init` 会创建 `.logiclens/config.yaml`。这个文件是仓库列表、索引行为、图存储、语义检索、LLM provider、MCP 安全策略和 watcher 行为的事实来源。

### 配置模板

默认情况下，`logiclens init` 会生成一个极简且干净的配置文件：

```yaml
systemName: default-system

repos:
  - name: service-a
    path: ../service-a
  - name: service-b
    path: ../service-b
```

### 高级配置

LogicLens 支持针对性能调优、索引设置、自定义 LLM 重试、以及语义存储提供商等多种高级配置项。

完整支持的参数列表及其默认值，请参阅 [Configuration Guide](docs/configuration.md)（英文说明）。

### 环境变量

```bash
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
LOGICLENS_NO_WATCH=1
LOGICLENS_FORCE_WATCH=1
```

| 变量 | 说明 |
| --- | --- |
| `OPENAI_API_KEY` | 当 `llm.apiKey` 或 `embedding.apiKey` 未设置时使用。 |
| `OPENAI_BASE_URL` | 当 `llm.baseUrl` 或 `embedding.baseUrl` 未设置时使用。 |
| `LOGICLENS_NO_WATCH=1` | 禁用文件监听。 |
| `LOGICLENS_FORCE_WATCH=1` | 即使策略通常会阻止 watcher，也强制启用。 |

### 成本和隐私说明

索引、图写入、`stats`、`deps`、`contracts`、`trace`、`impact` 和原始图查询默认都是本地图操作，不需要 LLM provider。

`ask` 会先做图检索，再调用配置的 LLM 生成答案。可选的 LLM 摘要和 embedding 也可能把选中的源码或文档文本发送给你配置的 provider。如果你希望索引过程完全本地化，请保持 `embedding.level: off` 和 `indexing.llmSummaryLevel: off`。

## CLI 使用

查看帮助：

```bash
logiclens --help
logiclens <command> --help
```

### 工作区命令

#### `logiclens init`

创建 `.logiclens/config.yaml`、`.logiclens/graph` 和 `.logiclens/cache`。

```bash
logiclens init
```

#### `logiclens uninit`

删除 `.logiclens` 工作区状态，并尝试停止 `.logiclens/mcp.pid` 记录的 MCP 进程。

```bash
logiclens uninit
```

#### `logiclens add-repo <path>`

向 `.logiclens/config.yaml` 添加单个仓库。

```bash
logiclens add-repo ../service-a
logiclens add-repo ../service-a --name order-service
```

| Option | 说明 |
| --- | --- |
| `--name <name>` | 自定义仓库名。默认使用目录名。 |

#### `logiclens add-repos <directory>`

发现某个目录下第一层 Git 仓库，并添加到工作区配置。

```bash
logiclens add-repos ../services
logiclens add-repos ../services --index --changed-only
logiclens add-repos ../services --index --batch-size 10 --write-mode auto
```

| Option | 说明 |
| --- | --- |
| `--index` | 添加后立即索引发现的仓库。 |
| `--changed-only` | 索引时尽量只处理已有状态中的变更文件。 |
| `--max-files <number>` | 每个仓库最多索引多少文件。 |
| `--batch-size <number>` | 大规模全量导入时每批处理多少仓库。 |
| `--write-mode <mode>` | 图写入模式：`auto`、`merge`、`bulk`、`bulk-upsert`。默认 `auto`。 |

### 索引命令

#### `logiclens index`

索引已配置仓库。它会扫描文件、解析源码、提取契约、写入图节点和边、在配置时更新语义数据，并重建仓库间依赖边。

```bash
logiclens index
logiclens index --repo service-a
logiclens index --changed-only
logiclens index --max-files 2000
logiclens index --batch-size 10 --write-mode auto
logiclens index --write-mode merge
```

| Option | 说明 |
| --- | --- |
| `--repo <name>` | 只索引一个已配置仓库。 |
| `--changed-only` | 只重新索引上次状态之后发生变化的文件。适合初次全量索引后的日常使用。 |
| `--max-files <number>` | 限制本次处理的文件数。适合 smoke test 或超大仓库。 |
| `--batch-size <number>` | 将大规模全量导入拆成仓库批次。适用于 `auto` 或 `bulk` 写入模式。 |
| `--write-mode <mode>` | `auto`、`merge`、`bulk` 或 `bulk-upsert`。默认 `auto`。 |

写入模式建议：

| 模式 | 适用场景 |
| --- | --- |
| `auto` | 希望 LogicLens 自动选择稳妥路径。推荐默认使用。 |
| `merge` | 更新已有图，或运行 `--changed-only`。 |
| `bulk` | 空图全量导入，并希望使用 full-copy bulk 路径。 |
| `bulk-upsert` | 需要面向已有图数据的批量 upsert 行为。 |

#### `logiclens rebuild-relations`

根据已索引的契约证据重建仓库间依赖边。

```bash
logiclens rebuild-relations
logiclens rebuild-relations --repo service-a
logiclens rebuild-relations --full
```

| Option | 说明 |
| --- | --- |
| `--repo <name>` | 只重建某个仓库的依赖边。 |
| `--full` | 重建全部依赖边。 |

#### `logiclens watch`

先运行一次 changed-only 补索引，然后监听文件变更。

```bash
logiclens watch
logiclens watch --repo service-a
logiclens watch --debounce-ms 3000
```

| Option | 说明 |
| --- | --- |
| `--debounce-ms <number>` | 文件事件发生后等待多久再索引。 |
| `--repo <name>` | 只监听和索引某个已配置仓库。 |

### 查询和分析命令

#### `logiclens stats`

打印仓库、文件、代码节点、文档章节、实体和边等图统计信息。

```bash
logiclens stats
```

#### `logiclens deps`

列出结构化跨仓库依赖和证据。

```bash
logiclens deps
logiclens deps --limit 50
logiclens deps --strength strong
logiclens deps --strength weak
logiclens deps --type api --limit 100
logiclens deps --type event --limit 100
```

| Option | 说明 |
| --- | --- |
| `--strength <strong\|weak>` | 按依赖强度过滤。package、import、API 被视为 strong；event 和 shared-contract 被视为 weak。 |
| `--type <type>` | 按依赖类型过滤，例如 `package`、`import`、`api`、`event`、`shared-contract`。 |
| `--limit <number>` | 最大输出数量。 |

#### `logiclens contracts`

列出识别到的契约，以及 producer、consumer、shared 数量。

```bash
logiclens contracts
logiclens contracts --kind api --limit 50
logiclens contracts --kind event --limit 50
logiclens contracts --kind package --limit 50
```

| Option | 说明 |
| --- | --- |
| `--kind <kind>` | 按 `package`、`api`、`event`、`dto`、`schema`、`enum`、`config` 过滤。 |
| `--limit <number>` | 最大输出数量。 |

#### `logiclens trace <contractOrEntity>`

追踪契约或实体。

```bash
logiclens trace api:/api/order/:id
logiclens trace event:OrderCreatedEvent
logiclens trace package:@internal/order-sdk
logiclens trace OrderService
```

带已知 `kind:value` 前缀的目标会被当作契约。其他目标会被当作实体或符号名。

#### `logiclens impact <symbolOrEntity>`

展示某个契约、实体或符号的潜在下游影响。

```bash
logiclens impact OrderCreatedEvent
logiclens impact api:/api/order/:id
logiclens impact OrderService
```

输出包括契约生产者/消费者、实体图上下文、匹配代码、相关调用边、相关文档和建议检查文件。

#### `logiclens ask <question>`

检索图上下文，并调用配置的 LLM 生成答案。

```bash
logiclens ask "哪些服务创建订单？"
logiclens ask "修改 OrderCreatedEvent 前应该检查什么？"
logiclens ask "哪些仓库依赖支付 API？"
```

如果没有配置 API key，检索仍可能返回 fallback 图上下文，但完整答案生成需要 OpenAI 兼容 provider。

#### `logiclens query <cypher>`

对本地图执行原始 Kuzu Cypher 查询。

```bash
logiclens query "MATCH (r:Repo) RETURN r.name AS name LIMIT 10"
logiclens query "MATCH (c:Contract) RETURN c.kind AS kind, c.key AS key LIMIT 20"
```

这个 CLI 命令面向本地可信使用。MCP 中的原始 Cypher 默认只读，除非启用 `mcp.allowUnsafeCypher`。

### 质量治理和诊断命令

#### `logiclens quality`

审计低置信度关系和冲突 producer。

```bash
logiclens quality
logiclens quality --min-confidence 0.7 --limit 50
```

| Option | 说明 |
| --- | --- |
| `--min-confidence <number>` | 低于该置信度的证据会出现在低置信度审计中。 |
| `--limit <number>` | 最大审计行数。 |

拒绝误报证据：

```bash
logiclens quality --reject-evidence <evidence-id> --reason "false positive"
```

注册 alias override：

```bash
logiclens quality --alias order-api --target-repo service-a --reason "internal service alias"
```

| Option | 说明 |
| --- | --- |
| `--reject-evidence <id>` | 将某条证据标记为 rejected。 |
| `--reason <text>` | 拒绝或 alias override 的原因。 |
| `--alias <alias>` | 要映射到仓库的别名。 |
| `--target-repo <name>` | alias 指向的仓库名。 |

#### `logiclens quality contracts`

审计契约质量规则。

```bash
logiclens quality contracts
```

#### `logiclens frameworks`

打印每个仓库检测到的框架和启用的 extractor。

```bash
logiclens frameworks
```

当契约提取结果不符合预期时，可以用它检查框架探测器或 extractor 是否启用。

#### `logiclens plugins`

列出已配置插件和注册的扩展钩子。

```bash
logiclens plugins
```

## SDK 使用

LogicLens 从 package root 暴露 Node.js ESM SDK。

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

### 使用自定义配置创建 client

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

### 常见 SDK 调用

```ts
await client.addRepos("../services", { index: true, changedOnly: true });
await client.index({ repo: "service-a", changedOnly: true, writeMode: "merge" });
await client.rebuildRelations({ full: true });

const deps = await client.dependencies({ type: "api", limit: 100 });
const unresolved = await client.unresolvedEvidence({ limit: 50 });
const retrieval = await client.retrieve("订单创建逻辑在哪里实现？");
const answer = await client.ask("哪些服务消费了 OrderCreatedEvent？");
const rows = await client.query("MATCH (r:Repo) RETURN r.name AS name LIMIT 10");
```

### SDK 方法参考

| 方法 | 用途 |
| --- | --- |
| `client.init()` | 初始化 `.logiclens` 目录和默认配置。 |
| `client.uninit()` | 删除工作区状态，并尽量停止记录的 MCP 进程。 |
| `client.addRepo(path, options)` | 添加单个仓库。 |
| `client.addRepos(directory, options)` | 发现并添加第一层 Git 仓库。 |
| `client.ensurePlugins()` | 加载配置插件和 inline 插件。 |
| `client.index(options)` | 索引仓库。 |
| `client.getIndexQueueStatus()` | 查看 SDK/MCP 索引队列状态。 |
| `client.rebuildRelations(options)` | 根据已索引证据重建依赖边。 |
| `client.stats()` | 返回图统计信息。 |
| `client.dependencies(options)` | 列出跨仓库依赖。 |
| `client.unresolvedEvidence(options)` | 列出无法规约为稳定契约 key 的提取点。 |
| `client.contracts(options)` | 列出识别到的契约。 |
| `client.trace(target)` | 追踪契约或实体。 |
| `client.impact(target)` | 分析下游影响面。 |
| `client.retrieve(question)` | 返回结构化检索上下文，不生成答案。 |
| `client.ask(question)` | 基于检索上下文生成答案。 |
| `client.query(cypher, params)` | 执行 Kuzu 查询。 |
| `client.watch(options)` | 开启自动变更文件索引。 |
| `client.unwatch()` | 停止 watcher。 |
| `client.getWatchStatus()` | 查看 watcher、catch-up、pending files 和队列状态。 |
| `client.close()` | 关闭 watcher、队列和图数据库资源。 |

### SDK 插件

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

插件可以注册：

- `registerParser(parser)`：自定义语言解析。
- `registerFrameworkDetector(detector)`：仓库级框架探测。
- `registerContractExtractor(extractor)`：提取 API、event、package、DTO、schema、enum、config 或自定义契约证据。
- `registerCliCommand(registerFn)`：扩展 CLI 命令。

## MCP 使用

LogicLens 可以作为 stdio Model Context Protocol Server 运行。你可以通过自动配置（推荐）或手动配置进行注册。

### 自动配置（推荐）

你可以使用交互式安装程序，在多个 AI 代理（Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE、Kiro）中自动注册 LogicLens MCP 服务：

```bash
logiclens install
```

如果需要非交互式静默安装（默认安装到全局，并自动授予 Claude 权限）：
```bash
# 自动检测本地已安装的 AI 代理并进行全局配置
logiclens install -y

# 仅在当前项目中为 Claude Code 和 Cursor 进行本地配置
logiclens install -y -t claude,cursor --location local
```

卸载已注册的配置：
```bash
# 交互式卸载
logiclens uninstall

# 静默全局卸载
logiclens uninstall -y
```

### 手动配置

手动在标准输入输出（stdio）上启动 MCP 服务：

```bash
logiclens mcp
```

MCP 客户端配置示例：

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

从源码仓库运行：

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

| Tool | 参数 | 说明 |
| --- | --- | --- |
| `logiclens_get_stats` | 无 | 以 JSON 返回图统计信息。 |
| `logiclens_get_watch_status` | 无 | 返回 watcher、启动补索引、pending file 和索引队列状态。 |
| `logiclens_list_dependencies` | `strength?`、`type?`、`limit?` | 列出跨仓库依赖。 |
| `logiclens_list_contracts` | `kind?`、`limit?` | 列出识别到的契约及 producer/consumer/shared 数量。 |
| `logiclens_trace` | `target` | 追踪契约如 `api:/v1/users`，或实体如 `OrderService`。 |
| `logiclens_impact_analysis` | `target` | 返回某个符号、实体或契约的下游影响上下文。 |
| `logiclens_ask_question` | `question` | 为自然语言问题检索结构化代码上下文。 |
| `logiclens_query_cypher` | `cypher` | 执行 Kuzu Cypher。`mcp.allowUnsafeCypher` 为 false 时默认只读。 |

### MCP 示例

你可以让 AI 助手执行：

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

### 新鲜度行为

MCP Server 启动时，LogicLens 会启动 watcher 和后台 changed-file catch-up。普通工具响应会包含新鲜度元数据，客户端可以判断索引是否可能滞后，例如：

- 启动补索引仍在运行。
- 补索引失败。
- watcher 已降级。
- 文件存在待处理变更。
- 索引队列正在运行或存在待执行任务。

## 当前语言和框架支持

当前 LogicLens 会扫描和解析：

| 类型 | 扩展名 |
| --- | --- |
| TypeScript | `.ts`、`.tsx` |
| JavaScript | `.js`、`.jsx` |
| Vue | `.vue` |
| Java | `.java` |
| Python | `.py` |
| Go | `.go` |
| Markdown / MDX | `.md`、`.mdx` |
| 配置文件 | `.yml`、`.yaml`、`.toml`、`.properties` |

内置框架和契约提取当前主要覆盖：

| 类型 | 当前覆盖 |
| --- | --- |
| JavaScript / TypeScript | `package.json`、import、常见 HTTP client 请求模式、静态可见的生成客户端证据。 |
| Java | Maven / Gradle 元数据、package facts、Spring MVC 注解和 import。 |
| Python | 通用 Python 解析，以及基于依赖元数据的 FastAPI 探测。 |
| Go | Go module、通用 Go 解析、Gin 探测。 |
| 文档 | 可关联到代码和影响面输出的 Markdown / MDX 章节。 |
| 配置 | YAML、TOML、properties，以及环境/配置类契约证据。 |

后续会逐步支持更多语言、框架和生成客户端模式。对于项目内部特有约定，推荐通过插件扩展，而不是等待内置支持。

## 当前局限

- LogicLens 仍处于 beta 阶段，图结构、提取器行为和插件 API 仍可能变化。
- 静态分析偏保守。动态 API path、反射、运行时依赖注入、生成代码和框架魔法可能提取不完整，或被报告为 unresolved evidence。
- 内置框架支持是聚焦的。未支持框架仍可作为源码解析，但契约提取可能较浅，直到添加对应 detector 或 extractor。
- 跨仓库依赖质量依赖仓库名、包元数据、import、alias 和契约证据。
- 大型工作区可能需要 `--changed-only`、`--batch-size`、`--max-files`、watcher 调优或 Chroma 语义存储。
- LLM 答案取决于检索上下文和 provider 行为。需要可审计证据时，优先使用 `trace`、`deps`、`contracts` 和 `impact`。
- MCP Server 拥有本地工作区访问能力。只应连接到你信任的客户端。

## 开发

```bash
npm install
npm run build
npm run typecheck
npm test
```

常用开发命令：

```bash
npm run dev -- --help
npm run bench:scale
npm run audit:prod
```

发布包校验：

```bash
npm pack --dry-run --ignore-scripts
```

## 贡献

非常欢迎并期待社区的贡献！无论是提交 Bug 报告、优化文档，还是开发新功能、增加语言和框架支持，你的帮助对我们都非常重要。

有关如何开始、设置本地开发环境以及提交 Pull Request 的详细步骤，请参阅英文版 [Contributing Guide](CONTRIBUTING.md)。

## 安全

LogicLens 会索引本地源码，并可能把图上下文暴露给 CLI 用户、SDK 调用方和 MCP 客户端。连接 MCP Server 到第三方工具，或启用原始 Cypher 写入时，请特别谨慎。

安全问题报告方式见 `SECURITY.md`。

## License

MIT，见 `LICENSE`。
