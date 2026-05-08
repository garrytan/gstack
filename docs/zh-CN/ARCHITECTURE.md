# 架构

本文档解释了 gstack **为什么**以这种方式构建。关于安装和命令，请参阅 CLAUDE.md。关于贡献，请参阅 CONTRIBUTING.md。

## 核心思想

gstack 为 Claude Code 提供了一个持久浏览器和一套有主见的工作流技能。浏览器是困难的部分——其余都是 Markdown。

关键洞察：与浏览器交互的 AI 智能体需要**亚秒级延迟**和**持久状态**。如果每个命令都冷启动浏览器，每次工具调用要等 3-5 秒。如果浏览器在命令之间死掉，你会丢失 Cookie、标签页和登录会话。因此 gstack 运行一个长期存活的 Chromium 守护进程，CLI 通过本地 HTTP 与之通信。

```
Claude Code                     gstack
─────────                      ──────
                               ┌──────────────────────┐
  工具调用：$B snapshot -i    │  CLI（编译二进制）     │
  ─────────────────────────→   │  • 读取状态文件       │
                               │  • POST /command      │
                               │    到 localhost:PORT   │
                               └──────────┬───────────┘
                                          │ HTTP
                               ┌──────────▼───────────┐
                               │  服务器（Bun.serve）   │
                               │  • 调度命令            │
                               │  • 与 Chromium 通信   │
                               │  • 返回纯文本          │
                               └──────────┬───────────┘
                                          │ CDP
                               ┌──────────▼───────────┐
                               │  Chromium（无头）      │
                               │  • 持久标签页          │
                               │  • Cookie 跨命令保留  │
                               │  • 30分钟空闲超时      │
                               └───────────────────────┘
```

第一次调用启动一切（约 3 秒）。之后每次调用约 100-200 毫秒。

## 为什么选择 Bun

Node.js 也可以用。但 Bun 在这里有三个优势：

1. **编译二进制。** `bun build --compile` 生成一个约 58MB 的单一可执行文件。运行时不需要 `node_modules`、不需要 `npx`、不需要 PATH 配置。二进制文件直接运行。这很重要，因为 gstack 安装到 `~/.claude/skills/`，用户不希望在那里管理一个 Node.js 项目。

2. **原生 SQLite。** Cookie 解密直接读取 Chromium 的 SQLite Cookie 数据库。Bun 内置了 `new Database()`——不需要 `better-sqlite3`，不需要原生插件编译，不需要 gyp。少一件在不同机器上出问题的东西。

3. **原生 TypeScript。** 服务器在开发期间以 `bun run server.ts` 运行。没有编译步骤，没有 `ts-node`，没有源映射需要调试。编译二进制用于部署；源文件用于开发。

4. **内置 HTTP 服务器。** `Bun.serve()` 快速、简单，不需要 Express 或 Fastify。服务器总共处理约 10 条路由。框架会是开销。

瓶颈始终是 Chromium，而不是 CLI 或服务器。Bun 的启动速度（编译二进制约 1 毫秒 vs Node.js 约 100 毫秒）很好，但不是我们选择它的原因。编译二进制和原生 SQLite 才是。

## 守护进程模型

### 为什么不每个命令都启动一个浏览器？

Playwright 可以在约 2-3 秒内启动 Chromium。对于单张截图来说可以接受。但对于有 20+ 命令的 QA 会话，那就是 40+ 秒的浏览器启动开销。更糟的是：命令之间你会丢失所有状态。Cookie、localStorage、登录会话、打开的标签页——全部消失。

守护进程模型意味着：

- **持久状态。** 登录一次，保持登录。打开标签页，它保持打开。localStorage 在命令之间持久化。
- **亚秒级命令。** 第一次调用后，每个命令只是一个 HTTP POST。约 100-200 毫秒的往返时间，包括 Chromium 的工作。
- **自动生命周期。** 服务器在首次使用时自动启动，30 分钟空闲后自动关闭。不需要进程管理。

### 状态文件

服务器写入 `.gstack/browse.json`（通过 tmp + rename 的原子写入，模式 0o600）：

```json
{ "pid": 12345, "port": 34567, "token": "uuid-v4", "startedAt": "...", "binaryVersion": "abc123" }
```

