# 为 gstack 做贡献

感谢你愿意让 gstack 变得更好。无论你只是修正某个 skill prompt 里的错字，
还是要构建一整套新的工作流，这份指南都会帮你快速上手。

## 快速开始

gstack 的 skills 本质上是 Claude Code 会从 `skills/` 目录中发现的 Markdown 文件。
通常它们位于 `~/.claude/skills/gstack/`（你的全局安装目录）。
但当你在开发 gstack 本身时，你会希望 Claude Code 直接使用**工作树里的 skills**，
这样任何改动都能立即生效，而不用复制或部署。

这就是 dev mode 的作用。它会把你的仓库通过 symlink 链接进本地 `.claude/skills/`
目录，让 Claude Code 直接从当前 checkout 读取 skills。

```bash
git clone <repo> && cd gstack
bun install                    # 安装依赖
bin/dev-setup                  # 启用 dev mode
```

现在你可以修改任意 `SKILL.md`，在 Claude Code 里调用它（例如 `/review`），
然后直接看到改动生效。开发结束后：

```bash
bin/dev-teardown               # 关闭 dev mode，回到全局安装
```

## Contributor 模式

Contributor mode 会把 gstack 变成一个可自我改进的工具。启用后，Claude Code
会定期回顾自己使用 gstack 的体验，并在每个主要工作流步骤结束时打 0-10 分。
只要某个体验没达到 10 分，它就会思考为什么，并向
`~/.gstack/contributor-logs/` 写入一份报告，记录发生了什么、如何复现，以及怎样才能更好。

```bash
~/.claude/skills/gstack/bin/gstack-config set gstack_contributor true
```

这些日志是写给**你自己**看的。当某个问题真的烦到你想修时，报告已经帮你写好了。
你只需要 fork gstack，把自己的 fork symlink 到你实际遇到问题的项目里，
修掉它，然后提一个 PR。

### 贡献者工作流

1. **正常使用 gstack**：Contributor mode 会自动记录问题并生成反思日志
2. **查看日志：** `ls ~/.gstack/contributor-logs/`
3. **Fork 并 clone gstack**（如果你还没做）
4. **把你的 fork symlink 到出现问题的项目中：**
   ```bash
   # 在你的核心项目里（也就是 gstack 让你不爽的那个项目）
   ln -sfn /path/to/your/gstack-fork .claude/skills/gstack
   cd .claude/skills/gstack && bun install && bun run build && ./setup
   ```
   `setup` 会创建每个 skill 的独立 symlink（例如 `qa -> gstack/qa`），
   并询问你是否需要前缀。传 `--no-prefix` 可以跳过提示并使用短名称。
5. **修复问题**：你的改动会在这个项目里立即生效
6. **用真实方式验证**：重复那个曾经让你烦躁的操作，确认问题已修复
7. **从你的 fork 发起 PR**

这是最好的贡献方式：在你真实工作中修 gstack，而且是在你真正感受到问题的项目环境中完成。

### 会话 awareness

当你同时打开 3 个或更多 gstack sessions 时，每个问题都会明确告诉你：
当前是哪个项目、哪个分支、正在发生什么。这样你就不会再盯着一个问题发愣：
“等等，这到底是哪个窗口？”
这个格式会在所有 skills 中保持一致。

## 在 gstack 仓库里开发 gstack

如果你正在编辑 gstack 的 skills，并希望在**同一个仓库里直接用 gstack 测试它们**，
`bin/dev-setup` 会帮你把环境搭好。它会创建 `.claude/skills/` symlinks
（这个目录已被 gitignore），并指回你的工作树，
这样 Claude Code 使用的是你本地改过的版本，而不是全局安装。

```text
gstack/                          <- 你的工作树
├── .claude/skills/              <- dev-setup 创建（gitignored）
│   ├── gstack -> ../../         <- 回指仓库根目录的 symlink
│   ├── review -> gstack/review  <- 默认短名称
│   ├── ship -> gstack/ship      <- 若使用 --prefix，则会变成 gstack-review 等
│   └── ...                      <- 每个 skill 一个 symlink
├── review/
│   └── SKILL.md                 <- 修改这里，然后用 /review 测试
├── ship/
│   └── SKILL.md
├── browse/
│   ├── src/                     <- TypeScript 源码
│   └── dist/                    <- 编译后的二进制（gitignored）
└── ...
```

