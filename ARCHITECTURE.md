# 架构

这份文档解释 gstack **为什么** 会按现在这种方式构建。关于安装与命令，请看 `CLAUDE.md`。关于贡献方式，请看 `CONTRIBUTING.md`。

## 核心想法

gstack 给 Claude Code 提供了一个持久化浏览器，以及一套带明确倾向的工作流 skill。浏览器这一层才是难点，其余基本都是 Markdown。

关键洞察是：一个与浏览器交互的 AI agent，需要 **亚秒级延迟** 和 **持久状态**。如果每条命令都要冷启动一次浏览器，那每次工具调用都要等 3-5 秒。如果浏览器在命令之间死掉，cookie、标签页和登录会话也都会丢。所以 gstack 会运行一个长生命周期的 Chromium daemon，由 CLI 通过 localhost HTTP 与之通信。

```
Claude Code                     gstack
─────────                      ──────
                               ┌──────────────────────┐
  Tool call: $B snapshot -i    │  CLI（编译后的二进制） │
  ─────────────────────────→   │  • 读取 state file     │
                               │  • 向 localhost:PORT   │
                               │    POST /command       │
                               └──────────┬───────────┘
                                          │ HTTP
                               ┌──────────▼───────────┐
                               │  Server（Bun.serve）  │
                               │  • 分发命令            │
                               │  • 与 Chromium 通信    │
                               │  • 返回纯文本          │
                               └──────────┬───────────┘
                                          │ CDP
                               ┌──────────▼───────────┐
                               │  Chromium（headless） │
                               │  • 持久化标签页        │
                               │  • cookie 会沿用       │
                               │  • 30 分钟空闲超时     │
                               └───────────────────────┘
```

第一次调用会启动整套系统（约 3 秒）。之后每次调用约 100-200ms。

## 为什么选 Bun

Node.js 也能用。但在这里 Bun 更合适，原因有四个：

1. **可编译成单文件二进制。** `bun build --compile` 能产出一个约 58MB 的单独可执行文件。运行时不需要 `node_modules`，不需要 `npx`，也不需要配 PATH。二进制拿来就能跑。这很重要，因为 gstack 是安装到 `~/.claude/skills/` 下的，用户不会期待自己去维护一个 Node.js 项目。

2. **原生 SQLite。** cookie 解密需要直接读取 Chromium 的 SQLite cookie 数据库。Bun 内置 `new Database()`，不需要 `better-sqlite3`，不需要原生 addon 编译，也不需要折腾 gyp。少一层跨机器失效点。

3. **原生 TypeScript。** 开发时服务端直接 `bun run server.ts`。不需要编译步骤，不需要 `ts-node`，调试时也不用额外处理 source map。发布时用编译后的二进制，开发时直接用源码。

4. **内置 HTTP 服务器。** `Bun.serve()` 足够快、足够简单，不需要 Express 或 Fastify。服务端总共也就十来个路由，上框架纯属额外负担。

这里真正的瓶颈永远是 Chromium，不是 CLI，也不是 server。Bun 的启动速度（编译后二进制约 1ms，对比 Node 约 100ms）不错，但这不是我们选它的主因。真正关键的是单文件二进制和原生 SQLite。

## daemon 模型

### 为什么不为每条命令单独启动浏览器？

Playwright 启动 Chromium 大约要 2-3 秒。只截一张图时还可以接受，但如果是一个有 20+ 条命令的 QA 会话，光浏览器启动开销就会多出 40+ 秒。更糟的是，每条命令之间所有状态都会丢失。cookie、localStorage、登录会话、打开的标签页，全部清空。

daemon 模型带来这些收益：

- **状态持久化。** 登录一次，后面一直保持登录。打开一个标签页，它会一直存在。localStorage 在命令间保持不变。
- **亚秒级命令。** 第一次调用之后，后续每条命令本质上都是一个 HTTP POST。包括 Chromium 的实际执行时间在内，往返约 100-200ms。
- **自动生命周期管理。** 第一次使用自动启动 server，空闲 30 分钟自动关闭。不需要用户自己管进程。

