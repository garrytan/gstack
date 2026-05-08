# 为 gstack 做贡献

感谢你想让 gstack 变得更好。无论你是修复技能提示中的拼写错误，还是构建全新的工作流，本指南都能让你快速上手。

## 快速开始

gstack 技能是 Markdown 文件，Claude Code 从 `skills/` 目录发现它们。通常它们位于 `~/.claude/skills/gstack/`（你的全局安装）。但当你在开发 gstack 本身时，你希望 Claude Code 使用*工作树中的*技能——这样编辑立即生效，无需复制或部署任何东西。

这就是开发模式的作用。它将你的仓库符号链接到本地 `.claude/skills/` 目录，使 Claude Code 直接从你的检出读取技能。

```bash
git clone https://github.com/garrytan/gstack.git && cd gstack
bun install                    # 安装依赖
bin/dev-setup                  # 激活开发模式
```

> **完整克隆 vs 浅克隆。** README 面向用户的安装使用 `--depth 1` 以提高速度。作为贡献者，使用完整克隆（无 `--depth` 标志）——你需要历史记录用于 `git log`、`git blame`、`git bisect` 和查看早期版本的 PR。如果你已经有了按照 README 安装的 `--depth 1` 克隆，用 `git fetch --unshallow` 将其提升为完整克隆。

现在编辑任何 `SKILL.md`，在 Claude Code 中调用它（例如 `/review`），看到你的更改生效。完成开发后：

```bash
bin/dev-teardown               # 停用——回到你的全局安装
```

## 操作性自我改进

gstack 自动从失败中学习。在每次技能会话结束时，智能体
会反思出错的地方（CLI 错误、错误方法、项目特有问题），并将
操作性学习记录到 `~/.gstack/projects/{slug}/learnings.jsonl`。未来会话
会自动浮现这些学习，使 gstack 随着时间在你的代码库上变得更智能。

无需设置。学习自动记录。用 `/learn` 查看它们。

### 贡献者工作流

1. **正常使用 gstack** — 操作性学习自动捕获
2. **检查你的学习内容：** `/learn` 或 `ls ~/.gstack/projects/*/learnings.jsonl`
3. **Fork 并克隆 gstack**（如果还没有）
4. **将你的 fork 符号链接到遇到 Bug 的项目：**
   ```bash
   # 在你的核心项目中（遇到 gstack 问题的那个）
   ln -sfn /path/to/your/gstack-fork .claude/skills/gstack
   cd .claude/skills/gstack && bun install && bun run build && ./setup
   ```
   Setup 创建每技能目录，其中有 SKILL.md 符号链接（`qa/SKILL.md -> gstack/qa/SKILL.md`），并询问你的前缀偏好。传递 `--no-prefix` 跳过提示并使用短名称。
5. **修复问题** — 你的更改立即在这个项目中生效
6. **通过实际使用 gstack 进行测试** — 做那件让你烦恼的事，验证它已修复
7. **从你的 fork 开一个 PR**

这是最好的贡献方式：在做真实工作时修复 gstack，在你实际感受到痛苦的项目中。

### 会话感知

当你同时打开 3+ 个 gstack 会话时，每个问题都会告诉你哪个项目、哪个分支和正在发生什么。不再盯着一个问题想"等等，这是哪个窗口？"格式在所有技能中保持一致。

## 在 gstack 仓库内使用 gstack

当你在编辑 gstack 技能并想通过实际使用 gstack
在同一仓库中测试时，`bin/dev-setup` 会配置好这一切。它创建 `.claude/skills/`
符号链接（已被 gitignore），指向你的工作树，使 Claude Code 使用
你的本地编辑而不是全局安装。

