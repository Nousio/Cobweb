# openCobweb

[English](./README.md) | 简体中文

许可证：[AGPL-3.0-only](./LICENSE)。

openCobweb 让 AI agent 在本机 `SKILL.md` 库中快速找到更匹配的 skill。不必把整批 skill 全文塞进对话，agent 先在本地索引里搜索、匹配对应skill并给出匹配理由，再按需只加载选中的 skill 的上下文。可以减少把整批 skill 全文塞进对话的 token 浪费。

## 为什么用 openCobweb

- 少手动解释：agent 可以通过 MCP 搜索本地 skill，再按需加载对应上下文。
- 少无关上下文：先选中候选 skill，再读取上下文，避免一开始就加载整批 skill 全文。
- 少重复维护：同一批 `SKILL.md` 可以用 CLI 检查、查重，并预览投射到 Cursor、Claude 等工具目录。
- 更容易排查：搜索结果会返回匹配理由，方便你判断 agent 为什么选中某个 skill。

## 运行要求

- Node.js `>= 22`（用 `node --version` 确认）

## 快速上手：推荐用 npx

大多数用户只需要这一种方式：**不用全局安装，直接在 MCP 配置里用 `npx` 启动 `cobweb-mcp`**。先按下面三步做，配置完成后再看是否需要后面的「可选：全局安装」。

### 1. 确认 Node.js

```bash
node --version
```

输出 `v22` 或更高即可。否则请先安装 Node 22+。

### 2. 把 Cobweb 加进 MCP 客户端

直接复制这个样例,把 `/Users/you/skills` 换成你的 skill 目录即可。这里用的是推荐方案：`npx` 按需下载并运行 npm 包里的 `cobweb-mcp`。

这是**客户端配置**，不是在终端里运行的命令。打开客户端的 MCP 配置文件，在 `mcpServers` 里加上 `cobweb` 块：

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "opencobweb",
        "cobweb-mcp",
        "--path",
        "/Users/you/skills"
      ]
    }
  }
}
```

多路径配置示例：

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "opencobweb",
        "cobweb-mcp",
        "--path",
        "/Users/you/work-skills",
        "/Users/you/personal-skills"
      ]
    }
  }
}
```

配置文件位置：

- **Cursor**：项目内的 `.cursor/mcp.json`，或对所有项目生效的 `~/.cursor/mcp.json`
- **Claude Desktop**：`claude_desktop_config.json`（macOS：`~/Library/Application Support/Claude/`）
- **其他客户端**：任何接受标准 `mcpServers` 配置块的文件

各字段含义：


| 字段                         | 含义                                    |
| -------------------------- | ------------------------------------- |
| `command: "npx"`           | 不全局安装，直接运行包里的可执行文件。                   |
| `-y`                       | 自动确认首次下载，避免客户端卡在确认提示上。                |
| `--package opencobweb`     | 要拉取的 npm 包。因为可执行文件名和包名不同，所以必须显式指定。    |
| `cobweb-mcp`               | 要在该包里启动的可执行文件——这是 MCP server（不是 CLI）。 |
| `--path /Users/you/skills` | 指定这个 MCP server 默认服务的 skill 目录。       |


> 如果想固定版本而不是每次拉最新，把参数写成 `"--package", "opencobweb@0.4.3"` 即可，@0.4.3 代表 0.4.3 版本。

### 3. 重启客户端，确认工具出现

重启（或重新加载）MCP 客户端。Cobweb 的工具（`skill_search`、`skill_select`、`skill_context` 等）应该会出现在客户端的 MCP/工具列表里。首次启动可能要等几秒，`npx` 在下载包。

到这里 Cobweb 已经安装并配置完成。之后 agent 调用 `scan`、`skill_search`、`skill_select` 时,如果没有显式传 `path`,Cobweb 会使用你在 MCP 配置里写的 `--path` 目录。

支持 MCP server instructions 的客户端（例如 Cursor）会把"何时、如何使用这些工具"呈现出来，agent 因此能自己想到用 Cobweb，不需要再手动加一条 rule。

## 可选：全局安装

这一节不是必选。已经按上面的 `npx` 配置好 MCP 客户端后，可以直接跳过。只有在你经常手动运行 `cobweb` CLI、希望命令更短时，才建议全局安装。

```bash
npm install -g opencobweb
```

安装后可以在终端中直接运行：

```bash
cobweb scan ./skills
cobweb lint ./skills/some-skill
```