### 状态文件

server 会写入 `.gstack/browse.json`（通过 tmp + rename 原子写入，权限 `0o600`）：

```json
{ "pid": 12345, "port": 34567, "token": "uuid-v4", "startedAt": "...", "binaryVersion": "abc123" }
```

CLI 通过读取这个文件找到 server。如果文件缺失，或者 server 的 HTTP 健康检查失败，CLI 就会拉起一个新的 server。在 Windows 上，Bun 二进制的 PID 级进程探测不可靠，因此在所有平台上，健康检查（`GET /health`）才是主要的存活信号。

### 端口选择

随机在 10000-60000 间选端口（碰撞时最多重试 5 次）。这样 10 个 Conductor 工作区都可以各自跑一个 browse daemon，不需要任何配置，也不会发生端口冲突。旧方案是扫描 9400-9409，在多工作区场景里几乎一直出问题。

### 版本自动重启

构建时会把 `git rev-parse HEAD` 写进 `browse/dist/.version`。每次 CLI 调用时，如果当前二进制版本与运行中的 server 的 `binaryVersion` 不一致，CLI 就会杀掉旧 server 并启动新 server。这样可以彻底消灭“二进制过期”这类问题。只要重新构建了二进制，下一条命令就会自动接上新版。

## 安全模型

### 仅监听 localhost

HTTP server 绑定在 `localhost`，不是 `0.0.0.0`。外网无法访问。

### Bearer token 鉴权

每个 server 会话都会生成一个随机 UUID token，并把它写入权限为 `0o600` 的状态文件（只有 owner 可读）。每个 HTTP 请求都必须带 `Authorization: Bearer <token>`。如果 token 不匹配，server 返回 401。

这能防止同一台机器上的其他进程直接调用你的 browse server。cookie picker UI（`/cookie-picker`）和健康检查（`/health`）是例外，它们只暴露在 localhost 上，而且不会执行命令。

### Cookie 安全

cookie 是 gstack 处理的最敏感数据。整体设计如下：

1. **访问 Keychain 需要用户批准。** 每个浏览器第一次导入 cookie 时，macOS 都会弹出 Keychain 对话框。用户必须点击 “Allow” 或 “Always Allow”。gstack 不会静默访问你的凭据。

2. **解密发生在进程内。** cookie 值会在内存中完成解密（PBKDF2 + AES-128-CBC），然后加载进 Playwright context，绝不会以明文写到磁盘。cookie picker UI 也不会展示 cookie 值，只显示域名和数量。

3. **数据库只读。** gstack 会先把 Chromium 的 cookie 数据库复制到一个临时文件（避免和正在运行的浏览器争抢 SQLite 锁），然后以只读方式打开。它绝不会修改你真实浏览器里的 cookie 数据库。

4. **密钥缓存只在当前会话内有效。** Keychain 密码和派生后的 AES key 只在 server 生命周期内缓存于内存中。server 一旦关闭（空闲超时或显式停止），缓存就消失。

5. **日志中不记录 cookie 值。** 控制台、网络和对话框日志都不会包含 cookie 值。`cookies` 命令输出的是 cookie 元数据（域名、名称、过期时间），值会被截断。

### 防止 Shell 注入

浏览器注册表（Comet、Chrome、Arc、Brave、Edge）是硬编码的。数据库路径由已知常量拼接而来，不接受用户输入。Keychain 访问通过 `Bun.spawn()` 和显式参数数组完成，不通过 shell 字符串插值。

## ref 系统

Refs（`@e1`、`@e2`、`@c1`）让 agent 能直接引用页面元素，而不需要手写 CSS selector 或 XPath。

### 工作方式

