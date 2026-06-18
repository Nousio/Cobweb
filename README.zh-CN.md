# Cobweb

[English](./README.md) | 简体中文

Cobweb 是一个本地优先的 Agent Skill 治理与路由工具。它会扫描已有的 `SKILL.md` 目录，根据目录层级和文档引用构建 SkillGraph，为 skill 建立可解释的本地检索索引，发现重复项，将 skill 登记到本地 store，并可把 canonical skill 投射到 Agents、Cursor、Claude、Codex 等工具目录。

Cobweb 围绕开放的 `SKILL.md` 约定工作，并把最终语义判断留给调用方 Agent。Cobweb 提供的是确定性的本地信号：解析后的元数据、method 摘要、资源链接、重复检查、FTS 命中、分数拆解和 SkillGraph 链路上下文。

## 为什么需要 Cobweb

Agent skill 往往散落在项目目录、全局工具目录、历史工作区、`.agents/skills`、`.cursor/skills`、`.claude/skills` 和兼容 `.codex` 的目录结构中。时间久了，同名 skill、近重复、索引陈旧、资源缺失和策略漂移都会影响 Agent 正确选择 skill。

Cobweb 为这些本地 skill 提供一个控制面：

- 发现目录下所有 `SKILL.md`。
- 用内存 SkillGraph 查看 skill 拓扑。
- 校验轻量结构、资源引用、策略对齐和重复风险。
- 将 skill 登记到本地索引，或在需要时复制到 canonical store。
- 通过符号链接或复制，把 canonical skill 同步到 provider 目录。
- 让 Agent 通过 MCP stdio server 调用同一套治理模型。

## 安装

Cobweb 要求 Node.js `>=22`。

```bash
npm install -g cobweb
cobweb --version
```

不安装时也可以临时运行：

```bash
npx cobweb --help
```

发布包提供三个可执行命令：

- `cobweb` / `cw`：面向用户的 CLI。
- `cobwebd`：持有运行态和写入入口的本地 daemon。
- `cobweb-mcp`：面向 Agent 客户端的 MCP stdio server。

日常使用只需要运行 `cobweb`。当存在构建后的 `cobwebd` 入口时，写命令会按需启动 daemon。MCP 请求不会自动启动 daemon。

## 快速开始

只读检查命令不需要 daemon：

```bash
cobweb scan ./skills
cobweb graph ./skills
cobweb graph chain ./skills --target my-skill
cobweb lint ./skills/my-skill
cobweb dedup ./skills
```

写命令默认只预览计划。需要真正持久化时加 `--write`，写入会经过 daemon Writer Queue。`sync` 读取的是 `cobweb.lock.yaml` 中的 canonical 记录，因此投射到 provider 目录前，需要先用 `--canonical <path>` 导入可同步副本：

```bash
cobweb import ./skills/my-skill
cobweb import ./skills/my-skill --write
cobweb import ./skills/my-skill --write --canonical ~/.local/share/cobweb/skills

cobweb sync --target agents,cursor
cobweb sync --target agents,cursor --write
```

管理策略、本地资源和合并计划：

```bash
cobweb policy check ./skills/my-skill
cobweb policy ./skills/my-skill --implicit off
cobweb policy ./skills/my-skill --self-contained on

cobweb vendor ./skills/my-skill
cobweb vendor ./skills/my-skill --write

cobweb merge ./skills/old-skill ./skills/my-skill
```

检查运行态健康：

```bash
cobweb status
cobweb status --readonly

cobweb daemon start
cobweb daemon status
cobweb daemon status --json
cobweb daemon doctor
cobweb daemon doctor --json
cobweb daemon repair
cobweb daemon stop
```

多数 CLI 命令输出 JSON，便于管道和脚本消费。`cobweb daemon status` 和 `cobweb daemon doctor` 默认输出人类可读文本，也支持 `--json`。

## CLI 命令

- `scan [path]`：递归发现 `SKILL.md`，返回解析后的候选、重名提示和 parser warning。
- `graph [path]`：基于扫描根目录构建只读的内存 SkillGraph。
- `graph chain [path] --target <target>`：返回某个 skill 的 containment path、引用的 skill、引用它的 skill 和资源列表。
- `lint [skill]`：检查描述长度、正文长度和 skill 根目录内的本地资源引用。
- `dedup [path]`：基于内容 hash、名称、描述和词面相似度发现重复或近重复 skill。
- `import <path>`：预览导入；使用 `--write` 时会把源 skill 登记到 SQLite，若同时提供 `--canonical <path>`，则复制到 canonical store。
- `sync`：把 `cobweb.lock.yaml` 记录的 canonical skill 投射到 provider 目录。支持 `agents`、`cursor`、`claude` 和 `codex`，默认使用符号链接，`--copy` 使用复制。
- `policy [skill]`：检查或更新不同工具约定下的调用策略和 self-contained 策略。
- `vendor <skill>`：当使用 `--write` 时，将逃出 skill 根目录的本地资源复制到 `resources/vendor/` 并重写引用。
- `merge <source-skill> <target-skill>`：输出合并计划，不直接写入。
- `status`：报告 daemon 和 store 健康；`--readonly` 可在 daemon 不可用时降级。
- `daemon`：启动、停止、诊断或修复本地 daemon 和 SQLite 索引。

