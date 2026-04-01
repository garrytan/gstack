# 待办事项

## Sidebar Security

### 机器学习 Prompt Injection 分类器

**What:** 通过 `@huggingface/transformers v4` 的 WASM 后端，引入 `DeBERTa-v3-base-prompt-injection-v2`，作为 Chrome 侧边栏的一层机器学习防御。做成可复用的 `browse/src/security.ts` 模块，对外暴露 `checkInjection()` API。配套内容包括 canary token、攻击日志、盾牌图标、特殊 telemetry（即使 telemetry 已关闭，只要检测到注入仍通过 AskUserQuestion 提醒），以及 BrowseSafe-bench 红队测试基座（来自 Perplexity 的 3,680 个对抗样本）。

**Why:** PR 1 已经修复了架构层问题，例如命令 allowlist、XML framing 和默认使用 Opus。但攻击者仍可能诱导 Claude 跳转到钓鱼站点，或者借助仍被允许的 browse 命令把可见页面数据带走。机器学习分类器能补到架构防线看不见的 prompt injection 模式。当前指标是准确率 94.8%、召回率 99.6%，WASM 推理耗时约 50 到 100ms，属于典型的 defense-in-depth。

**Context:** 完整设计文档，包含行业研究、开源工具版图、Codex review 结论，以及更激进的 Bun-native 方案设想（通过 FFI + Apple Accelerate 把推理压到 5ms）：[`docs/designs/ML_PROMPT_INJECTION_KILLER.md`](docs/designs/ML_PROMPT_INJECTION_KILLER.md)。CEO 计划与范围裁剪记录在：`~/.gstack/projects/garrytan-gstack/ceo-plans/2026-03-28-sidebar-prompt-injection-defense.md`。

**Effort:** L（human: ~2 weeks / CC: ~3-4 hours）  
**Priority:** P0  
**Depends on:** 先让 Sidebar security fix PR 落地，命令 allowlist + XML framing + 参数修复

## Builder Ethos

### 首次使用时的 Search Before Building 引导

**What:** 增加一个 `generateSearchIntro()` 函数，类似 `generateLakeIntro()`，在用户第一次使用时介绍 Search Before Building 原则，并附上博客文章链接。

**Why:** Boil the Lake 已经有一套首次引导流程，会跳转到文章，并写入 `.completeness-intro-seen`。Search Before Building 也应该具备相同的可发现性。

**Context:** 当前阻塞在还没有可链接的博客文章。等文章写好后，加上带 `.search-intro-seen` 标记文件的 intro flow。参考模式：`gen-skill-docs.ts:176` 的 `generateLakeIntro()`。

**Effort:** S  
**Priority:** P2  
**Depends on:** 一篇关于 Search Before Building 的博客文章

## Chrome DevTools MCP Integration

### 接入真实 Chrome 会话

**What:** 集成 Chrome DevTools MCP，让 gstack 直接连接用户真实的 Chrome 会话，使用真实 cookie 和真实登录状态，不再经过 Playwright 这一层中转。

**Why:** 现在的 headed mode 会启动一个全新的 Chromium profile。用户要么重新登录，要么手动导入 cookie。Chrome DevTools MCP 则可以直接接入用户当前真实的 Chrome，会话里所有已登录站点都能立刻使用。这更接近 AI agent 浏览器自动化的未来方向。

**Context:** Google 在 Chrome 146+（2025 年 6 月）发布了 Chrome DevTools MCP。它可以通过真实浏览器提供截图、console 消息、性能 trace、Lighthouse 审计，以及完整页面交互。gstack 应该用它来做真实会话访问，同时保留 Playwright 用于无头 CI / testing 场景。

潜在新技能：
- `/debug-browser`：带 source map 的 JS 错误追踪
- `/perf-debug`：性能 trace、Core Web Vitals、network waterfall

对大多数场景来说，它甚至可能替代 `/setup-browser-cookies`，因为真实 cookie 本来就已经存在于用户浏览器里。

**Effort:** L（human: ~2 weeks / CC: ~2 hours）  
**Priority:** P0  
**Depends on:** Chrome 146+，以及 DevTools MCP server 已安装

## Browse

### 把 `server.ts` 打进编译后二进制

**What:** 完全移除 `resolveServerScript()` 的 fallback 链，把 `server.ts` 直接打包进编译后的 browse 二进制。

**Why:** 现有 fallback 链会先找 `cli.ts` 邻近路径，再找全局安装路径，这套逻辑很脆弱，v0.3.2 就因为它出过问题。单个编译后二进制更简单，也更稳。

**Context:** Bun 的 `--compile` 支持把多个入口一起打包。现在 server 是运行时靠文件路径解析的。直接打进去就不需要再做解析。

**Effort:** M  
**Priority:** P2  
**Depends on:** None

### Sessions：隔离的浏览器实例

**What:** 提供按名称可寻址的隔离浏览器实例，每个实例都拥有独立的 cookie、storage 和 history。

**Why:** 可以并行测试不同用户角色、验证 A/B 流程，也能更干净地管理认证状态。

