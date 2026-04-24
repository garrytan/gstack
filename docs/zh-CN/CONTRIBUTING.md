# 为 gstack 做贡献

感谢愿意让 gstack 变得更好。无论是在 skill prompt 里修一个 typo，还是构建一整套全新的 workflow，这份指南都会帮助快速完成环境准备并开始动手。

## 快速开始

gstack 的 skills 是 Claude Code 从 `skills/` 目录中发现的 Markdown 文件。正常情况下，它们位于 `~/.claude/skills/gstack/`（也就是全局安装位置）。但当正在开发 gstack 本身时，需要让 Claude Code 直接使用**当前工作树中的 skills**——这样编辑一保存就能立刻生效，不需要复制，也不需要重新部署。

这就是 dev mode 的作用。它会把当前仓库 symlink 到本地 `.claude/skills/` 目录中，这样 Claude Code 读取的就是当前 checkout 里的 skills。

```bash
git clone <repo> && cd gstack
bun install                    # install dependencies
bin/dev-setup                  # activate dev mode
```

现在，只要编辑任意一个 `SKILL.md`，然后在 Claude Code 中调用它（例如 `/review`），就能立刻看到改动生效。开发完成后：

```bash
bin/dev-teardown               # deactivate — back to your global install
```

## 运行层面的自我改进

gstack 会自动从失败中学习。在每次 skill session 结束时，agent 都会回顾哪里出了问题（CLI errors、错误的方法、项目特有的怪癖），并把这些运行层面的经验记录到 `~/.gstack/projects/{slug}/learnings.jsonl` 中。未来的会话会自动读取这些 learnings，因此随着时间推移，gstack 会越来越熟悉你的代码库。

无需额外设置。learnings 会自动记录。可以通过 `/learn` 查看。

### Contributor workflow

1. **正常使用 gstack** —— 运行层面的 learnings 会被自动记录
2. **检查自己的 learnings：** `/learn` 或 `ls ~/.gstack/projects/*/learnings.jsonl`
3. **Fork 并 clone gstack**（如果还没做）
4. **把自己的 fork symlink 到实际遇到问题的项目里：**
   ```bash
   # In your core project (the one where gstack annoyed you)
   ln -sfn /path/to/your/gstack-fork .claude/skills/gstack
   cd .claude/skills/gstack && bun install && bun run build && ./setup
   ```
   Setup 会为每个 skill 创建对应目录，并在里面放置指向 `SKILL.md` 的 symlink（例如 `qa/SKILL.md -> gstack/qa/SKILL.md`），同时询问想使用哪种 prefix 模式。传入 `--no-prefix` 可以跳过提示并使用短名称。
5. **修复问题** —— 改动会立刻在这个项目里生效
6. **通过真实使用 gstack 来测试** —— 重新执行那个当初让人不爽的操作，确认问题已经修好
7. **从 fork 提交一个 PR**

这是最好的贡献方式：在真正工作的项目里，一边做自己的事，一边顺手把让人烦躁的 gstack 问题修掉。

### Session awareness

当同时打开 3 个以上 gstack session 时，每个问题都会明确告诉你当前是哪个项目、哪个分支、正在发生什么。再也不用盯着一个提问发愣：“等等，这是哪个窗口？” 这种格式会在所有 skills 中保持一致。

## 在 gstack 仓库内部开发 gstack

当正在编辑 gstack skills，并且希望直接在同一个仓库里使用 gstack 来测试它们时，`bin/dev-setup` 会自动完成 wiring。它会创建 `.claude/skills/` symlinks（已被 gitignore），并让这些链接指回当前工作树，这样 Claude Code 用的就是本地编辑版本，而不是全局安装版本。