CLI 读取此文件以找到服务器。如果文件缺失或服务器 HTTP 健康检查失败，CLI 会派生新服务器。在 Windows 上，基于 PID 的进程检测在 Bun 二进制中不可靠，所以健康检查（GET /health）是所有平台上的主要存活信号。

### 端口选择

10000-60000 之间的随机端口（冲突时最多重试 5 次）。这意味着 10 个 Conductor 工作区每个都可以运行自己的浏览守护进程，零配置、零端口冲突。旧方法（扫描 9400-9409）在多工作区设置中经常失败。

### 版本自动重启

构建将 `git rev-parse HEAD` 写入 `browse/dist/.version`。在每次 CLI 调用时，如果二进制文件的版本与运行中服务器的 `binaryVersion` 不匹配，CLI 会杀死旧服务器并启动新服务器。这完全防止了"过期二进制"这类 Bug——重新构建二进制，下一个命令自动使用新版本。

## 安全模型

### 仅本地

HTTP 服务器绑定到 `127.0.0.1`，而不是 `0.0.0.0`。无法从网络访问。

### 双监听器隧道架构（v1.6.0.0）

当用户运行 `pair-agent --client` 时，守护进程启动一个 ngrok 隧道，使远程配对的智能体能够驱动浏览器。将完整守护进程表面暴露给互联网（即使在随机 ngrok 子域名后面）意味着 `/health` 在任何来源欺骗时都会泄漏根令牌，`/cookie-picker` 将令牌嵌入任何调用者都可以获取的 HTML 中。

修复是**两个 HTTP 监听器**，而不是一个：

- **本地监听器**（`127.0.0.1:LOCAL_PORT`）——始终绑定。提供引导程序（具有令牌传递的 `/health`）、`/cookie-picker`、`/inspector/*`、`/welcome`、`/refs`、侧边栏智能体 API 和完整命令表面。永远不转发。
- **隧道监听器**（`127.0.0.1:TUNNEL_PORT`）——在 `/tunnel/start` 时懒惰绑定，在 `/tunnel/stop` 时拆除。提供锁定的允许列表：`/connect`（配对仪式，无认证 + 速率限制）、`/command`（仅限作用域令牌，进一步限制为浏览器驱动命令允许列表）和 `/sidebar-chat`。其他所有路径返回 404。

ngrok 仅转发隧道端口。安全属性来自**物理端口分离**：隧道调用者无法访问 `/health` 或 `/cookie-picker`，因为这些路径在该 TCP 套接字上不存在。头部推断（检查 `x-forwarded-for`、检查来源）不可靠（ngrok 头部行为会变化；本地代理可以添加这些头部）；套接字分离则不会。

| 端点 | 本地监听器 | 隧道监听器 | 备注 |
|---|---|---|---|
| `GET /health` | 公开（无令牌，除非有头模式/扩展）| 404 | 扩展的令牌引导仅在本地发生 |
| `GET /connect` | 公开（`{alive:true}`）| 公开（`{alive:true}`）| 隧道存活的探测路径 |
| `POST /connect` | 公开（速率限制 300/分钟）| 公开（速率限制）| pair-agent 的安装密钥交换 |
| `POST /command` | 认证（Bearer 根或作用域）| 认证（仅作用域，允许列表命令）| 隧道上的根令牌 = 403 |
| `POST /sidebar-chat` | 认证 | 认证 | 让远程智能体向本地侧边栏发布 |
| `POST /pair` | 仅根 | 404 | 配对生成——本地运营商操作 |
| `POST /tunnel/{start,stop}` | 仅根 | 404 | 守护进程配置 |
| `POST /token`、`DELETE /token/:id` | 仅根 | 404 | 作用域令牌生成/撤销 |
| `GET /cookie-picker`、`GET /cookie-picker/*` | 公开 UI，认证 API | 404 | 仅本地——读取本地浏览器数据库 |
| `GET /inspector`、`/inspector/events` 等 | 认证 | 404 | 扩展回调，仅本地 |
| `GET /welcome` | 公开 | 404 | GStack 浏览器落地页，仅本地 |
| `GET /refs` | 认证 | 404 | Ref 映射——内部状态 |
| `GET /activity/stream` | Bearer 或 HttpOnly `gstack_sse` Cookie | 404 | SSE。不再接受 ?token= 查询参数 |
| `GET /inspector/events` | Bearer 或 HttpOnly `gstack_sse` Cookie | 404 | SSE。与 /activity/stream 相同的 Cookie |
| `POST /sse-session` | 认证（Bearer）| 404 | 生成只读 30 分钟 SSE 会话 Cookie |

