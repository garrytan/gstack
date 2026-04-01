# gstack 开发说明

## 命令

```bash
bun install          # 安装依赖
bun test             # 运行免费测试（browse + snapshot + skill 校验）
bun run test:evals   # 运行付费 eval：LLM judge + E2E（基于 diff，单次最多约 $4）
bun run test:evals:all  # 无论 diff 如何都运行全部付费 eval
bun run test:gate    # 只跑 gate 层测试（CI 默认，阻断合并）
bun run test:periodic  # 只跑 periodic 层测试（每周 cron / 手动）
bun run test:e2e     # 只跑 E2E 测试（基于 diff，单次最多约 $3.85）
bun run test:e2e:all # 无论 diff 如何都运行全部 E2E 测试
bun run eval:select  # 展示基于当前 diff 会运行哪些测试
bun run dev <cmd>    # 用开发模式运行 CLI，例如 bun run dev goto https://example.com
bun run build        # 生成文档 + 编译二进制
bun run gen:skill-docs  # 从模板重新生成 SKILL.md 文件
bun run skill:check  # 所有 skill 的健康看板
bun run dev:skill    # watch 模式：文件变更后自动重新生成并校验
bun run eval:list    # 列出 ~/.gstack-dev/evals/ 中的所有 eval 运行记录
bun run eval:compare # 比较两次 eval 运行（默认自动选最新两次）
bun run eval:summary # 汇总所有 eval 运行统计
```

`test:evals` 需要 `ANTHROPIC_API_KEY`。Codex E2E 测试（`test/codex-e2e.test.ts`）
使用 `~/.codex/` 中的 Codex 自有鉴权，不需要 `OPENAI_API_KEY` 环境变量。
E2E 测试会实时流式输出进度（通过 `--output-format stream-json --verbose` 逐工具输出）。
结果会持久化到 `~/.gstack-dev/evals/`，并自动与上一次运行做对比。

**基于 diff 的测试选择：** `test:evals` 和 `test:e2e` 会根据相对于 base branch 的 `git diff` 自动挑选测试。每个测试在 `test/helpers/touchfiles.ts` 中声明自己的文件依赖。对全局 touchfile（如 `session-runner`、`eval-store`、`touchfiles.ts` 本身）的改动会触发所有测试。使用 `EVALS_ALL=1` 或 `:all` 变体可以强制运行全部测试。执行 `eval:select` 可以预览将会跑哪些测试。

**双层系统：** 测试会在 `E2E_TIERS`（位于 `test/helpers/touchfiles.ts`）中被标记为 `gate` 或 `periodic`。CI 只运行 gate 测试（`EVALS_TIER=gate`）；periodic 测试则通过每周 cron 或手动方式运行。使用 `EVALS_TIER=gate` 或 `EVALS_TIER=periodic` 进行筛选。新增 E2E 测试时，按下面标准分类：

1. 是安全护栏或确定性的功能测试？→ `gate`
2. 是质量基准、Opus 模型测试，或非确定性测试？→ `periodic`
3. 依赖外部服务（Codex、Gemini）？→ `periodic`

## 测试

```bash
bun test             # 每次提交前都跑，免费，<2s
bun run test:evals   # 发版前运行，付费，基于 diff（单次最多约 $4）
```

`bun test` 会运行 skill 校验、`gen-skill-docs` 质量检查，以及 browse 集成测试。
`bun run test:evals` 会运行基于 LLM-judge 的质量 eval 和通过 `claude -p` 启动的 E2E 测试。
在创建 PR 前，这两个都必须通过。

## 项目结构