大型 skill 树可以降低 graph 路径枚举预算：

```bash
cobweb graph ./skills --max-depth 16 --max-paths 500
```

## MCP Server

`cobweb-mcp` 通过 stdio 提供 MCP server，并把每个工具调用转发给本地 daemon。可在 MCP 客户端中这样配置：

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "cobweb-mcp",
      "args": []
    }
  }
}
```

MCP server 暴露以下工具：

- `status`：返回 daemon 状态。
- `scan`：扫描目录下的 `SKILL.md` skill。
- `skill_graph`：构建包含 `scan_root`、`skill`、`resource` 和 `external` 节点的内存 SkillGraph。
- `skill_chain`：从扫描根目录返回某个 skill 的链路上下文。
- `skill_search`：搜索 daemon 管理的 SQLite FTS 索引，返回候选、分数、分数拆解、命中原因和 freshness。
- `skill_select`：为分析后的路由查询选择最佳候选，并返回推荐、被拒候选、可选 SkillGraph chain 和可选 `guidance`。
- `skill_context`：返回某个 skill 的 method 摘要、资源、策略和 lint 上下文。
- `skill_validate`：在使用或导入 skill 前组合 lint、policy 和索引重复检查。

调用 `skill_select` 时，MCP 调用方必须提供 `workItem.subject`。`query` 应该是分析后的路由词，而不是用户原话整句。当缺少 work item、输入质量低、没有候选、候选置信度低或前两名过近时，Cobweb 会返回 `guidance`，其中包含原因、检查清单、示例和 `inspectionTargets`，方便 Agent 改写查询或检查精确 skill 路径。

如果 daemon 不可达，`cobweb-mcp` 会返回可重试错误，不会自动启动 daemon。先运行：

```bash
cobweb daemon start
```

如果 Cobweb 是全局安装的，请确认 `cobwebd` 在 `PATH` 中，并且 MCP 客户端与 CLI 使用相同的 `COBWEB_DATA_DIR`。

## 工作方式

Cobweb 按严格分层实现：

- `core`：纯业务逻辑，包括 parser、scan、SkillGraph、lint、dedup、policy、vendor plan、provider projection、存储类型和搜索排序。
- `daemon`：运行态所有者，负责 IPC、SQLite、Writer Queue、watcher、索引生命周期和所有持久化写入。
- `cli`：命令解析、daemon 调用、只读降级和输出格式化。
- `mcp`：MCP stdio server，只把工具调用转发给 daemon。

所有写入路径都经过 `cobwebd` 和 Writer Queue。`scan`、`graph`、`lint`、`dedup`、`merge` 等只读命令可以由 CLI 直接运行，不依赖 daemon 状态。

## 搜索与新鲜度

`skill_search` 和 `skill_select` 使用 SQLite FTS5，并对中文等连续文本做 CJK bigram 增广；随后根据名称覆盖、method 触发词、描述、字段覆盖、正文命中和 BM25 做确定性 re-rank。Cobweb 不运行 embedding 模型，不维护向量表，不调用外部 AI API，也不持久化模型判断。

搜索结果包含 `freshness` 字段：

- `fresh`：扫描根目录已经对账，在 staleness budget 有效期内可走 warm fast path。
- `rebuilding`：索引任务正在运行或排队。
- `degraded`：Cobweb 仍可从本地索引回答，但 watcher、parser、schema 或 reconcile 诊断需要关注。

默认 staleness budget 是 `2000ms`，可通过 `COBWEB_MAX_STALENESS_MS` 调整。Cobweb 只监听已索引的 `SKILL.md` 文件，而不是递归监听整个工作区；当 watcher 不可用时，会回退到 content-hash 对账。

使用 `cobweb daemon status` 查看 root 级 freshness 诊断，使用 `cobweb daemon doctor` 检查 SQLite、schema 和 FTS/index 一致性。如果 doctor 报告 index drift，可以运行 `cobweb daemon repair`，或搜索受影响 root 触发对账。

## 本地信任模型

Cobweb 是本地单用户工具。默认数据目录是：

```bash
~/.local/share/cobweb
```

可以通过 `COBWEB_DATA_DIR`、`COBWEB_DB_PATH`、`COBWEB_SOCKET_PATH`、`COBWEB_LOCK_PATH` 和 `COBWEB_DAEMON_LOCK_PATH` 覆盖运行时路径。

对 `import --write`、`sync --write`、policy 更新和 `vendor --write` 这类写命令，Cobweb 会读写 CLI 或 MCP 客户端传入的路径。请只在可信工作区和可信 skill 目录上运行写命令。

daemon 会以 `0700` 创建数据目录，以 `0600` 创建 daemon lock 和 socket。绝对路径资源和外部资源会提示人工检查，不会被自动 vendor。

## 当前边界

Cobweb 当前聚焦本地治理和可解释路由。它有意不提供：

- 新的私有 skill 格式。
- 远端 registry、marketplace、TUI 或 Web UI。
- Embedding、向量检索、模型托管或外部 AI provider 调用。
- 持久化 SkillGraph 边。SkillGraph 是现场构建的只读快照。
- 对用户已有 skill 拓扑的默认 audit、risk 或 blocked 判断。
