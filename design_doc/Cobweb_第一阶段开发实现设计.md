# Cobweb 第一阶段开发实现设计

> 命名：产品 `Cobweb`｜CLI `cobweb`（短别名 `cw`）｜daemon `cobwebd`｜MCP `Cobweb MCP`｜配置 `cobweb.config.yaml`｜锁文件 `cobweb.lock.yaml`｜本地库 `cobweb.db`。

## 0. 阶段目标

第一阶段目标是交付 **本地治理内核**，不做完整智能路由，不做团队 registry，不做 Web UI。阶段一必须把稳定地基打好：

- `cobwebd` daemon：按需启动、短期保温、空闲自退。
- SQLite(WAL) 状态库：可重建、单写者、支持 status/dedup/audit/sync。
- `cobweb` CLI：用户操作入口。
- 标准目录和任意目录扫描。
- `SKILL.md` 解析、校验、审计、重复检测、越界引用检测。
- canonical store、`cobweb.lock.yaml`、可移植 provenance、`.agents/skills/` 投射。
- daemon 不可用时的只读快照降级。

第一阶段不交付（但需预留 seam，不堵死后续）：

- 完整 Cobweb MCP 路由排序（阶段二）。
- Method 抽取与 FTS5（阶段二）。
- embedding 与语义召回（阶段三，确定要做，本阶段只预留接口与表迁移位）。
- TUI / Web UI、团队 registry（阶段四）。
- 自动正文合并、完整脚本沙箱执行。

## 1. 工程结构

```text
cobweb/
  packages/
    core/
      src/
        audit/
        db/
        dedup/
        parser/
        policy/
        providers/
        runtime/
        sync/
        vendor/
        writer/
        embedding/      # 阶段三实现，阶段一只放接口占位
    daemon/
      src/
        app-state/
        ipc/
        supervisor/
    cli/
      src/
        commands/
        output/
    mcp/
      src/
        shim/
  examples/
    skills/
  docs/
  cobweb.config.example.yaml
```

模块边界：

- `core`：纯业务逻辑，不能依赖 CLI 展示，也不能依赖 MCP SDK。
- `daemon`：持有 SQLite 写连接、Writer Queue、运行态和本地 IPC。
- `cli`：解析命令、调用 daemon、格式化输出。
- `mcp`：第一阶段只保留 shim 骨架和协议占位，不持有重状态。
- `core/embedding`：阶段一只定义 `EmbeddingProvider` 接口与空实现，阶段三填充。

## 2. 运行模式

### 2.1 daemon 模式

`cobwebd` 是本地单实例、按需常驻进程。

生命周期：

1. CLI/MCP 发现 daemon 不在。
2. CLI/MCP 尝试启动 daemon。
3. daemon 初始化 SQLite、加载配置、建立 IPC。
4. daemon 处理请求并刷新 idle 计时。
5. 5-15 分钟无请求、无后台任务、无 watcher 事件后自动退出。

第一阶段默认不做开机自启。

### 2.2 CLI 降级模式

读命令在 daemon 不可用时可降级：

- `status --readonly`
- `scan --dry-run`
- `dedup --readonly`
- `audit --readonly`

写命令不能绕过 daemon 直接写库：

- `import`
- `sync`
- `policy`
- `vendor --fix`
- `install`

写命令在 daemon 启动失败时必须失败并给出修复建议。

## 3. CLI 命令契约

### 3.1 daemon

```bash
cobweb daemon start
cobweb daemon stop
cobweb daemon status --json
cobweb daemon doctor
```

要求：

- `start`：启动本地单实例；若已运行，返回当前 pid/socket。
- `stop`：优雅退出，等待 Writer Queue 清空。
- `status`：输出 pid、socket、db path、freshness、pending jobs、last error。
- `doctor`：检查 socket、SQLite、lockfile、provider 路径和 watcher 状态。

### 3.2 scan / import

```bash
cobweb scan [path] --json
cobweb import <path> [--dry-run] [--canonical ~/skills]
```

`scan` 输出：

