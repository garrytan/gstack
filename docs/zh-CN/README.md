# gstack

[English](../../README.md) | [中文](README.md)

> "我想从去年十二月起基本上就没怎么敲过代码了，这是一个极其巨大的改变。" —— [Andrej Karpathy](https://fortune.com/2026/03/21/andrej-karpathy-openai-cofounder-ai-agents-coding-state-of-psychosis-openclaw/)，No Priors 播客，2026年3月

听到 Karpathy 这么说，我就想弄明白：怎么做到的？一个人怎么能干出二十个人的活？Peter Steinberger 基本上靠 AI 智能体一个人做出了 [OpenClaw](https://github.com/openclaw/openclaw)——GitHub 24.7 万颗星。革命已经来临。一个有正确工具的独立开发者，可以比传统团队移动更快。

我是 [Garry Tan](https://x.com/garrytan)，[Y Combinator](https://www.ycombinator.com/) 总裁兼 CEO。我与数千家初创公司一起工作过——Coinbase、Instacart、Rippling——那时它们都还是两三个人在车库里摸爬滚打。加入 YC 之前，我是 Palantir 最早的工程师/PM/设计师之一，联合创办了 Posterous（后被 Twitter 收购），并构建了 YC 的内部社交网络 Bookface。

**gstack 是我的答案。** 我做产品已经二十年了，而现在我发布产品的速度比以往任何时候都快。过去 60 天里：3 个生产服务、40 多个已发布功能，兼职完成，同时全职运营 YC。以逻辑代码变更计算（而非被 AI 虚增的原始行数），我 2026 年的出产速度是 **2013 年的约 810 倍**（每天 11,417 行 vs 14 行）。截至今年 4 月 18 日，2026 年已经产出了 **相当于 2013 年全年的 240 倍**。数据来自 40 个公开及私有 `garrytan/*` 仓库（包括 Bookface），排除了一个演示仓库。绝大部分代码由 AI 写出。重点不在谁敲了键盘，而在于发布了什么。

> LOC 批评者说原始行数在 AI 时代会膨胀，这没错。但他们错了的是：通货膨胀调整后，我的生产力并没有下降。相反，高出了很多。完整方法论、注意事项及复现脚本：**[关于 LOC 争议](docs/ON_THE_LOC_CONTROVERSY.md)**。

**2026 年——1,237 次代码提交，仍在持续增加：**

![2026年 GitHub 贡献——1,237次提交，1月至3月加速显著](docs/images/github-2026.png)

**2013 年——我在 YC 构建 Bookface 时（772 次提交）：**

![2013年 GitHub 贡献——772次提交，构建 Bookface at YC](docs/images/github-2013.png)

同一个人。不同的时代。差别在于工具。

**gstack 就是我的做法。** 它把 Claude Code 变成一支虚拟工程团队——一位 CEO 重新思考产品，一位工程经理锁定架构，一位设计师找出 AI 糟粕，一位评审者发现生产 Bug，一位 QA 负责人打开真实浏览器，一位安全官执行 OWASP + STRIDE 审计，一位发布工程师提交 PR。二十三位专家加八项强大工具，全部用斜杠命令，全部是 Markdown，全部免费，MIT 协议。

这是我的开源软件工厂。我每天都在用。我把它分享出来，因为这些工具应该人人可用。

Fork 它，改进它，让它成为你自己的。如果你想喷一款免费的开源软件——随便，但我希望你先用一用再说。

**适合哪些人：**
- **创始人和 CEO**——尤其是那些仍然想亲自发布产品的技术型领导者
- **初次使用 Claude Code 的用户**——有了结构化角色，不再对着空白提示词发呆
- **技术负责人和高级工程师**——在每个 PR 上执行严格的评审、QA 和发布自动化

## 快速上手

1. 安装 gstack（30 秒——见下文）
2. 运行 `/office-hours`——描述你在构建什么
3. 对任何功能想法运行 `/plan-ceo-review`
4. 对任何有改动的分支运行 `/review`
5. 对你的预发布 URL 运行 `/qa`
6. 停在这里。你会自己判断这东西适不适合你。

## 安装——30 秒

**前置要求：** [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Git](https://git-scm.com/)、[Bun](https://bun.sh/) v1.0+、[Node.js](https://nodejs.org/)（仅 Windows）

### 第一步：安装到本机

打开 Claude Code 并粘贴以下内容。Claude 会搞定剩下的事。

> 安装 gstack：运行 **`git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`**，然后在 CLAUDE.md 中添加 "gstack" 章节，说明所有网页浏览均使用 gstack 的 /browse 技能，永远不用 mcp\_\_claude-in-chrome\_\_\* 工具，并列出可用技能：/office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /setup-gbrain, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn。然后询问用户是否也希望把 gstack 加入当前项目，让队友也能使用。

### 第二步：团队模式——共享仓库自动更新（推荐）

从你的仓库内粘贴以下内容。切换到团队模式，初始化仓库使队友自动获得 gstack，并提交变更：

```bash
(cd ~/.claude/skills/gstack && ./setup --team) && ~/.claude/skills/gstack/bin/gstack-team-init required && git add .claude/ CLAUDE.md && git commit -m "require gstack for AI-assisted work"
```

无需在仓库内引入任何文件，不会出现版本漂移，无需手动升级。每次 Claude Code 会话启动时都会执行快速自动更新检查（每小时最多一次，网络故障安全，完全静默）。

将 `required` 换成 `optional`，可以改为建议队友使用而不是强制。

### OpenClaw

OpenClaw 通过 ACP 启动 Claude Code 会话，因此只要 Claude Code 安装了 gstack，所有 gstack 技能都可以直接使用。将以下内容粘贴给你的 OpenClaw 智能体：

> 安装 gstack：运行 `git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`，为 Claude Code 安装 gstack。然后在 AGENTS.md 中添加 "Coding Tasks" 章节，说明：当为编程任务启动 Claude Code 会话时，告诉该会话使用 gstack 技能。包含以下示例——安全审计："Load gstack. Run /cso"；代码评审："Load gstack. Run /review"；QA 测试某个 URL："Load gstack. Run /qa https://..."；端到端构建一个功能："Load gstack. Run /autoplan, implement the plan, then run /ship"；先计划再构建："Load gstack. Run /office-hours then /autoplan. Save the plan, don't implement."

**安装后，只需自然地和你的 OpenClaw 智能体对话：**

| 你说的话 | 发生什么 |
|---------|---------|
| "修复 README 里的错别字" | 简单任务——Claude Code 会话，无需 gstack |
| "对这个仓库做安全审计" | 启动 Claude Code，带 `Run /cso` |
| "帮我做一个通知功能" | 启动 Claude Code，/autoplan → 实现 → /ship |
| "帮我规划 v2 API 重设计" | 启动 Claude Code，/office-hours → /autoplan，保存计划 |

高级分发路由和 gstack-lite/gstack-full 提示模板，请参阅 [docs/OPENCLAW.md](docs/OPENCLAW.md)。

### 原生 OpenClaw 技能（通过 ClawHub）

四个方法论技能，可以直接在你的 OpenClaw 智能体中运行，无需 Claude Code 会话。从 ClawHub 安装：

```
clawhub install gstack-openclaw-office-hours gstack-openclaw-ceo-review gstack-openclaw-investigate gstack-openclaw-retro
```

| 技能 | 功能 |
|-----|-----|
| `gstack-openclaw-office-hours` | 产品质询，6 个强制性问题 |
| `gstack-openclaw-ceo-review` | 战略挑战，4 种范围模式 |
| `gstack-openclaw-investigate` | 根因调试方法论 |
| `gstack-openclaw-retro` | 每周工程回顾 |

这些是对话式技能，你的 OpenClaw 智能体通过聊天直接运行它们。

### 其他 AI 智能体

gstack 支持 10 款 AI 编程智能体，不仅仅是 Claude。安装程序会自动检测你已安装的智能体：

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/gstack
cd ~/gstack && ./setup
```

或使用 `./setup --host <name>` 指定特定智能体：

| 智能体 | 参数 | 技能安装路径 |
|-------|------|------------|
| OpenAI Codex CLI | `--host codex` | `~/.codex/skills/gstack-*/` |
| OpenCode | `--host opencode` | `~/.config/opencode/skills/gstack-*/` |
| Cursor | `--host cursor` | `~/.cursor/skills/gstack-*/` |
| Factory Droid | `--host factory` | `~/.factory/skills/gstack-*/` |
| Slate | `--host slate` | `~/.slate/skills/gstack-*/` |
| Kiro | `--host kiro` | `~/.kiro/skills/gstack-*/` |
| Hermes | `--host hermes` | `~/.hermes/skills/gstack-*/` |
| GBrain (mod) | `--host gbrain` | `~/.gbrain/skills/gstack-*/` |

**想添加其他智能体的支持？** 请参阅 [docs/ADDING_A_HOST.md](docs/ADDING_A_HOST.md)。只需一个 TypeScript 配置文件，零代码改动。

## 看它运行

```
你：    我想做一个日历每日简报 App。
你：    /office-hours
Claude：[追问痛点——具体案例，不是假设场景]

你：    多个 Google 日历，活动信息过时，地点错误。
        准备工作要花很长时间，结果又不够好……

Claude：我要质疑一下你的框架。你说的是"每日简报 App"。
        但你描述的，实际上是一个私人 AI 参谋长。
        [提炼出你没意识到自己提到的 5 项能力]
        [质疑 4 个前提——你同意、不同意或调整]
        [生成 3 种实现方案，附工作量估算]
        建议：明天就发布最窄的切入点，从真实使用中学习。
        完整愿景是个 3 个月的项目——先从真正好用的每日简报开始。
        [撰写设计文档 → 自动传给下游技能]

你：    /plan-ceo-review
        [读取设计文档，挑战范围，执行 10 节评审]

你：    /plan-eng-review
        [数据流、状态机、错误路径的 ASCII 图]
        [测试矩阵、故障模式、安全顾虑]

你：    批准计划，退出计划模式。
        [在 11 个文件中写了 2,400 行代码，约 8 分钟。]

你：    /review
        [自动修复] 2 个问题。[询问] 竞态条件 → 你批准修复。

你：    /qa https://staging.myapp.com
        [打开真实浏览器，点击流程，发现并修复 Bug]

你：    /ship
        测试：42 → 51（新增 9 个）。PR：github.com/you/app/pull/42
```

你说的是"每日简报 App"。智能体说的是"你在构建一个 AI 参谋长"——因为它听的是你的痛点，不是你的功能需求。八条命令，端到端搞定。这不是一个副驾驶，这是一支团队。

## 冲刺流程

gstack 是一个流程，不是一堆工具的集合。技能按照冲刺的顺序运行：

**思考 → 计划 → 构建 → 评审 → 测试 → 发布 → 复盘**

每个技能都为下一个提供输入。`/office-hours` 写出的设计文档由 `/plan-ceo-review` 读取。`/plan-eng-review` 写出的测试计划由 `/qa` 接手。`/review` 发现的 Bug，`/ship` 会验证已修复。没有任何东西会掉进缝隙，因为每一步都知道前面发生了什么。

| 技能 | 你的专家 | 他们做什么 |
|-----|---------|-----------|
| `/office-hours` | **YC 创业指导** | 从这里开始。六个强制性问题，在你写代码之前重新框架你的产品。质疑你的框架，挑战前提，生成实现方案。设计文档自动传给所有下游技能。|
| `/plan-ceo-review` | **CEO / 创始人** | 重新思考问题。找出需求背后的 10 星产品。四种模式：扩展、选择性扩展、保持范围、缩减。|
| `/plan-eng-review` | **工程经理** | 锁定架构、数据流、图表、边界情况和测试。把隐藏的假设逼到台面上。|
| `/plan-design-review` | **高级设计师** | 对每个设计维度评 0-10 分，说明 10 分是什么样，然后编辑计划达到目标。AI 糟粕检测。交互式——每个设计决策一个 AskUserQuestion。|
| `/plan-devex-review` | **开发者体验负责人** | 交互式 DX 评审：探索开发者画像，对标竞品 TTHW，设计你的魔法时刻，逐步追踪摩擦点。三种模式：DX 扩展、DX 打磨、DX 分类。20-45 个强制性问题。|
| `/design-consultation` | **设计合伙人** | 从零构建完整设计系统。研究行业现状，提出创意风险，生成真实产品原型。|
| `/review` | **高级工程师** | 找出通过 CI 却在生产中爆炸的 Bug。自动修复明显问题，标记完整性缺口。|
| `/investigate` | **调试器** | 系统性根因调试。铁律：没有调查就没有修复。追踪数据流，验证假设，3 次修复失败后停下来。|
| `/design-review` | **会写代码的设计师** | 与 /plan-design-review 相同的审计，然后修复发现的问题。原子提交，修改前后截图对比。|
| `/devex-review` | **DX 测试员** | 实时开发者体验审计。真实测试你的引导流程：浏览文档，尝试 Getting Started，计时 TTHW，截图报错。与 `/plan-devex-review` 分数对比——检验计划与现实是否一致的回旋镖。|
| `/design-shotgun` | **设计探索员** | "给我看看选项。" 生成 4-6 个 AI 原型变体，在浏览器中打开对比看板，收集你的反馈，并进行迭代。品味记忆学习你的偏好。反复直到你喜欢某个，然后交给 `/design-html`。|
| `/design-html` | **设计工程师** | 把原型变成真正能用的生产 HTML。使用 Pretext 计算布局：文本在调整大小时真正重排，高度随内容调整，布局是动态的。30KB，零依赖。检测 React/Svelte/Vue。根据设计类型智能路由 API（落地页 vs 仪表盘 vs 表单）。输出是可发布的，不是演示。|
| `/qa` | **QA 负责人** | 测试你的应用，发现 Bug，用原子提交修复，重新验证。为每个修复自动生成回归测试。|
| `/qa-only` | **QA 报告员** | 与 /qa 方法论相同，但仅报告。纯 Bug 报告，不修改代码。|
| `/pair-agent` | **多智能体协调员** | 与任何 AI 智能体共享你的浏览器。一条命令，一次粘贴，立即连接。支持 OpenClaw、Hermes、Codex、Cursor 或任何能 curl 的工具。每个智能体拥有自己的标签页。自动启动有头模式让你观看全过程。自动启动 ngrok 隧道供远程智能体使用。作用域令牌、标签页隔离、速率限制、活动归因。|
| `/cso` | **首席安全官** | OWASP Top 10 + STRIDE 威胁模型。零噪音：17 个误报排除项，8/10+ 置信度门控，独立发现验证。每个发现包含具体利用场景。|
| `/ship` | **发布工程师** | 同步主干，运行测试，审计覆盖率，推送，开 PR。如果你没有测试框架，从零引导搭建。|
| `/land-and-deploy` | **发布工程师** | 合并 PR，等待 CI 和部署，验证生产健康状态。从"已审批"到"生产验证"，一条命令搞定。|
| `/canary` | **SRE** | 部署后监控循环。监控控制台错误、性能回退和页面故障。|
| `/benchmark` | **性能工程师** | 基准页面加载时间、核心网页指标和资源大小。在每个 PR 上做前后对比。|
| `/document-release` | **技术写作者** | 更新所有项目文档以匹配你刚发布的内容。自动捕捉过时的 README。|
| `/retro` | **工程经理** | 团队感知的每周回顾。逐人分析，发布连续记录，测试健康趋势，成长机会。`/retro global` 跨所有项目和 AI 工具（Claude Code、Codex、Gemini）运行。|
| `/browse` | **QA 工程师** | 给智能体一双眼睛。真实的 Chromium 浏览器，真实的点击，真实的截图。每条命令约 100ms。`/open-gstack-browser` 启动带有侧边栏、反机器人伪装和自动模型路由的 GStack 浏览器。|
| `/setup-browser-cookies` | **会话管理器** | 从你的真实浏览器（Chrome、Arc、Brave、Edge）导入 Cookie 到无头会话。测试需要登录的页面。|
| `/autoplan` | **评审流水线** | 一条命令，完整的评审计划。自动运行 CEO → 设计 → 工程评审，内置决策原则。只把品味决策浮出来让你审批。|
| `/learn` | **记忆** | 管理 gstack 跨会话学到的内容。回顾、搜索、修剪和导出项目专属的模式、陷阱和偏好。学习在会话间积累，让 gstack 对你的代码库越来越聪明。|

### 我应该用哪种评审？

| 构建对象... | 计划阶段（写代码前） | 上线审计（发布后） |
|------------|---------------------|------------------|
| **终端用户**（UI、Web App、移动端） | `/plan-design-review` | `/design-review` |
| **开发者**（API、CLI、SDK、文档） | `/plan-devex-review` | `/devex-review` |
| **架构**（数据流、性能、测试） | `/plan-eng-review` | `/review` |
| **以上全部** | `/autoplan`（自动运行 CEO → 设计 → 工程 → DX，自动检测适用项） | — |

### 强力工具

| 技能 | 功能 |
|-----|-----|
| `/codex` | **第二意见**——来自 OpenAI Codex CLI 的独立代码评审。三种模式：评审（通过/失败门控）、对抗性挑战（主动尝试破解你的代码）、持续会话的开放式咨询。当 `/review`（Claude）和 `/codex`（OpenAI）都评审了同一分支时，提供跨模型分析，显示哪些发现重叠，哪些是各自独有的。|
| `/careful` | **安全护栏**——在破坏性命令前发出警告（rm -rf、DROP TABLE、强制推送）。说"be careful"即可激活。可覆盖任何警告。|
| `/freeze` | **编辑锁定**——把文件编辑限制在一个目录内。防止调试时意外修改无关代码。|
| `/guard` | **完全安全**——一条命令同时激活 `/careful` + `/freeze`。生产工作的最高安全模式。|
| `/unfreeze` | **解锁**——移除 `/freeze` 边界。|
| `/open-gstack-browser` | **GStack 浏览器**——启动带侧边栏、反机器人伪装、自动模型路由（Sonnet 执行操作，Opus 做分析）、一键 Cookie 导入和 Claude Code 集成的 GStack 浏览器。清理页面，智能截图，编辑 CSS，将信息回传到你的终端。|
| `/setup-deploy` | **部署配置器**——`/land-and-deploy` 的一次性设置。检测你的平台、生产 URL 和部署命令。|
| `/setup-gbrain` | **GBrain 引导**——5 分钟内从零到运行 gbrain。PGLite 本地模式、Supabase 现有 URL 或通过 Management API 自动创建新 Supabase 项目。为 Claude Code 注册 MCP，加上每仓库信任三元组（读写/只读/拒绝）。[完整指南](USING_GBRAIN_WITH_GSTACK.md)。|
| `/sync-gbrain` | **保持大脑最新**——通过 `gbrain sources add` + `gbrain sync --strategy code` 将该仓库代码重新索引到 gbrain，刷新 CLAUDE.md 中的 `## GBrain Search Guidance` 块，并在能力检查失败时自动删除该引导。`--incremental`（默认）、`--full`、`--dry-run`。幂等，可安全重复运行。|
| `/gstack-upgrade` | **自我更新**——升级 gstack 到最新版。自动检测全局安装 vs 项目内嵌，同步两者，显示变更内容。|

### 新增二进制工具（v0.19）

除了斜杠命令技能，gstack 还附带独立 CLI，用于不适合在会话内运行的工作流：

| 命令 | 功能 |
|-----|-----|
| `gstack-model-benchmark` | **跨模型基准测试**——用同一提示词同时跑 Claude、GPT（通过 Codex CLI）和 Gemini；对比延迟、Token 数、成本和（可选）LLM 评判质量分。每个提供商按需自动检测身份验证，不可用的提供商自动跳过。输出为表格、JSON 或 Markdown 格式。`--dry-run` 验证参数和身份验证，不消耗 API 调用。|
| `gstack-taste-update` | **设计品味学习**——将 `/design-shotgun` 中的审批和拒绝写入每项目持久化品味档案。每周衰减 5%。反馈到未来的变体生成中，让系统学会你真正的选择偏好。|

### 连续检查点模式（可选，默认本地）

设置 `gstack-config set checkpoint_mode continuous`，技能会在工作过程中以 `WIP:` 前缀加结构化 `[gstack-context]` 正文（决策、剩余工作、失败方案）自动提交你的进度。能在崩溃和上下文切换时存活。`/context-restore` 读取这些提交来重建会话状态。`/ship` 在 PR 之前过滤压缩 WIP 提交（保留非 WIP 提交），保持 bisect 干净。推送是可选项（`checkpoint_push=true`）——默认仅本地，不在每次 WIP 提交时触发 CI。

### 领域技能 + 原始 CDP 逃生舱

两个新的浏览器原语，让 gstack 智能体随时间积累进化：

- **`$B domain-skill save`**——智能体保存每站点注释（例如"LinkedIn 的申请按钮在 iframe 里"），下次访问该主机名时自动触发。经过 3 次成功使用后从隔离区升为活跃，可通过 `$B domain-skill promote-to-global` 选择性推广为全局。存储与 `/learn` 的项目学习文件并列。完整参考：**[docs/domain-skills.md](docs/domain-skills.md)**。
- **`$B cdp <Domain.method>`**——原始 Chrome DevTools Protocol 逃生舱，用于策划命令遗漏的少数情况。默认拒绝：方法必须在 `browse/src/cdp-allowlist.ts` 中明确添加，附一行理由说明。双层互斥锁将浏览器范围的 CDP 调用与每个标签页的工作串行化。数据导出方法的输出用 UNTRUSTED 信封包裹。

> 想要没有护栏、没有允许名单、没有守护进程——只是从智能体到 Chrome 的薄传输层的原始 CDP？[browser-use/browser-harness-js](https://github.com/browser-use/browser-harness-js) 是另一种理念（智能体编写辅助工具 vs gstack 的策划命令），如果你不想要 gstack 的安全堆栈，它是很好的选择。两者可以共存：gstack 的 `$B cdp` 和 harness 都可以通过 Playwright 的 `newCDPSession` 连接同一个 Chrome。

**[每个技能的深度解读，含示例和设计哲学 →](docs/skills.md)**

### Karpathy 的四大失败模式？已全部覆盖。

Andrej Karpathy 的 [AI 编程规则](https://github.com/forrestchang/andrej-karpathy-skills)（17K 星）精准指出了四大失败模式：错误假设、过度复杂、正交编辑、命令式而非声明式。gstack 的工作流技能全部涵盖。`/office-hours` 在写代码之前把假设逼到台面上。混淆协议阻止 Claude 在架构决策上猜测。`/review` 捕捉不必要的复杂性和顺手改动。`/ship` 把任务变成可验证目标，配合测试优先执行。如果你已经在使用 Karpathy 风格的 CLAUDE.md 规则，gstack 就是让这些规则在整个冲刺中都能生效的工作流执行层——而不只是在单个提示词上。

## 并行冲刺

gstack 跑一个冲刺很好用，跑十个同时运行才真正有意思。

**设计是核心。** `/design-consultation` 从零构建你的设计系统，研究行业现状，提出创意风险，写出 `DESIGN.md`。但真正的魔力在于猎枪到 HTML 的流水线。

**`/design-shotgun` 是你探索的方式。** 你描述你想要的，它用 GPT Image 生成 4-6 个 AI 原型变体，然后在浏览器中并排打开对比看板。你选出喜欢的，留下反馈（"多点留白"、"标题更粗"、"去掉渐变"），它生成新一轮。反复进行，直到你爱上某个。跑几轮之后品味记忆开始起作用，偏向你真正喜欢的风格。再也不用用文字描述你的愿景然后期望 AI 理解了。你看见选项，挑好的，视觉化迭代。

**`/design-html` 让它成真。** 拿着那个批准的原型（来自 `/design-shotgun`、CEO 计划、设计评审或者只是一段描述），把它变成生产质量的 HTML/CSS。不是那种在一个视口宽度下看起来还行、其他地方全挂的 AI HTML。这里用的是 Pretext 计算布局：文本在调整大小时真正重排，高度随内容调整，布局是动态的。30KB 开销，零依赖。检测你的框架（React、Svelte、Vue）并输出正确格式。智能 API 路由根据落地页、仪表盘、表单还是卡片布局选择不同的 Pretext 模式。输出是真正能发布的，不是演示。

**`/qa` 是一个巨大的解锁。** 它让我从 6 个并行工作流增长到 12 个。Claude Code 说出 *"我看到问题了"* 然后真的修复它、生成回归测试、验证修复——这改变了我的工作方式。智能体现在有眼睛了。

**智能评审路由。** 就像在运转良好的初创公司里：CEO 不需要看基础设施 Bug 修复，后端变更不需要设计评审。gstack 追踪已运行的评审，判断什么合适，然后做正确的事。发布就绪看板在你发布前告诉你现在的状态。

**测试一切。** `/ship` 如果你的项目没有测试框架，会从零搭建一个。每次 `/ship` 都产出覆盖率审计。每次 `/qa` Bug 修复都生成回归测试。100% 测试覆盖率是目标——测试让感觉编码变得安全，而不是无厘头瞎搞。

**`/document-release` 是你从未有过的工程师。** 它读取项目中的每个文档文件，与 diff 交叉引用，更新所有漂移的内容。README、ARCHITECTURE、CONTRIBUTING、CLAUDE.md、TODOS——全部自动保持最新。而且现在 `/ship` 会自动调用它——无需额外命令，文档保持同步。

**真实浏览器模式。** `/open-gstack-browser` 启动 GStack 浏览器——一个 AI 控制的 Chromium，带反机器人伪装、自定义品牌和内置侧边栏扩展。Google、NYTimes 等网站无需验证码即可访问。菜单栏显示 "GStack Browser" 而非 "Chrome for Testing"。你的常规 Chrome 不受影响。所有现有浏览命令无改动地继续工作。`$B disconnect` 返回无头模式。只要窗口保持打开，浏览器就保持活跃……不会在你工作时因空闲超时被杀死。

**侧边栏智能体——你的 AI 浏览器助手。** 在 Chrome 侧面板用自然语言输入，一个子 Claude 实例执行它。"导航到设置页面并截图。""用测试数据填写这个表单。""遍历这个列表中的每一项并提取价格。"侧边栏自动路由到正确的模型：Sonnet 处理快速操作（点击、导航、截图），Opus 处理阅读和分析。每个任务最多 5 分钟。侧边栏智能体在隔离会话中运行，不会干扰你的主 Claude Code 窗口。侧边栏底部一键导入 Cookie。

**个人自动化。** 侧边栏智能体不只是开发工作流。示例："浏览我孩子学校的家长门户，把所有其他家长的姓名、电话号码和照片添加到我的 Google 联系人。"有两种方式获得身份验证：（1）在有头浏览器中登录一次，你的会话持久保存；（2）点击侧边栏底部的 "cookies" 按钮从真实 Chrome 导入 Cookie。一旦认证，Claude 会导航目录，提取数据，创建联系人。

**提示注入防御。** 恶意网页试图劫持你的侧边栏智能体。gstack 提供分层防御：随浏览器捆绑的 22MB ML 分类器在本地扫描每个页面和工具输出；Claude Haiku 转录检查对完整对话结构投票；系统提示中的随机金丝雀令牌跨文本、工具参数、URL 和文件写入捕捉会话劫持尝试；判决合并器要求两个分类器达成一致才会阻止（防止在 Stack Overflow 风格的指令页面上出现单模型误报）。侧边栏标题中的盾牌图标显示状态（绿/黄/红）。通过 `GSTACK_SECURITY_ENSEMBLE=deberta` 可选加入 721MB DeBERTa-v3 集成，实现 2/3 多数表决。紧急关闭：`GSTACK_SECURITY_OFF=1`。完整技术栈见 [ARCHITECTURE.md](ARCHITECTURE.md#prompt-injection-defense-sidebar-agent)。

**AI 卡住时的浏览器接管。** 遇到验证码、身份验证墙或 MFA？`$B handoff` 在完全相同的页面打开可见 Chrome，携带你所有的 Cookie 和标签页。解决问题，告诉 Claude 你完成了，`$B resume` 从原处继续。智能体在连续 3 次失败后甚至会自动建议这样做。

**`/pair-agent` 是跨智能体协调。** 你在 Claude Code 里，同时还有 OpenClaw 在运行，或者 Hermes、Codex。你想让它们都看同一个网站。输入 `/pair-agent`，选择你的智能体，一个 GStack 浏览器窗口打开，你可以观看。技能打印一段指令，把这段指令粘贴到另一个智能体的聊天框。它用一次性设置密钥换取会话令牌，创建自己的标签页，开始浏览。你看到两个智能体在同一浏览器里各自工作，每人一个标签页，互不干扰。如果安装了 ngrok，隧道会自动启动，让另一个智能体可以在完全不同的机器上。同机器的智能体有零摩擦快捷方式，直接写入凭据。这是来自不同厂商的 AI 智能体首次能够通过共享浏览器进行有真实安全保障的协调：作用域令牌、标签页隔离、速率限制、域名限制和活动归因。

**多 AI 第二意见。** `/codex` 从 OpenAI 的 Codex CLI 获取独立评审——一个完全不同的 AI 看同一个 diff。三种模式：带通过/失败门控的代码评审、主动尝试破解你代码的对抗性挑战、持续会话的开放咨询。当 `/review`（Claude）和 `/codex`（OpenAI）评审了同一分支，你会得到跨模型分析，显示哪些发现重叠，哪些是各自独有的。

**按需安全护栏。** 说"be careful"，`/careful` 会在任何破坏性命令前发出警告——rm -rf、DROP TABLE、强制推送、git reset --hard。`/freeze` 在调试时将编辑锁定在一个目录，这样 Claude 就不会意外"修复"无关代码。`/guard` 同时激活两者。`/investigate` 会自动冻结到正在调查的模块。

**主动技能建议。** gstack 注意到你所处的阶段——头脑风暴、评审、调试、测试——并推荐正确的技能。不喜欢？说"stop suggesting"，它会跨会话记住。

## 10-15 个并行冲刺

gstack 跑一个冲刺很强大。同时跑十个才是变革性的。

[Conductor](https://conductor.build) 并行运行多个 Claude Code 会话——每个都在独立的隔离工作空间。一个会话对新想法跑 `/office-hours`，另一个对 PR 做 `/review`，第三个实现功能，第四个对预发布跑 `/qa`，还有六个在其他分支上。全部同时进行。我经常同时跑 10-15 个并行冲刺——这是目前的实际上限。

冲刺结构正是让并行可行的原因。没有流程，十个智能体就是十个混乱来源。有了流程——思考、计划、构建、评审、测试、发布——每个智能体清楚地知道该做什么以及何时停下。你像 CEO 管团队一样管理它们：关注重要的决策，其余的让它们自己跑。

### 语音输入（AquaVoice、Whisper 等）

gstack 技能有语音友好的触发短语。自然地说出你的需求——"run a security check"（运行安全检查）、"test the website"（测试网站）、"do an engineering review"（做工程评审）——正确的技能就会激活。你不需要记住斜杠命令名称或缩写。

## 卸载

### 方式一：运行卸载脚本

如果 gstack 安装在你的机器上：

```bash
~/.claude/skills/gstack/bin/gstack-uninstall
```

此命令处理技能、符号链接、全局状态（`~/.gstack/`）、项目本地状态、浏览守护进程和临时文件。使用 `--keep-state` 保留配置和分析数据。使用 `--force` 跳过确认。

### 方式二：手动删除（无本地仓库）

如果你没有克隆仓库（例如通过 Claude Code 粘贴安装后删除了克隆）：

```bash
# 1. 停止浏览守护进程
pkill -f "gstack.*browse" 2>/dev/null || true

# 2. 删除指向 gstack/ 的每个技能符号链接
find ~/.claude/skills -maxdepth 1 -type l 2>/dev/null | while read -r link; do
  case "$(readlink "$link" 2>/dev/null)" in gstack/*|*/gstack/*) rm -f "$link" ;; esac
done

# 3. 删除 gstack
rm -rf ~/.claude/skills/gstack

# 4. 删除全局状态
rm -rf ~/.gstack

# 5. 删除集成（跳过从未安装的）
rm -rf ~/.codex/skills/gstack* 2>/dev/null
rm -rf ~/.factory/skills/gstack* 2>/dev/null
rm -rf ~/.kiro/skills/gstack* 2>/dev/null
rm -rf ~/.openclaw/skills/gstack* 2>/dev/null

# 6. 删除临时文件
rm -f /tmp/gstack-* 2>/dev/null

# 7. 每个项目清理（在每个项目根目录运行）
rm -rf .gstack .gstack-worktrees .claude/skills/gstack 2>/dev/null
rm -rf .agents/skills/gstack* .factory/skills/gstack* 2>/dev/null
```

### 清理 CLAUDE.md

卸载脚本不会编辑 CLAUDE.md。在每个添加了 gstack 的项目中，手动删除 `## gstack` 和 `## Skill routing` 章节。

### Playwright

`~/Library/Caches/ms-playwright/`（macOS）保持原位，因为其他工具可能共享它。如果没有其他东西需要，可以删除它。

---

免费，MIT 许可，开源。无付费版，无候补名单。

我开源了我构建软件的方式。你可以 Fork 并做成你自己的。

> **我们在招人。** 想在 AI 编程速度下发布真实产品，并帮助加固 gstack？
> 来 YC 工作——[ycombinator.com/software](https://ycombinator.com/software)
> 极具竞争力的薪资和股权。旧金山，Dogpatch 区。

## GBrain——你的编程智能体的持久知识库

[GBrain](https://github.com/garrytan/gbrain) 是 AI 智能体的持久知识库——想象成你的智能体在会话间真正保留的记忆。GStack 为你提供从零到"它在运行，我的智能体可以调用它"的一命令路径。

```bash
/setup-gbrain
```

三条路，任选一条：

- **Supabase，现有 URL**——你的云智能体已经配置了一个 brain；粘贴 Session Pooler URL，现在这台笔记本使用相同的数据。
- **Supabase，自动配置**——粘贴 Supabase Personal Access Token；技能创建新项目，轮询到健康状态，获取 pooler URL，交给 `gbrain init`。端到端约 90 秒。
- **PGLite 本地**——零账号，零网络，约 30 秒。仅在这台 Mac 上的独立 brain。适合先试用；之后用 `/setup-gbrain --switch` 迁移到 Supabase。

初始化后，技能提供为 Claude Code 注册 gbrain 为 MCP 服务器（`claude mcp add gbrain -- gbrain serve`），使 `gbrain search`、`gbrain put_page` 等作为一等类型化工具出现——而不是 bash shell 调用。

**保持 brain 最新。** 在任意仓库运行 `/sync-gbrain`，将其代码重新索引到 gbrain（默认增量，`--full` 完整重新索引，`--dry-run` 预览）。技能通过 `gbrain sources add` 将当前目录注册为联合数据源，运行 `gbrain sync --strategy code`，并向项目的 CLAUDE.md 写入 `## GBrain Search Guidance` 块，使智能体优先使用 `gbrain search`/`code-def`/`code-refs` 而非 Grep。如果能力检查失败，该块会自动删除——不会留下指向未安装工具的陈旧引导。

**每仓库信任策略。** 你机器上的每个仓库都有三个等级之一：

- `read-write`——智能体可以搜索 brain，也可以从该仓库写入新页面
- `read-only`——智能体可以搜索但不能写入（最适合多客户顾问：搜索共享 brain，不用客户 A 的工作污染在客户 B 仓库时的 brain）
- `deny`——完全不与 gbrain 交互

技能在每个仓库只问一次。决定在同一远程的所有工作树和分支上持久有效。

**GStack 记忆同步（不同功能，相同私有仓库基础设施）。** 可选将你的 gstack 状态（学习内容、CEO 计划、设计文档、回顾、开发者档案）推送到私有 git 仓库，使你的记忆跟随你跨机器使用，配一次性隐私提示（全部允许/仅产物/关闭）以及深度防御密钥扫描器，在离开机器之前阻止 AWS 密钥、令牌、PEM 块和 JWT。

```bash
gstack-brain-init
```

**完整指南——每个场景、每个参数、每个 bin 助手、每个故障排除步骤：** [USING_GBRAIN_WITH_GSTACK.md](USING_GBRAIN_WITH_GSTACK.md)

其他参考资料：[docs/gbrain-sync.md](docs/gbrain-sync.md)（同步专项指南）• [docs/gbrain-sync-errors.md](docs/gbrain-sync-errors.md)（错误索引）

## 文档

| 文档 | 内容 |
|-----|-----|
| [技能深度解读](docs/skills.md) | 每个技能的理念、示例和工作流（含 Greptile 集成） |
| [构建者精神](ETHOS.md) | 构建者哲学：煮沸湖泊、先搜索再构建、三层知识 |
| [在 GStack 中使用 GBrain](USING_GBRAIN_WITH_GSTACK.md) | `/setup-gbrain` 的每个路径、参数、bin 助手和故障排除步骤 |
| [GBrain 同步](docs/gbrain-sync.md) | 跨机器记忆设置、隐私模式、故障排除 |
| [架构](ARCHITECTURE.md) | 设计决策和系统内部原理 |
| [浏览器参考](BROWSER.md) | `/browse` 完整命令参考 |
| [贡献](CONTRIBUTING.md) | 开发设置、测试、贡献者模式和开发模式 |
| [更新日志](CHANGELOG.md) | 每个版本的新内容 |

## 隐私与遥测

gstack 包含**可选的**使用遥测以帮助改进项目。以下是具体说明：

- **默认关闭。** 除非你明确同意，否则不发送任何内容。
- **首次运行时**，gstack 会询问你是否愿意分享匿名使用数据。你可以说不。
- **如果你选择加入，发送的内容：** 技能名称、持续时间、成功/失败、gstack 版本、操作系统。仅此而已。
- **永远不发送：** 代码、文件路径、仓库名称、分支名称、提示词或任何用户生成的内容。
- **随时更改：** `gstack-config set telemetry off` 立即禁用一切。

数据存储在 [Supabase](https://supabase.com)（开源 Firebase 替代品）。Schema 在 [`supabase/migrations/`](supabase/migrations/) 中——你可以验证收集的具体内容。仓库中的 Supabase 可公开密钥是公钥（类似 Firebase API 密钥）——行级安全策略拒绝所有直接访问。遥测数据通过强制 Schema 检查、事件类型允许名单和字段长度限制的已验证边缘函数流转。

**本地分析始终可用。** 运行 `gstack-analytics` 从本地 JSONL 文件查看你的个人使用看板——无需远程数据。

## 故障排除

**技能未显示？** `cd ~/.claude/skills/gstack && ./setup`

**`/browse` 失败？** `cd ~/.claude/skills/gstack && bun install && bun run build`

**安装陈旧？** 运行 `/gstack-upgrade`——或在 `~/.gstack/config.yaml` 中设置 `auto_upgrade: true`

**想要更短的命令？** `cd ~/.claude/skills/gstack && ./setup --no-prefix`——从 `/gstack-qa` 切换到 `/qa`。你的选择会在未来升级时记住。

**想要命名空间命令？** `cd ~/.claude/skills/gstack && ./setup --prefix`——从 `/qa` 切换到 `/gstack-qa`。如果你同时运行其他技能包，这很有用。

**Codex 提示 "Skipped loading skill(s) due to invalid SKILL.md"？** 你的 Codex 技能描述已过时。修复方法：`cd ~/.codex/skills/gstack && git pull && ./setup --host codex`——或对于仓库本地安装：`cd "$(readlink -f .agents/skills/gstack)" && git pull && ./setup --host codex`

**Windows 用户：** gstack 通过 Git Bash 或 WSL 在 Windows 11 上运行。除了 Bun，还需要 Node.js——Bun 在 Windows 上的 Playwright 管道传输有已知 Bug（[bun#4253](https://github.com/oven-sh/bun/issues/4253)）。浏览服务器自动回退到 Node.js。确保 `bun` 和 `node` 都在你的 PATH 中。

**Claude 说看不到技能？** 确保你的项目的 `CLAUDE.md` 有 gstack 章节。添加以下内容：

```
## gstack
Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.
Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy,
/canary, /benchmark, /browse, /open-gstack-browser, /qa, /qa-only, /design-review,
/setup-browser-cookies, /setup-deploy, /setup-gbrain, /sync-gbrain, /retro, /investigate, /document-release,
/codex, /cso, /autoplan, /pair-agent, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn.
```

## 许可证

MIT。永久免费。去构建些什么吧。