```
gstack/                          <- 你的工作树
├── .claude/skills/              <- 由 dev-setup 创建（gitignored）
│   ├── gstack -> ../../         <- 符号链接回仓库根
│   ├── review/                  <- 真实目录（短名称，默认）
│   │   └── SKILL.md -> gstack/review/SKILL.md
│   ├── ship/                    <- 如果 --prefix 则为 gstack-review/、gstack-ship/
│   │   └── SKILL.md -> gstack/ship/SKILL.md
│   └── ...                      <- 每个技能一个目录
├── review/
│   └── SKILL.md                 <- 编辑这个，用 /review 测试
├── ship/
│   └── SKILL.md
├── browse/
│   ├── src/                     <- TypeScript 源码
│   └── dist/                    <- 编译后的二进制（gitignored）
└── ...
```

Setup 在顶层创建真实目录（不是符号链接），内部有 SKILL.md 符号链接。这确保 Claude 将它们作为顶级技能发现，而不是嵌套在 `gstack/` 下。名称取决于你的前缀设置（`~/.gstack/config.yaml`）。短名称（`/review`、`/ship`）是默认的。如果你更喜欢命名空间名称（`/gstack-review`、`/gstack-ship`），运行 `./setup --prefix`。

## 日常工作流

```bash
# 1. 进入开发模式
bin/dev-setup

# 2. 编辑技能
vim review/SKILL.md

# 3. 在 Claude Code 中测试——更改立即生效
#    > /review

# 4. 编辑浏览源？重新构建二进制
bun run build

# 5. 今天完成了？拆除
bin/dev-teardown
```

## 测试 & evals

### 设置

```bash
# 1. 复制 .env.example 并添加你的 API 密钥
cp .env.example .env
# 编辑 .env → 设置 ANTHROPIC_API_KEY=sk-ant-...

# 2. 安装依赖（如果还没有）
bun install
```

Bun 自动加载 `.env`——无需额外配置。Conductor 工作区会自动从主工作树继承 `.env`（参见下面的"Conductor 工作区"）。

### 测试层次

| 层次 | 命令 | 成本 | 测试内容 |
|------|-----|------|---------|
| 1 — 静态 | `bun test` | 免费 | 命令验证、快照标志、SKILL.md 正确性、TODOS-format.md 引用、可观测性单元测试 |
| 2 — E2E | `bun run test:e2e` | ~$3.85 | 通过 `claude -p` 子进程的完整技能执行 |
| 3 — LLM eval | `bun run test:evals` | ~$0.15（独立）| LLM 评审者对生成的 SKILL.md 文档的评分 |
| 2+3 | `bun run test:evals` | ~$4（合并）| E2E + LLM 评审者（两者都运行）|

```bash
bun test                     # 仅层次 1（每次提交运行，<5s）
bun run test:e2e             # 层次 2：仅 E2E（需要 EVALS=1，不能在 Claude Code 内运行）
bun run test:evals           # 层次 2 + 3 合并（~$4/次运行）
```

### 层次 1：静态验证（免费）

使用 `bun test` 自动运行。不需要 API 密钥。

- **技能解析器测试**（`test/skill-parser.test.ts`）— 从 SKILL.md bash 代码块提取每个 `$B` 命令并对 `browse/src/commands.ts` 中的命令注册表验证。捕获拼写错误、删除的命令和无效的快照标志。
- **技能验证测试**（`test/skill-validation.test.ts`）— 验证 SKILL.md 文件只引用真实命令和标志，命令描述满足质量阈值。
- **生成器测试**（`test/gen-skill-docs.test.ts`）— 测试模板系统：验证占位符正确解析，输出包含标志的值提示（例如 `-d <N>` 而不仅仅是 `-d`），关键命令的丰富描述（例如 `is` 列出有效状态，`press` 列出按键示例）。

### 层次 2：通过 `claude -p` 的 E2E（~$3.85/次运行）

将 `claude -p` 作为子进程派生，带 `--output-format stream-json --verbose`，流式传输 NDJSON 以实时进度，并扫描浏览错误。这是最接近"这个技能实际上端到端运行吗？"的东西