```json
{
  "candidates": [
    {
      "path": "/repo/.agents/skills/review",
      "kind": "skill_dir",
      "name": "review",
      "description": "Review code changes",
      "risk_level": "low",
      "duplicate_of": null
    }
  ],
  "warnings": []
}
```

要求：

- `scan` 只读，不写 SQLite，除非显式 `--record` 后走 daemon。
- `import` 默认 dry-run。
- 真实导入必须记录 provenance、content_hash、canonical_path，并把可移植 provenance 写回 frontmatter。

### 3.3 lint / audit

```bash
cobweb lint [skill] [--fix]
cobweb audit [skill] [--strict]
cobweb doctor [--fix]
```

`lint` 检查：

- `SKILL.md` 是否存在。
- frontmatter 是否有 `name`、`description`。
- `description` 是否过长。
- 正文是否过长。
- 资源引用是否存在。

`audit` 检查：

- scripts/hooks 中的危险命令。
- 外部下载、`curl | sh`、权限提升。
- 凭据读取、secret、private key。
- 绝对路径和越界相对路径。
- 未知来源和缺失 provenance。
- 优先复用成熟扫描规则（YARA/静态规则），减少自研误报。

### 3.4 dedup / merge

```bash
cobweb dedup [--threshold 0.85] [--json]
cobweb merge <source-skill> <target-skill> [--dry-run]
```

第一阶段只做合并计划，不自动合并正文。

重复检测优先级：

1. `content_hash` 完全一致。
2. `name` 完全一致。
3. `name + description` 相似（词面）。
4. heading / method summary 相似（词面）。

> 阶段三接入 embedding 后，新增“语义近重复”作为第 5 级信号，捕捉“措辞不同但语义重复”的 skill。

### 3.5 sync / status

```bash
cobweb sync [--target agents,cursor,claude,codex] [--link|--copy] [--dry-run]
cobweb status [--provider cursor] [--json]
```

`sync` 要求：

- 默认 dry-run。
- `.agents/skills/` 是主投射落点。
- link 优先；copy 必须写入来源 hash。
- 写入流程：临时路径 → 原子替换 → 写后校验 → 记录结果。
- 部分失败不能静默吞掉，必须在 `status` 标记漂移。

`status` 输出：

```json
{
  "db": { "freshness": "fresh", "path": ".../cobweb.db" },
  "daemon": { "running": true, "pid": 12345 },
  "skills": [
    {
      "name": "review",
      "canonical_path": "...",
      "providers": ["agents", "cursor"],
      "drift": false,
      "risk_level": "low"
    }
  ]
}
```

### 3.6 policy / vendor

```bash
cobweb policy <skill> --implicit on|off
cobweb policy check
cobweb vendor <skill> [--dry-run]
```

要求：

- `policy check` 检查 Cursor frontmatter 与 Codex sidecar 是否等价。
- `vendor --dry-run` 输出外部引用、目标路径和重写计划。
- `vendor` 真正写入必须走 Writer Queue，并保留原文件 hash。

## 4. daemon IPC

第一阶段推荐使用本地 JSON-RPC 风格协议。

Unix/macOS：

- Unix domain socket。

Windows 或兼容场景：

- `127.0.0.1` loopback + 随机 token。

请求示例：

```json
{
  "id": "req-1",
  "method": "scan",
  "params": {
    "path": "/repo",
    "dry_run": true
  }
}
```

响应示例：

```json
{
  "id": "req-1",
  "ok": true,
  "result": {}
}
```

错误格式：

```json
{
  "id": "req-1",
  "ok": false,
  "error": {
    "code": "SQLITE_BUSY_TIMEOUT",
    "message": "Writer queue timed out",
    "retryable": true
  }
}
```

## 5. SQLite 设计

### 5.1 PRAGMA

daemon 打开数据库后必须执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

### 5.2 基础表