如果你也想让 MCP 客户端使用全局安装的命令，可以把 MCP 配置改成下面这样：

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

如果客户端报告找不到 `cobweb-mcp`，说明全局 npm bin 目录不在该客户端进程的 `PATH` 中。要么修好客户端的 `PATH`，要么把 `command` 改成该可执行文件的绝对路径（用 `which cobweb-mcp` 查）。

简单判断：

- **只想把 Cobweb 接入 Cursor/Claude 等 MCP 客户端**：用上面的推荐 `npx` 配置，不需要全局安装。
- **经常在终端里手动跑 `cobweb scan`、`cobweb lint`**：可以全局安装，让 CLI 命令更短。

## 日常使用

如果只是想从终端确认目录能被识别，可以运行：

```bash
npx -y --package opencobweb cobweb scan /Users/you/skills
```

### 配置一个或多个 skill 目录

在一个 `--path` 后面直接列出多个目录(目录数组),即可让同一个 MCP server 服务多个 skill 目录：

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "opencobweb",
        "cobweb-mcp",
        "--path",
        "/Users/you/work-skills",
        "/Users/you/personal-skills"
      ]
    }
  }
}
```

如果你更习惯,也可以重复写多个 `--path`,两种写法等价。

配置了一个或多个 `--path` 后,`scan`、`skill_search`、`skill_select` 可以省略工具参数里的 `path`；多目录时 Cobweb 会分别查询这些目录并合并候选。

需要注意: `skill_context` 读取的是某一个具体 skill 的上下文,所以仍然需要传选中 skill 的路径。通常流程是先 `skill_select`,再把返回的 `selected.path` 传给 `skill_context`。

如果配置里写了 `--path` 但值为空,`cobweb-mcp` 会直接报错退出、不启动服务,这样配置错误会立刻在客户端暴露,而不是跑起一个没有 skill 目录的服务。

CLI 可以在每条命令里指定目录,例如：

```bash
npx -y --package opencobweb cobweb scan /Users/you/skills
npx -y --package opencobweb cobweb dedup /Users/you/skills
npx -y --package opencobweb cobweb graph /Users/you/skills
```

CLI 命令的目录参数只对当前这条命令生效,不会修改 MCP 配置。

## 试用验证（可跳过，仅用于测试）

这一节只是用一个临时 skill 验证配置是否生效。它不是正式使用步骤；如果你已经有自己的 skill 目录，可以直接跳过。

### 创建一个演示 skill

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

### CLI 检查

```bash
npx -y --package opencobweb cobweb scan ./demo-skills
npx -y --package opencobweb cobweb lint ./demo-skills/review-pr
```

### 指定 agent 调用mcp

```text
请使用 Cobweb 在 ./demo-skills 中查找适合 review pull request 的 skill。
```

agent 通常会先调用 `skill_select`（或 `skill_search`）选出 skill，再调用 `skill_context` 读取它的详细内容。如果你的客户端工作目录不明确，请用绝对路径。

## MCP 工具

连接成功后，agent 可以调用这些工具。除特别说明外，每个工具都接收一个目录 `path`（包含 skill 的扫描根）；跨客户端时用绝对路径最稳妥。


| 工具               | 作用                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `skill_search`   | 在已索引的 skill 上做全文搜索，返回候选项及每条命中的匹配理由。                                                                        |
| `skill_select`   | 针对已分析的路由查询选出最合适的 skill，给出确定性分数明细和 SkillGraph 链路上下文；返回 `selectionStatus`，低置信结果仅为暂定候选，并附带 `guidance` 和待核查目标。 |
| `skill_context`  | 返回某个 skill 的方法、资源、policy 和 lint 上下文。                                                                       |
| `skill_graph`    | 从扫描根构建内存中的只读 SkillGraph 拓扑。                                                                                |
| `skill_chain`    | 在图中返回某个 skill 的根到 skill 路径、引用关系和引用的资源。                                                                     |
| `skill_validate` | 用 lint、policy 和已索引的查重对 skill 做校验。                                                                          |
| `scan`           | 只读地发现目录下的 `SKILL.md` skill。                                                                                |
| `status`         | 返回 daemon 状态、索引新鲜度以及运行时/租约状态。                                                                              |


## CLI 命令

`cobweb` CLI 把 skill 作为受治理的资产库来管理，并以 JSON 输出。最常用的命令：


| 命令                    | 用途                                           |
| --------------------- | -------------------------------------------- |
| `cobweb scan [path]`  | 列出目录下的 `SKILL.md` skill。只读。                  |
| `cobweb lint [skill]` | 检查单个 skill 的结构和内容问题。                         |
| `cobweb dedup [path]` | 查找目录下相近的重复 skill。                            |
| `cobweb status`       | 查看 daemon 状态和索引新鲜度（`--readonly` 可跳过 daemon）。 |
| `cobweb sync`         | 把 skill 投射到工具目录（Cursor、Claude 等）。默认仅预览。      |


`scan`、`lint`、`dedup` 是只读命令，无需 daemon 即可运行。会改动文件的命令（如 `sync --write`、`import --write`）经由 daemon 的 Writer Queue。`sync` 默认只预览，加 `--write` 才真正写入，执行前请先确认目标路径和权限：

```bash
# 预览哪些 provider 会收到哪些 skill
npx -y --package opencobweb cobweb sync --target cursor,claude