```bash
# 必须从普通终端运行——不能嵌套在 Claude Code 或 Conductor 中
EVALS=1 bun test test/skill-e2e-*.test.ts
```

- 由 `EVALS=1` 环境变量门控（防止意外昂贵的运行）
- 如果在 Claude Code 内运行则自动跳过（`claude -p` 不能嵌套）
- API 连接预检查——在烧掉预算之前快速失败
- 向 stderr 实时进度：`[Ns] turn T tool #C: Name(...)`
- 保存完整的 NDJSON 记录和失败 JSON 以供调试
- 测试位于 `test/skill-e2e-*.test.ts`（按类别拆分），运行器逻辑在 `test/helpers/session-runner.ts`

### E2E 可观测性

E2E 测试运行时，它们在 `~/.gstack-dev/` 中产生机器可读的产物：

| 产物 | 路径 | 用途 |
|------|------|------|
| 心跳 | `e2e-live.json` | 当前测试状态（每次工具调用更新）|
| 部分结果 | `evals/_partial-e2e.json` | 已完成测试（在终止时存活）|
| 进度日志 | `e2e-runs/{runId}/progress.log` | 追加式文本日志 |
| NDJSON 记录 | `e2e-runs/{runId}/{test}.ndjson` | 每次测试的原始 `claude -p` 输出 |
| 失败 JSON | `e2e-runs/{runId}/{test}-failure.json` | 失败时的诊断数据 |

**实时看板：** 在第二个终端运行 `bun run eval:watch` 以查看显示已完成测试、当前运行测试和成本的实时看板。使用 `--tail` 同时显示 progress.log 的最后 10 行。

**Eval 历史工具：**

```bash
bun run eval:list            # 列出所有 eval 运行（每次运行的轮次、持续时间、成本）
bun run eval:compare         # 比较两次运行——显示每测试的变化 + 解读注释
bun run eval:summary         # 跨运行的聚合统计 + 每测试效率平均值
```

**Eval 比较注释：** `eval:compare` 生成自然语言解读部分，说明运行之间发生了什么变化——标记回归、记录改进、指出效率提升（更少轮次、更快、更便宜），并产生总体摘要。这由 `eval-store.ts` 中的 `generateCommentary()` 驱动。

产物永远不清理——它们在 `~/.gstack-dev/` 中积累，用于事后调试和趋势分析。

### 层次 3：LLM 评审者（~$0.15/次运行）

使用 Claude Sonnet 在三个维度上对生成的 SKILL.md 文档评分：

- **清晰度** — AI 智能体能否无歧义地理解指令？
- **完整性** — 所有命令、标志和使用模式是否都有记录？
- **可操作性** — 智能体能否仅使用文档中的信息执行任务？

每个维度评 1-5 分。阈值：每个维度必须得分 **≥ 4**。还有一个回归测试，将生成的文档与来自 `origin/main` 的手工维护基准进行比较——生成的文档必须得分相同或更高。

```bash
# 需要 .env 中的 ANTHROPIC_API_KEY——包含在 bun run test:evals 中
```

- 使用 `claude-sonnet-4-6` 保持评分稳定
- 测试位于 `test/skill-llm-eval.test.ts`
- 直接调用 Anthropic API（不是 `claude -p`），所以可以从任何地方工作，包括 Claude Code 内部

### CI

GitHub Action（`.github/workflows/skill-docs.yml`）在每次推送和 PR 时运行 `bun run gen:skill-docs --dry-run`。如果生成的 SKILL.md 文件与已提交的不同，CI 失败。这在合并前捕捉过期文档。

测试直接对浏览二进制运行——不需要开发模式。

## 编辑 SKILL.md 文件

SKILL.md 文件是**从 `.tmpl` 模板生成的**。不要直接编辑 `.md`——你的更改会在下次构建时被覆盖。