```
gstack/
├── browse/          # Headless 浏览器 CLI（Playwright）
│   ├── src/         # CLI + server + commands
│   │   ├── commands.ts  # 命令注册表（单一真实来源）
│   │   └── snapshot.ts  # SNAPSHOT_FLAGS 元数据数组
│   ├── test/        # 集成测试 + fixtures
│   └── dist/        # 编译后的二进制
├── scripts/         # 构建与 DX 工具
│   ├── gen-skill-docs.ts  # 模板 → SKILL.md 生成器
│   ├── resolvers/   # 模板解析模块（preamble、design、review 等）
│   ├── skill-check.ts     # 健康看板
│   └── dev-skill.ts       # watch 模式
├── test/            # Skill 校验 + eval 测试
│   ├── helpers/     # skill-parser.ts、session-runner.ts、llm-judge.ts、eval-store.ts
│   ├── fixtures/    # Ground truth JSON、种植 bug 的 fixture、eval baseline
│   ├── skill-validation.test.ts  # Tier 1：静态校验（免费，<1s）
│   ├── gen-skill-docs.test.ts    # Tier 1：生成器质量（免费，<1s）
│   ├── skill-llm-eval.test.ts   # Tier 3：LLM-as-judge（约 $0.15 / 次）
│   └── skill-e2e-*.test.ts       # Tier 2：通过 claude -p 做 E2E（约 $3.85 / 次，按类别拆分）
├── qa-only/         # /qa-only skill（只出报告，不修复）
├── plan-design-review/  # /plan-design-review skill（只出报告的设计审计）
├── design-review/    # /design-review skill（设计审计 + 修复循环）
├── ship/            # Ship 工作流 skill
├── review/          # PR review skill
├── plan-ceo-review/ # /plan-ceo-review skill
├── plan-eng-review/ # /plan-eng-review skill
├── autoplan/        # /autoplan skill（自动 review 流水线：CEO → design → eng）
├── benchmark/       # /benchmark skill（性能回归检测）
├── canary/          # /canary skill（发布后监控循环）
├── codex/           # /codex skill（通过 OpenAI Codex CLI 获得多 AI second opinion）
├── land-and-deploy/ # /land-and-deploy skill（merge → deploy → canary verify）
├── office-hours/    # /office-hours skill（YC Office Hours，创业诊断 + builder brainstorm）
├── investigate/     # /investigate skill（系统化根因排查）
├── retro/           # 复盘 skill（包含 /retro 的全局跨项目模式）
├── bin/             # CLI 工具（gstack-repo-mode、gstack-slug、gstack-config 等）
├── document-release/ # /document-release skill（ship 后文档更新）
├── cso/             # /cso skill（基于 OWASP Top 10 + STRIDE 的安全审计）
├── design-consultation/ # /design-consultation skill（从零开始做设计系统）
├── design-shotgun/  # /design-shotgun skill（视觉设计探索）
├── connect-chrome/  # /connect-chrome skill（带侧边面板的 headed Chrome）
├── design/          # 设计二进制 CLI（GPT Image API）
│   ├── src/         # CLI + commands（generate、variants、compare、serve 等）
│   ├── test/        # 集成测试
│   └── dist/        # 编译后的二进制
├── extension/       # Chrome 扩展（侧边面板 + 活动流 + CSS 检查器）
├── lib/             # 共享库（worktree.ts）
├── docs/designs/    # 设计文档
├── setup-deploy/    # /setup-deploy skill（一次性部署配置）
├── .github/         # CI 工作流 + Docker 镜像
│   ├── workflows/   # evals.yml（Ubicloud 上跑 E2E）、skill-docs.yml、actionlint.yml
│   └── docker/      # Dockerfile.ci（预置工具链 + Playwright/Chromium）
├── setup            # 一次性安装：构建二进制 + 创建 skill symlink
├── SKILL.md         # 由 SKILL.md.tmpl 生成（不要直接编辑）
├── SKILL.md.tmpl    # 模板：改这个，然后运行 gen:skill-docs
├── ETHOS.md         # Builder 哲学（Boil the Lake、Search Before Building）
└── package.json     # browse 的构建脚本
```

## 技能.md 工作流

SKILL.md 文件是从 `.tmpl` 模板**生成**出来的。要更新文档：

1. 编辑 `.tmpl` 文件（例如 `SKILL.md.tmpl` 或 `browse/SKILL.md.tmpl`）
2. 运行 `bun run gen:skill-docs`（或者运行 `bun run build`，它会自动做）
3. 同时提交 `.tmpl` 文件和生成出的 `.md` 文件

要新增一个 browse 命令：把它加到 `browse/src/commands.ts` 并重新构建。  
要新增一个 snapshot flag：把它加到 `browse/src/snapshot.ts` 中的 `SNAPSHOT_FLAGS`，然后重新构建。

**SKILL.md 文件上的 merge conflict：** 永远不要直接在生成出来的 SKILL.md 文件上选某一边解决冲突。正确做法是：

1. 在 `.tmpl` 模板和 `scripts/gen-skill-docs.ts`（真实来源）上解决冲突
2. 运行 `bun run gen:skill-docs`，重新生成所有 SKILL.md 文件
3. 把重新生成的文件加入暂存

如果直接接受一边的生成结果，另一边模板中的改动会被静默丢掉。

## 平台无关设计

skill 永远不应该硬编码框架特定的命令、文件模式或目录结构。正确顺序是：

1. **读取 CLAUDE.md**，获取项目特定配置（测试命令、eval 命令等）
2. **如果缺失，就 AskUserQuestion**，要么让用户告诉你，要么让 gstack 去搜索仓库
3. **把答案写回 CLAUDE.md**，这样以后就不用再问

