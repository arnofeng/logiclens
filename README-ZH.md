# LogicLens

<center>

[![npm version](https://img.shields.io/npm/v/logiclens.svg)](https://www.npmjs.com/package/logiclens)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</center>

**一个本地优先（local-first）的跨仓库语义契约图，帮助 AI 编程代理理解跨仓库接口，并推理变更影响。**

[English](README.md) · **中文**

> [!IMPORTANT]
> **LogicLens 目前处于活跃的 Beta 开发阶段。** 虽然核心索引引擎、CLI、SDK、文件监听器（watcher）和 MCP 服务都已完全可用，但对语言和框架的覆盖仍是逐步增量的。在 API 和 Schema 结构不断完善的过程中，可能会发生一些调整。

---

## 目录

- [⚡ 快速开始](#-快速开始)
- [🧠 为什么需要 LogicLens](#-为什么需要-logiclens)
- [🧬 核心理念：代码图谱](#-核心理念代码图谱code-graph)
- [🔍 CLI 使用示例](#-cli-使用示例)
- [🤖 MCP 集成（AI Coding Agents）](#-mcp-集成ai-coding-agents)
- [🧠 SDK（编程方式访问）](#-sdk编程方式访问)
- [⚙️ 配置](#️-配置)
- [👍 当前语言和框架支持](#-当前语言和框架支持)
- [🧑‍💻 贡献](#贡献)
- [🛡️ 安全](#安全)
- [📄 License](#license)

---

## ⚡ 快速开始

### 1. 安装 LogicLens

```bash
npm install -g logiclens
logiclens --version
```

### 2. 初始化仓库

初始化工作区。这个工作区可以是多个仓库的父目录，也可以只是一个引用其他仓库路径的独立目录。

```bash
logiclens init

# 添加某个目录下第一层 Git 仓库
logiclens add-repos ../services
# 添加单个仓库
logiclens add-repo ../service-a --name service-a

logiclens index # 索引所有仓库
```

### 3. 基于图上下文提问

```bash
logiclens ask "哪些仓库参与了订单创建流程？"
```

预期输出示例：

```
Based on the code graph, the following repositories are involved
in the order creation flow:

1. service-a — exposes POST /api/order (producer)
2. service-b — consumes OrderCreatedEvent (consumer)
3. gateway — routes /api/order to service-a (router)
```

---

## 🧠 为什么需要 LogicLens

现代软件系统已经不再是单一仓库，而是由多个部分组成：

- 微服务（Services）
- 前端应用（Frontend）
- SDK / Client
- 事件系统（Event Bus）
- 共享库（Shared Packages）

但大多数工具仍然停留在文件级理解和单仓库视角，这会导致一个根本问题：

- 改一个 API，不知道谁在用
- 改一个事件，不知道影响范围
- AI Agent 无法理解整个系统结构

### LogicLens vs 传统工具

| | 传统工具 | LogicLens |
|---|---|---|
| 视野 | 单仓库 | 跨仓库工作区 |
| 粒度 | 文件级 | 符号 / 契约级 |
| 依赖发现 | 手动 grep | 自动图谱遍历 |
| AI 友好 | ❌ | ✅ MCP 原生集成 |
| 变更影响 | 凭经验猜 | 图路径追踪 |

---

## 🧬 核心理念：代码图谱（Code Graph）

LogicLens 会自动分析你的多仓库系统，将整个代码系统建模为一个 **图结构（Graph）**：

### 📦 节点（Nodes）

- 仓库（Repo）
- 文件（File）
- 符号（Symbol）
- 代码契约（Contract）— API / Event / DTO / Schema / RPC / GraphQL / Dubbo / Package 等契约关系

### 🔗 边（Edges）

- 跨仓库依赖图谱
- 符号级调用链路（call）
- 生产 / 消费关系（produce / consume）
- 服务之间的连接关系（depends-on）
- 变更影响路径（impact）

### 🚀 能力

- **本地优先**：基于 Kuzu 图数据库构建代码知识图谱，默认存储在 `.logiclens/graph`，数据完全留在本地。
- **跨仓库工作区**：一个工作区可以指向多个仓库，统一构建覆盖整个代码系统的图谱。
- **静态代码智能**：提取符号、import、调用、文档、语言事实和框架信号，作为图谱的节点和边。
- **契约模型**：将跨仓库证据归一为 `api`、`event`、`package`、`dto`、`schema`、`grpc-method`、`dubbo-method`、`graphql-operation`、`enum`、`config` 等契约类型，丰富图谱语义。
- **依赖视图**：展示仓库间依赖的强度、类型、证据位置、规则和解析信息。
- **追踪和影响面分析**：从契约或符号出发，沿图谱路径返回生产者、消费者、相关代码、调用、文档和建议检查文件。
- **CLI / SDK / MCP**：支持手动查询图谱、Node.js 集成和 AI 编程助手接入。
- **质量治理**：审计低置信度证据、拒绝误报、注册 alias override，确保图谱准确性。
- **可选 LLM / embedding 层**：需要时可接入 OpenAI 兼容 chat 和 embedding provider，增强图谱语义能力。

**从"代码搜索"升级为"图谱遍历 + 推理"。**

### 🏗️ 系统架构

```text
代码仓库（Repositories）
        ↓
解析器 + 提取器（Parser & Extractor）
        ↓
契约模型（API / Event / Schema / RPC / GraphQL / Dubbo / Package）
        ↓
代码图谱构建器（Code Graph Builder）
        ↓
本地图数据库（Kuzu）
        ↓
┌────────────┬────────────┬────────────┐
│   CLI      │    SDK     │    MCP     │
└─────┬──────┴─────┬──────┴─────┬──────┘
      ↓            ↓            ↓
  开发者 / CI    应用 /        AI Coding
              自动化          Agents
```

---

## 🔍 CLI 使用示例

> 完整的 CLI 命令和参数说明，请参阅 [CLI 命令参考](docs/cli-reference.md)。

```bash
logiclens stats
logiclens deps --limit 20
logiclens contracts --kind api
```

### 💥 契约追踪

```bash
logiclens trace api:/api/order/:id
logiclens trace event:OrderCreatedEvent
```

### 🔎 影响分析

```bash
logiclens impact OrderCreatedEvent
logiclens impact api:/api/order/:id
```

---

## 🤖 MCP 集成（AI Coding Agents）

LogicLens 通过 **Model Context Protocol（MCP）** 将代码图谱暴露给 AI Agent。

### 一键安装

```bash
logiclens install
```

你可以使用交互式安装程序，在多个 AI 代理（Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE、Kiro）中自动注册 LogicLens MCP 服务。

### MCP 工具

| 工具名称 | 功能说明 |
|---|---|
| `logiclens_get_stats` | 获取图数据库的汇总统计（仓库数、文件数、代码节点数、调用数等） |
| `logiclens_get_watch_status` | 获取文件监听器和启动追赶索引的状态 |
| `logiclens_list_dependencies` | 列出跨仓库依赖及其证据（支持按 strength/type 过滤） |
| `logiclens_list_contracts` | 列出已识别的契约及其生产者/消费者/共享计数（支持按 kind 过滤） |
| `logiclens_trace` | 追踪特定契约或实体，找到所有生产者、消费者和引用 |
| `logiclens_impact_analysis` | 评估修改代码符号或契约的下游影响范围 |
| `logiclens_ask_question` | 基于 RAG 的问答，检索代码符号、文档、契约、依赖等结构化上下文 |
| `logiclens_query_cypher` | 对 Kuzu 图数据库执行原始 Cypher 查询（默认只读） |

### MCP 配置示例

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

## 🧠 SDK（编程方式访问）

LogicLens 提供 Node.js SDK，用于构建自动化系统与 AI 工具链。

```ts
import { createLogicLens } from "logiclens";

const client = await createLogicLens({ cwd: process.cwd() });

try {
  // addRepo 只更新该 client 的内存态配置(不落盘)。
  // 如需持久化工作区配置,请用 CLI:`logiclens init` / `logiclens add-repo`。
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

### SDK 方法参考

| 方法 | 用途 |
|---|---|
| `client.addRepo(path, options)` | 将单个仓库加入该 client 的内存态配置(不落盘)。 |
| `client.addRepos(directory, options)` | 发现并将第一层 Git 仓库加入内存态配置(不落盘)。 |
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

---

## ⚙️ 配置

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

完整支持的参数列表及其默认值，请参阅 [Configuration Guide](docs/configuration.md)。

### 成本和隐私说明

索引、图写入、`stats`、`deps`、`contracts`、`trace`、`impact` 和原始图查询默认都是本地图操作，不需要 LLM provider。

`ask` 会先做图检索，再调用配置的 LLM 生成答案。可选的 LLM 摘要和 embedding 也可能把选中的源码或文档文本发送给你配置的 provider。如果你希望索引过程完全本地化，请保持 `embedding.level: off` 和 `indexing.llmSummaryLevel: off`。

---

## 👍 当前语言和框架支持

当前 LogicLens 会扫描和解析：

| 类型 | 扩展名 |
|---|---|
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
|---|---|
| JavaScript / TypeScript | `package.json`、import、常见 HTTP client 请求模式、静态可见的生成客户端证据。 |
| Java | Maven / Gradle 元数据、package facts、Spring MVC 注解和 import。 |
| Python | 通用 Python 解析，以及基于依赖元数据的 FastAPI 探测。 |
| Go | Go module、通用 Go 解析、Gin 探测。 |
| 文档 | 可关联到代码和影响面输出的 Markdown / MDX 章节。 |
| 配置 | YAML、TOML、properties，以及环境/配置类契约证据。 |

后续会逐步支持更多语言、框架和生成客户端模式。

### 当前局限

- LogicLens 仍处于 Beta 阶段，图结构和提取器行为仍可能变化。
- 静态分析偏保守。动态 API path、反射、运行时依赖注入、生成代码和框架魔法可能提取不完整，或被报告为 unresolved evidence。
- 内置框架支持是聚焦的。未支持框架仍可作为源码解析，但契约提取可能较浅，直到添加对应 detector 或 extractor。
- 跨仓库依赖质量依赖仓库名、包元数据、import、alias 和契约证据。
- 大型工作区可能需要 `--changed-only`、`--batch-size`、`--max-files`、watcher 调优或 Chroma 语义存储。
- LLM 答案取决于检索上下文和 provider 行为。需要可审计证据时，优先使用 `trace`、`deps`、`contracts` 和 `impact`。
- MCP Server 拥有本地工作区访问能力。只应连接到你信任的客户端。

---

## 贡献

非常欢迎并期待社区的贡献！无论是提交 Bug 报告、优化文档，还是开发新功能、增加语言和框架支持，你的帮助对我们都非常重要。

**快速开始：**

1. Fork 本仓库
2. 创建你的特性分支：`git checkout -b feature/my-feature`
3. 提交更改：`git commit -m 'feat: add my feature'`
4. 推送到分支：`git push origin feature/my-feature`
5. 发起 Pull Request

有关更详细的步骤，请参阅 [Contributing Guide](CONTRIBUTING.md)。

## 安全

LogicLens 会索引本地源码，并可能把图上下文暴露给 CLI 用户、SDK 调用方和 MCP 客户端。连接 MCP Server 到第三方工具，或启用原始 Cypher 写入时，请特别谨慎。

安全问题报告方式见 [SECURITY.md](SECURITY.md)。

## License

MIT，见 [LICENSE](LICENSE)。