**隧道表面拒绝日志。** 隧道监听器上的每次拒绝（`path_not_on_tunnel`、`root_token_on_tunnel`、`missing_scoped_token`、`disallowed_command:*`）都会异步记录到 `~/.gstack/security/attempts.jsonl`，包含时间戳、来源 IP（来自 `x-forwarded-for`）、路径和方法。全局速率上限为每分钟 60 次写入，防止日志泛滥 DoS。与提示注入扫描器共享尝试日志。

**SSE 会话 Cookie。** EventSource 不能发送 Authorization 头，所以扩展在引导时用根 Bearer 一次性 POST `/sse-session`，并收到一个 30 分钟的只读 Cookie（`gstack_sse`，HttpOnly，SameSite=Strict）。该 Cookie 仅对 `/activity/stream` 和 `/inspector/events` 有效——它不是作用域令牌，不能在 `/command` 上使用。作用域隔离由模块边界强制执行：`sse-session-cookie.ts` 不从 `token-registry.ts` 导入。

### Bearer 令牌认证

每个服务器会话生成一个随机 UUID 令牌，写入模式 0o600（仅所有者读取）的状态文件。每个改变浏览器状态的 HTTP 请求必须包含 `Authorization: Bearer <token>`。如果令牌不匹配，服务器返回 401。

这防止同一台机器上的其他进程与你的浏览服务器通信。Cookie 选择器 UI（`/cookie-picker`）和健康检查（`/health`）在本地监听器上是豁免的——它们绑定到 127.0.0.1 且不执行命令。在隧道监听器上，除 `/connect` 外无一豁免。

### Cookie 安全

Cookie 是 gstack 处理的最敏感数据。设计：

1. **Keychain 访问需要用户批准。** 每个浏览器的首次 Cookie 导入会触发 macOS Keychain 对话框。用户必须点击"允许"或"始终允许"。gstack 不会静默访问凭证。

2. **解密在进程内发生。** Cookie 值在内存中解密（PBKDF2 + AES-128-CBC），加载到 Playwright 上下文中，永远不会以明文写入磁盘。Cookie 选择器 UI 从不显示 Cookie 值——只显示域名和计数。

3. **数据库是只读的。** gstack 将 Chromium Cookie 数据库复制到临时文件（避免与运行中浏览器的 SQLite 锁冲突）并以只读方式打开。它永远不修改你真实浏览器的 Cookie 数据库。

4. **密钥缓存是每会话的。** Keychain 密码 + 派生的 AES 密钥在服务器生命周期内缓存在内存中。当服务器关闭（空闲超时或明确停止）时，缓存消失。

5. **日志中没有 Cookie 值。** 控制台、网络和对话框日志从不包含 Cookie 值。`cookies` 命令输出 Cookie 元数据（域、名称、过期时间）但值被截断。

### Shell 注入防止

浏览器注册表（Comet、Chrome、Arc、Brave、Edge）是硬编码的。数据库路径由已知常量构造，从不来自用户输入。Keychain 访问使用带明确参数数组的 `Bun.spawn()`，而不是 shell 字符串插值。

### 提示注入防御（侧边栏智能体）

Chrome 侧边栏智能体有工具（Bash、Read、Glob、Grep、WebFetch）并读取恶意网页，所以它是 gstack 中最暴露于提示注入的部分。防御是分层的，而不是单点的。

1. **L1-L3 内容安全（`browse/src/content-security.ts`）。** 在每个页面内容命令和每个工具输出上运行：数据标记、隐藏元素剥离、ARIA 正则表达式、URL 黑名单和信任边界信封包装器。在服务器和智能体两端都应用。

2. **L4 ML 分类器——TestSavantAI（`browse/src/security-classifier.ts`）。** 一个 22MB BERT-small ONNX 模型（int8 量化），与智能体捆绑。本地运行，无网络。在 Claude 看到之前扫描每个用户消息和每个 Read/Glob/Grep/WebFetch 工具输出。通过 `GSTACK_SECURITY_ENSEMBLE=deberta` 可选加入 721MB DeBERTa-v3 集成。