```bash
# 1. 编辑模板
vim SKILL.md.tmpl              # 或 browse/SKILL.md.tmpl

# 2. 为所有宿主重新生成
bun run gen:skill-docs --host all

# 3. 检查健康（报告所有宿主）
bun run skill:check

# 或使用监视模式——保存时自动重新生成
bun run dev:skill
```

有关模板编写最佳实践（自然语言而非 bash 风格、动态分支检测、`{{BASE_BRANCH_DETECT}}` 用法），请参阅 CLAUDE.md 的"编写 SKILL 模板"部分。

要添加浏览命令，将其添加到 `browse/src/commands.ts`。要添加快照标志，将其添加到 `browse/src/snapshot.ts` 中的 `SNAPSHOT_FLAGS`。然后重新构建。

## 术语表（V1 写作风格）

gstack 的写作风格部分（注入到每个 ≥2 层技能的前言中）在每次技能调用时首次使用时术语。有资格注释的术语列表位于 `scripts/jargon-list.json`——约 50 个精心策划的高频术语（幂等、竞态条件、N+1、背压等）。不在列表上的术语被假定为足够通俗。

**添加或删除术语：** 开一个编辑 `scripts/jargon-list.json` 的 PR。编辑后运行 `bun run gen:skill-docs`——术语在生成时烘焙到每个生成的 SKILL.md 中，所以更改只有在重新生成后才会生效。没有运行时加载；没有用户端覆盖。仓库列表是真实来源。

好的添加候选：非技术用户在评审输出中遇到但没有上下文的高频术语（常见数据库/并发术语、安全行话、前端框架概念）。不要添加只在一两个小众技能中出现的术语——成本价值比不值得审查开销。

## 多宿主开发

gstack 从一套 `.tmpl` 模板为 8 个宿主生成 SKILL.md 文件。每个宿主是 `hosts/*.ts` 中的一个类型化配置。生成器读取这些配置以产生宿主适当的输出（不同的前置元数据、路径、工具名称）。

**支持的宿主：** Claude（主要）、Codex、Factory、Kiro、OpenCode、Slate、Cursor、OpenClaw。

### 为所有宿主生成

```bash
# 为特定宿主生成
bun run gen:skill-docs                    # Claude（默认）
bun run gen:skill-docs --host codex       # Codex
bun run gen:skill-docs --host opencode    # OpenCode
bun run gen:skill-docs --host all         # 全部 8 个宿主

# 或使用 build，它做所有宿主 + 编译二进制
bun run build
```

### 宿主间的差异

每个宿主配置（`hosts/*.ts`）控制：

| 方面 | 示例（Claude vs Codex）|
|------|----------------------|
| 输出目录 | `{skill}/SKILL.md` vs `.agents/skills/gstack-{skill}/SKILL.md` |
| 前置元数据 | 完整（名称、描述、钩子、版本）vs 最小（名称 + 描述）|
| 路径 | `~/.claude/skills/gstack` vs `$GSTACK_ROOT` |
| 工具名称 | "use the Bash tool" vs 相同（Factory 重写为 "run this command"）|
| 钩子技能 | `hooks:` 前置元数据 vs 内联安全建议散文 |
| 抑制的部分 | 无 vs Codex 自调用部分被剥离 |

有关完整的 `HostConfig` 接口，请参阅 `scripts/host-config.ts`。

### 测试宿主输出

```bash
# 运行所有静态测试（包括所有宿主的参数化冒烟测试）
bun test

# 检查所有宿主的新鲜度
bun run gen:skill-docs --host all --dry-run

# 健康看板涵盖所有宿主
bun run skill:check
```

### 添加新宿主

有关完整指南，请参阅 [docs/ADDING_A_HOST.md](docs/ADDING_A_HOST.md)。简短版本：

1. 创建 `hosts/myhost.ts`（从 `hosts/opencode.ts` 复制）
2. 添加到 `hosts/index.ts`
3. 将 `.myhost/` 添加到 `.gitignore`
4. 运行 `bun run gen:skill-docs --host myhost`
5. 运行 `bun test`（参数化测试自动覆盖它）