skill symlink 的名字取决于你的前缀设置（`~/.gstack/config.yaml`）。
默认是短名称（`/review`、`/ship`）。如果你偏好 namespaced 名称
（如 `/gstack-review`、`/gstack-ship`），可以运行 `./setup --prefix`。

## 日常工作流

```bash
# 1. 进入 dev 模式
bin/dev-setup

# 2. 编辑一个 技能
vim review/SKILL.md

# 3. 在 Claude Code 里测试，改动会立即生效
#    > /审查

# 4. 如果改的是 browse 源码，要重新编译
bun run build

# 5. 今天结束时，执行清理
bin/dev-teardown
```

## 测试与 evals

### 初始化

```bash
# 1. 复制 .env.示例 并填入 API key
cp .env.example .env
# 编辑 .env → 设置 ANTHROPIC_API_KEY=sk-ant-...

# 2. 如果还没装依赖，先安装
bun install
```

Bun 会自动加载 `.env`，不需要额外配置。Conductor workspaces 也会自动继承主工作树里的 `.env`
（见下文 “Conductor workspaces”）。

### 测试层级

| 层级 | 命令 | 成本 | 测试内容 |
|------|------|------|----------|
| 1 — Static | `bun test` | 免费 | 命令校验、snapshot flags、SKILL.md 正确性、TODOS-format.md 引用、可观测性单测 |
| 2 — E2E | `bun run test:e2e` | ~$3.85 | 通过 `claude -p` 执行完整 skill 流程 |
| 3 — LLM eval | `bun run test:evals` | 单独约 ~$0.15 | 用 LLM-as-judge 评估生成的 SKILL.md 文档 |
| 2+3 | `bun run test:evals` | 合计约 ~$4 | 同时运行 E2E + LLM-as-judge |

```bash
bun test                     # 仅 Tier 1（每次 commit 都跑，<5s）
bun run test:e2e             # Tier 2：仅 E2E（需要 EVALS=1，不能嵌套在 Claude Code 里跑）
bun run test:evals           # Tier 2 + 3 一起跑（约 $4/次）
```

### Tier 1：静态校验（免费）

随着 `bun test` 自动运行，不需要 API key。

- **Skill parser tests**（`test/skill-parser.test.ts`）
  从 SKILL.md 的 bash code blocks 中提取每个 `$B` 命令，
  然后与 `browse/src/commands.ts` 中的命令注册表比对。
  用于捕获拼写错误、被移除的命令和非法 snapshot flags。
- **Skill validation tests**（`test/skill-validation.test.ts`）
  校验 SKILL.md 文件是否只引用真实存在的命令和 flags，
  并检查命令描述是否达到质量阈值。
- **Generator tests**（`test/gen-skill-docs.test.ts`）
  测试模板系统：验证占位符能否正确展开、输出是否包含 flags 的值提示
  （例如 `-d <N>`，而不是只有 `-d`），以及关键命令的增强描述是否正确。

### Tier 2：通过 `claude -p` 执行 E2E（约 ~$3.85 / 次）

它会把 `claude -p` 当作子进程启动，并使用 `--output-format stream-json --verbose`
流式读取 NDJSON，用于实时展示进度并扫描 browse errors。
这已经非常接近“这个 skill 端到端到底能不能工作”的真实验证。

```bash
# 必须在普通终端里运行，不能嵌套在 Claude Code 或 Conductor 中
EVALS=1 bun test test/skill-e2e-*.test.ts
```

- 需要通过 `EVALS=1` 显式开启，避免误触昂贵测试
- 如果当前运行环境是 Claude Code，会自动跳过（因为 `claude -p` 不能嵌套）
- 在真正消耗预算前会先检查 API 连通性，遇到 `ConnectionRefused` 会快速失败
- 实时进度输出到 stderr：`[Ns] turn T tool #C: Name(...)`
- 会保存完整 NDJSON transcripts 和失败时的 JSON 诊断文件
- 测试位于 `test/skill-e2e-*.test.ts`，runner 逻辑在 `test/helpers/session-runner.ts`

