# gstack

> “我想大概从去年 12 月开始，我几乎就没怎么亲手写过哪怕一行代码了。这是一个极其巨大的变化。” —— [Andrej Karpathy](https://fortune.com/2026/03/21/andrej-karpathy-openai-cofounder-ai-agents-coding-state-of-psychosis-openclaw/)，No Priors 播客，2026 年 3 月

当我听到 Karpathy 这么说时，我就想知道这到底是怎么做到的。一个人究竟要怎样，才能像二十人的团队一样持续交付？Peter Steinberger 几乎是是独自一人，在借助 AI agents 之下构建了 [OpenClaw](https://github.com/openclaw/openclaw)——在 GitHub 上已经拿到 247K stars。变革已经到来，只要工具合适，一个独立开发者就能比传统团队推进得更快。

我是 [Garry Tan](https://x.com/garrytan)，[Y Combinator](https://www.ycombinator.com/) 的总裁兼 CEO。我曾与数千家刚开始发展的公司合作过——像 Coinbase、Instacart、Rippling。加入 YC 之前，我曾是 Palantir 最早的一批工程 / 产品 / 设计成员之一，联合创办了 Posterous（后来卖给 Twitter），还构建了 YC 的内部社交网络 Bookface。

**gstack 就是我的答案。** 我做产品已经二十年了，而现在我写出来的代码，比以往任何时候都更多。过去 60 天里：我写出了 **60 万+ 行生产代码**（其中 35% 是测试），**每天 1 万到 2 万行**，而且这是在我全职管理 YC 的同时兼职完成的。这是我最近一次横跨 3 个项目的 `/retro` 数据：**一周内新增 140,751 行代码，362 次提交，净新增约 115k 行代码。**

**2026 年——已达 1,237 次贡献，并且还在继续：**

![GitHub contributions 2026 — 1,237 contributions, massive acceleration in Jan-Mar](docs/images/github-2026.png)

**2013 年——我当年在 YC 构建 Bookface 时（772 次贡献）：**

![GitHub contributions 2013 — 772 contributions building Bookface at YC](docs/images/github-2013.png)

同一个人，不同的时代。差别就在于使用的工具。

**gstack 就是我完成这一切的方式。** 它把 Claude Code 变成一支虚拟工程团队——一个重新思考产品方向的 CEO，一个锁定架构的工程经理，一个能识别 AI 糊弄设计的设计师，一个能找出生产环境 bug 的审查人，一个会打开真实浏览器的 QA 负责人，一个执行 OWASP + STRIDE 审计的安全负责人，还有一个负责交付 PR 的发布工程师。二十三位专家，八个强力工具，全部都是 slash commands，全部是 Markdown，全部免费，MIT license。

这是我自己的开源软件工厂。我每天都在用它。我现在把它分享出来，是因为这些工具本来就应该属于每一个人。

Fork 它。改进它。把它变成自己的工具。如果你就是想吐槽免费的开源软件——也欢迎，但我还是更希望先试试看。

**适合谁使用：**
- **创始人和 CEO** —— 尤其是那些依然想亲手交付产品的技术型创始人
- **第一次使用 Claude Code 的人** —— 用结构化角色代替空白提示词
- **技术负责人和资深工程师** —— 在每个 PR 上都执行严格的 review、QA 和发布自动化

## 快速开始

1. 安装 gstack（30 秒——见下文）
2. 运行 `/office-hours` —— 描述正在构建的东西
3. 对任意功能想法运行 `/plan-ceo-review`
4. 在任意有变更的分支上运行 `/review`
5. 对暂存环境 URL 运行 `/qa`
6. 在这停下就好。你很快就会知道它是否适合你自己。

## 安装 —— 30 秒

**要求：** [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Git](https://git-scm.com/)、[Bun](https://bun.sh/) v1.0+、[Node.js](https://nodejs.org/)（仅 Windows 需要）

### 第 1 步：安装到本机

打开 Claude Code，然后把下面这段粘贴进去。剩下的事 Claude 会自己完成。

> Install gstack: run **`git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`** then add a "gstack" section to CLAUDE.md that says to use the /browse skill from gstack for all web browsing, never use mcp\_\_claude-in-chrome\_\_\* tools, and lists the available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn. Then ask the user if they also want to add gstack to the current project so teammates get it.

### 第 2 步：团队模式 —— 为共享 repo 自动更新（推荐）

所有开发者都全局安装，更新会自动进行：

```bash
cd ~/.claude/skills/gstack && ./setup --team
```

然后为repos启用团队模式，这样队友也能获得它：

```bash
cd <your-repo>
~/.claude/skills/gstack/bin/gstack-team-init required  # or: optional
git add .claude/ CLAUDE.md && git commit -m "require gstack for AI-assisted work"
```

无需把源代码手动复制到 repo 里，不会出现版本漂移，也不需要手动升级。每次 Claude Code 会话开始时，都会先执行一次快速自动更新检查（节流为每小时最多一次；网络失败安全；完全静默）。

> **想参与贡献，或者需要完整历史记录？** 上面的命令使用了 `--depth 1` 以便快速安装。如果打算你参与贡献，或者需要完整的 git 历史，请改用完整 clone:
> ```bash
> git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> ```

### OpenClaw

OpenClaw 会通过 ACP 启动 Claude Code 会话，因此只要 Claude Code 已经安装了 gstack，所有 gstack skill 都可以直接工作。
把下面这段粘贴到 OpenClaw agent 中：

> Install gstack: run `git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup` to install gstack for Claude Code. Then add a "Coding Tasks" section to AGENTS.md that says: when spawning Claude Code sessions for coding work, tell the session to use gstack skills. Include these examples — security audit: "Load gstack. Run /cso", code review: "Load gstack. Run /review", QA test a URL: "Load gstack. Run /qa https://...", build a feature end-to-end: "Load gstack. Run /autoplan, implement the plan, then run /ship", plan before building: "Load gstack. Run /office-hours then /autoplan. Save the plan, don't implement."

**完成设置后，直接和 OpenClaw agent 对话即可：**

| 你说的话 | 会发生的事 |
|---------|-------------|
| "Fix the typo in README" | 简单任务 —— 启动 Claude Code 会话，不需要 gstack |
| "Run a security audit on this repo" | 启动 Claude Code，并执行 `Run /cso` |
| "Build me a notifications feature" | 启动 Claude Code 执行 /autoplan → implement → /ship |
| "Help me plan the v2 API redesign" | 启动 Claude Code 执行 /office-hours → /autoplan 并保存 |

如果想要了解更高级的 dispatch routing，以及 gstack-lite / gstack-full prompt templates，请参考 [docs/OPENCLAW.md](docs/OPENCLAW.md)。

### 原生的 OpenClaw Skills (通过 ClawHub)

四个不需要 Claude Code 会话，可直接在 OpenClaw agent 中使用的方法论技能。可通过 ClawHub 安装：

```
clawhub install gstack-openclaw-office-hours gstack-openclaw-ceo-review gstack-openclaw-investigate gstack-openclaw-retro
```

| 技能 | 功能 |
|-------|-------------|
| `gstack-openclaw-office-hours` | 通过 6 个强制性问题进行产品追问 |
| `gstack-openclaw-ceo-review` | 通过 4 种 scope 模式进行战略挑战 |
| `gstack-openclaw-investigate` | 根因调试方法论 |
| `gstack-openclaw-retro` | 每周工程复盘 |

这些是对话式技能。OpenClaw agent 会直接在聊天中运行它们。

### 其他 AI Agents

gstack 不只支持 Claude，同时还支持 8 种 AI 编码代理。
安装程序会自动检测你已经安装了哪些 agent：

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/gstack
cd ~/gstack && ./setup
```

或者，也可以通过 `./setup --host <name>` 来指定特定 agent:

| Agent | Flag | Skills安装位置|
|-------|------|-------------------|
| OpenAI Codex CLI | `--host codex` | `~/.codex/skills/gstack-*/` |
| OpenCode | `--host opencode` | `~/.config/opencode/skills/gstack-*/` |
| Cursor | `--host cursor` | `~/.cursor/skills/gstack-*/` |
| Factory Droid | `--host factory` | `~/.factory/skills/gstack-*/` |
| Slate | `--host slate` | `~/.slate/skills/gstack-*/` |
| Kiro | `--host kiro` | `~/.kiro/skills/gstack-*/` |

** 想为支持其他的 agent ？** 请参考 [docs/ADDING_A_HOST.md](docs/ADDING_A_HOST.md)。只需要一个 TypeScript 配置文件，不需要改动任何代码。

## 看它如何工作

```text
你：    我想做一个给日历用的每日简报应用。
你：    /office-hours
Claude： [询问痛点——要具体例子，而不是假设性的说法]

你：    我有多个 Google 日历，事件信息经常过期，地点也总写错。
        准备工作要花很久，而且结果还不够好……

Claude： 我要先反驳一下这个措辞。你说的是“每日简报应用”，
        但你真正描述出来的，其实是一个 personal chief of
        staff AI。
        [提炼出 5 个你自己都没意识到正在描述的能力]
        [质疑 4 个前提——你可以同意、不同意，或调整]
        [生成 3 种实现方案并附上工作量估算]
        RECOMMENDATION：明天就先交付最窄的 wedge，并从真实使用中学习。
        完整愿景是一个 3 个月项目——先从那个真正可用的
        每日简报做起。
        [写出设计文档 → 自动传递给后续技能]

你：    /plan-ceo-review
        [读取设计文档，挑战 scope，执行 10 个部分的 review]

你：    /plan-eng-review
        [给出数据流、状态机、错误路径的 ASCII 图]
        [测试矩阵、失败模式、安全问题]

你：    Approve plan. Exit plan mode.
        [跨 11 个文件写出 2,400 行代码。约 8 分钟。]

你：    /review
        [AUTO-FIXED] 2 issues. [ASK] Race condition → 你批准修复。

你：    /qa https://staging.myapp.com
        [打开真实浏览器，点完整个流程，发现并修复一个 bug]

你：    /ship
        Tests: 42 → 51（+9 new）。PR: github.com/you/app/pull/42

你说的是 “每日简报应用”。agent 回答的是 “you're building a chief of staff AI”——因为它听的是痛点，而不只是功能请求。八条命令，从头到尾。这不是 copilot。这是一支团队。

## sprint 流程

gstack 是一个流程，而不只是工具的集合。各个 skill 会按照一个 sprint 的顺序运行：

**Think → Plan → Build → Review → Test → Ship → Reflect

每个 skill 都会把结果传给下一个。`/office-hours 会写出设计文档，供 `/plan-ceo-review` 读取；`/plan-eng-review` 会写出测试计划，供 `/qa` 接手；`/review` 会抓出 bug，而 `/ship` 会验证这些 bug 是否已经修好。因为每一步都知道前面发生了什么，所以不会有东西从流程里漏掉

| Skill | Your specialist | What they do |
|-------|----------------|--------------|
| `/office-hours` | **YC Office Hours** | 从这里开始。通过六个强制性问题，在真正开始写代码之前重新定义产品。它会反驳你的措辞，挑战你的前提，并生成不同的实现方案。输出的设计文档会传递给所有后续 skill。 |
| `/plan-ceo-review` | **CEO / Founder** | 重新思考这个问题。找出需求背后那个真正有机会做到满星的产品。提供四种模式：Expansion、Selective Expansion、Hold Scope、Reduction。 |
| `/plan-eng-review` | **Eng Manager** | 锁定架构、数据流、图示、边界情况和测试。强迫隐藏的假设暴露出来。 |
| `/plan-design-review` | **Senior Designer** | 按 0-10 分为每个设计维度打分，解释 10 分意味着什么，然后直接修改计划，帮助它达到那个水准。用于识别 AI Slop。交互式流程——每个设计决策只问一个 AskUserQuestion。 |
| `/plan-devex-review` | **Developer Experience Lead** | 交互式 DX review：探索开发者画像，对比竞品的 TTHW，设计你的 magical moment，并逐步追踪每个 friction point。三种模式：DX EXPANSION、DX POLISH、DX TRIAGE。20-45 个强制性问题。 |
| `/design-consultation` | **Design Partner** | 从零开始构建完整设计系统。研究现有产品，提出有创意的风险尝试，并生成逼真的产品 mockup。 |
| `/review` | **Staff Engineer** | 找出那些 CI 能通过、但上线后会爆炸的 bug。自动修掉明显问题，并标出完成度缺口。 |
| `/investigate` | **Debugger** | 系统化的根因调试。铁律：不调查，就不修复。它会追踪数据流、验证假设，并在连续三次修复失败后停下。 |
| `/design-review` | **Designer Who Codes** | 使用和 `/plan-design-review` 相同的审查框架，然后直接修掉发现的问题。采用 atomic commits，并提供 before/after screenshots。 |
| `/devex-review` | **DX Tester** | 实时开发者体验审计。真的去测试你的 onboarding：浏览文档、尝试 getting started 流程、计时 TTHW、截图错误。还会与 `/plan-devex-review` 的评分对比——像一个 boomerang，能看出计划和现实是否一致。 |
| `/design-shotgun` | **Design Explorer** | “给我看几个方案。” 生成 4-6 个 AI mockup 变体，在浏览器里打开对比板，收集反馈并继续迭代。taste memory 会记住偏好，越做越贴近喜欢的风格。 |
| `/design-html` | **Design Engineer** | 把 mockup 变成真正可用的生产级 HTML。使用 Pretext 做计算式布局：文字会随宽度重新流动，高度会根据内容自动调整，整体布局是动态的。30KB、零依赖。会自动识别 React / Svelte / Vue。输出是可以发货的，而不是 demo。 |
| `/qa` | **QA Lead** | 测试应用、发现 bug、用 atomic commits 修复，然后重新验证。还会为每次修复自动生成回归测试。 |
| `/qa-only` | **QA Reporter** | 与 `/qa` 使用相同的方法论，但只生成报告，不修改代码。适合只要 bug report、不想直接改代码的时候。 |
| `/pair-agent` | **Multi-Agent Coordinator** | 与任意 AI agent 共享浏览器。一个命令，一段粘贴，即可连接。支持 OpenClaw、Hermes、Codex、Cursor，或任何可以 curl 的东西。每个 agent 都有自己的标签页。自动启动 headed mode，方便观察全过程。也会为远程 agent 自动启动 ngrok tunnel。支持 scoped tokens、标签页隔离、限流与活动归因。 |
| `/cso` | **Chief Security Officer** | OWASP Top 10 + STRIDE threat model。低噪音：排除 17 类误报，设置 8/10+ 置信度门槛，并对每个发现做独立验证。每条发现都附带具体 exploit scenario。 |
| `/ship` | **Release Engineer** | 同步 main、运行测试、审查 coverage、push，并打开 PR。如果项目还没有测试框架，它会顺手帮你初始化。 |
| `/land-and-deploy` | **Release Engineer** | 合并 PR，等待 CI 和 deploy 完成，并验证生产环境健康状况。从 “approved” 到 “verified in production”，一个命令完成。 |
| `/canary` | **SRE** | 部署后监控循环。持续观察 console errors、性能回退和页面故障。 |
| `/benchmark` | **Performance Engineer** | 建立页面加载时间、Core Web Vitals 和资源体积的基线，并在每个 PR 上做前后对比。 |
| `/document-release` | **Technical Writer** | 更新项目中所有文档，使其与刚刚发布的内容保持一致。能自动发现过期 README。 |
| `/retro` | **Eng Manager** | 面向团队的每周复盘。包括按成员拆分的数据、持续交付 streak、测试健康趋势和成长机会。`/retro global` 可以跨所有项目和 AI 工具（Claude Code、Codex、Gemini）运行。 |
| `/browse` | **QA Engineer** | 给 agent 一双眼睛。真实 Chromium 浏览器、真实点击、真实截图。每条命令约 100ms。`/open-gstack-browser` 会启动带有侧边栏、anti-bot stealth 和自动模型路由的 GStack Browser。 |
| `/setup-browser-cookies` | **Session Manager** | 将真实浏览器（Chrome、Arc、Brave、Edge）中的 cookies 导入 headless session，以便测试需要登录的页面。 |
| `/autoplan` | **Review Pipeline** | 一个命令，得到完整审阅后的计划。会自动依次运行 CEO → design → eng review，并编码决策原则。只把 taste decisions 暴露出来供你确认。 |
| `/learn` | **Memory** | 管理 gstack 跨会话学到的内容。可以审阅、搜索、清理和导出项目特定的模式、坑点与偏好。随着会话累积，gstack 会越来越熟悉你的代码库。 |

### 我该用哪种 review？

| 构建对象 | 计划阶段（写代码前） | 线上审计（发布后） |
|---------|----------------------|-------------------|
| **终端用户**（UI、web app、mobile） | `/plan-design-review` | `/design-review` |
| **开发者**（API、CLI、SDK、docs） | `/plan-devex-review` | `/devex-review` |
| **架构**（data flow、performance、tests） | `/plan-eng-review` | `/review` |
| **以上全部** | `/autoplan`（自动运行 CEO → design → eng → DX，并判断哪些需要启用） | — |

### Power tools

| Skill | 功能 |
|-------|------|
| `/codex` | **Second Opinion** —— 来自 OpenAI Codex CLI 的独立代码审查。三种模式：review（pass/fail gate）、adversarial challenge，以及 open consultation。当 `/review` 和 `/codex` 都跑过后，还会给出 cross-model analysis，对比哪些发现是重叠的，哪些只被其中一方找到。 |
| `/careful` | **Safety Guardrails** —— 在执行破坏性命令前发出警告，例如 `rm -rf`、`DROP TABLE`、force-push。说一句 “be careful” 就能激活。也可以覆盖任何警告继续执行。 |
| `/freeze` | **Edit Lock** —— 将文件编辑限制在一个目录中，防止调试时误改作用域以外的内容。 |
| `/guard` | **Full Safety** —— 把 `/careful` 和 `/freeze` 合并成一个命令。适合生产环境工作时使用。 |
| `/unfreeze` | **Unlock** —— 解除 `/freeze` 的边界限制。 |
| `/open-gstack-browser` | **GStack Browser** —— 启动 GStack Browser，内置侧边栏、anti-bot stealth、自动模型路由（Sonnet 负责操作，Opus 负责分析）、一键导入 cookies，并与 Claude Code 集成。可以清理页面、拍智能截图、修改 CSS，并将信息传回终端。 |
| `/setup-deploy` | **Deploy Configurator** —— 为 `/land-and-deploy` 做一次性初始化配置。自动检测部署平台、生产 URL 和部署命令。 |
| `/gstack-upgrade` | **Self-Updater** —— 将 gstack 升级到最新版本。能识别是 global 安装还是 vendored 安装，同步两者，并展示变更内容。 |

**[查看每个 skill 的深度解析、示例和设计理念 →](docs/skills.md)**

## 并行 sprint

gstack 用在单个 sprint 上已经很好用了；当同时跑十个 sprint 时，它才真正变得有意思。

**设计是核心。** `/design-consultation` 会从零开始构建设计系统，研究现有方案，提出有创意的风险尝试，并写出 `DESIGN.md`。但真正厉害的地方，是从 shotgun 到 HTML 的那条流水线。

**`/design-shotgun` 是探索方案的方式。** 描述想要的东西之后，它会使用 GPT Image 生成 4-6 个 AI mockup 变体，然后在浏览器里打开一个对比板，把所有方案并排放在一起。你可以挑出偏好的版本，留下反馈（“留白再多一点”“标题更大胆一些”“去掉渐变”），然后它会继续生成下一轮。重复这个过程，直到真的喜欢为止。几轮之后，taste memory 就会开始生效，逐渐偏向真正偏好的方向。不再只是把愿景用语言丢给 AI 然后碰运气，而是可以真的看到选项、挑出好的版本，并进行视觉上的迭代。

**`/design-html` 会把它变成真的。** 把已经确认的 mockup（可以来自 `/design-shotgun`、CEO 计划、design review，或者只是一个描述）转成 production-quality HTML/CSS。不是那种只在一个 viewport width 下勉强好看、其他地方一塌糊涂的 AI HTML。这里使用的是 Pretext 做 computed text layout：文字会在窗口大小变化时真实重排，高度会随着内容自动调整，布局是动态的。额外开销 30KB，零依赖。它会检测当前框架（React、Svelte、Vue），并输出对应格式。Smart API routing 还会根据页面类型（landing page、dashboard、form 或 card layout）选择不同的 Pretext 模式。产物是可以真正拿去发货的，而不是 demo。

**`/qa` 是一个巨大的解锁点。** 它让我能把并行 worker 数量从 6 提高到 12。Claude Code 说出 *"I SEE THE ISSUE"*，然后真的去修复它、生成一个回归测试、再验证修复结果——这彻底改变了我的工作方式。现在 agent 真的有眼睛了。

**智能 review 路由。** 就像一家运转良好的创业公司一样：CEO 不必看基础设施 bug 修复，设计审查也不需要介入纯后端变更。gstack 会记录已经执行过哪些 review，判断现在真正需要什么，然后自动做出合理选择。Review Readiness Dashboard 会在发布前告诉你当前处于什么状态。

**测试一切。** `/ship` 会在项目没有测试框架时，从零帮你搭起来。每次 `/ship` 都会生成 coverage audit。每次 `/qa` 修 bug 都会生成一个回归测试。目标是 100% test coverage —— 测试让 vibe coding 变得安全，而不是变成 yolo coding。

**`/document-release` 是你从未拥有过的那个工程师。** 它会读取项目里的每一个文档文件，对照 diff，更新所有已经漂移的内容。README、ARCHITECTURE、CONTRIBUTING、CLAUDE.md、TODOS —— 都能自动保持同步。现在 `/ship` 还会自动调用它 —— 文档更新不再需要额外执行一条命令。

**真实浏览器模式。** `/open-gstack-browser` 会启动 GStack Browser，一个由 AI 控制的 Chromium，内置 anti-bot stealth、自定义品牌外观和侧边栏扩展。像 Google 和 NYTimes 这样的网站也能正常打开，不会被 captcha 卡住。菜单栏里会显示 “GStack Browser”，而不是 “Chrome for Testing”。你自己的 Chrome 不会受到影响。所有已有的 browse 命令都可以不做修改继续使用。`$B disconnect` 会回到 headless 模式。只要浏览器窗口不关，它就会一直保持存活——不会因为 idle timeout 在工作时突然被杀掉。

**侧边栏 agent —— 浏览器里的 AI 助手。** 可以直接在 Chrome 侧边栏里用自然语言下指令，然后由一个子 Claude 实例执行。“进入设置页并截图。”“用测试数据填完这个表单。”“把这个列表里的每一项价格都提取出来。” 侧边栏会自动把任务路由给合适的模型：Sonnet 负责快速操作（点击、跳转、截图），Opus 负责阅读和分析。每个任务最多可运行 5 分钟。侧边栏 agent 运行在隔离会话中，因此不会干扰主 Claude Code 窗口。侧边栏底部还支持一键导入 cookies。

**个人自动化。** 侧边栏 agent 不只是开发工具。比如：“浏览孩子学校的家长门户网站，把其他家长的姓名、电话号码和照片加进 Google Contacts。” 有两种完成认证的方式：（1）先在 headed browser 里登录一次，之后 session 会保留；或者（2）点击侧边栏底部的 “cookies” 按钮，从真实 Chrome 导入 cookies。完成认证后，Claude 就能浏览目录、提取数据并创建联系人。

**当 AI 卡住时进行浏览器接管。** 碰到 CAPTCHA、认证墙或 MFA 提示时，可以使用 `$B handoff`，它会打开一个可见的 Chrome，并停留在完全相同的页面上，所有 cookies 和标签页都保持原样。问题解决后，告诉 Claude 已经处理完，再执行 `$B resume`，它就会从中断处继续。连续失败三次后，agent 甚至会自动建议这样做。

**`/pair-agent` 是跨 agent 协作。** 可能当前正在 Claude Code 里工作，同时还开着 OpenClaw、Hermes 或 Codex，也希望它们一起看同一个网站。这时输入 `/pair-agent`，选择对应的 agent，就会打开一个 GStack Browser 窗口供你观察。skill 会打印出一整段说明，只需要把它粘贴到另一个 agent 的聊天里。它会用一次性 setup key 换取 session token，创建自己的标签页，然后开始浏览。你会看到多个不同厂商的 agent 同时在同一个浏览器里工作——各自在自己的标签页中，彼此互不干扰。如果安装了 ngrok，还会自动启动 tunnel，这样另一边的 agent 甚至可以运行在完全不同的机器上。同机 agent 则有零摩擦捷径，可以直接把凭据写入。第一次，不同厂商的 AI agents 可以通过一个共享浏览器完成协作，而且具备真实的安全机制：scoped tokens、标签页隔离、限流、域名限制和活动归因。

**多 AI 的第二意见。** `/codex` 会通过 OpenAI 的 Codex CLI 拉来一个独立的代码审查者——一套完全不同的 AI，审阅同一份 diff。它有三种模式：带 pass/fail gate 的代码审查、主动尝试搞坏代码的 adversarial challenge，以及支持连续上下文的 open consultation。当 `/review`（Claude）和 `/codex`（OpenAI）都审过同一个分支后，还会给出 cross-model analysis，告诉你哪些问题是两边都发现的，哪些只被其中一方找到。

**按需启用的安全护栏。** 只要说一句 “be careful”，`/careful` 就会在任何破坏性命令之前发出警告——例如 `rm -rf`、`DROP TABLE`、force-push、`git reset --hard`。`/freeze` 会在调试时把编辑范围锁在一个目录里，防止 Claude “顺手”改到无关代码。`/guard` 则会同时开启这两个功能。`/investigate` 在调查问题时还会自动启用 freeze，把范围锁定在当前模块。

**主动技能建议。** gstack 会感知当前处在哪个阶段——brainstorming、reviewing、debugging、testing——并主动建议合适的 skill。不喜欢这种行为？说一句 “stop suggesting”，它就会记住，而且会跨会话生效。

## 10-15 个并行 sprint

gstack 在单个 sprint 上已经很强；而当同时跑十个 sprint 时，它会变得彻底不同。

[Conductor](https://conductor.build) 可以并行运行多个 Claude Code 会话——每一个都位于自己的隔离工作区中。一个会话在对新想法运行 `/office-hours`，另一个在对某个 PR 执行 `/review`，第三个在实现新功能，第四个在暂存环境上运行 `/qa`，另外六个还在各自的分支上工作。所有这些都能同时进行。我自己经常同时运行 10-15 个并行 sprint —— 这差不多就是目前现实可行的上限。

真正让这种并行成立的，是 sprint 结构本身。没有流程的话，十个 agents 只是十个混乱源头；一旦有了流程——think、plan、build、review、test、ship——每个 agent 都知道自己该做什么，也知道什么时候该停下。管理它们的方式，就像 CEO 管理一支团队：只检查真正重要的决策，让其他部分自行推进。

### 语音输入（AquaVoice、Whisper 等）

gstack skills 提供了对语音友好的触发短语。只要自然地说出需求——比如 “run a security check”、“test the website”、“do an engineering review”——系统就会激活对应的 skill。无需死记 slash command 名称或缩写。

## 卸载

### 方式 1: 运行卸载脚本

如果 gstack 已安装到本机：

```bash
~/.claude/skills/gstack/bin/gstack-uninstall
```
`
这个脚本会处理 skills、symlinks、全局状态（~/.gstack/）、项目本地状态、browse daemons 和临时文件。使用 `--keep-state` 可以保留配置和分析数据；使用 `--force` 可以跳过确认步骤。

### 方式 2：手动移除（没有本地仓库时）
如果没有保留仓库 clone（例如，曾通过 Claude Code 粘贴命令安装，后来又把 clone 删掉了）：

```bash
# 1. Stop browse daemons
pkill -f "gstack.*browse" 2>/dev/null || true

# 2. Remove per-skill symlinks pointing into gstack/
find ~/.claude/skills -maxdepth 1 -type l 2>/dev/null | while read -r link; do
  case "$(readlink "$link" 2>/dev/null)" in gstack/*|*/gstack/*) rm -f "$link" ;; esac
done

# 3. Remove gstack
rm -rf ~/.claude/skills/gstack

# 4. Remove global state
rm -rf ~/.gstack

# 5. Remove integrations (skip any you never installed)
rm -rf ~/.codex/skills/gstack* 2>/dev/null
rm -rf ~/.factory/skills/gstack* 2>/dev/null
rm -rf ~/.kiro/skills/gstack* 2>/dev/null
rm -rf ~/.openclaw/skills/gstack* 2>/dev/null

# 6. Remove temp files
rm -f /tmp/gstack-* 2>/dev/null

# 7. Per-project cleanup (run from each project root)
rm -rf .gstack .gstack-worktrees .claude/skills/gstack 2>/dev/null
rm -rf .agents/skills/gstack* .factory/skills/gstack* 2>/dev/null
```

### 清理 CLAUDE.md

卸载脚本不会自动编辑 CLAUDE.md。在每一个曾添加过 gstack 的项目中，请手动移除 ## gstack 和 ## Skill routing 这两个小节。

### Playwright

`~/Library/Caches/ms-playwright/` (macOS) 会被保留下来，因为其他工具也可能共用它。如果确定没有其他工具需要它，可以手动删除。

---

免费，MIT license，开源。没有 premium tier，也没有 waitlist。
我把自己构建软件的方式开源了。你可以 fork 它，然后把它变成自己的工具。

> **We're hiring.** Want to ship 10K+ LOC/day and help harden gstack?
> Come work at YC — [ycombinator.com/software](https://ycombinator.com/software)
> Extremely competitive salary and equity. San Francisco, Dogpatch District.

## 文档

| 文档 | 覆盖内容 |
|-----|---------------|
| [Skill Deep Dives](docs/skills.md) | 每个 skill 的设计理念、示例与工作流（包含 Greptile integration） |
| [Builder Ethos](ETHOS.md) | Builder philosophy：Boil the Lake、Search Before Building，以及三层知识结构 |
| [Architecture](ARCHITECTURE.md) | 设计决策与系统内部机制 |
| [Browser Reference](BROWSER.md) | `/browse` 的完整命令参考 |
| [Contributing](CONTRIBUTING.md) | 开发环境配置、测试、contributor mode 和 dev mode |
| [Changelog](CHANGELOG.md) | 每个版本的更新内容 |

## 隐私与遥测

gstack 包含**可选择加入（opt-in）**的使用遥测，用来帮助改进项目。具体行为如下：

- **默认关闭。** 除非明确同意，否则不会向任何地方发送任何数据。
- **首次运行时，** gstack 会询问是否愿意分享匿名使用数据。可以拒绝。
- **如果选择加入，会发送的内容包括：** skill 名称、持续时间、成功 / 失败状态、gstack 版本、操作系统。仅此而已。
- **绝不会发送的内容包括：** 代码、文件路径、仓库名称、分支名称、提示词，或任何用户生成内容。
- **可以随时修改：** 运行 `gstack-config set telemetry off` 即可立刻彻底关闭。

数据存储在 [Supabase](https://supabase.com) 中（一个开源的 Firebase 替代方案）。数据库结构定义在 [`supabase/migrations/`](supabase/migrations/) 中——可以自行核实具体收集了哪些数据。仓库中的 Supabase publishable key 是公开密钥（类似 Firebase API key）——row-level security policies 会拒绝所有直接访问。遥测数据通过经过校验的 edge functions 进入系统，这些函数会强制执行 schema checks、event type allowlists 和字段长度限制。

**本地分析始终可用。** 运行 `gstack-analytics`，就能从本地 JSONL 文件里查看个人使用仪表盘——不需要任何远程数据。

## 故障排查

**Skill 没有显示出来？** `cd ~/.claude/skills/gstack && ./setup`

**`/browse` 失败？** `cd ~/.claude/skills/gstack && bun install && bun run build`

**安装已经过期？** 运行 `/gstack-upgrade` —— 或在 `~/.gstack/config.yaml` 中设置 `auto_upgrade: true`

**想要更短的命令？** `cd ~/.claude/skills/gstack && ./setup --no-prefix` —— 会把 `/gstack-qa` 切换成 `/qa`。这个选择会在之后的升级中被记住。

**想要带命名空间的命令？** `cd ~/.claude/skills/gstack && ./setup --prefix` —— 会把 `/qa` 切换成 `/gstack-qa`。如果同时在用其他 skill packs，这会更方便。

**Codex 提示 “Skipped loading skill(s) due to invalid SKILL.md”?** 说明 Codex 的 skill 描述已经过期。修复方式：`cd ~/.codex/skills/gstack && git pull && ./setup --host codex` —— 如果是 repo-local 安装，则运行：`cd "$(readlink -f .agents/skills/gstack)" && git pull && ./setup --host codex`

**Windows 用户：** gstack 可以在 Windows 11 上通过 Git Bash 或 WSL 运行。除了 Bun，还需要安装 Node.js —— 因为 Bun 在 Windows 上对 Playwright 的 pipe transport 有一个已知 bug（[bun#4253](https://github.com/oven-sh/bun/issues/4253)）。browse server 会自动回退到 Node.js。请确保 `bun` 和 `node` 都已经加入 PATH。

**Claude 提示它看不到这些 skills？** 确保项目里的 `CLAUDE.md` 包含一个 gstack 小节。添加以下内容：

```
## gstack
Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.
Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy,
/canary, /benchmark, /browse, /open-gstack-browser, /qa, /qa-only, /design-review,
/setup-browser-cookies, /setup-deploy, /retro, /investigate, /document-release, /codex,
/cso, /autoplan, /pair-agent, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn.
```

## License

MIT. Free forever. Go build something.