3. **L4b 转录分类器。** 一个 Claude Haiku 过程，查看完整的对话形状（用户消息、工具调用、工具输出），而不仅仅是文本。由 `LOG_ONLY: 0.40` 门控，使大多数干净流量跳过付费调用。

4. **L5 金丝雀令牌（`browse/src/security.ts`）。** 在会话开始时注入系统提示的随机令牌。滚动缓冲区检测跨 `text_delta` 和 `input_json_delta` 流，如果令牌出现在 Claude 输出的任何地方、工具参数、URL 或文件写入中，就会捕获它。确定性 BLOCK——如果令牌泄漏，攻击者说服 Claude 揭示了系统提示，会话结束。

5. **L6 集成组合器（`combineVerdict`）。** BLOCK 需要两个 ML 分类器以 >= `WARN`（0.60）达成一致，而不是单一自信的命中。这是 Stack Overflow 指令编写误报缓解措施。在工具输出扫描上，单层高置信度直接 BLOCK——内容不是用户编写的，所以误报关切不适用。

**关键约束：** `security-classifier.ts` 只在侧边栏智能体进程中运行，从不在编译的浏览二进制文件中。`@huggingface/transformers` v4 需要 `onnxruntime-node`，它无法从 Bun compile 的临时解压目录进行 `dlopen`。只有纯字符串部分（金丝雀注入/检查、判决组合器、攻击日志、状态）在 `security.ts` 中，可以安全地从 `server.ts` 导入。

**环境变量：** `GSTACK_SECURITY_OFF=1` 是一个真正的切断开关（跳过 ML 扫描，金丝雀仍然注入）。模型缓存在 `~/.gstack/models/testsavant-small/`（112MB，首次运行）和 `~/.gstack/models/deberta-v3-injection/`（721MB，仅选择加入）。攻击日志在 `~/.gstack/security/attempts.jsonl`（加盐 sha256 + 域，在 10MB 时轮转，5 代）。每设备盐在 `~/.gstack/security/device-salt`（0600），在进程内缓存以在 FS 不可写环境中存活。

## Ref 系统

Refs（`@e1`、`@e2`、`@c1`）是智能体在不编写 CSS 选择器或 XPath 的情况下寻址页面元素的方式。

### 工作原理

```
1. 智能体运行：$B snapshot -i
2. 服务器调用 Playwright 的 page.accessibility.snapshot()
3. 解析器遍历 ARIA 树，分配顺序 refs：@e1, @e2, @e3...
4. 对于每个 ref，构建 Playwright Locator：getByRole(role, { name }).nth(index)
5. 在 BrowserManager 实例上存储 Map<string, RefEntry>（角色 + 名称 + Locator）
6. 以纯文本返回带注释的树

之后：
7. 智能体运行：$B click @e3
8. 服务器解析 @e3 → Locator → locator.click()
```

### 为什么用 Locators 而不是 DOM 变异

显而易见的方法是向 DOM 注入 `data-ref="@e1"` 属性。这在以下情况下会失败：

- **CSP（内容安全策略）。** 许多生产站点会阻止来自脚本的 DOM 修改。
- **React/Vue/Svelte 水合。** 框架调和可能会剥离注入的属性。
- **Shadow DOM。** 无法从外部访问 shadow root 内部。

Playwright Locators 是 DOM 外部的。它们使用可访问性树（Chromium 在内部维护）和 `getByRole()` 查询。没有 DOM 变异，没有 CSP 问题，没有框架冲突。

### Ref 生命周期

Ref 在导航时被清除（主框架上的 `framenavigated` 事件）。这是正确的——导航后，所有 Locator 都已过期。智能体必须再次运行 `snapshot` 以获得新鲜的 refs。这是设计上的：过期的 refs 应该大声失败，而不是点击错误的元素。

### Ref 过期检测

SPA 可以在不触发 `framenavigated` 的情况下变异 DOM（例如 React 路由器转换、标签页切换、模态窗口打开）。这使 refs 变得过期，即使页面 URL 没有改变。为了捕获这一点，`resolveRef()` 在使用任何 ref 之前执行异步 `count()` 检查：