无需更改生成器、安装或工具代码。

### 添加新技能

当你添加新技能模板时，所有宿主自动获得它：
1. 创建 `{skill}/SKILL.md.tmpl`
2. 运行 `bun run gen:skill-docs --host all`
3. 动态模板发现会自动识别它，无需更新静态列表
4. 提交 `{skill}/SKILL.md`，外部宿主输出在安装时生成并被 gitignore

## Conductor 工作区

如果你在使用 [Conductor](https://conductor.build) 并行运行多个 Claude Code 会话，`conductor.json` 会自动连接工作区生命周期：

| 钩子 | 脚本 | 功能 |
|------|------|------|
| `setup` | `bin/dev-setup` | 从主工作树复制 `.env`，安装依赖，符号链接技能 |
| `archive` | `bin/dev-teardown` | 删除技能符号链接，清理 `.claude/` 目录 |

当 Conductor 创建新工作区时，`bin/dev-setup` 自动运行。它检测主工作树（通过 `git worktree list`），复制你的 `.env` 使 API 密钥可用，并设置开发模式——无需手动步骤。

**首次设置：** 将你的 `ANTHROPIC_API_KEY` 放在主仓库的 `.env` 中（参见 `.env.example`）。每个 Conductor 工作区自动继承它。

## 需要了解的事情

- **SKILL.md 文件是生成的。** 编辑 `.tmpl` 模板，而不是 `.md`。运行 `bun run gen:skill-docs` 重新生成。
- **TODOS.md 是统一的积压。** 按技能/组件组织，有 P0-P4 优先级。`/ship` 自动检测已完成的项目。所有计划/评审/回顾技能读取它以获取上下文。
- **浏览源更改需要重建。** 如果你修改 `browse/src/*.ts`，运行 `bun run build`。
- **开发模式会遮蔽你的全局安装。** 项目本地技能优先于 `~/.claude/skills/gstack`。`bin/dev-teardown` 恢复全局安装。
- **Conductor 工作区是独立的。** 每个工作区是自己的 git 工作树。`bin/dev-setup` 通过 `conductor.json` 自动运行。
- **`.env` 跨工作树传播。** 在主仓库设置一次，所有 Conductor 工作区都能获得它。
- **`.claude/skills/` 被 gitignore。** 符号链接永远不会被提交。

## 在真实项目中测试你的更改

**这是开发 gstack 的推荐方式。** 将你的 gstack 检出符号链接到你实际使用它的项目，这样你的更改在你做真实工作时是实时的。

### 步骤 1：符号链接你的检出

```bash
# 在你的核心项目中（不是 gstack 仓库）
ln -sfn /path/to/your/gstack-checkout .claude/skills/gstack
```

### 步骤 2：运行 setup 创建每技能符号链接

仅有 `gstack` 符号链接是不够的。Claude Code 通过单独的顶级目录发现技能（`qa/SKILL.md`、`ship/SKILL.md` 等），而不是通过 `gstack/` 目录本身。运行 `./setup` 创建它们：

```bash
cd .claude/skills/gstack && bun install && bun run build && ./setup
```

Setup 会询问你是想要短名称（`/qa`）还是命名空间的（`/gstack-qa`）。你的选择保存到 `~/.gstack/config.yaml` 并在未来运行中记住。要跳过提示，传递 `--no-prefix`（短名称）或 `--prefix`（命名空间）。

### 步骤 3：开发

编辑模板，运行 `bun run gen:skill-docs`，下一次 `/review` 或 `/qa` 调用立即使用新版本。无需重启。

### 回到稳定的全局安装

删除项目本地符号链接。Claude Code 回退到 `~/.claude/skills/gstack/`：

```bash
rm .claude/skills/gstack
```

每技能目录（`qa/`、`ship/` 等）包含指向 `gstack/...` 的 SKILL.md 符号链接，所以它们会自动解析到全局安装。

### 切换前缀模式

如果你用一个前缀设置安装了 gstack 并想切换：

```bash
cd .claude/skills/gstack && ./setup --no-prefix   # 切换到 /qa、/ship
cd .claude/skills/gstack && ./setup --prefix       # 切换到 /gstack-qa、/gstack-ship
```

Setup 自动清理旧符号链接。无需手动清理。

### 替代方案：将全局安装指向一个分支

如果你不想要每项目符号链接，可以切换全局安装：

```bash
cd ~/.claude/skills/gstack
git fetch origin
git checkout origin/<branch>
bun install && bun run build && ./setup
```

这影响所有项目。要恢复：`git checkout main && git pull && bun run build && ./setup`。

## 社区 PR 分流（波次流程）

当社区 PR 积累时，将它们分批到有主题的波次：

1. **分类** — 按主题分组（安全、功能、基础设施、文档）
2. **去重** — 如果两个 PR 修复了同样的事情，选择更改行数更少的那个。用指向胜出者的注释关闭另一个。
3. **收集器分支** — 创建 `pr-wave-N`，合并干净的 PR，解决脏 PR 的冲突，用 `bun test && bun run build` 验证
4. **带上下文关闭** — 每个关闭的 PR 都有一条注释解释原因和（如果有的话）什么取代了它。贡献者做了真实的工作；用清晰的沟通尊重这一点。
5. **作为一个 PR 发布** — 单个 PR 到 main，所有归属在合并提交中保留。包含合并了什么和关闭了什么的摘要表。

参见 [PR #205](../../pull/205)（v0.8.3）作为第一波的示例。

## 升级迁移

当一个版本以 `./setup` 单独无法修复的方式更改了磁盘状态（目录结构、配置格式、过期文件）时，添加一个迁移脚本，使现有用户可以干净地升级。

### 何时添加迁移

- 更改了技能目录的创建方式（符号链接 vs 真实目录）
- 重命名或移动了 `~/.gstack/config.yaml` 中的配置键
- 需要删除来自早期版本的孤立文件
- 更改了 `~/.gstack/` 状态文件的格式

不要为以下情况添加迁移：新功能（用户自动获得）、新技能（setup 发现它们）或仅代码更改（无磁盘状态）。

### 如何添加

1. 创建 `gstack-upgrade/migrations/v{VERSION}.sh`，其中 `{VERSION}` 匹配需要修复的版本的 VERSION 文件。
2. 使其可执行：`chmod +x gstack-upgrade/migrations/v{VERSION}.sh`
3. 脚本必须是**幂等的**（安全多次运行）且**非致命的**（失败会记录但不阻止升级）。
4. 在顶部包含一个注释块，解释发生了什么变化、为什么需要迁移以及哪些用户受影响。

示例：

```bash
#!/usr/bin/env bash
# 迁移：v0.15.2.0 — 修复技能目录结构
# 受影响：v0.15.2.0 之前使用 --no-prefix 安装的用户
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
"$SCRIPT_DIR/bin/gstack-relink" 2>/dev/null || true
```

### 它如何运行

在 `/gstack-upgrade` 期间，`./setup` 完成（步骤 4.75）之后，升级技能扫描 `gstack-upgrade/migrations/` 并运行每个版本比用户旧版本新的 `v*.sh` 脚本。脚本按版本顺序运行。失败会记录但永远不会阻止升级。

### 测试迁移

迁移作为 `bun test` 的一部分（层次 1，免费）进行测试。测试套件验证 `gstack-upgrade/migrations/` 中的所有迁移脚本是可执行的，并且在语法上没有错误。

## 发布你的更改

当你对技能编辑感到满意时：

```bash
/ship
```

这会运行测试、评审差异、分流 Greptile 注释（2 层升级），管理 TODOS.md、升级版本并开一个 PR。有关完整工作流，请参阅 `ship/SKILL.md`。