这适用于测试命令、eval 命令、部署命令，以及任何其他项目特定行为。项目自己拥有配置，gstack 只负责读取。

## 编写 技能 模板

SKILL.md.tmpl 文件是 **给 Claude 读取的 prompt 模板**，不是 bash 脚本。
每个 bash 代码块都在独立 shell 中执行，变量不会跨代码块保留。

规则：

- **用自然语言表达逻辑与状态。** 不要用 shell 变量在多个代码块之间传状态。应该用 prose 告诉 Claude 需要记住什么，例如“第 0 步检测到的 base branch”。
- **不要硬编码分支名。** 通过 `gh pr view` 或 `gh repo view` 动态检测 `main` / `master` 等。面向 PR 的 skill 使用 `{{BASE_BRANCH_DETECT}}`。在 prose 里说 “the base branch”，在代码块占位里写 `<base>`。
- **让 bash 块自包含。** 每个代码块都应该能独立运行。如果需要上一步上下文，就在上方 prose 中重新说明。
- **条件判断用英语表达。** 不要在 bash 里堆 `if/elif/else`，改用编号式决策步骤，例如“1. If X, do Y. 2. Otherwise, do Z.”

## 浏览器交互

当你需要操作浏览器（QA、dogfooding、cookie 设置）时，使用 `/browse` skill，或者直接通过 `$B <command>` 调用 browse 二进制。**绝不要使用** `mcp__claude-in-chrome__*` 工具，它们又慢又不稳定，也不是本项目的正式路径。

## Vendored symlink 感知

在开发 gstack 时，`.claude/skills/gstack` 可能是一个指回当前工作目录的 symlink（且被 gitignore）。这意味着 skill 改动会**立刻生效**，这对于快速迭代很好，但在做大重构时也很危险，因为半写好的 skill 可能会影响其他正在用 gstack 的 Claude Code 会话。

**每个会话检查一次：** 运行 `ls -la .claude/skills/gstack`，确认它是 symlink 还是一份真实拷贝。如果它是一个指向当前工作目录的 symlink，需要知道：

- 模板改动 + `bun run gen:skill-docs` 会立即影响所有 gstack 调用
- 对 `SKILL.md.tmpl` 的破坏性修改会影响并发中的 gstack 会话
- 做大重构时，可以先移除 symlink（`rm .claude/skills/gstack`），这样会回退到使用全局安装 `~/.claude/skills/gstack/`

**前缀设置：** skill symlink 既可以用短名（`qa -> gstack/qa`），也可以用带命名空间前缀的名字（`gstack-qa -> gstack/qa`），由 `~/.gstack/config.yaml` 中的 `skill_prefix` 控制。把 gstack vendoring 到项目里时，在完成 symlink 后运行 `./setup`，这样会按你的偏好创建各 skill 的 symlink。传 `--no-prefix` 或 `--prefix` 可以跳过交互式提示。

**对 plan review 而言：** 当你审查那些会修改 skill template 或 `gen-skill-docs` 流水线的计划时，要考虑这些改动是否应该先隔离测试，再对真实环境生效，尤其是当用户在其他窗口里还在 actively 使用 gstack 时。

## 编译后二进制 —— 永远不要提交 `browse/dist/` 或 `design/dist/`

`browse/dist/` 和 `design/dist/` 目录里包含编译后的 Bun 二进制（`browse`、`find-browse`、`design`，每个约 58MB）。这些文件是 Mach-O arm64 only，只能跑在 Apple Silicon 上，**不能** 在 Linux、Windows 或 Intel Mac 上运行。`./setup` 脚本本来就会在每个平台从源码重新构建，因此把这些二进制提交进仓库完全是冗余的。它们之所以还被 git 跟踪，只是历史原因，最终应该通过 `git rm --cached` 清掉。

**绝不要暂存或提交这些文件。** 它们之所以会在 `git status` 中显示为 modified，是因为历史上已经被跟踪了，尽管 `.gitignore` 里已经忽略它们。暂存文件时，永远显式指定文件名（`git add file1 file2`），不要 `git add .` 或 `git add -A`，否则很容易把这些二进制一并带进去。

## 提交风格

**永远做可二分的提交。** 每个 commit 都应该只包含一个逻辑变化。只要你做了多件事（例如重命名 + 重写 + 新增测试），就要在 push 前拆成多个独立 commit。每个 commit 都应该可以被单独理解，也可以被单独回滚。

好的拆分例子：

- 重命名 / 移动 与 行为改动 分开提交
- 测试基础设施（`touchfiles`、helpers）与 测试实现 分开提交
- 模板变更 与 生成文件刷新 分开提交
- 机械性重构 与 新功能 分开提交