# 可选 provider：agents、cursor、claude、codex
```

完整命令请运行 `cobweb --help`（或 `npx -y --package opencobweb cobweb --help`）。

## 配置项参考

Cobweb 把运行态集中在一个数据目录下。默认是 `~/.local/share/cobweb`，而且 **MCP server 和 CLI 都会自动使用这同一个默认值**——所以开箱即用时它们本就共享同一个 daemon 和索引，你无需设置任何东西。

只有当你想换一个自定义位置（例如按项目隔离）时才需要用到下面这些变量。一旦设置，请在 **MCP 客户端和你的 shell 中设成同一个值**，否则两个客户端会指向不同的数据目录。


| 变量                       | 控制什么                     | 默认值                                 |
| ------------------------ | ------------------------ | ----------------------------------- |
| `COBWEB_DATA_DIR`        | 索引、socket、lockfile 的基目录。 | `~/.local/share/cobweb`             |
| `COBWEB_DB_PATH`         | SQLite 索引路径。             | `$COBWEB_DATA_DIR/cobweb.db`        |
| `COBWEB_SOCKET_PATH`     | daemon IPC socket 路径。    | `$COBWEB_DATA_DIR/cobwebd.sock`     |
| `COBWEB_LOCK_PATH`       | canonical lockfile 路径。   | `$COBWEB_DATA_DIR/cobweb.lock.yaml` |
| `COBWEB_IDLE_TIMEOUT_MS` | daemon 空闲多久后自动退出（毫秒）。    | `600000`（10 分钟）                     |


要使用自定义数据目录，在 MCP 配置里加 `env`，并在 shell 里 export 同一个值：

```json
{
  "mcpServers": {
    "cobweb": {
      "command": "npx",
      "args": ["-y", "--package", "opencobweb", "cobweb-mcp"],
      "env": {
        "COBWEB_DATA_DIR": "/Users/you/.local/share/cobweb"
      }
    }
  }
}
```

```bash
export COBWEB_DATA_DIR="/Users/you/.local/share/cobweb"
```

## 工作原理

`cobweb-mcp` 会连接（或启动）单实例本地 `cobwebd` daemon，并为本次 MCP 会话打开一个运行时租约，在会话期间持续保活。daemon 是运行态的唯一持有者——SQLite 索引、Writer Queue 和文件 watcher；MCP server 与 CLI 都是它的客户端。MCP 会话断开、租约过期后，daemon 回到正常的空闲退出策略（`COBWEB_IDLE_TIMEOUT_MS`）。

## 常见问题排查

- **客户端报找不到 `cobweb-mcp`。** 用 `npx` 配置时不应出现，请确认 `command` 是 `npx`。用全局安装时，是客户端进程的 `PATH` 缺了 npm bin 目录——改用 `which cobweb-mcp` 得到的绝对路径。
- **首次启动很慢或超时。** `npx` 正在下载包。先在终端跑一次 `npx -y --package opencobweb cobweb --version`，再重连客户端。
- **报 `node: command not found` 或版本错误。** 确认已安装 Node `>= 22`，且客户端能看到它（GUI 应用未必继承你的 shell `PATH`）。
- **CLI 和 agent 结果对不上。** 它们用了不同的数据目录。要么各处都不设 `COBWEB_DATA_DIR`（推荐），要么在 MCP 配置和 shell 里设成完全一样的值。
- **工具返回空结果。** 确认你传的 `path` 里确实有 `SKILL.md` 文件，可以尝试用绝对路径。

## 许可证

[AGPL-3.0-only](./LICENSE)。