```
1. agent 运行：$B snapshot -i
2. server 调用 Playwright 的 page.accessibility.snapshot()
3. 解析器遍历 ARIA 树，顺序分配 ref：@e1、@e2、@e3...
4. 为每个 ref 构建一个 Playwright Locator：getByRole(role, { name }).nth(index)
5. 在 BrowserManager 实例上保存 Map<string, RefEntry>（包含 role、name、Locator）
6. 将带注释的树以纯文本返回

之后：
7. agent 运行：$B click @e3
8. server 解析 @e3 → Locator → locator.click()
```

### 为什么用 Locator，而不是修改 DOM

最直觉的办法，是往 DOM 里注入 `data-ref="@e1"` 之类的属性。但这会在下面这些场景出问题：

- **CSP（Content Security Policy）。** 很多生产站点会阻止脚本修改 DOM。
- **React / Vue / Svelte hydration。** 框架的 reconciliation 可能把注入的属性删掉。
- **Shadow DOM。** 你无法从外部直接深入 shadow root。

Playwright Locator 是 DOM 之外的机制。它依赖的是可访问性树（由 Chromium 内部维护）和 `getByRole()` 查询。这样就不需要 DOM 注入，没有 CSP 问题，也不会和框架冲突。

### ref 生命周期

导航发生时（主 frame 的 `framenavigated` 事件），refs 会被清空。这是正确行为，因为导航之后所有 locator 都失效了。agent 必须重新运行 `snapshot` 获取新 refs。这是刻意设计的：失效 ref 应该大声报错，而不是误点到错误元素。

### ref 失效检测

SPA 可以在不触发 `framenavigated` 的情况下修改 DOM，例如 React Router 跳转、标签切换、模态框打开。这会让 refs 失效，即使 URL 没变。为了捕捉这类情况，`resolveRef()` 在使用 ref 前会先执行异步 `count()` 检查：

```
resolveRef(@e3) → entry = refMap.get("e3")
                → count = await entry.locator.count()
                → if count === 0: throw "Ref @e3 is stale — element no longer exists. Run 'snapshot' to get fresh refs."
                → if count > 0: return { locator }
```

这样可以快速失败（约 5ms 开销），而不是等到 Playwright 在一个不存在的元素上卡满 30 秒 action timeout。`RefEntry` 还会额外存储 `role` 和 `name` 元数据，好让错误信息能告诉 agent 这个元素原本是什么。

### 光标可交互 refs（`@c`）

`-C` 标志会额外发现那些虽然不在 ARIA 树里、但实际上可点击的元素，例如带 `cursor: pointer` 样式的元素、带 `onclick` 的节点，或者自定义 `tabindex` 的组件。这些元素会被分配到独立命名空间里，形成 `@c1`、`@c2`。这样可以覆盖那些被框架渲染成 `<div>`、但行为上其实是按钮的自定义组件。

## 日志架构

三个环形缓冲区（各 50,000 条，`O(1)` push）：

```
浏览器事件 → CircularBuffer（内存中）→ 异步 flush 到 .gstack/*.log
```

控制台消息、网络请求和对话框事件各自有独立缓冲区。flush 每 1 秒执行一次，server 只会把上次 flush 之后的新条目追加到磁盘。这带来几个效果：

- HTTP 请求处理永远不会被磁盘 I/O 阻塞
- server 崩溃后日志仍能保住（最多丢失 1 秒数据）
- 内存是有上界的（50K 条 × 3 个缓冲区）
- 磁盘文件是 append-only，可供外部工具读取

`console`、`network`、`dialog` 这些命令读取的是内存缓冲区，而不是磁盘。磁盘文件只是用于事后排障。

## 技能.md 模板系统

### 问题

SKILL.md 文件负责告诉 Claude 如何使用 browse 命令。如果文档里列了一个不存在的 flag，或者漏写了一个新加命令，agent 就会直接撞错。靠人手维护的文档一定会和代码漂移。

### 解决方案

```
SKILL.md.tmpl          （人工编写的说明 + 占位符）
       ↓
gen-skill-docs.ts      （读取源码元数据）
       ↓
SKILL.md               （提交到仓库，自动生成的部分已展开）
```