**Context:** 需要 Playwright browser context isolation。每个 session 都有独立 context，自己的 cookies 和 localStorage。这也是视频录制和 auth vault 的前置条件。

**Effort:** L  
**Priority:** P3

### 视频录制

**What:** 录制浏览器交互视频，支持 start / stop。

**Why:** 可以把视频证据放进 QA 报告和 PR body。当前暂缓，是因为 `recreateContext()` 会销毁页面状态。

**Context:** 需要 sessions 来保证上下文生命周期干净。Playwright 本身支持按 context 录制视频，同时还需要 WebM → GIF 转换，方便嵌进 PR。

**Effort:** M  
**Priority:** P3  
**Depends on:** Sessions

### v20 加密格式支持

**What:** 为未来 Chromium cookie DB 版本支持 AES-256-GCM，目前只支持 v10。

**Why:** 未来 Chromium 版本可能会改加密格式。提前支持可以避免突然断掉。

**Effort:** S  
**Priority:** P3

### 状态持久化，已发布

~~**What:** 把 cookies + localStorage 保存/加载成 JSON 文件，用于可复现实验会话。~~

`$B state save/load` 已在 v0.12.1.0 发布。V1 只保存 cookies 和 URL，不保存 localStorage，因为 load-before-navigate 会失效。文件保存到 `.gstack/browse-states/{name}.json`，权限为 `0o600`。加载时会替换当前 session，并先关闭所有页面。名称会清洗为 `[a-zA-Z0-9_-]`。

**Remaining:** V2 的 localStorage 支持，还需要 pre-navigation injection 策略。  
**Completed:** v0.12.1.0（2026-03-26）

### Auth vault

**What:** 做一个加密的凭据仓库，通过名字引用。LLM 永远看不到密码。

**Why:** 安全。现在认证凭据会直接流过 LLM 上下文。vault 能把秘密挡在 AI 视野外。

**Effort:** L  
**Priority:** P3  
**Depends on:** Sessions，state persistence

### Iframe 支持，已发布

~~**What:** `frame <sel>` 和 `frame main`，用于跨 frame 交互。~~

`$B frame` 已在 v0.12.1.0 发布。支持 CSS selector、@ref、`--name` 和 `--url` 模式匹配。通过执行目标抽象 `getActiveFrameOrPage()` 把 read / write / snapshot 命令统一起来。导航、切 tab、resume 时会清理 frame context。支持 detached frame 自动恢复。像 goto、screenshot、viewport 这类页面级操作，在 frame context 下会报出清晰错误。

**Completed:** v0.12.1.0（2026-03-26）

### 语义定位器

**What:** `find role/label/text/placeholder/testid`，并可直接挂动作。

**Why:** 相比 CSS selector 或 ref number，更稳健。

**Effort:** M  
**Priority:** P4

### 设备预设模拟

**What:** `set device "iPhone 16 Pro"`，用于手机 / 平板测试。

**Why:** 做响应式测试时，不必手动调 viewport。

**Effort:** S  
**Priority:** P4

### 网络 mock / 路由

**What:** 拦截、屏蔽和 mock 网络请求。

**Why:** 方便测试错误态、加载态和离线行为。

**Effort:** M  
**Priority:** P4

### 下载处理

**What:** 点击下载，并可控制保存路径。

**Why:** 能把文件下载流程跑完整。

**Effort:** S  
**Priority:** P4

### 内容安全

**What:** 增加 `--max-output` 截断，以及 `--allowed-domains` 过滤。

**Why:** 防止上下文窗口被撑爆，并限制只能跳到安全域名。

**Effort:** S  
**Priority:** P4

### Streaming，WebSocket 实时预览

**What:** 为双人协作浏览提供基于 WebSocket 的 live preview。

**Why:** 支持实时协作，人类看着 AI 浏览。

**Effort:** L  
**Priority:** P4

### 带 Chrome 扩展的 headed 模式，已发布

`$B connect` 会启动 Playwright 自带 Chromium 的 headed 模式，并自动加载 gstack Chrome 扩展。`$B handoff` 现在也会走同样路径，包含扩展和 side panel。侧边栏聊天仍由 `--chat` flag 控制。

### `$B watch`，已发布

Claude 可以以被动只读模式观察用户浏览，并定期抓快照。`$B watch stop` 结束并输出总结。watch 期间会阻止 mutation 类命令。

### Sidebar scout / file drop relay，已发布

Sidebar agent 会把结构化消息写入 `.context/sidebar-inbox/`。workspace agent 通过 `$B inbox` 读取。消息格式：`{type, timestamp, page, userMessage, sidebarSessionId}`。

### 多 agent 标签页隔离

**What:** 两个 Claude 会话同时连到同一个浏览器，但各自操作不同标签页，互不污染。

**Why:** 可以在同一个浏览器里并行跑 `/qa` 和 `/design-review`，但操作不同 tab。

**Context:** 需要一个 tab ownership 模型，处理并发 headed 连接。Playwright 对双 persistent context 支持可能不够干净，还需要验证。