第一阶段最小表：

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  root_path TEXT NOT NULL,
  canonical_path TEXT,
  source_type TEXT NOT NULL,
  provenance_json TEXT,
  paths_json TEXT,
  implicit_invocation INTEGER,
  self_contained INTEGER,
  trust_level TEXT,
  risk_level TEXT,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  path TEXT NOT NULL,
  is_external INTEGER NOT NULL,
  risk_flags_json TEXT,
  content_hash TEXT,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE TABLE provider_installs (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  install_path TEXT NOT NULL,
  projection_strategy TEXT NOT NULL,
  content_hash TEXT,
  drift INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE TABLE audit_results (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  audited_at TEXT NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE runtime_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

阶段二增加 `methods` 与 FTS5 表；阶段三增加 `skill_vectors` 表。为此第一阶段必须建立 `schema_migrations` 版本表，保证后续平滑迁移，不需要推倒重建。

### 5.3 写入纪律

- 所有写入只允许 daemon Writer Queue 执行。
- 每个写任务使用事务。
- `content_hash` 相同则跳过重复解析。
- 批量任务可分块提交，避免长事务阻塞读。
- 定期 `wal_checkpoint(RESTART)`。

## 6. Parser 实现

输入：

- skill 根目录。
- `SKILL.md` 内容。
- 可选 sidecar，例如 `agents/openai.yaml`。

输出：

```ts
interface ParsedSkill {
  name: string
  description: string
  rootPath: string
  frontmatter: Record<string, unknown>
  rawFrontmatter: string
  sections: ParsedSection[]
  resources: ParsedResource[]
  policy: ParsedPolicy
  contentHash: string
}
```

实现要求：

- 用 `gray-matter` 解析 frontmatter。
- 用 `unified` + `remark-parse` 解析 Markdown AST。
- 资源引用检测必须识别相对路径、绝对路径、`../` 越界引用。
- 解析失败不能导致整个扫描中断；记录 warning 并继续。

## 7. Provider 实现

Provider 接口：

```ts
interface Provider {
  name: string
  detectGlobalPaths(ctx: RuntimeContext): string[]
  detectProjectPaths(projectRoot: string): string[]
  supportsAgentsDir: boolean
  policyMapping: PolicyMapping
  project(skill: CanonicalSkill, target: ProjectionTarget): ProjectionPlan
}
```

第一阶段内置：

- `AgentsProvider`：`.agents/skills/`
- `CursorProvider`：`.cursor/skills/` 或 `.agents/skills/` 兼容
- `ClaudeProvider`：`.claude/skills/`
- `CodexProvider`：`.agents/skills/` + sidecar policy
- `GenericProvider`：用户配置路径

## 8. Embedding 接口占位（阶段一只定义，不实现）

为保证阶段三平滑接入，阶段一先固化接口与边界，不写实现：

```ts
interface EmbeddingProvider {
  readonly model: string
  readonly dim: number
  embed(texts: string[]): Promise<Float32Array[]>
}

// 阶段一默认空实现：返回未启用，路由与 dedup 不依赖它
class NoopEmbeddingProvider implements EmbeddingProvider { /* disabled */ }
```

约束：

- 阶段一/二的 dedup、router、validate 不得硬依赖 embedding，必须在“无向量”下完整可用。
- 阶段三接入后，embedding 只作为额外召回与相似度信号，不改变既有硬过滤与降权规则。
- 嵌入对象先限定 `name + description + method summary`，按 `content_hash` 增量。

## 9. Writer Queue

Writer Queue 职责：

- 串行化所有写任务。
- 给任务分配 id 和状态。
- 提供 pending/running/done/failed 查询。
- 支持 daemon stop 前 drain。
- 支持失败重试和幂等重放。

任务类型：

- `ImportSkill`
- `UpdateSkill`
- `WriteAuditResult`
- `SyncProjection`
- `UpdatePolicy`
- `VendorResource`
- `CheckpointWal`
- `EmbedSkill`（阶段三启用，阶段一登记类型占位）

## 10. 故障恢复

### 10.1 daemon 崩溃

1. CLI/MCP 连接失败。
2. 尝试惰性重启 daemon。
3. 重启成功后继续执行。
4. 重启失败时，读命令降级只读快照；写命令失败。

### 10.2 SQLite 损坏

1. `daemon doctor` 执行 `PRAGMA integrity_check`。
2. 失败后备份坏库。
3. 从 canonical skill 文件与 `cobweb.lock.yaml` 重建。
4. 重建完成后恢复 status。

### 10.3 sync 中断

- 写临时路径。
- 原子替换。
- 写后校验 hash。
- 失败时清理临时文件。
- `status` 显示漂移和修复建议。

## 11. 安全策略

第一阶段只做静态审计，不执行脚本沙箱。

风险等级：

- `low`：标准 skill，无危险脚本，无越界引用。
- `medium`：存在脚本、外链或未知来源。
- `high`：存在危险命令、凭据读取、外部下载执行、越界写入。
- `blocked`：命中 blocklist 或明确恶意模式。

默认策略：

- `high` / `blocked` 不进入自动路由候选。
- `install/import` 时必须提示风险。
- `audit --strict` 遇到 high 直接非零退出。

## 12. 开发里程碑

### M1：项目骨架

- monorepo 结构。
- TypeScript、lint、test。
- CLI 入口。
- core 包基础类型 + `EmbeddingProvider` 接口占位。

验收：

- `cobweb --help` 可运行。
- 单元测试能运行。

### M2：Parser 与 Scan

- `SKILL.md` 解析。
- 标准目录扫描。
- 任意目录扫描。
- JSON 输出。

验收：

- 能识别 examples 下的 skill。
- 解析失败不影响整体扫描。

### M3：SQLite 与 daemon

- SQLite 初始化 + `schema_migrations`。
- Writer Queue。
- daemon start/status/stop。
- IPC 基础协议。

验收：

- CLI 可启动 daemon。
- 写任务只通过 Writer Queue。
- WAL 与 `busy_timeout` 生效。

### M4：Import / Status / Dedup

- `import --dry-run`。
- 真实导入 + 可移植 provenance 写回。
- `status`。
- 同名与 hash 重复检测。

验收：

- 导入后 SQLite 可查询。
- 重复 skill 能被报告。

### M5：Audit / Vendor / Policy

- lint 和 audit（含复用扫描规则）。
- 越界引用检测。
- `vendor --dry-run`。
- `policy check`。

验收：

- 能检测 `../` 越界引用。
- 能标记 high risk。

### M6：Sync / Projection

- `.agents/skills/` 投射。
- provider 抽象。
- link/copy。
- 漂移检测。

验收：

- canonical skill 可投射到 `.agents/skills/`。
- 人工修改投射副本后 `status` 能标记 drift。

### M7：降级与稳定性

- daemon 崩溃后惰性重启。
- 只读快照降级。
- WAL checkpoint。
- `daemon doctor`。

验收：

- kill daemon 后读命令可恢复或降级。
- 并发 CLI 操作不出现未处理的 `SQLITE_BUSY`。

## 13. 测试计划

单元测试：

- frontmatter 解析。
- Markdown section 抽取。
- 资源引用检测。
- provider path 检测。
- audit 规则。
- dedup 规则。

集成测试：

- 扫描 examples。
- import 到 SQLite。
- sync 到临时 `.agents/skills/`。
- status 漂移检测。
- daemon start/stop/status。
- writer queue 并发写。
- schema 迁移：旧版本库可升级到当前版本。

回归样例：

- 缺 `description`。
- description 过长。
- 同名不同内容。
- 内容 hash 相同。
- `../` 越界引用。
- 绝对路径引用。
- 含危险脚本。
- provider 目录不可写。

## 14. 第一阶段完成标准

第一阶段完成时，应满足：

- 目录中至少有 5 个 example skills 覆盖正常、重复、越界、高风险、策略差异。
- `cobweb scan/import/status/lint/audit/dedup/sync/policy/vendor/daemon` 可用。
- SQLite 可删库重建，且 `schema_migrations` 支持向后迁移。
- daemon 可惰性启动、idle 退出、崩溃后恢复。
- `.agents/skills/` 投射可用。
- `EmbeddingProvider` 接口与 `EmbedSkill` 任务类型已占位，阶段三可零改造接入。
- 架构文档中的第一阶段验收指标全部可手动或自动验证。