模板里只保留那些需要人工判断的工作流、提示和例子。占位符在构建时由源码填充：

| 占位符 | 来源 | 生成内容 |
|-------------|--------|-------------------|
| `{{COMMAND_REFERENCE}}` | `commands.ts` | 分类后的命令表 |
| `{{SNAPSHOT_FLAGS}}` | `snapshot.ts` | 带示例的 flag 参考 |
| `{{PREAMBLE}}` | `gen-skill-docs.ts` | 启动块：更新检查、会话跟踪、contributor mode、AskUserQuestion 格式 |
| `{{BROWSE_SETUP}}` | `gen-skill-docs.ts` | 二进制发现 + 安装说明 |
| `{{BASE_BRANCH_DETECT}}` | `gen-skill-docs.ts` | 针对 PR 型 skill（ship、review、qa、plan-ceo-review）的动态 base branch 检测 |
| `{{QA_METHODOLOGY}}` | `gen-skill-docs.ts` | `/qa` 与 `/qa-only` 共用的 QA 方法块 |
| `{{DESIGN_METHODOLOGY}}` | `gen-skill-docs.ts` | `/plan-design-review` 与 `/design-review` 共用的设计审计方法块 |
| `{{REVIEW_DASHBOARD}}` | `gen-skill-docs.ts` | `/ship` pre-flight 的 Review Readiness Dashboard |
| `{{TEST_BOOTSTRAP}}` | `gen-skill-docs.ts` | `/qa`、`/ship`、`/design-review` 共用的测试框架识别、bootstrap 与 CI/CD 配置 |
| `{{CODEX_PLAN_REVIEW}}` | `gen-skill-docs.ts` | `/plan-ceo-review` 与 `/plan-eng-review` 的可选跨模型计划审查（Codex 或 Claude subagent fallback） |
| `{{DESIGN_SETUP}}` | `resolvers/design.ts` | `$D` 设计二进制的发现模式，对齐 `{{BROWSE_SETUP}}` |
| `{{DESIGN_SHOTGUN_LOOP}}` | `resolvers/design.ts` | `/design-shotgun`、`/plan-design-review`、`/design-consultation` 共用的对比板反馈循环 |

这个结构是稳的：代码里有的命令，一定会出现在文档里；代码里没有的命令，就不可能凭空出现在文档里。

### preamble

每个 skill 都以一个 `{{PREAMBLE}}` 块开头，在 skill 自身逻辑执行前先跑。它用一个 bash 命令同时处理五件事：

1. **更新检查**：调用 `gstack-update-check`，判断是否有可用升级。
2. **会话跟踪**：`touch ~/.gstack/sessions/$PPID`，并统计最近 2 小时内活跃的会话数（按文件修改时间计）。当同时存在 3+ 个会话时，所有 skill 都进入 “ELI16 mode”，因为用户此时通常正在多个窗口之间切换，所以每次提问都要重新帮用户锚定上下文。
3. **contributor mode**：从配置里读取 `gstack_contributor`。为 true 时，如果 gstack 自己行为异常，agent 会把简短 field report 写到 `~/.gstack/contributor-logs/`。
4. **AskUserQuestion 格式**：统一格式包括 context、question、`RECOMMENDATION: Choose X because ___` 和字母编号选项。所有 skill 都保持一致。
5. **Search Before Building**：在搭基础设施或处理陌生模式前，先搜索。知识分三层：已验证可靠（Layer 1）、新但流行（Layer 2）、第一性原理（Layer 3）。当第一性原理推翻了传统共识时，agent 必须明确指出这个 “eureka moment”，并记录下来。完整的 builder 哲学见 `ETHOS.md`。

### 为什么提交生成结果，而不是运行时生成？

有三个原因：

1. **Claude 会在加载 skill 时直接读取 SKILL.md。** 用户调用 `/browse` 时不会再额外跑一个构建步骤，所以文件必须事先存在且内容正确。
2. **CI 可以校验新鲜度。** `gen:skill-docs --dry-run` + `git diff --exit-code` 能在合并前发现文档是否过期。
3. **Git blame 可追溯。** 你可以清楚看到某个命令是什么时候加进来的、在哪个提交里加的。