**Effort:** L（human: ~2 weeks / CC: ~2 hours）  
**Priority:** P3  
**Depends on:** Headed mode（已发布）

### Sidebar agent 需要 Write 工具，以及更好的错误可见性

**What:** `sidebar-agent.ts` 现在有两个问题：  
1. `--allowedTools` 被硬编码成 `Bash,Read,Glob,Grep`，缺了 `Write`，所以 Claude 在侧边栏里没法创建文件，比如 CSV。  
2. 当 Claude 报错或返回空内容时，侧边栏 UI 什么都不显示，只剩一个绿点，没有错误提示，也没有 “我试了但失败了” 这样的可见反馈。

**Why:** 用户会说“把这个写成 CSV”，但侧边栏其实偷偷做不到，用户只会以为它坏了。UI 必须能明确显示错误，Claude 也必须拥有真正完成任务所需的工具。

**Context:** `sidebar-agent.ts:163` 硬编码了 `--allowedTools`。事件中继 `handleStreamEvent` 已处理 `agent_done` 和 `agent_error`，但扩展里的 `sidepanel.js` 很可能没把错误状态渲染出来。侧边栏应该显示 “Error: ...” 或 “Claude finished but produced no output”，而不是永远挂在绿点状态。

**Effort:** S（human: ~2h / CC: ~10min）  
**Priority:** P1  
**Depends on:** None

### Chrome Web Store 发布

**What:** 把 gstack browse 扩展发布到 Chrome Web Store，降低安装门槛。

**Why:** 现在还得靠 `chrome://extensions` 侧载。上架后就是一键安装。

**Effort:** S  
**Priority:** P4  
**Depends on:** 先证明 Chrome 扩展通过 sideloading 有实际价值

### Linux cookie 解密，部分已发布

~~**What:** 为非 macOS cookie 导入支持 GNOME Keyring / kwallet / DPAPI。~~

Linux cookie 导入已在 v0.11.11.0（Wave 3）发布。支持 Linux 上的 Chrome、Chromium、Brave、Edge，支持 GNOME Keyring（libsecret）和 `"peanuts"` fallback。Windows DPAPI 仍然延后。

**Remaining:** Windows cookie 解密（DPAPI），需要完整重写，PR #64 有 1346 行且已陈旧。  
**Effort:** L（仅 Windows）  
**Priority:** P4  
**Completed (Linux):** v0.11.11.0（2026-03-23）

## Ship

### `/land-and-deploy` 的 GitLab 支持

**What:** 为 `/land-and-deploy` 增加 GitLab MR merge + CI 轮询支持。现在内部有 15+ 个位置直接用了 `gh pr view`、`gh pr checks`、`gh pr merge`、`gh run list/view`，都需要补一条 GitLab 分支，例如 `glab ci status`、`glab mr merge` 等。

**Why:** 现在 GitLab 用户能 `/ship`，也就是创建 MR，但不能 `/land-and-deploy`，也就是 merge + verify。这个缺口会让 GitLab 故事只做到一半。

**Context:** `/retro`、`/ship`、`/document-release` 已经通过多平台 `BASE_BRANCH_DETECT` resolver 支持 GitLab。`/land-and-deploy` 则更深地依赖 GitHub 语义，比如 merge queue、`gh pr checks` 的 required checks、部署 workflow 轮询。这些在 GitLab 里形状不同。`glab` CLI（v1.90.0）支持 `glab mr merge`、`glab ci status`、`glab ci view`，但输出格式不同，也没有 merge queue 概念。

**Effort:** L  
**Priority:** P2  
**Depends on:** None，`BASE_BRANCH_DETECT` 多平台 resolver 已经完成

### 多 commit CHANGELOG 完整性评估

**What:** 增加一个周期性 E2E eval，构造一个包含 5+ commits、跨 3+ 个主题（功能、清理、基础设施）的分支，运行 `/ship` 第 5 步 CHANGELOG 生成，并验证 CHANGELOG 是否覆盖所有主题。

**Why:** v0.11.22 修过一个 bug，`garrytan/ship-full-commit-coverage`，说明 `/ship` 在长分支上生成 CHANGELOG 时，会偏向最近 commits。prompt 修复虽然补了 cross-check，但目前没有测试真正覆盖到这种多 commit 失败模式。现有 `ship-local-workflow` E2E 只测单 commit 分支。

**Context:** 这是一个 `periodic` 级测试，约 `$4/run`，而且有一定不确定性，因为它本质是在测 LLM 是否按指令执行。大致流程：创建 bare remote、clone、一条 feature branch 上做 5+ commits、覆盖多个主题，通过 `claude -p` 跑第 5 步，然后验证 CHANGELOG 是否涵盖所有主题。参考模式：`test/skill-e2e-workflow.test.ts` 中的 `ship-local-workflow`。

**Effort:** M  
**Priority:** P3  
**Depends on:** None

### Ship log，记录每次 `/ship` 的持久化日志

**What:** 在每次 `/ship` 结束时，往 `.gstack/ship-log.json` 追加结构化 JSON 条目，包含 version、date、branch、PR URL、review findings、Greptile stats、完成的 todos、测试结果。