当用户说 “bisect commit” 或 “bisect and push” 时，要把 staged / unstaged 改动拆成多个逻辑 commit 再 push。

## 社区 PR 护栏

在审查或合并社区 PR 时，**只要触及以下任何情况，都必须先 AskUserQuestion 再决定是否接受：**

1. **修改 `ETHOS.md`**，这是 Garry 的个人 builder 哲学。外部贡献者或 AI agent 一律不能直接改。
2. **删除或弱化宣传性内容**，YC 引用、创始人视角和产品语气都是刻意保留的。凡是把这些内容说成“不必要”或“太宣传”的 PR，都必须拒绝。
3. **改变 Garry 的语气**，skill 模板、CHANGELOG、文档中的口吻、幽默感、直接性和视角都不是通用文案。任何试图把它改得更“中性”或更“专业”的 PR，都必须拒绝。

即使 agent 非常确定某个改动“对项目更好”，以上三类也必须通过 AskUserQuestion 获取用户明确批准。没有例外。不能自动合并。也不能“顺手帮你清理一下”。

## CHANGELOG + VERSION 风格

**VERSION 和 CHANGELOG 都是按分支作用域管理的。** 每个发版的 feature branch 都要有自己的版本号提升和 CHANGELOG 条目。条目写的是“这个分支新增了什么”，不是 `main` 里已经有了什么。

**什么时候写 CHANGELOG 条目：**

- 在 `/ship` 阶段的第 5 步写，不是在开发中途。
- 条目应该覆盖这个分支相对 base branch 的全部提交。
- 永远不要把新工作折叠进一个已经落到 `main` 的旧版本条目里。如果 `main` 上已经有 `v0.10.0.0`，而你的分支新增了功能，就应该升到 `v0.10.1.0` 并写一个新条目，不要去改旧的 `v0.10.0.0` 条目。

**写之前必须先问自己：**

1. 我当前在哪个分支？这个分支到底改了什么？
2. base branch 上的那个版本是不是已经发布了？如果是，就应该 bump 并写新条目。
3. 这个分支上是否已经有一个旧条目覆盖了更早的一部分工作？如果有，就把它替换成一个对应最终版本的统一条目。

**合并 `main` 不等于继承 `main` 的版本号。** 当你把 `origin/main` 合并到 feature branch 时，`main` 可能带来更高版本和新的 CHANGELOG 条目。但你的分支仍然必须在其之上再 bump 出一个**自己的**版本。如果 `main` 已经到 `v0.13.8.0`，而你的分支又新增了功能，就应该写成 `v0.13.9.0` 并新增一个条目。绝不要把你的改动塞进一个已经在 `main` 落地的条目里。你的条目应当排在最上方，因为你的分支是下一次落地。

**合并 main 之后，务必检查：**

- CHANGELOG 里是否有属于你这个分支的独立条目，而不是混进 main 的条目里？
- VERSION 是否高于 main 的 VERSION？
- 你的条目是否位于 CHANGELOG 的最顶部（高于 main 最新条目）？

只要有一个答案是否定的，先修好再继续。

**凡是对 CHANGELOG 做了移动、增加或删除条目，** 都必须立刻运行
`grep "^## \[" CHANGELOG.md`，确认完整版本序列连续，没有缺口，也没有重复，再提交。只要有版本缺失，就说明这次编辑破坏了顺序，必须先修复。

CHANGELOG.md 是**写给用户看**的，不是写给贡献者看的。写法要像产品 release notes：

- 开头要先说用户现在**能做什么**，而不是实现细节。
- 用通俗语言，不要写实现细节。用 “You can now...” 而不是 “Refactored the...”
- **绝不要提 `TODOS.md`、内部跟踪、eval 基础设施、贡献者视角的细节。** 这些对用户不可见，也毫无意义。
- 贡献者 / 内部变更，单独放在文末的 “For contributors” 部分。
- 每个条目都要让人产生“哦，这个不错，我想试试”的感觉。
- 不要写术语，比如不要写 “AskUserQuestion format standardized across skill templates via preamble resolver”，要写“每次提问现在都会明确告诉你当前处在哪个项目和分支”。

## AI 工作量压缩

在估算或讨论工作量时，总是同时给出人工团队时间和 CC+gstack 时间：