```text
gstack/                          <- your working tree
├── .claude/skills/              <- created by dev-setup (gitignored)
│   ├── gstack -> ../../         <- symlink back to repo root
│   ├── review/                  <- real directory (short name, default)
│   │   └── SKILL.md -> gstack/review/SKILL.md
│   ├── ship/                    <- or gstack-review/, gstack-ship/ if --prefix
│   │   └── SKILL.md -> gstack/ship/SKILL.md
│   └── ...                      <- one directory per skill
├── review/
│   └── SKILL.md                 <- edit this, test with /review
├── ship/
│   └── SKILL.md
├── browse/
│   ├── src/                     <- TypeScript source
│   └── dist/                    <- compiled binary (gitignored)
└── ...
```

Setup 会在顶层创建真实目录（而不是 symlink），并在这些目录内部放置一个指向 `SKILL.md` 的 symlink。这样 Claude 才会把它们识别为顶层 skill，而不是 `gstack/` 目录下的嵌套内容。名称取决于 prefix 设置（`~/.gstack/config.yaml`）。默认使用短名称（例如 `/review`、`/ship`）。如果更喜欢带命名空间的名称（例如 `/gstack-review`、`/gstack-ship`），可以运行 `./setup --prefix`。

## 日常工作流

```bash
# 1. Enter dev mode
bin/dev-setup

# 2. Edit a skill
vim review/SKILL.md

# 3. Test it in Claude Code — changes are live
#    > /review

# 4. Editing browse source? Rebuild the binary
bun run build

# 5. Done for the day? Tear down
bin/dev-teardown
```

## 测试与评估

### Setup

```bash
# 1. Copy .env.example and add your API key
cp .env.example .env
# Edit .env → set ANTHROPIC_API_KEY=sk-ant-...

# 2. Install deps (if you haven't already)
bun install
```

Bun 会自动加载 `.env` —— 不需要额外配置。Conductor workspaces 也会自动继承主 worktree 中的 `.env`（见下文 “Conductor workspaces”）。

### 测试层级

| Tier | Command | Cost | 测试内容 |
|------|---------|------|----------|
| 1 — Static | `bun test` | Free | 命令校验、snapshot flags、SKILL.md 正确性、TODOS-format.md 引用、可观测性单元测试 |
| 2 — E2E | `bun run test:e2e` | ~$3.85 | 通过 `claude -p` 子进程执行完整 skill |
| 3 — LLM eval | `bun run test:evals` | ~$0.15 standalone | 使用 LLM-as-judge 对生成的 SKILL.md 文档进行评分 |
| 2+3 | `bun run test:evals` | ~$4 combined | E2E + LLM-as-judge（两者一起运行） |

```bash
bun test                     # Tier 1 only (runs on every commit, <5s)
bun run test:e2e             # Tier 2: E2E only (needs EVALS=1, can't run inside Claude Code)
bun run test:evals           # Tier 2 + 3 combined (~$4/run)
```

### Tier 1：静态校验（免费）

通过 `bun test` 自动运行。不需要 API key。

- **Skill parser tests**（`test/skill-parser.test.ts`）—— 从 `SKILL.md` 的 bash code blocks 中提取所有 `$B` 命令，并与 `browse/src/commands.ts` 中的命令注册表进行校验。可以抓出 typo、已移除命令和非法 snapshot flags。
- **Skill validation tests**（`test/skill-validation.test.ts`）—— 校验 `SKILL.md` 文件是否只引用真实存在的命令和 flags，并检查命令说明是否达到质量阈值。
- **Generator tests**（`test/gen-skill-docs.test.ts`）—— 测试模板系统：验证占位符是否正确解析，输出是否包含 flag 的取值提示（例如 `-d <N>` 而不仅是 `-d`），以及关键命令的描述是否足够丰富（例如 `is` 会列出合法状态，`press` 会列出按键示例）。

### Tier 2：通过 `claude -p` 执行 E2E（约 $3.85/次）

它会把 `claude -p` 作为子进程启动，并带上 `--output-format stream-json --verbose`，以流式方式读取 NDJSON 获得实时进度，同时扫描 browse errors。这已经非常接近“这个 skill 到底能不能端到端真的跑起来”。