**Why:** `/retro` 现在没有结构化数据去看发版速度。Ship log 能支持 PR 每周产量趋势、review 问题率、Greptile 信号演化，以及测试套件增长趋势。

**Context:** `/retro` 已经会读取 `greptile-history.md`，模式类似。代码库里 `eval-store.ts` 也已经有 JSON append 模式可参考。这事本身在 ship template 里大概只要 15 行。

**Effort:** S  
**Priority:** P2  
**Depends on:** None

### 在 PR body 中放截图做可视化验证

**What:** `/ship` 第 7.5 步，在 push 之后截图关键页面，并嵌入到 PR body。

**Why:** 让 PR 有视觉证据。reviewer 不用本地部署，也能直接看到发生了什么变化。

**Context:** 属于 Phase 3.6，需要 S3 上传图片用于托管。

**Effort:** M  
**Priority:** P2  
**Depends on:** `/setup-gstack-upload`

## 审查

### 行内 PR 注释

**What:** `/ship` 和 `/review` 通过 `gh api` 在具体 file:line 位置发布 inline review comments。

**Why:** 行级注释比顶层评论更可操作。PR thread 会变成 Greptile、Claude 与人类 reviewer 的逐行对话。

**Context:** GitHub 支持通过 `gh api repos/$REPO/pulls/$PR/reviews` 创建 inline review comments。和 Phase 3.6 的视觉注释天然适配。

**Effort:** S  
**Priority:** P2  
**Depends on:** None

### Greptile 训练反馈导出

**What:** 把 `greptile-history.md` 聚合成机器可读 JSON，总结 false positive 模式，并可导出给 Greptile 团队做模型改进。

**Why:** 这能把反馈闭环补上，让 Greptile 不再在同一个代码库上重复犯一样的错。

**Context:** 原本只是一个 P3 future idea。现在因为 `greptile-history.md` 的数据基础已经有了，升级成 P2。信号已经在采集，缺的只是一个导出器，体量大概 40 行。

**Effort:** S  
**Priority:** P2  
**Depends on:** 需要积累足够的 FP 数据，至少 10+ 条

### 带标注截图的视觉 审查

**What:** `/review` 第 4.5 步，打开 PR preview deploy，截图改动页面并做标注，对比 production，检查响应式布局，验证 accessibility tree。

**Why:** 视觉 diff 能抓到纯代码 review 看不到的布局回退。

**Context:** 属于 Phase 3.6，需要 S3 上传图片用于托管。

**Effort:** M  
**Priority:** P2  
**Depends on:** `/setup-gstack-upload`

## QA

### QA 趋势追踪

**What:** 随时间对比 `baseline.json`，识别多次 QA 之间的质量回退。

**Why:** 用来观察质量趋势，产品到底是在变好，还是在变差。

**Context:** QA 已经会输出结构化报告，现在只是再做跨多次运行的对比。

**Effort:** S  
**Priority:** P2

### CI/CD 集成 QA

**What:** 把 `/qa` 作为 GitHub Action 步骤运行，如果健康分跌破阈值就让 PR fail。

**Why:** 形成自动质量门禁，在 merge 前拦截回退。

**Effort:** M  
**Priority:** P2

### 智能默认 QA tier

**What:** 跑过几次之后，从 `index.md` 判断用户通常选哪个 tier，直接跳过 AskUserQuestion。

**Why:** 降低重度用户的摩擦。

**Effort:** S  
**Priority:** P2

### 无障碍审计模式

**What:** 增加 `--a11y` flag，专门跑无障碍测试。

**Why:** 给通用 QA checklist 之外的无障碍测试一个专门入口。

**Effort:** S  
**Priority:** P3

### 为非 GitHub 平台生成 CI/CD

**What:** 扩展 CI/CD bootstrap，自动生成 GitLab CI（`.gitlab-ci.yml`）、CircleCI（`.circleci/config.yml`）和 Bitrise pipeline。

**Why:** 不是所有项目都用 GitHub Actions。通用 CI/CD bootstrap 才能让 test bootstrap 真正适配更多人。

**Context:** v1 目前只支持 GitHub Actions。检测逻辑已经会检查 `.gitlab-ci.yml`、`.circleci/`、`bitrise.yml`，并在发现时给出提示。每个 provider 只需要在 `generateTestBootstrap()` 里补大约 20 行模板文本。

**Effort:** M  
**Priority:** P3  
**Depends on:** Test bootstrap（已发布）

### 把弱测试（★）自动升级成强测试（★★★）

**What:** 当第 3.4 步覆盖率审计识别出现有的 ★ 级测试，比如 smoke / trivial assertions，就自动生成更强版本，覆盖边界条件和错误路径。

**Why:** 很多代码库“有测试”，但这些测试抓不到真实 bug，比如 `expect(component).toBeDefined()` 根本不测行为。把这些弱测试升级，才能缩小 “有测试” 和 “有好测试” 之间的差距。