### E2E 可观测性

E2E tests 运行时，会在 `~/.gstack-dev/` 下生成机器可读的 artifacts：

| Artifact | 路径 | 用途 |
|----------|------|------|
| Heartbeat | `e2e-live.json` | 当前测试状态（每次 tool call 更新） |
| Partial results | `evals/_partial-e2e.json` | 已完成测试（即使中途中断也能保留） |
| Progress log | `e2e-runs/{runId}/progress.log` | 追加式文本日志 |
| NDJSON transcripts | `e2e-runs/{runId}/{test}.ndjson` | 每个测试的原始 `claude -p` 输出 |
| Failure JSON | `e2e-runs/{runId}/{test}-failure.json` | 测试失败时的诊断信息 |

**实时面板：** 在另一个终端运行 `bun run eval:watch`，可以看到实时 dashboard，
包含已完成测试、当前运行中的测试和成本。加 `--tail` 还可以顺带查看 progress.log 的最后 10 行。

**Eval 历史工具：**

```bash
bun run eval:list            # 列出所有 eval runs（turns、duration、cost 等）
bun run eval:compare         # 比较两次 run，展示逐测试差异与 Takeaway 解读
bun run eval:summary         # 汇总所有 run 的统计结果与每个测试的平均效率
```

**Eval comparison commentary：** `eval:compare` 会自动生成自然语言的 Takeaway 部分，
解释两次 run 有哪些变化，包括回归、提升、效率变化（更少 turns、更快、更便宜）和整体总结。
这部分逻辑由 `eval-store.ts` 中的 `generateCommentary()` 驱动。

这些 artifacts 不会被清理，而是持续累积在 `~/.gstack-dev/` 中，
便于事后排查和趋势分析。

### Tier 3：LLM-as-judge（约 ~$0.15 / 次）

使用 Claude Sonnet 从三个维度对生成的 SKILL.md 文档打分：

- **Clarity**：AI agent 是否能无歧义地理解说明？
- **Completeness**：所有命令、flags 和使用模式是否都被覆盖？
- **Actionability**：agent 是否能仅凭文档内容完成任务？

每个维度打分范围为 1-5，阈值要求是 **每一项都 ≥ 4**。
另外还包含回归测试：将生成文档与 `origin/main` 上的手写基线比较，
要求生成结果得分相同或更高。

```bash
# 需要在 .env 里配置 ANTHROPIC_API_KEY —— bun run 测试:evals 会自动用到
```

- 使用 `claude-sonnet-4-6` 以获得更稳定的评分
- 测试文件位于 `test/skill-llm-eval.test.ts`
- 直接调用 Anthropic API，而不是通过 `claude -p`，因此可以在任何环境中运行，包括 Claude Code 内部

### CI

GitHub Action（`.github/workflows/skill-docs.yml`）会在每次 push 与 PR 上运行
`bun run gen:skill-docs --dry-run`。如果生成后的 SKILL.md 与仓库中提交的版本不一致，CI 就会失败。
这样能在合并前提前发现文档陈旧问题。

测试是直接对 browse binary 运行的，不依赖 dev mode。

## 编辑 技能.md 文件

`SKILL.md` 文件是从 `.tmpl` 模板**生成**的。
不要直接编辑 `.md`，否则你的改动会在下一次构建时被覆盖。

```bash
# 1. 先改模板
vim SKILL.md.tmpl              # 或 browse/SKILL.md.tmpl

# 2. 为两个宿主重新生成
bun run gen:skill-docs
bun run gen:skill-docs --host codex

# 3. 检查健康状态（同时覆盖 Claude 和 Codex）
bun run skill:check

# 或者直接用 watch 模式，在保存时自动重新生成
bun run dev:skill
```

关于模板编写最佳实践（例如优先自然语言、动态分支探测、`{{BASE_BRANCH_DETECT}}` 的用法），
请查看 `CLAUDE.md` 中的 “Writing SKILL templates” 一节。

若要添加 browse command，请修改 `browse/src/commands.ts`。
若要添加 snapshot flag，请修改 `browse/src/snapshot.ts` 中的 `SNAPSHOT_FLAGS`。
然后重新构建。