```bash
# Must run from a plain terminal — can't nest inside Claude Code or Conductor
EVALS=1 bun test test/skill-e2e-*.test.ts
```

- 通过 `EVALS=1` 环境变量启用（防止不小心跑昂贵测试）
- 如果检测到当前运行在 Claude Code 内部，会自动跳过（因为 `claude -p` 不能嵌套）
- 带有 API connectivity pre-check —— 在真正烧预算前先快速失败，例如 `ConnectionRefused`
- 实时把进度输出到 stderr：`[Ns] turn T tool #C: Name(...)`
- 会保存完整 NDJSON transcript 和 failure JSON，方便调试
- 测试文件位于 `test/skill-e2e-*.test.ts`（按类别拆分），runner 逻辑位于 `test/helpers/session-runner.ts`

### E2E 可观测性

当 E2E 测试运行时，会在 `~/.gstack-dev/` 中生成可机器读取的 artifacts：

| Artifact | Path | Purpose |
|----------|------|---------|
| Heartbeat | `e2e-live.json` | 当前测试状态（每次 tool call 后更新） |
| Partial results | `evals/_partial-e2e.json` | 已完成测试（即使进程被杀也能保留） |
| Progress log | `e2e-runs/{runId}/progress.log` | 追加式文本日志 |
| NDJSON transcripts | `e2e-runs/{runId}/{test}.ndjson` | 每个测试对应的原始 `claude -p` 输出 |
| Failure JSON | `e2e-runs/{runId}/{test}-failure.json` | 失败时的诊断数据 |

**实时 dashboard：** 在第二个终端运行 `bun run eval:watch`，即可看到一个实时 dashboard，显示已完成测试、当前正在运行的测试以及成本。加上 `--tail` 还可以额外显示 `progress.log` 的最后 10 行。

**Eval history 工具：**

```bash
bun run eval:list            # list all eval runs (turns, duration, cost per run)
bun run eval:compare         # compare two runs — shows per-test deltas + Takeaway commentary
bun run eval:summary         # aggregate stats + per-test efficiency averages across runs
```

**Eval comparison commentary：** `eval:compare` 会生成自然语言的 Takeaway 段落，对两次运行之间发生的变化做解释——标出回退、说明改进、指出效率收益（回合更少、更快、更便宜），并给出整体总结。这个功能由 `eval-store.ts` 中的 `generateCommentary()` 驱动。

Artifacts 永远不会被清理——它们会持续累积在 `~/.gstack-dev/` 中，用于事后调试和趋势分析。

### Tier 3：LLM-as-judge（约 $0.15/次）

使用 Claude Sonnet 对生成的 `SKILL.md` 文档从三个维度打分：

- **Clarity** —— AI agent 能否在没有歧义的情况下理解这些说明？
- **Completeness** —— 所有命令、flags 和使用模式是否都已记录？
- **Actionability** —— agent 是否能仅凭这份文档完成任务？

每个维度打分范围为 1-5。阈值要求：每一个维度都必须 **≥ 4**。此外还有一个 regression test，会把生成的文档与 `origin/main` 中人工维护的 baseline 做对比——生成版本的分数必须相同或更高。

```bash
# Needs ANTHROPIC_API_KEY in .env — included in bun run test:evals
```

- 使用 `claude-sonnet-4-6` 来获得更稳定的评分结果
- 测试文件位于 `test/skill-llm-eval.test.ts`
- 直接调用 Anthropic API（而不是 `claude -p`），所以无论在何处都能运行，包括 Claude Code 内部

### CI

一个 GitHub Action（`.github/workflows/skill-docs.yml`）会在每次 push 和 PR 上运行 `bun run gen:skill-docs --dry-run`。如果生成出来的 `SKILL.md` 与仓库中已提交版本不一致，CI 就会失败。这样可以在合并前抓住过期文档。

测试是直接针对 browse binary 运行的——不依赖 dev mode。

## 编辑 SKILL.md 文件