**Context:** 需要先有 test coverage audit 的质量评分规则。直接改现有测试文件比新建文件风险更高，必须小心对 diff，确保升级后的测试仍然能过。也可以考虑生成 companion test file，而不是硬改原文件。

**Effort:** M  
**Priority:** P3  
**Depends on:** Test quality scoring（已发布）

## Retro

### 部署健康追踪，retro + browse

**What:** 截图生产环境状态，检查性能指标（页面加载时间），统计关键页面的 console 错误，并在 retro 时间窗口里看趋势。

**Why:** Retro 不该只看代码指标，还要包含生产环境健康度。

**Context:** 需要 browse 集成。截图与指标会注入到 retro 输出中。

**Effort:** L  
**Priority:** P3  
**Depends on:** Browse sessions

## Infrastructure

### `/setup-gstack-upload` 技能，S3 bucket

**What:** 配置一个用于图片托管的 S3 bucket。用于视觉 PR 注释的一次性准备动作。

**Why:** `/ship` 和 `/review` 的视觉 PR 注释都依赖它。

**Effort:** M  
**Priority:** P2

### gstack-upload helper

**What:** `browse/bin/gstack-upload`，上传文件到 S3，并返回公共 URL。

**Why:** 给所有需要在 PR 中嵌图的技能提供一个共享工具。

**Effort:** S  
**Priority:** P2  
**Depends on:** `/setup-gstack-upload`

### WebM 转 GIF

**What:** 基于 ffmpeg 的 WebM → GIF 转换，用于在 PR 中嵌入视频证据。

**Why:** GitHub PR body 能显示 GIF，但不能直接显示 WebM。视频证据最终还是要变 GIF。

**Effort:** S  
**Priority:** P3  
**Depends on:** Video recording

### 将 worktree 隔离扩展到 Claude E2E 测试

**What:** 给 `runSkillTest()` 增加 `useWorktree?: boolean` 选项，让任何 Claude E2E test 都能选择 worktree 模式，用完整仓库上下文替代 tmpdir fixture。

**Why:** 一些 Claude E2E 测试，例如 CSO audit、review-sql-injection，会造最小假仓库，但如果用完整 repo 上下文，结果会更真实。基础设施已经存在，`e2e-helpers.ts` 里有 `describeWithWorktree()`，这里只是把它延伸到 session-runner 层。

**Context:** WorktreeManager 已在 v0.11.12.0 发布。当前只有 Gemini / Codex 测试用 worktree。Claude 测试仍主要使用 planted-bug fixture repo，这对其当前用途是合理的。这个 TODO 的目标是让未来需要真实 repo 上下文的新测试更容易启用 worktree。

**Effort:** M（human: ~2 days / CC: ~20 min）  
**Priority:** P3  
**Depends on:** Worktree isolation（已发布 v0.11.12.0）

### E2E 模型固定，已发布

~~**What:** 把 E2E 测试固定到 claude-sonnet-4-6，以节省成本，并增加 `retry:2` 抵抗 flaky LLM responses。~~

已发布：结构测试约 30 个默认使用 Sonnet，质量测试约 10 个保留 Opus。增加了 `--retry 2`。提供 `EVALS_MODEL` 环境变量用于覆盖。新增 `test:e2e:fast` tier，并在 eval-store 中增加 rate-limit telemetry，`first_response_ms`、`max_inter_turn_ms`、`wall_clock_ms`。

### Eval Web Dashboard

**What:** `bun run eval:dashboard` 启动一个本地 HTML 服务，展示 cost 趋势、检测率、通过 / 失败历史等图表。

**Why:** 可视化图表比 CLI 更适合发现趋势。

**Context:** 读取 `~/.gstack-dev/evals/*.json`。大概是 200 行 HTML，再加 chart.js，通过 Bun HTTP server 提供。

**Effort:** M  
**Priority:** P3  
**Depends on:** Eval persistence（已发布 v0.3.6）

### CI/CD QA 质量门禁

**What:** 在 GitHub Actions 中执行 `/qa`，如果健康分低于阈值就让 PR fail。

**Why:** 自动质量门禁能在 merge 前抓住回退。现在 QA 还是手动，接入 CI 才能成为默认流程的一部分。

**Context:** 需要 CI 中可用的 headless browse binary。`/qa` 已经会产出带健康分的 `baseline.json`，CI 步骤只要和 main 分支的 baseline 对比，如果分数下降就 fail。由于 `/qa` 使用 Claude，还需要在 CI secrets 里配置 `ANTHROPIC_API_KEY`。

**Effort:** M  
**Priority:** P2  
**Depends on:** None

### 跨平台 URL 打开 helper

**What:** 做一个 `gstack-open-url` helper 脚本，根据平台自动调用 `open`（macOS）或 `xdg-open`（Linux）。

**Why:** 第一次 Completeness Principle 引导目前直接用 macOS 的 `open` 打开文章。将来如果 gstack 支持 Linux，这里会悄悄失效。

**Effort:** S（human: ~30 min / CC: ~2 min）  
**Priority:** P4  
**Depends on:** Nothing

### 基于 CDP 的 DOM 变更检测，用于 ref 失效