## 双宿主开发（Claude + Codex）

gstack 会为两个宿主生成 SKILL.md 文件：**Claude**（`.claude/skills/`）
和 **Codex**（`.agents/skills/`）。任何模板改动都必须同时为两边重新生成。

### 为两个宿主生成

```bash
# 生成 Claude 输出（默认）
bun run gen:skill-docs

# 生成 Codex 输出
bun run gen:skill-docs --host codex
# --host agents 也是 --host codex 的别名

# 或者直接用 构建，一次做完生成 + 二进制编译
bun run build
```

### 两个宿主的差异

| 方面 | Claude | Codex |
|------|--------|-------|
| 输出目录 | `{skill}/SKILL.md` | `.agents/skills/gstack-{skill}/SKILL.md`（在 setup 时生成，gitignored） |
| Frontmatter | 完整（name、description、allowed-tools、hooks、version） | 精简（只保留 name + description） |
| 路径 | `~/.claude/skills/gstack` | `$GSTACK_ROOT`（仓库中为 `.agents/skills/gstack`，否则为 `~/.codex/skills/gstack`） |
| Hook skills | 用 `hooks:` frontmatter（由 Claude 强制执行） | 使用内嵌安全提示文本（只做 advisory） |
| `/codex` skill | 包含（Claude 会包装 codex exec） | 不包含（避免自引用） |

### 测试 Codex 输出

```bash
# 运行全部静态测试（包含 Codex 校验）
bun test

# 检查两个宿主的文档新鲜度
bun run gen:skill-docs --dry-run
bun run gen:skill-docs --host codex --dry-run

# 健康面板同样覆盖两个宿主
bun run skill:check
```

### `.agents/` 的 dev setup

当你运行 `bin/dev-setup` 时，它会同时在 `.claude/skills/` 和 `.agents/skills/`
里创建 symlinks（如果适用），这样 Codex-compatible agents 也能发现你的开发版 skills。
`.agents/` 目录是在 setup 时根据 `.tmpl` 模板生成的，它被 gitignore，不会提交。

### 添加新 技能

当你新增一个 skill template 时，两个宿主都会自动获得它：
1. 创建 `{skill}/SKILL.md.tmpl`
2. 运行 `bun run gen:skill-docs`（Claude 输出）和 `bun run gen:skill-docs --host codex`（Codex 输出）
3. 动态模板发现机制会自动识别，无需手动维护静态列表
4. 提交 `{skill}/SKILL.md` 即可，`.agents/` 会在 setup 时动态生成且被 gitignore

## Conductor workspaces

