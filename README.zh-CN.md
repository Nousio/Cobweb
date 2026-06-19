# openCobweb

[English](./README.md) | 简体中文

<sub>许可证：[AGPL-3.0-only](./LICENSE)。</sub>

openCobweb 是一个 MCP server，用于在支持 MCP 的客户端中使用本地 Agent Skills。

## 使用 npx

在 MCP 客户端配置中添加 openCobweb：

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

## 全局安装

如果你的 MCP 客户端不能通过 `npx` 运行包，可以先安装 openCobweb：

```bash
npm install -g opencobweb
```

然后配置 MCP 客户端运行已安装的命令：

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

## 运行时生命周期

`cobweb-mcp` 是本地 `cobwebd` 运行时的 stdio MCP client shim。MCP server 启动时会连接或启动单实例本地 daemon，随后打开运行时租约，并在 MCP 会话连接期间持续保活。只要仍有租约、请求、Writer Queue 任务或索引任务，daemon 就不会因空闲退出；MCP 会话断开且租约释放或过期后，daemon 会回到正常的空闲退出策略。

## 运行要求

openCobweb 要求 Node.js `>=22`。

更新 MCP 配置后，重启你的 MCP 客户端。