**What:** 用 Chrome DevTools Protocol 的 `DOM.documentUpdated` / MutationObserver 事件，在 DOM 变化时主动把 stale refs 作废，而不是等到下次显式 `snapshot` 才发现。

**Why:** 当前 ref stale detection 通过异步 `count()` 检查，只会在动作执行时发现 stale ref。CDP 级 DOM 变更检测可以更早预警，在 SPA 重新渲染时避免 5 秒 timeout。

**Context:** ref staleness 修复的第 1、2 部分，RefEntry metadata + 基于 `count()` 的 eager validation，已经发布。这是第 3 部分，也是最激进的一块。需要在 Playwright 旁边挂 CDP session、MutationObserver bridge，还要仔细控制性能成本。

**Effort:** L  
**Priority:** P3  
**Depends on:** Ref staleness 第 1、2 部分（已发布）

## Office Hours / 设计

### 设计文档同步到 Supabase team store

**What:** 把 design docs，`*-design-*.md`，加入 Supabase 同步管线，与 test plans、retro snapshots、QA reports 一起同步。

**Why:** 让跨团队设计探索真正可发现。现在本地 `~/.gstack/projects/$SLUG/` 的关键词 grep 只对同一台机器有效，Supabase 同步后，整个团队都能发现重复点子和已探索方向。

**Context:** `/office-hours` 已经把设计文档写入 `~/.gstack/projects/$SLUG/`。团队存储目前已经会同步 test plans、retro snapshots、QA reports。设计文档模式完全一样，只差一个 sync adapter。

**Effort:** S  
**Priority:** P2  
**Depends on:** `garrytan/team-supabase-store` 分支先落 main

### `/yc-prep` 技能

**What:** 一个帮助 founder 准备 YC 申请的 skill，在 `/office-hours` 识别出强信号之后触发。它会拉取 design doc，整理成 YC 申请问题的答案，并跑一次 mock interview。

**Why:** 这是闭环。`/office-hours` 负责识别 founder，`/yc-prep` 负责帮他把申请写好。设计文档里其实已经有大部分原始素材。

**Effort:** M（human: ~2 weeks / CC: ~2 hours）  
**Priority:** P2  
**Depends on:** 先让 office-hours 的 founder discovery engine 发布

## 设计 审查

### `/plan-design-review` + `/qa-design-review` + `/design-consultation`，已发布

已在 v0.5.0 上主分支发布。包括 `/plan-design-review`（只出报告的设计审计）、`/qa-design-review`（审计 + 修复循环）和 `/design-consultation`（交互式创建 DESIGN.md）。`{{DESIGN_METHODOLOGY}}` resolver 提供共享的 80 项设计审计清单。

### 在 `/plan-eng-review` 里引入设计外部视角

**What:** 把并行双外部声音模式，Codex + Claude subagent，扩展到 `/plan-eng-review` 的架构评审部分。

**Why:** 设计 beachhead，v0.11.3.0，证明了跨模型共识对主观评审有效。架构评审也有类似的主观性，尤其在 tradeoff 决策上。

**Context:** 依赖 design beachhead 的学习结果。如果 litmus scorecard 证明有效，可以把同样的模式改造成架构维度评分，例如 coupling、scaling、reversibility。

**Effort:** S  
**Priority:** P3  
**Depends on:** Design outside voices 已发布（v0.11.3.0）

### 在 `/qa` 里用外部设计视角做视觉回归检测

**What:** 给 `/qa` 增加 Codex 设计视角，用于 bug 修复后的视觉回归检测。

**Why:** 修 bug 的过程中很容易顺手引入视觉回归，而纯代码检查看不见。Codex 可以在 re-test 阶段指出 “这个 fix 把响应式布局搞坏了”。

**Context:** 这依赖 `/qa` 本身具备一定设计意识。目前 `/qa` 更偏向功能测试。

**Effort:** M  
**Priority:** P3  
**Depends on:** Design outside voices 已发布（v0.11.3.0）

## Document-Release

### 从 `/ship` 自动调用 `/document-release`，已发布

已在 v0.8.3 发布。给 `/ship` 加了第 8.5 步，在创建 PR 后自动读取 `document-release/SKILL.md` 并执行文档更新工作流。文档更新几乎零摩擦。

### 共享的 `{{DOC_VOICE}}` resolver

**What:** 在 `gen-skill-docs.ts` 中增加一个 placeholder resolver，编码 gstack 的 voice guide，友好、以用户价值为先、先讲收益。把它注入 `/ship` 第 5 步、`/document-release` 第 5 步，并在 `CLAUDE.md` 中复用。

**Why:** 减少重复。现在 voice rules 分散在 3 个地方，`CLAUDE.md` 的 CHANGELOG 风格段、`/ship` 第 5 步、`/document-release` 第 5 步。voice 一变，这三处就会漂移。

**Context:** 和 `{{QA_METHODOLOGY}}` 一样，用共享 block 注入多个模板，防止漂移。大概只要在 `gen-skill-docs.ts` 里加 20 行。

**Effort:** S  
**Priority:** P2  
**Depends on:** None

