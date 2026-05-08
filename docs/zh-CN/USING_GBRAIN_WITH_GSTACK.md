# 在 GStack 中使用 GBrain

你的编程智能体，带着它真正保留的记忆。

[GBrain](https://github.com/garrytan/gbrain) 是专为 AI 智能体设计的持久知识库。它存储智能体学到的东西、你做出的决定、什么有效什么无效，并让智能体随时搜索这一切。GStack 为你提供从零到"gbrain 正在运行，我的智能体可以调用它"的一命令路径——有本地试用、团队共享等各种场景的路径。

这是全面指南：每个场景、每个参数、每个辅助工具、每个故障排除步骤。快速概述请参阅 [README 的 GBrain 章节](README.md#gbrain——你的编程智能体的持久知识库)。错误代码和同步相关问题请参阅 [docs/gbrain-sync.md](docs/gbrain-sync.md)。

---

## 一命令安装

```bash
/setup-gbrain
```

就是这样。技能会检测你的当前状态，最多问三个问题，然后引导你完成安装、初始化、Claude Code 的 MCP 注册和每仓库信任策略。在全新的 Mac 上不到五分钟完成。在已经部分设置的 Mac 上只需几秒钟（它会检测现有状态并跳过已完成的工作）。

## 三条路径

当技能询问"你的 brain 应该存在哪里？"时，你选择一条路径。

### 路径 1：Supabase，你已有一个连接字符串

最适合：你（或队友的云智能体）已经配置了一个 Supabase brain，你想让这台本机使用同样的数据。

**发生什么：** 粘贴 Session Pooler URL（设置 → 数据库 → 连接池 → 会话 → 复制 URI，端口 6543）。技能以 echo 关闭的方式读取它，向你显示脱敏预览（`aws-0-us-east-1.pooler.supabase.com:6543/postgres`——主机可见，密码掩码），通过 `GBRAIN_DATABASE_URL` 环境变量将其交给 `gbrain init`，URL 永远不会出现在 argv 或你的 shell 历史记录中。

**信任警告：** 粘贴此 URL 会让你的本地 Claude Code 对共享 brain 中的每个页面具有完全读写访问权。如果这不是你想要的信任级别，请选择 PGLite 本地（路径 3），接受 brain 是独立的。

### 路径 2a：Supabase，自动配置新项目

最适合：全新的 Supabase 账户，你想要一个干净的新项目，无需点击。

**发生什么：** 你粘贴 Supabase Personal Access Token（PAT）。技能首先向你展示权限披露——*该令牌授予对你 Supabase 账户中每个项目的完全访问权，而不仅仅是我们即将创建的那个*。它列出你的组织，询问选择哪个以及哪个地区（默认 `us-east-1`），生成数据库密码，调用 `POST /v1/projects`，每 5 秒轮询 `GET /v1/projects/{ref}` 直到项目变为 `ACTIVE_HEALTHY`（180 秒超时），获取 pooler URL，将其交给 `gbrain init`。端到端：约 90 秒。

最后：明确提醒你在 https://supabase.com/dashboard/account/tokens 吊销 PAT。技能已经从内存中丢弃了它。

**如果你在配置中途 Ctrl-C：** SIGINT 陷阱会打印你的进行中项目 ref + 一个恢复命令。你可以在 Supabase 仪表板删除孤立项目，或运行 `/setup-gbrain --resume-provision <ref>` 从中断处继续。

### 路径 2b：Supabase，手动创建

最适合：你宁愿自己点击 supabase.com 而不是粘贴 PAT。

**发生什么：** 技能引导你完成四个手动步骤（注册 → 新建项目 → 等待约 2 分钟 → 复制 Session Pooler URL），然后从路径 1 的粘贴步骤接管。与路径 1 的安全处理方式相同。

### 路径 3：PGLite 本地

最适合：先试用、无账号、无云、无共享。或者专门用于"这台 Mac 的 brain"，与任何云智能体隔离。

**发生什么：** `gbrain init --pglite`。Brain 位于 `~/.gbrain/brain.pglite`。无网络调用。30 秒完成。

这是最好的首选方案，如果你只是想先感受一下 gbrain 再决定是否使用云。你随时可以用 `/setup-gbrain --switch` 迁移到 Supabase。

## Claude Code 的 MCP 注册

默认情况下，技能会询问"为 gbrain 提供一个 Claude Code 的类型化工具表面？"如果你说是，它会运行：

```bash
claude mcp add gbrain -- gbrain serve
```

这会将 gbrain 的 stdio MCP 服务器注册到 Claude Code。现在 `gbrain search`、`gbrain put_page`、`gbrain get_page` 等功能在每个会话中以一等类型化工具出现，而不是 bash shell 调用。

**如果 `claude` 不在 PATH 中**，技能会优雅地跳过 MCP 注册，并给出手动注册提示。CLI 解析器仍然可以从任何通过 shell 调用 `gbrain` 的技能中使用——MCP 是升级，不是前提条件。

**其他本地智能体**（Cursor、Codex CLI 等）需要自己的 MCP 注册。技能针对 Claude Code 作为 v1 的目标；其他宿主可以在其自己的 MCP 配置中手动注册 `gbrain serve`。

## 每远程信任策略（三元组）

你机器上的每个仓库都有一个策略决定：**读写**、**只读**或**拒绝**。

- **read-write（读写）** — 你的智能体可以从这个仓库的上下文中 `gbrain search`，也可以将新页面写回 brain。适合你自己的项目。
- **read-only（只读）** — 你的智能体可以搜索 brain，但不能从这个仓库的会话中写入新页面。对于多客户顾问来说是理想的：搜索共享 brain，不要在你处于客户 B 仓库时用客户 A 的代码污染它。
- **deny（拒绝）** — 完全不与 gbrain 交互。该仓库对 gbrain 工具不可见。

技能在你第一次在那里运行 gstack 技能时对每个仓库询问一次。之后决定是粘性的——同一 git 远程的每个工作树 + 分支共享同样的策略，所以你设置一次，它就跟随你。

SSH 和 HTTPS 远程变体折叠为同一个键：`https://github.com/foo/bar.git` 和 `git@github.com:foo/bar.git` 是同一个仓库。

**要更改策略：**

```bash
/setup-gbrain --repo      # 仅对当前仓库重新提示

# 或直接：
~/.claude/skills/gstack/bin/gstack-gbrain-repo-policy set "github.com/foo/bar" read-only
```

**查看每个策略：**

```bash
~/.claude/skills/gstack/bin/gstack-gbrain-repo-policy list
```

存储：`~/.gstack/gbrain-repo-policy.json`，模式 0600，schema 版本化，以便未来迁移保持确定性。

## 之后切换引擎

选了 PGLite 现在想加入团队 brain？一个命令：

```bash
/setup-gbrain --switch
```

技能在 `timeout 180s` 包装下运行 `gbrain migrate --to supabase --url "$URL"`。迁移是双向的（Supabase → PGLite 也可以）且无损——页面、块、嵌入、链接、标签和时间轴都会复制。你的原始 brain 被保留为备份。

**如果迁移卡住：** 另一个 gstack 会话可能持有源 brain 的锁。超时在 3 分钟后触发，并给出可操作的提示。关闭其他工作区然后重新运行。

## GStack 记忆同步（一个独立的关注点）

这与 gbrain 本身不同。你的 gstack 状态（`~/.gstack/` — 学习内容、计划、回顾、时间轴、开发者档案）默认在机器上是本地的。"GStack 记忆同步"选择性地将一个经过筛选、扫描过秘密的子集推送到私有 git 仓库，使你的记忆跟随你跨机器——如果你使用 gbrain，该 git 仓库也可以在那里建立索引。

通过以下方式启用：

```bash
gstack-brain-init
```

你会得到一次性隐私提示：**所有内容允许列表** / **仅产物**（计划、设计、回顾、学习内容——跳过时间轴等行为数据）/ **关闭**。每次技能运行都会在开始和结束时同步队列——没有守护进程，没有后台进程。

有秘密形状的内容（AWS 密钥、GitHub 令牌、PEM 块、JWT、Bearer 令牌）在离开你的机器之前被阻止同步。

**在新机器上：** 将 `~/.gstack-brain-remote.txt` 复制过来，运行 `gstack-brain-restore`，昨天在另一台机器上的学习内容就会出现在今天的笔记本上。

完整指南：[docs/gbrain-sync.md](docs/gbrain-sync.md)。错误索引：[docs/gbrain-sync-errors.md](docs/gbrain-sync-errors.md)。

`/setup-gbrain` 在初始安装结束时提供为你配置这个——又是一个 AskUserQuestion，它与同样的私有仓库基础设施集成。

## 清理孤立项目

如果你在配置中途 Ctrl-C 了，在决定名称前尝试了三个不同的名称，或者以其他方式积累了你不再使用的 gbrain 形状的 Supabase 项目，有一个子命令：

```bash
/setup-gbrain --cleanup-orphans
```

技能重新收集 PAT（一次性，之后丢弃），列出你 Supabase 账户中名称以 `gbrain` 开头且其 ref 与你活跃的 `~/.gbrain/config.json` pooler URL 不匹配的每个项目。对于每个孤立项目，它会逐项询问：*"删除孤立项目 `<ref>`（`<name>`，创建于 `<date>`）？"* — 不批量处理，没有"全部删除"快捷方式。活跃的 brain 永远不会被提出删除。

## 命令 + 参数参考

### `/setup-gbrain` 入口模式

| 调用方式 | 功能 |
|---|---|
| `/setup-gbrain` | 完整流程：检测状态、选择路径、安装、初始化、MCP、策略、可选记忆同步 |
| `/setup-gbrain --repo` | 仅翻转当前仓库的每远程信任策略 |
| `/setup-gbrain --switch` | 迁移引擎（PGLite ↔ Supabase），无需重新运行其他步骤 |
| `/setup-gbrain --resume-provision <ref>` | 恢复在轮询期间被中断的路径 2a 自动配置 |
| `/setup-gbrain --cleanup-orphans` | 列出 + 逐项删除孤立 Supabase 项目 |

### 辅助工具（用于脚本）

| 工具 | 用途 |
|---|---|
| `gstack-gbrain-detect` | 以 JSON 形式输出当前状态：gbrain 是否在 PATH、版本、配置引擎、doctor 状态、同步模式 |
| `gstack-gbrain-install` | 检测优先安装器（探测 `~/git/gbrain`、`~/gbrain`，然后全新克隆）。有 `--dry-run` 和 `--validate-only` 参数。PATH 覆盖检查在有修复菜单的情况下退出 3。|
| `gstack-gbrain-lib.sh` | 被 sourced，不被执行。提供 `read_secret_to_env VARNAME "prompt" [--echo-redacted "<sed-expr>"]` |
| `gstack-gbrain-supabase-verify` | 结构性 URL 检查。以退出 3 和修复菜单拒绝直连 URL（`db.*.supabase.co:5432`）|
| `gstack-gbrain-supabase-provision` | Management API 包装器。子命令：`list-orgs`、`create`、`wait`、`pooler-url`、`list-orphans`、`delete-project`。所有命令都需要 `SUPABASE_ACCESS_TOKEN` 在环境中。`create` 和 `pooler-url` 还需要 `DB_PASS`。每个子命令都有 `--json` 模式。|
| `gstack-gbrain-repo-policy` | 每远程信任三元组。子命令：`get`、`set`、`list`、`normalize` |
| `gstack-gbrain-source-wireup` | 通过 `gbrain sources add` + `git worktree` 将你的 `~/.gstack/` brain 仓库注册为 gbrain 的联合数据源，然后运行初始 `gbrain sync`。幂等。替换了 v1.12.x 中的 `consumers.json + /ingest-repo` HTTP 连接方式。参数：`--strict`、`--source-id <id>`、`--no-pull`、`--uninstall`、`--probe`。|

### gbrain CLI（上游工具）

gbrain 本身附带这些由 gstack 包装的命令：

| 命令 | 用途 |
|---|---|
| `gbrain init --pglite` | 初始化本地 PGLite brain |
| `gbrain init --non-interactive` | 通过 env（`GBRAIN_DATABASE_URL` 或 `DATABASE_URL`）初始化。永远不要将 URL 作为 argv 传递——它会泄漏到 shell 历史记录。|
| `gbrain doctor --json` | 健康检查。返回 `{status: "ok"|"warnings"|"error", health_score: 0-100, checks: [...]}` |
| `gbrain migrate --to supabase --url ...` | 将 PGLite brain 迁移到 Supabase（无损，保留源作为备份）|
| `gbrain migrate --to pglite` | 反向迁移 |
| `gbrain search "query"` | 搜索 brain |
| `gbrain put_page --title "..." --tags "a,b" <<<"content"` | 写入页面 |
| `gbrain get_page "<slug>"` | 获取页面 |
| `gbrain serve` | 启动 MCP stdio 服务器（由 `claude mcp add` 使用）|

### 配置文件 + 状态

| 路径 | 内容 |
|---|---|
| `~/.gbrain/config.json` | 引擎（pglite/postgres）、数据库 URL 或路径、API 密钥。模式 0600。由 `gbrain init` 写入。|
| `~/.gstack/gbrain-repo-policy.json` | 每远程信任三元组。Schema v2。模式 0600。|
| `~/.gstack/.setup-gbrain.lock.d` | 并发运行锁（原子 mkdir）。正常退出 + SIGINT 时释放。|
| `~/.gstack/.brain-queue.jsonl` | gstack 记忆同步的待处理同步条目 |
| `~/.gstack/.brain-last-push` | 上次同步推送的时间戳（用于 `/health` 评分）|
| `~/.gstack-brain-remote.txt` | 你的 gstack 记忆同步远程的 URL（可以安全地在机器间复制）|
| `~/.gstack/.setup-gbrain-inflight.json` | 为未来的 `--resume-provision` 持久状态保留 |

### 环境变量

| 变量 | 读取位置 | 作用 |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | `gstack-gbrain-supabase-provision` | Management API 调用的 PAT。每次安装运行后丢弃。|
| `DB_PASS` | `gstack-gbrain-supabase-provision`（create、pooler-url）| 生成的 DB 密码。从不在 argv 中。|
| `GBRAIN_DATABASE_URL` | `gbrain init`、`gbrain doctor` 等 | Postgres 连接字符串（对我们来说是 Supabase pooler URL）。环境优先于 `~/.gbrain/config.json`。|
| `DATABASE_URL` | `gbrain init`（备用）| 与 `GBRAIN_DATABASE_URL` 语义相同；第二个检查。|
| `SUPABASE_API_BASE` | `gstack-gbrain-supabase-provision` | 覆盖 Management API 主机。测试用于指向模拟服务器。|
| `GBRAIN_INSTALL_DIR` | `gstack-gbrain-install` | 覆盖默认安装路径（`~/gbrain`）|
| `GSTACK_HOME` | 每个辅助工具 | 覆盖 `~/.gstack` 状态目录。大量测试使用。|

## 安全模型

这个技能触及的每个秘密有一条规则：**仅环境变量，永不 argv，永不记录，永不由我们写入磁盘。** 唯一的持久存储是 gbrain 自己的 `~/.gbrain/config.json`，模式 0600，这是 gbrain 的纪律，不是我们的。

**在代码中强制执行：**

- `test/skill-validation.test.ts` 中的 CI grep 测试在 argv 位置出现 `$SUPABASE_ACCESS_TOKEN` 或 `$GBRAIN_DATABASE_URL` 时构建失败
- CI grep 测试在 `bin/gstack-gbrain-supabase-provision` 中出现 `--insecure`、`-k` 或 `NODE_TLS_REJECT_UNAUTHORIZED=0` 时失败
- 配置辅助工具顶部的 `set +x` 防止调试跟踪泄漏 PAT
- 遥测载荷只包含枚举的分类值（场景、安装结果、MCP 选择加入、信任层级）——从不包含可能含有秘密的自由格式字符串

**通过测试强制执行：**

- `test/secret-sink-harness.test.ts` 使用种子秘密运行每个处理秘密的工具，并断言种子不会出现在任何捕获的通道中（stdout、stderr、`$HOME` 下的文件、遥测 JSONL）。每个种子有四条匹配规则：精确、URL 解码、前 12 字符前缀、base64。
- 同一测试文件中的正向控制故意在每个覆盖通道中泄漏种子，并断言测试套件能检测到每一个。没有正向控制，一个静默漏报的测试套件看起来会与工作的测试套件相同。

**你仍然可以泄漏的内容**（v1 的诚实限制）：

- 如果你在 `read -s` 之外的普通聊天消息中粘贴秘密，它会进入对话记录和任何主机端日志
- 泄漏测试套件不转储子进程环境——一个 `env >> ~/.log` 的工具会逃过检测（v1 中没有工具这样做；grep 测试阻止了这一点）
- 你 shell 自己的 `HISTFILE` 行为是你 shell 的——我们从不将秘密传递给 argv，所以它们不会通过我们的代码落在那里，但没有什么能阻止你自己将其粘贴到原始 `curl` 命令中

## 故障排除

### 安装期间的"PATH 覆盖检测"

另一个 `gbrain` 二进制文件在 PATH 中比安装器刚链接的那个更靠前。安装器的版本检查捕获到了它。修复以下之一：

- 如果你不需要另一个，运行 `rm $(which gbrain)`
- 在你的 shell rc 中将 `~/.bun/bin` 添加到 PATH 开头，使链接的二进制文件获胜
- 将 `GBRAIN_INSTALL_DIR` 设置为覆盖二进制文件的安装目录并重新运行

然后重新运行 `/setup-gbrain`。

### "拒绝了直连 URL"

你粘贴了 `db.<ref>.supabase.co:5432` URL。这些仅支持 IPv6，在大多数环境中会失败。改用 Session Pooler URL：Supabase 仪表板 → 设置 → 数据库 → 连接池 → **会话** → 复制 URI（端口 6543）。

### 自动配置在 180 秒时超时

Supabase 项目仍在初始化中。你的 ref 已打印在退出消息中。等一分钟，然后：

```bash
/setup-gbrain --resume-provision <ref>
```

技能重新收集 PAT，跳过项目创建，恢复轮询。

### "另一个 `/setup-gbrain` 实例正在运行"

你有一个过期的锁目录。如果你确定没有其他实例真的在运行：

```bash
rm -rf ~/.gstack/.setup-gbrain.lock.d
```

然后重新运行。

### 策略文件上的"没有跨模型张力"

你用旧版的 `allow` 值手动编辑了 `~/.gstack/gbrain-repo-policy.json`？没问题。下次读取时，gstack 自动将 `allow` 迁移为 `read-write` 并添加 `_schema_version: 2`。stderr 上一行日志，幂等，确定性。

### `gbrain doctor` 说"warnings"

`/health` 将其视为黄色，而不是红色。检查 `gbrain doctor --json | jq .checks` 以查看哪些子检查在警告。典型原因：解析器 MECE 重叠（技能名称冲突）或 DB 连接尚未配置。

### 切换 PGLite → Supabase 时挂起

另一个 gstack 会话在兄弟 Conductor 工作区中可能通过其前言的 `gstack-brain-sync` 调用持有你本地 PGLite 文件的锁。关闭其他工作区，重新运行 `/setup-gbrain --switch`。超时限制在 180 秒，所以你永远不会真的永久等待。

## 为什么这样设计

**为什么是每远程信任三元组而不是二元允许/拒绝？** 多客户顾问需要搜索而不是写回。一个自由职业开发者早上在客户 A 项目工作，下午在客户 B 项目工作，不能让 A 的代码洞察泄漏到客户 B 可以搜索的 brain 中。只读干净地解决了这个问题。

**为什么不将 gbrain 打包进 gstack？** Gbrain 是一个独立的、积极开发的项目，有自己的发布节奏、schema 迁移和 MCP 表面。打包意味着 gstack 必须为 gbrain 更新设置门控，这会减慢 gbrain 改进到达用户的速度。独立但集成让每个项目按自己的节奏发布。

**为什么通过环境变量而不是参数使用 `gbrain init --non-interactive`？** 连接字符串包含数据库密码。将其作为 argv 传递会使密码出现在 `ps`、shell 历史记录和进程列表中。环境变量传递只将秘密保留在进程内存中。Gbrain 同时支持 `GBRAIN_DATABASE_URL` 和 `DATABASE_URL`；我们使用前者以避免与非 gbrain 工具发生冲突。

**为什么在 PATH 覆盖时硬失败而不是警告继续？** 一个覆盖的 `gbrain` 意味着每个后续命令都调用与我们刚安装的不同的二进制文件。这是一个静默的版本漂移 Bug，几周后会表现为神秘的功能差距。安装技能有一个任务——设置一个工作环境。拒绝安装到一个损坏的环境是安装技能的正确行为。

**为什么不自动导入每个仓库？** 隐私 + 噪音。一个自动导入前言钩子，会摄入你触碰的每个仓库，将：（a）未经同意地将工作代码泄漏到共享 brain 中，以及（b）用一次性仓库堵塞搜索。每远程策略使摄入成为一个明确的每仓库决定。`/setup-gbrain` 目前不安装任何自动导入钩子——但策略存储对以后的一个是前向兼容的。

## 相关技能 + 后续步骤

- `/health` — 在其 0-10 综合评分中包含一个 GBrain 维度（doctor 状态、同步队列深度、最后推送时间）。当 gbrain 未安装时该维度被省略；在非 gbrain 机器上运行 `/health` 不会因此选择受到惩罚。
- `/gstack-upgrade` — 让 gstack 本身保持最新。不独立升级 gbrain。要升级 gbrain，请更新 `bin/gstack-gbrain-install` 中的 `PINNED_COMMIT` 并重新运行 `/setup-gbrain`。
- `/retro` — 当记忆同步开启时，每周回顾从你的 gbrain 中提取学习内容和计划，让回顾可以引用跨机器的历史。

运行 `/setup-gbrain` 看看会发生什么。