`SKILL.md` 文件是从 `.tmpl` 模板**生成**出来的。不要直接编辑 `.md` 文件——下一次 build 时，改动会被覆盖。

```bash
# 1. Edit the template
vim SKILL.md.tmpl              # or browse/SKILL.md.tmpl

# 2. Regenerate for all hosts
bun run gen:skill-docs --host all

# 3. Check health (reports all hosts)
bun run skill:check

# Or use watch mode — auto-regenerates on save
bun run dev:skill
```

关于模板编写的最佳实践（例如偏向自然语言而不是 bash-isms、动态分支检测、`{{BASE_BRANCH_DETECT}}` 的使用方式），请参见 `CLAUDE.md` 中的 “Writing SKILL templates” 小节。

如果要添加一个 browse command，请把它加到 `browse/src/commands.ts`。如果要添加一个 snapshot flag，请把它加到 `browse/src/snapshot.ts` 中的 `SNAPSHOT_FLAGS`。之后重新 build 即可。

## 多宿主开发

gstack 会从同一套 `.tmpl` 模板为 8 个 host 生成 `SKILL.md` 文件。每个 host 都是 `hosts/*.ts` 里的一个 typed config。生成器会读取这些配置，产出适配对应 host 的输出（包括不同的 frontmatter、路径和工具名称）。

**支持的 hosts：** Claude（主）、Codex、Factory、Kiro、OpenCode、Slate、Cursor、OpenClaw。

### 为所有 hosts 生成文档

```bash
# Generate for a specific host
bun run gen:skill-docs                    # Claude (default)
bun run gen:skill-docs --host codex       # Codex
bun run gen:skill-docs --host opencode    # OpenCode
bun run gen:skill-docs --host all         # All 8 hosts

# Or use build, which does all hosts + compiles binaries
bun run build
```

### 不同 host 之间会变化的内容

每个 host 配置（`hosts/*.ts`）会控制：

| Aspect | Example (Claude vs Codex) |
|--------|---------------------------|
| Output directory | `{skill}/SKILL.md` vs `.agents/skills/gstack-{skill}/SKILL.md` |
| Frontmatter | 完整版（name、description、hooks、version） vs 精简版（仅 name + description） |
| Paths | `~/.claude/skills/gstack` vs `$GSTACK_ROOT` |
| Tool names | “use the Bash tool” vs 相同（Factory 会改写成 “run this command”） |
| Hook skills | `hooks:` frontmatter vs 行内 safety advisory prose |
| Suppressed sections | 无 vs Codex 会去掉 self-invocation 相关段落 |

完整的 `HostConfig` 接口请见 `scripts/host-config.ts`。

### 测试 host 输出

```bash
# Run all static tests (includes parameterized smoke tests for all hosts)
bun test

# Check freshness for all hosts
bun run gen:skill-docs --host all --dry-run

# Health dashboard covers all hosts
bun run skill:check
```

### 添加一个新的 host

完整指南请见 [docs/ADDING_A_HOST.md](docs/ADDING_A_HOST.md)。简要流程如下：

1. 创建 `hosts/myhost.ts`（可从 `hosts/opencode.ts` 复制）
2. 将其加入 `hosts/index.ts`
3. 把 `.myhost/` 加进 `.gitignore`
4. 运行 `bun run gen:skill-docs --host myhost`
5. 运行 `bun test`（参数化测试会自动覆盖它）

不需要修改 generator、setup 或其他 tooling 代码。

### 添加一个新的 skill

当添加一个新的 skill 模板时，所有 hosts 都会自动获得它：

1. 创建 `{skill}/SKILL.md.tmpl`
2. 运行 `bun run gen:skill-docs --host all`
3. 动态模板发现机制会自动识别它，不需要更新静态列表
4. 提交 `{skill}/SKILL.md`；外部 host 的输出会在 setup 时生成，并已被 gitignore

## Conductor workspaces