## Ship Confidence Dashboard

### 智能 审查 相关性检测，部分已发布

~~**What:** 根据分支变更自动判断 4 类 review 哪些相关，如果没有 CSS / view 改动就跳过 Design Review，如果只是 plan 改动就跳过 Code Review。~~

`bin/gstack-diff-scope` 已发布，会把 diff 分类为 SCOPE_FRONTEND、SCOPE_BACKEND、SCOPE_PROMPTS、SCOPE_TESTS、SCOPE_DOCS、SCOPE_CONFIG。现在 design-review-lite 已经会在没有 frontend 改动时跳过。下一步是把这套规则接入 dashboard，做条件化行显示。

**Remaining:** Dashboard 条件化行显示，比如当 `SCOPE_FRONTEND=false` 时隐藏 “Design Review: NOT YET RUN”。同时扩展到 Eng Review，docs-only 时跳过，和 CEO Review，config-only 时跳过。

**Effort:** S  
**Priority:** P3  
**Depends on:** gstack-diff-scope（已发布）

## Codex

### Codex→Claude 反向 buddy check 技能

**What:** 一个 Codex 原生 skill，`.agents/skills/gstack-claude/SKILL.md`，通过 `claude -p` 获取 Claude 的独立第二意见。也就是把今天 `/codex` 在 Claude Code 里做的事情反过来。

**Why:** Codex 用户也值得拥有 Claude 用户现在通过 `/codex` 得到的那种 cross-model challenge。现在流程是单向的，Claude→Codex。Codex 用户没法反向拿 Claude 第二意见。

**Context:** `/codex` skill 模板，`codex/SKILL.md.tmpl`，已经展示了模式，用 `codex exec` 封装 JSONL 解析、超时处理和结构化输出。反向 skill 只要用类似基础设施包装 `claude -p`。然后通过 `gen-skill-docs --host codex` 生成到 `.agents/skills/gstack-claude/`。

**Effort:** M（human: ~2 weeks / CC: ~30 min）  
**Priority:** P1  
**Depends on:** None

## Completeness

### Completeness 指标面板

**What:** 追踪 gstack 会话里 Claude 选择完整方案 vs 捷径方案的比例，并聚合成一个 dashboard，看 Completeness 趋势随时间如何变化。

**Why:** 不测量就不知道 Completeness Principle 有没有真正生效。也许能暴露某些 skill 仍然倾向捷径。

**Context:** 需要记录用户在 AskUserQuestion 中做出的选择，比如写入 JSONL，再做解析和趋势展示。模式和 eval persistence 类似。

**Effort:** M（human） / S（CC）  
**Priority:** P3  
**Depends on:** Boil the Lake 已发布（v0.6.1）

## Safety & Observability

### 按需开启的 hook 技能，`/careful`、`/freeze`、`/guard`，已发布

~~**What:** 三个利用 Claude Code 会话级 PreToolUse hooks 的新技能，在需要时按需加安全护栏。~~

已在 v0.6.5 发布，对应 `/careful`、`/freeze`、`/guard` 和 `/unfreeze`。同时包含 hook 触发率 telemetry，只记录 pattern 名，不记录命令内容，以及内联 skill activation telemetry。

### 技能 使用 telemetry，已发布

~~**What:** 跟踪每个 skill 被调用了多少次、在哪个 repo 里被调用。~~

已在 v0.6.5 发布。`gen-skill-docs.ts` 的 TemplateContext 会把 skill 名 baked 进 preamble telemetry 行。并提供 analytics CLI，`bun run analytics`，用于查询。`/retro` 也已接入，可展示本周使用过的 skills。

### `/investigate` 的 scoped debugging 增强，取决于 telemetry

**What:** 给 `/investigate` 的自动 freeze 增加 6 项增强功能，但前提是 telemetry 证明 freeze hook 在真实调试会话里确实经常触发。

**Why:** `/investigate` 在 v0.7.1 引入了自动 freeze，把编辑限制在被调试的模块内。如果 telemetry 证明这个 hook 真有价值，这 6 项增强就值得做。如果从来不触发，说明问题并不真实，也就没必要继续投。

**Context:** 这 6 项都只是 `investigate/SKILL.md.tmpl` 的文案扩展，不需要新脚本。

**Items：**
1. 基于 stack trace 自动检测 freeze 目录，解析最深的 app frame
2. Freeze boundary widening，撞边界时不直接硬挡，而是询问是否扩大
3. 修完后自动 unfreeze，并跑完整测试集
4. 清理调试临时插桩，用 `DEBUG-TEMP` 标记，提交前自动移除
5. 调试会话持久化，`~/.gstack/investigate-sessions/`，保存调查过程供复用
6. 在 debug report 中加入 investigation timeline，记录每个假设和花费时间

**Effort:** M（六项合并）  
**Priority:** P3  
**Depends on:** 先用 telemetry 证明 freeze hook 在真实 `/investigate` 会话里经常触发

## Factory Droid

### 给 Factory Droid 做 Browse MCP server