如果你使用 [Conductor](https://conductor.build) 并行运行多个 Claude Code sessions，
`conductor.json` 会自动接管 workspace 生命周期：

| Hook | 脚本 | 作用 |
|------|------|------|
| `setup` | `bin/dev-setup` | 复制主工作树 `.env`、安装依赖、创建 skill symlinks |
| `archive` | `bin/dev-teardown` | 删除 skill symlinks，清理 `.claude/` 目录 |

当 Conductor 创建新的 workspace 时，`bin/dev-setup` 会自动执行。
它会通过 `git worktree list` 找到主工作树，复制 `.env` 使 API keys 也能带过去，
并自动进入 dev mode，不需要额外手动操作。

**首次设置：** 把 `ANTHROPIC_API_KEY` 写进主仓库的 `.env`（参见 `.env.example`）。
之后每个 Conductor workspace 都会自动继承这份配置。

## 需要知道的事

- **SKILL.md 文件是生成的。** 请改 `.tmpl` 模板，不要直接改 `.md`。修改后运行 `bun run gen:skill-docs` 重新生成。
- **TODOS.md 是统一 backlog。** 它按 skill / component 组织，并带有 P0-P4 优先级。`/ship` 会自动识别已完成项。所有 planning / review / retro skills 都会读取它作为上下文。
- **browse 源码改动后必须重建。** 如果你改了 `browse/src/*.ts`，务必运行 `bun run build`。
- **dev mode 会遮蔽全局安装。** 项目本地 skills 的优先级高于 `~/.claude/skills/gstack`。运行 `bin/dev-teardown` 才会恢复到全局版本。
- **Conductor workspaces 彼此独立。** 每个 workspace 都是单独的 git worktree。`bin/dev-setup` 会通过 `conductor.json` 自动执行。
- **`.env` 会跨 worktrees 传播。** 只需在主仓库设置一次，所有 Conductor workspaces 都会继承。
- **`.claude/skills/` 已被 gitignore。** 这些 symlinks 不会被提交。

## 在真实项目中测试你的改动

**这是开发 gstack 的推荐方式。** 把你的 gstack checkout symlink 到你真正使用它的项目中，
这样你在做真实工作时，改动就会立即生效。

### 第 1 步：symlink 你的 checkout

```bash
# 在你的核心项目里（不是 gstack 仓库）
ln -sfn /path/to/your/gstack-checkout .claude/skills/gstack
```

### 第 2 步：运行 setup，创建每个 技能 的 symlink

只有 `gstack` 这个 symlink 还不够。Claude Code 是通过单独的 skill symlinks
（如 `qa -> gstack/qa`、`ship -> gstack/ship`）来发现 skills 的，
而不是直接扫 `gstack/` 目录。所以你还需要运行 `./setup`：

```bash
cd .claude/skills/gstack && bun install && bun run build && ./setup
```

`setup` 会询问你想使用短名称（如 `/qa`）还是带前缀名称（如 `/gstack-qa`）。
你的选择会保存到 `~/.gstack/config.yaml`，以后自动记住。
如果不想交互，可以传 `--no-prefix`（短名称）或 `--prefix`（带前缀）。

### 第 3 步：开始开发

修改模板、运行 `bun run gen:skill-docs`，下一次 `/review` 或 `/qa`
调用时就会立即用上新版本，不需要重启。

### 回到稳定的全局安装

删除项目本地的 symlink，Claude Code 就会回退到 `~/.claude/skills/gstack/`：

```bash
rm .claude/skills/gstack
```

每个 skill 的 symlink（如 `qa`、`ship`）依然会指向 `gstack/...`，
因此它们会自动解析到全局安装版本。

### 切换前缀模式

如果你之前用一种前缀模式 vendored gstack，现在想切换：

```bash
cd .claude/skills/gstack && ./setup --no-prefix   # 切换为 /qa、/ship
cd .claude/skills/gstack && ./setup --prefix      # 切换为 /gstack-qa、/gstack-ship
```

`setup` 会自动清理旧 symlinks，不需要手动处理。

### 另一种方式：让全局安装直接指向某个分支

如果你不想在项目里做 symlink，也可以直接切换全局安装：

```bash
cd ~/.claude/skills/gstack
git fetch origin
git checkout origin/<branch>
bun install && bun run build && ./setup
```

这样会影响所有项目。若要恢复：
`git checkout main && git pull && bun run build && ./setup`

## 社区 PR 批处理（wave process）

当社区 PR 积累较多时，可以按主题波次处理：

1. **分类**：按主题分组（security、features、infra、docs）
2. **去重**：如果两个 PR 修的是同一类问题，优先保留改动更少的那个。关闭另一个，并在评论里说明被谁替代。
3. **Collector branch**：创建 `pr-wave-N`，先合并干净 PR，再为脏 PR 手动解决冲突，最后运行 `bun test && bun run build` 验证
4. **带着上下文关闭**：每个被关闭的 PR 都应得到解释，说明原因以及是否被别的 PR 取代。贡献者花了时间，要尊重他们的工作。
5. **作为一个 PR 发回 main**：把这一波统一整理成单个 PR 发回 main，同时保留 merge commits 中的 attribution。PR 描述里最好包含一个汇总表，说明哪些合并、哪些关闭。

可以参考 [PR #205](../../pull/205)（v0.8.3）作为第一轮 wave 的示例。

## 发布你的改动

当你对自己的 skill 修改满意之后：

```bash
/ship
```

它会运行测试、审查 diff、处理 Greptile comments（含两层升级机制）、维护 TODOS.md、
bump version，并打开一个 PR。完整流程见 `ship/SKILL.md`。