| 任务类型 | 人工团队 | CC+gstack | 压缩比 |
|-----------|-----------|-----------|-------------|
| 样板代码 / 脚手架 | 2 天 | 15 分钟 | ~100x |
| 写测试 | 1 天 | 15 分钟 | ~50x |
| 功能实现 | 1 周 | 30 分钟 | ~30x |
| Bug 修复 + 回归测试 | 4 小时 | 15 分钟 | ~20x |
| 架构 / 设计 | 2 天 | 4 小时 | ~5x |
| 研究 / 探索 | 1 天 | 3 小时 | ~3x |

完整实现的边际成本已经很低。只要完整实现是一个“湖”（可达成），而不是一个“海”（多季度迁移），就不要推荐捷径。完整哲学见 skill preamble 里的 Completeness Principle。

## 先搜索，再构建

在设计任何涉及并发、陌生模式、基础设施，或者运行时 / 框架可能已经内建支持的方案之前，先做三件事：

1. 搜索 `"{runtime} {thing} built-in"`
2. 搜索 `"{thing} best practice {current year}"`
3. 检查官方 runtime / framework 文档

知识分三层：已验证可靠（Layer 1）、新且流行（Layer 2）、第一性原理（Layer 3）。其中最重视 Layer 3。完整 builder 哲学见 `ETHOS.md`。

## 本地 plans

贡献者可以把长期愿景文档和设计文档放在 `~/.gstack-dev/plans/`。这些文件只存在本地，不会提交进仓库。审查 `TODOS.md` 时，也要检查 `plans/` 里是否有某些内容已经成熟，适合提升为 TODO 或直接实现。

## E2E eval 失败归因协议

当 `/ship` 或其他流程中的 E2E eval 失败时，**绝不能在没有证据的前提下说“这和我们的改动无关”。** 这类系统存在大量隐性耦合，改了 preamble 文本就可能影响 agent 行为，新增 helper 也可能改变时序，重新生成 SKILL.md 也会改变 prompt 上下文。

**在把失败归因为“历史遗留问题”之前，必须满足：**

1. 在 `main`（或 base branch）上运行同一个 eval，并证明它在那里也失败
2. 如果它在 `main` 上通过，但在当前分支失败，那就是你的改动导致的。继续追责来源。
3. 如果你跑不了 `main`，那就明确写 “unverified — may or may not be related”，并在 PR 描述里把它列为风险

没有证据就说“历史遗留”是偷懒。要么证明，要么别说。

## 长时间任务：不要放弃

运行 eval、E2E 测试或任何长时间后台任务时，**必须轮询直到完成**。做法是使用 `sleep 180 && echo "ready"`，并结合 `TaskOutput` 每 3 分钟轮询一次。不要切到阻塞模式后等超时就放弃。也不要说“完成后我会收到通知”然后停止检查。除非用户明确叫停，否则就持续轮询直到任务结束。

完整 E2E 套件可能需要 30-45 分钟，也就是 10-15 个轮询周期。全部都要跑完。每次检查都要汇报进度（哪些测试通过了，哪些还在跑，到目前为止有哪些失败）。用户要看到的是实际跑完，而不是你承诺“稍后再看”。

## E2E 测试 fixture：只提取，不复制

**绝不要把完整 SKILL.md 文件复制进 E2E 测试 fixture。** 一个 SKILL.md 文件通常有 1500-2000 行。`claude -p` 读取这么大的文件会导致上下文膨胀，进而带来 timeout、turn limit 抖动，以及测试耗时暴涨到原来的 5-10 倍。

正确做法是，只提取测试真正需要的那一段：

```typescript
// BAD — agent 读 1900 行，把 token 浪费在无关部分，容易超时
fs.copyFileSync(path.join(ROOT, 'ship', 'SKILL.md'), path.join(dir, 'ship-SKILL.md'));

// GOOD — agent 只读 ~60 行，38 秒结束，而不是超时
const full = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
const start = full.indexOf('## Review Readiness Dashboard');
const end = full.indexOf('\n---\n', start);
fs.writeFileSync(path.join(dir, 'ship-SKILL.md'), full.slice(start, end > start ? end : undefined));
```

另外，在为排查失败而运行定向 E2E 测试时：

- 用**前台模式**运行（`bun test ...`），不要后台跑再配 `&` 和 `tee`
- 永远不要 `pkill` 一个正在运行的 eval 再重启，这会丢结果，还会浪费钱
- 一次干净的完整运行，胜过三次被杀掉重来的运行

## 部署到当前激活的 技能

当前激活的 skill 位于 `~/.claude/skills/gstack/`。改完之后：

1. push 你的分支
2. 在 skill 目录里 fetch 并 reset：`cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`
3. 重新构建：`cd ~/.claude/skills/gstack && bun run build`

或者直接复制二进制：

- `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`
- `cp design/dist/design ~/.claude/skills/gstack/design/dist/design`