```
resolveRef(@e3) → entry = refMap.get("e3")
                → count = await entry.locator.count()
                → if count === 0: 抛出 "Ref @e3 已过期——元素不再存在。运行 'snapshot' 获取新鲜 refs。"
                → if count > 0: 返回 { locator }
```

这快速失败（约 5 毫秒开销），而不是让 Playwright 的 30 秒动作超时在缺失元素上到期。`RefEntry` 与 Locator 一起存储 `role` 和 `name` 元数据，这样错误消息可以告诉智能体该元素是什么。

### 光标交互 refs（@c）

`-C` 标志找到可点击但不在 ARIA 树中的元素——用 `cursor: pointer` 样式的元素、有 `onclick` 属性的元素或自定义 `tabindex`。这些在单独的命名空间中获得 `@c1`、`@c2` refs。这捕捉了框架渲染为 `<div>` 但实际上是按钮的自定义组件。

## 日志架构

三个环形缓冲区（各 50,000 条目，O(1) 推送）：

```
浏览器事件 → CircularBuffer（内存中）→ 异步刷新到 .gstack/*.log
```

控制台消息、网络请求和对话框事件各有自己的缓冲区。刷新每 1 秒发生一次——服务器只附加自上次刷新以来的新条目。这意味着：

- HTTP 请求处理永远不会被磁盘 I/O 阻塞
- 日志在服务器崩溃时存活（最多 1 秒的数据丢失）
- 内存是有界的（50K 条目 × 3 缓冲区）
- 磁盘文件是追加式的，可被外部工具读取

`console`、`network` 和 `dialog` 命令从内存缓冲区读取，而不是磁盘。磁盘文件用于事后调试。

## SKILL.md 模板系统

### 问题

SKILL.md 文件告诉 Claude 如何使用浏览命令。如果文档列出了不存在的标志，或者遗漏了刚添加的命令，智能体会遇到错误。手动维护的文档总是与代码脱节。

### 解决方案

```
SKILL.md.tmpl          （人工编写的散文 + 占位符）
       ↓
gen-skill-docs.ts      （读取源代码元数据）
       ↓
SKILL.md               （已提交，自动生成的部分）
```

模板包含需要人工判断的工作流、提示和示例。占位符在构建时从源代码填充：

| 占位符 | 来源 | 生成内容 |
|--------|------|---------|
| `{{COMMAND_REFERENCE}}` | `commands.ts` | 分类命令表 |
| `{{SNAPSHOT_FLAGS}}` | `snapshot.ts` | 带示例的标志参考 |
| `{{PREAMBLE}}` | `gen-skill-docs.ts` | 启动块：更新检查、会话跟踪、贡献者模式、AskUserQuestion 格式 |
| `{{BROWSE_SETUP}}` | `gen-skill-docs.ts` | 二进制发现 + 设置说明 |
| `{{BASE_BRANCH_DETECT}}` | `gen-skill-docs.ts` | PR 目标技能的动态基础分支检测（ship、review、qa、plan-ceo-review）|
| `{{QA_METHODOLOGY}}` | `gen-skill-docs.ts` | /qa 和 /qa-only 的共享 QA 方法论块 |
| `{{DESIGN_METHODOLOGY}}` | `gen-skill-docs.ts` | /plan-design-review 和 /design-review 的共享设计审计方法论 |
| `{{REVIEW_DASHBOARD}}` | `gen-skill-docs.ts` | /ship 预检的评审准备看板 |
| `{{TEST_BOOTSTRAP}}` | `gen-skill-docs.ts` | /qa、/ship、/design-review 的测试框架检测、引导、CI/CD 设置 |
| `{{CODEX_PLAN_REVIEW}}` | `gen-skill-docs.ts` | /plan-ceo-review 和 /plan-eng-review 的可选跨模型计划评审（Codex 或 Claude 子智能体备用）|
| `{{DESIGN_SETUP}}` | `resolvers/design.ts` | `$D` 设计二进制的发现模式，镜像 `{{BROWSE_SETUP}}` |
| `{{DESIGN_SHOTGUN_LOOP}}` | `resolvers/design.ts` | /design-shotgun、/plan-design-review、/design-consultation 的共享比较看板反馈循环 |
| `{{UX_PRINCIPLES}}` | `resolvers/design.ts` | 用户行为基础（扫描、满意、善意储备、主干测试），用于 /design-html、/design-shotgun、/design-review、/plan-design-review |
| `{{GBRAIN_CONTEXT_LOAD}}` | `resolvers/gbrain.ts` | 带关键词提取、健康感知和数据研究路由的 Brain 优先上下文搜索。注入到 10 个支持 brain 的技能中。在非 brain 宿主上抑制。|
| `{{GBRAIN_SAVE_RESULTS}}` | `resolvers/gbrain.ts` | 带实体丰富、节流处理和每技能保存说明的技能后 brain 持久化。8 种技能特定保存格式。|