### 模板测试分层

| 层级 | 内容 | 成本 | 速度 |
|------|------|------|-------|
| 1 — 静态校验 | 解析 SKILL.md 中所有 `$B` 命令，并与 registry 校验 | 免费 | <2s |
| 2 — 通过 `claude -p` 做 E2E | 启动真实 Claude 会话，逐个运行 skill，检查是否报错 | ~$3.85 | ~20min |
| 3 — LLM 评审 | 用 Sonnet 评估文档的清晰度 / 完整性 / 可执行性 | ~$0.15 | ~30s |

第 1 层在每次 `bun test` 都会跑。第 2、3 层则通过 `EVALS=1` 控制。思路很简单：95% 的问题用免费手段先挡住，LLM 只用在需要判断的地方。

## 命令分发

命令按副作用分类：

- **READ**（text、html、links、console、cookies 等）：不修改状态，可安全重试，返回页面状态。
- **WRITE**（goto、click、fill、press 等）：会修改页面状态，不是幂等操作。
- **META**（snapshot、screenshot、tabs、chain 等）：属于 server 级操作，无法简单归入 read / write。

这不只是为了整理文档。server 也依赖这套分类做分发：

```typescript
if (READ_COMMANDS.has(cmd))  → handleReadCommand(cmd, args, bm)
if (WRITE_COMMANDS.has(cmd)) → handleWriteCommand(cmd, args, bm)
if (META_COMMANDS.has(cmd))  → handleMetaCommand(cmd, args, bm, shutdown)
```

`help` 命令会返回这三组命令，方便 agent 自己发现可用能力。

## 错误哲学

错误信息是给 AI agent 看的，不是给人看的。每条错误都必须可执行：

- `"Element not found"` → `"Element not found or not interactable. Run \`snapshot -i\` to see available elements."`
- `"Selector matched multiple elements"` → `"Selector matched multiple elements. Use @refs from \`snapshot\` instead."`
- 超时 → `"Navigation timed out after 30s. The page may be slow or the URL may be wrong."`

Playwright 原生错误会通过 `wrapError()` 改写，去掉内部堆栈，并加上下一步指导。agent 看到错误后，应该不用人介入就知道下一步怎么做。

### 崩溃恢复

server 不尝试自愈。如果 Chromium 崩溃（`browser.on('disconnected')`），server 立即退出。CLI 会在下一条命令时检测到 server 已死，并自动重启。这比尝试重新连到一个半死不活的浏览器进程更简单，也更可靠。

## E2E 测试基础设施

### 会话运行器（`test/helpers/session-runner.ts`）

E2E 测试会把 `claude -p` 启动成一个完全独立的子进程，而不是通过 Agent SDK，因为 Agent SDK 不能嵌套在 Claude Code 会话里。runner 的流程是：

1. 把 prompt 写进临时文件（避免 shell escaping 问题）
2. 启动 `sh -c 'cat prompt | claude -p --output-format stream-json --verbose'`
3. 从 stdout 流式读取 NDJSON，实时拿到进度
4. 与可配置超时做 race
5. 把完整 NDJSON transcript 解析成结构化结果

`parseNDJSON()` 是纯函数，没有 I/O，也没有副作用，因此可以单独测试。

### 可观测性数据流