如果正在使用 [Conductor](https://conductor.build) 并行运行多个 Claude Code 会话，那么 `conductor.json` 会自动处理 workspace lifecycle：

| Hook | Script | What it does |
|------|--------|-------------|
| `setup` | `bin/dev-setup` | 从主 worktree 复制 `.env`、安装依赖、创建 skill symlinks |
| `archive` | `bin/dev-teardown` | 删除 skill symlinks，清理 `.claude/` 目录 |

当 Conductor 创建一个新的 workspace 时，`bin/dev-setup` 会自动运行。它会检测主 worktree（通过 `git worktree list`），复制 `.env`，这样 API keys 也会被带过去，并自动启用 dev mode —— 不需要手动操作。

**首次设置：** 把 `ANTHROPIC_API_KEY` 写进主仓库的 `.env`（参见 `.env.example`）。之后每一个 Conductor workspace 都会自动继承它。

## 需要知道的事

- **`SKILL.md` 文件是生成出来的。** 请编辑 `.tmpl` 模板，而不是 `.md`。运行 `bun run gen:skill-docs` 重新生成。
- **`TODOS.md` 是统一 backlog。** 它按 skill / component 组织，并带有 P0-P4 优先级。`/ship` 会自动检测已完成项。所有 planning / review / retro skills 都会读取它作为上下文。
- **修改 browse source 后需要重新 build。** 如果动了 `browse/src/*.ts`，请运行 `bun run build`。
- **dev mode 会覆盖全局安装。** 项目本地的 skills 优先级高于 `~/.claude/skills/gstack`。运行 `bin/dev-teardown` 可以恢复全局版本。
- **Conductor workspaces 彼此独立。** 每个 workspace 都是独立的 git worktree。`bin/dev-setup` 会通过 `conductor.json` 自动运行。
- **`.env` 会在多个 worktree 之间传播。** 只需在主仓库设置一次，所有 Conductor workspaces 都会获得它。
- **`.claude/skills/` 已被 gitignore。** 这些 symlinks 不会被提交进仓库。

## 在真实项目中测试改动

**这是推荐的 gstack 开发方式。** 把当前 gstack checkout symlink 到实际使用它的项目中，这样在做真实工作时，改动会立刻生效。

### 第 1 步：给 checkout 建立 symlink

```bash
# In your core project (not the gstack repo)
ln -sfn /path/to/your/gstack-checkout .claude/skills/gstack
```

### 第 2 步：运行 setup，为每个 skill 创建 symlink

仅仅有 `gstack` 这个 symlink 还不够。Claude Code 发现 skills 的方式，是通过单独的顶层目录（例如 `qa/SKILL.md`、`ship/SKILL.md`），而不是通过 `gstack/` 目录本身。所以还需要运行 `./setup` 来生成这些目录：

```bash
cd .claude/skills/gstack && bun install && bun run build && ./setup
```

Setup 会询问要使用短名称（`/qa`）还是带命名空间的名称（`/gstack-qa`）。选择会保存到 `~/.gstack/config.yaml` 中，并在未来运行时被记住。若想跳过提示，可以传入 `--no-prefix`（短名称）或 `--prefix`（带命名空间）。

### 第 3 步：开始开发

编辑模板，运行 `bun run gen:skill-docs`，随后下一次 `/review` 或 `/qa` 调用就会立即读取到改动。不需要重启。

### 回到稳定的全局安装

移除项目本地 symlink 即可。Claude Code 会自动退回到 `~/.claude/skills/gstack/`：

```bash
rm .claude/skills/gstack
```

每个 skill 的目录（`qa/`、`ship/` 等）内部包含的 `SKILL.md` symlink 都是指向 `gstack/...` 的，所以它们会自动解析回全局安装版本。

### 切换 prefix 模式

如果最初安装 gstack 时使用了一种 prefix 设置，而现在想切换：

```bash
cd .claude/skills/gstack && ./setup --no-prefix   # switch to /qa, /ship
cd .claude/skills/gstack && ./setup --prefix       # switch to /gstack-qa, /gstack-ship
```

Setup 会自动清理旧的 symlinks，不需要手动删除。

### 另一种方式：让全局安装指向某个分支

如果不想使用项目级 symlink，也可以直接切换全局安装：

```bash
cd ~/.claude/skills/gstack
git fetch origin
git checkout origin/<branch>
bun install && bun run build && ./setup
```

这会影响所有项目。想恢复时，运行：`git checkout main && git pull && bun run build && ./setup`。

## 社区 PR 分流（wave process）

当社区 PR 积累到一定数量后，可以按主题分批处理：

1. **Categorize** —— 按主题分组（security、features、infra、docs）
2. **Deduplicate** —— 如果两个 PR 修的是同一个问题，选改动行数更少的那个。关闭另一个，并留言指出被哪个 PR 替代。
3. **Collector branch** —— 创建 `pr-wave-N`，合并干净的 PR，对有冲突的 PR 进行手动解决，然后通过 `bun test && bun run build` 验证
4. **Close with context** —— 每个被关闭的 PR 都要附带评论，解释为什么关闭、以及是否被其他内容取代。贡献者确实做了真实工作；应该用清晰沟通给予尊重。
5. **Ship as one PR** —— 最终只向 main 提一个 PR，并通过 merge commits 保留所有 attribution。PR 里附上一张 summary table，说明哪些被合并、哪些被关闭。

可以参考 [PR #205](../../pull/205)（v0.8.3）作为第一轮 wave 的示例。

## 升级迁移

当一次发布会修改磁盘上的状态（例如目录结构、配置格式、旧文件残留），并且这些变化无法仅靠 `./setup` 修复时，就应该添加 migration script，以便现有用户在升级时得到干净的结果。

### 什么时候需要加 migration

- 改变了 skill 目录的创建方式（symlink vs real dirs）
- 重命名或移动了 `~/.gstack/config.yaml` 里的配置项
- 需要删除旧版本遗留下来的孤儿文件
- 改变了 `~/.gstack/` 状态文件的格式

以下情况**不需要**加 migration：新功能（用户会自动获得）、新 skill（setup 会自动发现）、纯代码改动（不会影响磁盘状态）。

### 如何添加一个 migration

1. 创建 `gstack-upgrade/migrations/v{VERSION}.sh`，其中 `{VERSION}` 要与需要修复的那个发布版本的 VERSION 文件一致。
2. 赋予可执行权限：`chmod +x gstack-upgrade/migrations/v{VERSION}.sh`
3. 脚本必须满足两个要求：**幂等**（可安全重复运行）以及 **non-fatal**（失败会被记录，但不会阻塞升级）。
4. 在文件顶部加一段注释，说明改了什么、为什么需要 migration、以及哪些用户会受影响。

示例：

```bash
#!/usr/bin/env bash
# Migration: v0.15.2.0 — Fix skill directory structure
# Affected: users who installed with --no-prefix before v0.15.2.0
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
"$SCRIPT_DIR/bin/gstack-relink" 2>/dev/null || true
```

### 它是如何运行的

在 `/gstack-upgrade` 期间，`./setup` 完成之后（Step 4.75），upgrade skill 会扫描 `gstack-upgrade/migrations/`，并按版本顺序运行所有比用户旧版本更新的 `v*.sh` 脚本。失败会被记录，但绝不会阻塞升级流程。

### 测试 migrations

migrations 作为 `bun test`（tier 1，免费）的一部分进行测试。测试套件会验证 `gstack-upgrade/migrations/` 中的所有 migration scripts 都具有可执行权限，并且能在没有语法错误的情况下被解析。

## 发布改动

当对 skill 的改动已经满意时：

```bash
/ship
```

这会运行测试、审查 diff、分流 Greptile 评论（带 2-tier escalation）、管理 `TODOS.md`、提升版本号，并打开一个 PR。完整流程请参见 `ship/SKILL.md`。