这在结构上是合理的——如果代码中存在命令，它就会出现在文档中。如果不存在，就不会出现。

### 前言

每个技能都以一个 `{{PREAMBLE}}` 块开始，在技能自身逻辑之前运行。它在单个 bash 命令中处理五件事：

1. **更新检查** — 调用 `gstack-update-check`，如果有升级可用则报告。
2. **会话跟踪** — 触碰 `~/.gstack/sessions/$PPID` 并统计活跃会话数（最近 2 小时内修改的文件）。当 3+ 个会话在运行时，所有技能进入"ELI16 模式"——每个问题都重新为用户提供上下文，因为他们在同时处理多个窗口。
3. **操作性自我改进** — 在每次技能会话结束时，智能体反思失败（CLI 错误、错误方法、项目特有问题），并将操作性学习记录到项目的 JSONL 文件中以供未来会话使用。
4. **AskUserQuestion 格式** — 通用格式：上下文、问题、`RECOMMENDATION: 选择 X 因为 ___`、字母选项。跨所有技能保持一致。
5. **先搜索再构建** — 在构建基础设施或不熟悉的模式之前，先搜索。三层知识：久经考验（第一层）、新兴流行（第二层）、第一原理（第三层）。当第一原理推理揭示惯常智慧是错误的时，智能体命名"顿悟时刻"并记录它。完整的构建者哲学参见 `ETHOS.md`。

### 为什么已提交而不是在运行时生成？

三个原因：

1. **Claude 在技能加载时读取 SKILL.md。** 用户调用 `/browse` 时没有构建步骤。文件必须已经存在且正确。
2. **CI 可以验证新鲜度。** `gen:skill-docs --dry-run` + `git diff --exit-code` 在合并前捕捉过期文档。
3. **Git blame 有效。** 你可以看到命令是什么时候添加的以及在哪个提交中。

### 模板测试层次

| 层次 | 内容 | 成本 | 速度 |
|------|------|------|------|
| 1 — 静态验证 | 解析 SKILL.md 中的每个 `$B` 命令，对注册表验证 | 免费 | <2s |
| 2 — 通过 `claude -p` 的 E2E | 派生真实 Claude 会话，运行每个技能，检查错误 | ~$3.85 | ~20分钟 |
| 3 — LLM 评审者 | Sonnet 评估文档的清晰度/完整性/可操作性 | ~$0.15 | ~30s |

层次 1 在每个 `bun test` 时运行。层次 2+3 在 `EVALS=1` 后门控。思路是：免费捕捉 95% 的问题，仅将 LLM 用于判断调用。

## 命令调度

命令按副作用分类：

- **READ（读取）**（text、html、links、console、cookies...）：无变异。安全重试。返回页面状态。
- **WRITE（写入）**（goto、click、fill、press...）：变异页面状态。不是幂等的。
- **META（元）**（snapshot、screenshot、tabs、chain...）：服务器级操作，不整齐地符合读/写。

这不仅仅是组织性的。服务器用它进行调度：

```typescript
if (READ_COMMANDS.has(cmd))  → handleReadCommand(cmd, args, bm)
if (WRITE_COMMANDS.has(cmd)) → handleWriteCommand(cmd, args, bm)
if (META_COMMANDS.has(cmd))  → handleMetaCommand(cmd, args, bm, shutdown)
```

`help` 命令返回所有三个集合，使智能体能够自我发现可用命令。

## 错误哲学