```
  skill-e2e-*.test.ts
        │
        │ 生成 runId，并把 testName + runId 传给每次调用
        │
  ┌─────┼──────────────────────────────┐
  │     │                              │
  │  runSkillTest()              evalCollector
  │  (session-runner.ts)         (eval-store.ts)
  │     │                              │
  │  每次工具调用：              每次 addTest():
  │  ┌──┼──────────┐              savePartial()
  │  │  │          │                   │
  │  ▼  ▼          ▼                   ▼
  │ [HB] [PL]    [NJ]          _partial-e2e.json
  │  │    │        │             （原子覆盖写入）
  │  │    │        │
  │  ▼    ▼        ▼
  │ e2e-  prog-  {name}
  │ live  ress   .ndjson
  │ .json .log
  │
  │  失败时：
  │  {name}-failure.json
  │
  │  所有文件都写到 ~/.gstack-dev/
  │  Run 目录：e2e-runs/{runId}/
  │
  │         eval-watch.ts
  │              │
  │        ┌─────┴─────┐
  │     read HB     read partial
  │        └─────┬─────┘
  │              ▼
  │        渲染 dashboard
  │        （>10 分钟未更新则告警）
```

**职责拆分：** session-runner 负责 heartbeat（当前测试状态），eval-store 负责 partial results（已完成测试状态）。watcher 同时读取两者。它们彼此不知道对方存在，只通过文件系统共享数据。

**任何观测都不能致命：** 所有可观测性 I/O 都被包在 try/catch 里。写失败绝不能让测试失败。测试本身才是真实来源，可观测性只是 best-effort。

**机器可读诊断：** 每个测试结果都包含 `exit_reason`（`success`、`timeout`、`error_max_turns`、`error_api`、`exit_code_N`）、`timeout_at_turn` 和 `last_tool_call`。这样就能直接用 `jq` 分析：

```bash
jq '.tests[] | select(.exit_reason == "timeout") | .last_tool_call' ~/.gstack-dev/evals/_partial-e2e.json
```

### Eval 持久化（`test/helpers/eval-store.ts`）

`EvalCollector` 会累计测试结果，并以两种方式落盘：

1. **增量写入：** `savePartial()` 会在每个测试后写 `_partial-e2e.json`（原子方式：写 `.tmp`，再 `fs.renameSync`）。即使进程被杀，也能保住进度。
2. **最终写入：** `finalize()` 会写一个带时间戳的 eval 文件（例如 `e2e-20260314-143022.json`）。partial 文件不会被清理，它会和最终文件一起保留，供观测使用。

`eval:compare` 用于比较两次 eval。`eval:summary` 会汇总 `~/.gstack-dev/evals/` 下所有运行记录的统计数据。

### 测试分层

| 层级 | 内容 | 成本 | 速度 |
|------|------|------|-------|
| 1 — 静态校验 | 解析 `$B` 命令、对照 registry 校验、运行 observability 单测 | 免费 | <5s |
| 2 — 通过 `claude -p` 做 E2E | 启动真实 Claude 会话，逐个运行 skill，并扫描报错 | ~$3.85 | ~20min |
| 3 — LLM 评审 | 用 Sonnet 评估文档的清晰度 / 完整性 / 可执行性 | ~$0.15 | ~30s |

第 1 层在每次 `bun test` 都会执行。第 2、3 层通过 `EVALS=1` 打开。策略还是一样：95% 的问题靠免费手段拦住，LLM 只用于判断与集成测试。

## 有意不做的部分

- **不做 WebSocket 流式传输。** HTTP 请求 / 响应更简单，可以直接用 curl 调试，而且已经够快。流式传输会增加复杂度，但收益很有限。
- **不做 MCP 协议。** MCP 每次请求都会带来 JSON schema 开销，而且要求持久连接。纯 HTTP + 纯文本输出更省 token，也更容易调试。
- **不支持多用户。** 一个工作区一个 server，一个用户。token 鉴权只是防御性加固，不是为多租户设计。
- **不支持 Windows / Linux 的 cookie 解密。** 目前只支持 macOS Keychain。Linux（GNOME Keyring / kwallet）和 Windows（DPAPI）在架构上能做，但现在没实现。
- **不做 iframe 自动发现。** `$B frame` 已经支持跨 frame 交互（CSS selector、`@ref`、`--name`、`--url` 匹配），但 ref 系统不会在 `snapshot` 时自动爬 iframe。你必须先显式进入 frame 上下文。
