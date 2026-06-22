# openCobweb

[English](./README.md) | 简体中文

<sub>许可证：[AGPL-3.0-only](./LICENSE)。</sub>

openCobweb 让 AI agent 在本机 `SKILL.md` 库中快速找到更匹配的 skill：它先用本地索引和匹配理由筛选候选，再按需加载选中的 skill 上下文。可以减少把整批 skill 全文塞进对话的 token 浪费。

## 为什么用 openCobweb

- 少手动解释：agent 可以通过 MCP 搜索本地 skill，再按需加载对应上下文。
- 少无关上下文：先选中候选 skill，再读取上下文，避免一开始就加载整批 skill 全文。
- 少重复维护：同一批 `SKILL.md` 可以用 CLI 检查、查重，并预览投射到 Cursor、Claude 等工具目录。
- 更容易排查：搜索结果会返回匹配理由，方便你判断 agent 为什么选中某个 skill。

## 运行要求

- Node.js `>= 22`

## 快速上手

### 1. 检查运行环境

openCobweb 要求 Node.js `>= 22`：

```bash
node --version
```

### 2. 配置 MCP 客户端

下面是 MCP 客户端配置，不是在终端中直接运行的命令。把它写入你的 MCP 客户端配置文件：

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "npx",
      "args": ["-y", "--package", "opencobweb", "cobweb-mcp"]
    }
  }
}
```

常见位置：

- **Cursor**：项目内的 `.cursor/mcp.json`，或全局 MCP 设置。
- **Claude Desktop**：`claude_desktop_config.json`（macOS：`~/Library/Application Support/Claude/`）。
- **其他 MCP 客户端**：任何接受标准 `mcpServers` 配置块的文件。

保存后重启 MCP 客户端。连接成功后，你的 agent 会看到 `skill_search`、`skill_select`、`skill_context` 等 Cobweb 工具。

### 3. 创建一个可测试的 skill

```bash
mkdir -p ./demo-skills/review-pr
cat > ./demo-skills/review-pr/SKILL.md <<'EOF'
---
name: review-pr
description: Review pull requests for correctness and risk.
---

# When to use

Use this skill when reviewing a pull request or checking a branch diff.

# Workflow

Input: repository diff.
Output: concise review findings.
Tools: git, tests.
EOF
```

### 4. 用 CLI 检查这个 skill

```bash
npx -y --package opencobweb cobweb scan ./demo-skills
npx -y --package opencobweb cobweb lint ./demo-skills/review-pr
npx -y --package opencobweb cobweb dedup ./demo-skills
```

### 5. 让 agent 使用它

在 MCP 客户端里对 agent 说：

```text
请使用 Cobweb 在 ./demo-skills 中查找适合 review pull request 的 skill。
```

agent 通常会先调用 `skill_select` 或 `skill_search`，再调用 `skill_context` 读取选中的 skill 上下文。

## 安装方式

上面的示例使用 `npx` 按需运行，无需安装。如果你经常在终端中使用 `cobweb`，可以全局安装：

```bash
npm install -g opencobweb
```

安装后可以直接运行：

```bash
cobweb scan ./demo-skills
cobweb lint ./demo-skills/review-pr
```

如果你希望 MCP 客户端也使用全局命令，可以把配置改成：

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

如果客户端找不到 `cobweb-mcp`，请确认全局 npm bin 目录在该客户端进程的 `PATH` 中；必要时把 `command` 改为 `cobweb-mcp` 的实际绝对路径。

## MCP 工具

| 工具 | 说明 |
| --- | --- |
| `skill_search` | 在已索引的 skill 上做全文搜索，返回候选项及每条命中的匹配理由。 |
| `skill_select` | 针对已分析的路由查询选出最合适的 skill，给出确定性分数明细和 SkillGraph 链路上下文；返回 `selectionStatus`，低置信结果仅为暂定候选，并附带 `guidance` 和待核查目标。 |
| `skill_context` | 返回某个 skill 的方法、资源、policy 和 lint 上下文——选定 skill 后、动手前应调用它。 |
| `skill_graph` | 从扫描根构建内存中的只读 SkillGraph 拓扑（扫描根、skill、资源、引用）。 |
| `skill_chain` | 在图中返回某个 skill 的根到 skill 路径、出/入引用以及其引用的资源。 |
| `skill_validate` | 用 lint、policy 和已索引的查重对 skill 做校验。 |
| `scan` | 只读地发现目录下的 `SKILL.md` skill。 |
| `status` | 返回 daemon 状态、索引新鲜度以及运行时/租约状态。 |

## 常用 CLI 命令

`cobweb` CLI 把 skill 作为受治理的资产库来管理。命令以 JSON 输出，便于在脚本中组合。常见流程：

```bash
# 发现目录下的 skill
npx -y --package opencobweb cobweb scan ./demo-skills

# lint 单个 skill
npx -y --package opencobweb cobweb lint ./demo-skills/review-pr

# 查找相近的重复 skill
npx -y --package opencobweb cobweb dedup ./demo-skills

# 把 skill 导入 canonical store（经由 daemon 写入）
npx -y --package opencobweb cobweb import ./demo-skills/review-pr --write --canonical ./canonical-skills

# 预览把 canonical skill 投射到各工具安装目录
npx -y --package opencobweb cobweb sync --target cursor,claude

# 查看运行时状态
npx -y --package opencobweb cobweb status
npx -y --package opencobweb cobweb daemon status
```

写入类命令（`import --write`、`sync --write`、`vendor --write`、`policy` 更新）经由 daemon 的 Writer Queue。只读命令（`scan`、`lint`、`dedup`、`graph`）无需 daemon 即可运行。`sync --write` 会写入目标工具目录，执行前请先确认目标目录和权限；上面的示例只保留预览命令。完整命令请运行 `npx -y --package opencobweb cobweb --help`。

## 配置项参考

openCobweb 把运行态集中在一个数据目录下。请为 MCP 客户端和 CLI 设置相同的 `COBWEB_DATA_DIR`，让它们共享同一个 daemon 和索引。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `COBWEB_DATA_DIR` | 索引、socket、lockfile 的基目录。 | `~/.local/share/cobweb` |
| `COBWEB_DB_PATH` | SQLite 索引路径。 | `$COBWEB_DATA_DIR/cobweb.db` |
| `COBWEB_SOCKET_PATH` | daemon IPC socket 路径。 | `$COBWEB_DATA_DIR/cobwebd.sock` |
| `COBWEB_LOCK_PATH` | canonical lockfile 路径。 | `$COBWEB_DATA_DIR/cobweb.lock.yaml` |
| `COBWEB_IDLE_TIMEOUT_MS` | daemon 空闲多久后自动退出。 | `600000` |

## 工作原理

`cobweb-mcp` 是本地 `cobwebd` 运行时的 stdio shim。MCP server 启动时会连接（或启动）单实例本地 daemon，打开一个运行时租约，并在 MCP 会话期间持续保活。只要仍有租约、请求、Writer Queue 任务或索引任务，daemon 就不会因空闲退出；MCP 会话断开且租约释放或过期后，daemon 回到正常的空闲退出策略。

daemon 是运行态的唯一持有者——SQLite 索引、Writer Queue 和文件 watcher。MCP server 与 CLI 都是它的客户端，从而保证写入单线程、索引一致。

## 许可证

[AGPL-3.0-only](./LICENSE)。
