# 使用 GBrain 同步实现跨机器记忆

gstack 向 `~/.gstack/` 写入了大量有用的状态——学习内容、回顾、CEO 计划、设计文档、开发者档案。默认情况下，当你切换笔记本时，这些都会消失。**GBrain 同步**将一个精心筛选的子集推送到私有 git 仓库，使你的记忆跟随你跨机器，并可被 GBrain 建立索引。

## 你得到了什么

- 在机器 A 上工作，在机器 B 上无缝继续。
- 你的学习内容、计划和设计在 GBrain 中可见（如果你在使用它）。
- 一个干净的退出路径（`gstack-brain-uninstall`），永远不会触碰你的数据。
- 没有守护进程，没有系统服务，没有后台进程。

## 什么不会离开你的机器

按设计，即使同步开启，这些也保持本地：

- 凭证：`.auth.json`、`auth-token.json`、`sidebar-sessions/`、`security/device-salt`、`config.yaml` 中的消费者令牌
- 机器特定状态：Chromium 配置文件、ONNX 模型权重、缓存、eval 缓存、CDP 配置文件、一次性提示标记（`.welcome-seen`、`.telemetry-prompted`、`.vendoring-warned-*` 等）
- 问题偏好：每机器的 UX 偏好（`question-preferences.json`、`question-log.jsonl`、`question-events.jsonl`）

确切的允许列表位于 `~/.gstack/.brain-allowlist`。CLI 管理它；你可以在标记行下面添加自己的条目。

## 首次设置（30-90 秒）

```bash
gstack-brain-init
```

该命令：

1. 将 `~/.gstack/` 变成一个 git 仓库。
2. 询问远程 URL（默认：`gh repo create --private gstack-brain-$USER`）。任何 git 远程都可以——GitHub、GitLab、Gitea、自托管。
3. 推送一个仅包含配置的初始提交。
4. 写入 `~/.gstack-brain-remote.txt`（仅 URL，没有秘密——可以安全复制到另一台机器）。
5. 通过 `gbrain sources add` + `git worktree` 将 gstack-brain 仓库连接到你的本地 gbrain 作为联合数据源，使 `gbrain search` 可以索引你同步的学习内容、计划和设计。实现位于 `bin/gstack-gbrain-source-wireup`。v1.15.1.0 中删除了旧的 `gstack-brain-reader add --ingest-url ...` HTTP 路径——它依赖于 gbrain 从未发布的 `/ingest-repo` 端点。

初始化后，**你运行的下一个技能**将询问你一个关于隐私模式的问题：

- **所有内容允许列表（推荐）**：学习内容、评审、计划、设计、回顾、时间轴和开发者档案全部同步。
- **仅产物**：计划、设计、回顾、学习内容——跳过行为数据（时间轴、开发者档案）。
- **拒绝**：保持所有内容本地。你可以稍后用 `gstack-config set gbrain_sync_mode full` 开启同步。

你的回答会被持久化。不会再次询问。

## 跨机器工作流

在机器 A 上：运行 `gstack-brain-init` 一次。就是这样——每次技能调用现在都会在其开始和结束边界清空同步队列（每次技能约 200-800 毫秒的网络暂停）。

在机器 B 上：

1. 将 `~/.gstack-brain-remote.txt` 从机器 A 复制到机器 B（密码管理器、dotfile 仓库、USB 棒——你自己决定）。
2. 运行任何 gstack 技能。前言看到 URL 文件并打印：
   ```
   BRAIN_SYNC: 检测到 brain 仓库：<url>
   BRAIN_SYNC: 运行 'gstack-brain-restore' 以拉取你的跨机器记忆
   ```
3. 运行 `gstack-brain-restore`。这会克隆仓库，重新填充你的学习内容/计划/回顾，并重新注册 git 合并驱动程序。
4. 重新输入消费者令牌（它们是机器本地的，**不会**同步——`gstack-config set gbrain_token <your-token>`）。
5. 下一个技能：你昨天在机器 A 上的学习内容出现了。那就是神奇的时刻。

## 状态、健康和队列深度

```bash
gstack-brain-sync --status
```

显示：上次成功推送、待处理队列深度、任何同步阻塞以及当前隐私模式。

每次技能运行都会在前言输出顶部附近打印一行 `BRAIN_SYNC:`。扫描它以查找问题。

## 隐私模式详情

| 模式 | 同步内容 |
|------|---------|
| `off` | 什么都不同步（默认）。|
| `artifacts-only` | 计划、设计、回顾、学习内容、评审。跳过时间轴 + 开发者档案。|
| `full` | 允许列表中的所有内容，包括行为状态。|

随时更改：
```bash
gstack-config set gbrain_sync_mode full
gstack-config set gbrain_sync_mode off
```

## 秘密保护

每个提交在离开你的机器之前都会扫描凭证形状的内容。被阻止的模式包括：

- AWS 访问密钥（`AKIA…`）
- GitHub 令牌（`ghp_`、`gho_`、`ghu_`、`ghs_`、`ghr_`、`github_pat_`）
- OpenAI 密钥（`sk-…`）
- PEM 块（`-----BEGIN …-----`）
- JWT（`eyJ…`）
- JSON 中的 Bearer 令牌（`"authorization": "…"`、`"api_key": "…"` 等）

如果扫描命中，同步停止，队列被保留，你的前言打印：

```
BRAIN_SYNC: 已阻止：<模式-家族>:<片段>
```

修复方法：

1. 检查违规文件。
2. 如果匹配是你明确想要同步的内容上的误报，运行 `gstack-brain-sync --skip-file <path>` 永久排除该路径。
3. 否则，编辑文件删除秘密，然后重新运行任何技能。

在 `~/.gstack/.git/hooks/pre-commit` 有一个深度防御钩子，如果你手动 `git commit` 到仓库，也会运行同样的扫描。

## 双机器冲突

如果你在同一天在机器 A 和机器 B 上写作，两者都会推送追加提交。Git 的默认行为会在文件尾部冲突，但 `.jsonl` 和 Markdown 文件注册了自定义合并驱动程序：

- JSONL 文件使用按 ISO 时间戳排序去重的驱动程序（对每行 SHA-256 哈希确定性回退）。
- Markdown 产物（回顾、计划、设计）使用连接双方的联合合并驱动程序。

你不应该看到冲突提示。如果你看到了（真正的语义冲突，比如两台机器编辑同一个计划），git 会停下来提示。

## 跨机器拉取节奏

前言每 24 小时运行一次 `git fetch` + `git merge --ff-only`（通过 `~/.gstack/.brain-last-pull` 缓存）。你不需要考虑这个——它在每天第一次技能调用时自动发生。

## 卸载

```bash
gstack-brain-uninstall
```

这会：

- 删除 `~/.gstack/.git/` 和所有 `.brain-*` 配置文件。
- 清除 `gstack-config` 中的 `gbrain_sync_mode`。
- **不**触碰你的学习内容、计划、回顾或开发者档案。

添加 `--delete-remote` 也可以删除私有 GitHub 仓库（仅限 GitHub，使用 `gh repo delete`）。

随时用 `gstack-brain-init` 重新初始化。

## 故障排除

有关 `gstack-brain-*` 可能打印的每条错误消息的索引，以及每条的问题/原因/修复，请参阅 [gbrain-sync-errors.md](gbrain-sync-errors.md)。

## 底层原理

有关此功能背后的架构决策（允许列表 vs 拒绝列表、守护进程 vs 前言边界同步、JSONL 合并驱动程序、隐私停止门），请参阅 gstack 计划目录中的批准计划。