**What:** 把 gstack 的 browse 二进制和关键工作流包装成 MCP server，让 Factory Droid 原生接入。Factory 用户通过 `/mcp` 增加 gstack server 后，就能直接获得 browse、QA 和 review 能力。

**Why:** Factory 本身已经有 40+ 个 MCP server。把 gstack 的 browse binary 放进它的注册表，本质上是个分发机会。市面上几乎没人有真正编译好的浏览器二进制 MCP 工具，这正是 gstack 在 Factory Droid 上最独特的价值。

**Context:** Option A，`--host factory` 兼容层，会先在 v0.13.4.0 发布。Option B 是更深的后续集成。browse binary 已经是一个无状态 CLI，所以把它包成 MCP server 很顺，stdin/stdout JSON-RPC 即可。每个 browse command 都是一个 MCP tool。

**Effort:** L（human: ~1 week / CC: ~5 hours）  
**Priority:** P1  
**Depends on:** `--host factory`，也就是 Option A，先在 v0.13.4.0 发布

### 同时输出 `.agent/skills/`，提高跨 agent 兼容性

**What:** Factory 也支持 `<repo>/.agent/skills/` 作为跨 agent 兼容路径。未来可以除了 `.factory/skills/` 之外，也一起输出到 `.agent/skills/`，兼容更多采用 `.agent` 约定的 agent。

**Why:** 除了 Factory 以外，更多 AI agent 可能会采用 `.agent/skills/` 这类约定。额外输出一份就能拿到免费兼容性。

**Effort:** S  
**Priority:** P3  
**Depends on:** `--host factory`

### 跟 技能 一起发布 Custom Droid 定义

**What:** Factory 支持 “custom droids”，也就是可限制工具、指定模型、设定 autonomy 的 subagent。可以随 skill 一起发布 `gstack-qa.md` 这样的 droid 配置，让工具范围只保留 read-only + execute，提升安全性。

**Why:** 这会让 Factory 集成更深。Droid configs 让 Factory 用户能更细粒度控制 gstack skill 的权限。

**Effort:** M  
**Priority:** P3  
**Depends on:** `--host factory`

## Completed

### CI eval pipeline（v0.9.9.0）
- GitHub Actions eval 上传，跑在 Ubicloud runner，约 `$0.006/run`
- 文件内测试并发，`test()` → `testConcurrentIfSelected()`
- Eval artifact 上传，并在 PR 评论中展示 pass/fail + 成本
- 从 main 下载 artifact 做 baseline 对比
- `EVALS_CONCURRENCY=40`，把 wall clock 从约 18 分钟压到约 6 分钟
**Completed:** v0.9.9.0

### 部署 pipeline（v0.9.8.0）
- `/land-and-deploy`，merge PR，等待 CI / deploy，再做 canary verification
- `/canary`，部署后监控循环，含 anomaly detection
- `/benchmark`，基于 Core Web Vitals 的性能回退检测
- `/setup-deploy`，一次性部署平台配置
- `/review` 中增加 Performance & Bundle Impact pass
- E2E 模型固定，Sonnet 默认，质量测试保留 Opus
- E2E 时间 telemetry，`first_response_ms`、`max_inter_turn_ms`、`wall_clock_ms`
- `test:e2e:fast` tier，以及所有 E2E 脚本的 `--retry 2`
**Completed:** v0.9.8.0

### 阶段 1，基础设施（v0.2.0）
- 重命名为 gstack
- 调整为 monorepo 布局
- 增加 skill symlink 的 setup 脚本
- Snapshot 命令和基于 ref 的元素选择
- Snapshot tests
**Completed:** v0.2.0

### 阶段 2，增强浏览器（v0.2.0）
- 标注截图、snapshot diff、dialog handling、文件上传
- cursor-interactive 元素、元素状态检测
- CircularBuffer、异步 buffer flush、health check
- Playwright 错误包装、useragent 修复
- 148 个 integration tests
**Completed:** v0.2.0

### 阶段 3，QA Testing Agent（v0.3.0）
- `/qa` 的 SKILL.md，6 阶段工作流，3 种模式，full / quick / regression
- 问题分类体系、严重级别、探索清单
- 报告模板、健康分标准、框架检测
- `wait` / `console` / `cookie-import` 命令，以及 find-browse binary
**Completed:** v0.3.0

### 阶段 3.5，Browser Cookie Import（v0.3.x）
- `cookie-import-browser` 命令，支持 Chromium cookie DB 解密
- Cookie picker Web UI，和 `/setup-browser-cookies` skill
- 18 个 unit tests，browser registry，Comet、Chrome、Arc、Brave、Edge
**Completed:** v0.3.1

### E2E 测试 成本追踪
- 跟踪累计 API 开销，超过阈值时警告
**Completed:** v0.3.6

### 自动升级模式 + 智能更新检查
- 配置 CLI，`bin/gstack-config`
- 通过 `~/.gstack/config.yaml` 控制自动升级
- 12h cache TTL
- 指数退避 snooze，24h → 48h → 1wk
- “never ask again” 选项
- 升级时同步 vendored copy
**Completed:** v0.3.8