错误是为 AI 智能体设计的，而不是人类。每条错误消息必须是可操作的：

- "找不到元素" → "找不到或无法与该元素交互。运行 `snapshot -i` 查看可用元素。"
- "选择器匹配了多个元素" → "选择器匹配了多个元素。改用 `snapshot` 中的 @refs。"
- 超时 → "导航在 30 秒后超时。页面可能很慢或 URL 可能是错误的。"

Playwright 的原生错误通过 `wrapError()` 重写，剥离内部堆栈跟踪并添加指导。智能体应该能够读取错误并知道下一步做什么，而无需人工干预。

### 崩溃恢复

服务器不尝试自我修复。如果 Chromium 崩溃（`browser.on('disconnected')`），服务器立即退出。CLI 在下一个命令时检测到死服务器并自动重启。这比尝试重新连接到半死的浏览器进程更简单、更可靠。

## E2E 测试基础设施

### 会话运行器（`test/helpers/session-runner.ts`）

E2E 测试将 `claude -p` 作为完全独立的子进程派生——不通过 Agent SDK，它不能嵌套在 Claude Code 会话中。运行器：

1. 将提示写入临时文件（避免 shell 转义问题）
2. 派生 `sh -c 'cat prompt | claude -p --output-format stream-json --verbose'`
3. 从 stdout 流式传输 NDJSON 以实时进度
4. 与可配置超时竞速
5. 将完整的 NDJSON 记录解析为结构化结果

`parseNDJSON()` 函数是纯的——没有 I/O，没有副作用——使其可以独立测试。

### 可观测性数据流

```
  skill-e2e-*.test.ts
        │
        │ 生成 runId，将 testName + runId 传递给每个调用
        │
  ┌─────┼──────────────────────────────┐
  │     │                              │
  │  runSkillTest()              evalCollector
  │  (session-runner.ts)         (eval-store.ts)
  │     │                              │
  │  每次工具调用：              每次 addTest()：
  │  ┌──┼──────────┐              savePartial()
  │  │  │          │                   │
  │  ▼  ▼          ▼                   ▼
  │ [HB] [PL]    [NJ]          _partial-e2e.json
  │  │    │        │             （原子覆写）
  │  │    │        │
  │  ▼    ▼        ▼
  │ e2e-  prog-  {name}
  │ live  ress   .ndjson
  │ .json .log
  │
  │  失败时：
  │  {name}-failure.json
  │
  │  所有文件在 ~/.gstack-dev/
  │  运行目录：e2e-runs/{runId}/
  │
  │         eval-watch.ts
  │              │
  │        ┌─────┴─────┐
  │     读取 HB     读取 partial
  │        └─────┬─────┘
  │              ▼
  │        渲染看板
  │        （过期 >10分钟？警告）
```

**分离所有权：** session-runner 拥有心跳（当前测试状态），eval-store 拥有部分结果（已完成测试状态）。观察者读取两者。两个组件互相不了解——它们只通过文件系统共享数据。

**一切非致命：** 所有可观测性 I/O 都包装在 try/catch 中。写入失败永远不会导致测试失败。测试本身是真实的来源；可观测性是尽力而为的。

**机器可读诊断：** 每个测试结果包括 `exit_reason`（success、timeout、error_max_turns、error_api、exit_code_N）、`timeout_at_turn` 和 `last_tool_call`。这使得 `jq` 查询成为可能，例如：
```bash
jq '.tests[] | select(.exit_reason == "timeout") | .last_tool_call' ~/.gstack-dev/evals/_partial-e2e.json
```

## 有意不在这里的东西

- **没有 WebSocket 流式传输。** HTTP 请求/响应更简单，可用 curl 调试，速度足够。流式传输会增加复杂性而边际收益甚微。
- **没有 MCP 协议。** MCP 每个请求增加 JSON 模式开销，需要持久连接。普通 HTTP + 普通文本输出对令牌消耗更轻，更易于调试。
- **没有多用户支持。** 每个工作区一个服务器，一个用户。令牌认证是深度防御，而不是多租户。
- **没有 Windows/Linux Cookie 解密。** macOS Keychain 是唯一受支持的凭证存储。Linux（GNOME Keyring/kwallet）和 Windows（DPAPI）在架构上是可能的，但未实现。
