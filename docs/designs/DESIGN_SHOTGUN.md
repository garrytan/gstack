# 设计：设计 Shotgun，浏览器到 Agent 的反馈闭环

生成时间：2026-03-27  
分支：`garrytan/agent-design-tools`  
状态：`LIVING DOCUMENT`，随着发现和修复 bug 持续更新

## 这个功能做什么

Design Shotgun 会生成多份 AI 设计稿，把它们并排打开在用户真实浏览器中的一个 comparison board 上，并收集结构化反馈，例如选择最喜欢的方案、给其他方案打分、留下备注、请求重新生成。然后这些反馈会回流给 coding agent，由 agent 基于反馈继续执行，要么接受选中的变体继续推进，要么生成新变体并刷新 comparison board。

用户始终停留在浏览器标签页里。agent 不会重复追问。board 本身就是反馈机制。

## 核心问题：两个必须通信的世界

```
  ┌─────────────────────┐          ┌──────────────────────┐
  │   USER'S BROWSER    │          │   CODING AGENT       │
  │   (real Chrome)     │          │   (Claude Code /     │
  │                     │          │    Conductor)         │
  │  Comparison board   │          │                      │
  │  with buttons:      │   ???    │  Needs to know:      │
  │  - Submit           │ ──────── │  - What was picked   │
  │  - Regenerate       │          │  - Star ratings      │
  │  - More like this   │          │  - Comments          │
  │  - Remix            │          │  - Regen requested?  │
  └─────────────────────┘          └──────────────────────┘
```

中间这个 “???” 才是最难的部分。用户在 Chrome 里点了一个按钮，而运行在终端里的 agent 需要知道这件事。它们是两个完全独立的进程，没有共享内存，没有共享事件总线，也没有 WebSocket 连接。

## 架构：这个连接是怎么实现的

```
  USER'S BROWSER                    $D serve (Bun HTTP)              AGENT
  ═══════════════                   ═══════════════════              ═════
       │                                   │                           │
       │  GET /                            │                           │
       │ ◄─────── serves board HTML ──────►│                           │
       │    (with __GSTACK_SERVER_URL      │                           │
       │     injected into <head>)         │                           │
       │                                   │                           │
       │  [user rates, picks, comments]    │                           │
       │                                   │                           │
       │  POST /api/feedback               │                           │
       │ ─────── {preferred:"A",...} ─────►│                           │
       │                                   │                           │
       │  ◄── {received:true} ────────────│                           │
       │                                   │── writes feedback.json ──►│
       │  [inputs disabled,                │   (or feedback-pending    │
       │   "Return to agent" shown]        │    .json for regen)       │
       │                                   │                           │
       │                                   │                  [agent polls
       │                                   │                   every 5s,
       │                                   │                   reads file]
```

### 三个文件

| 文件 | 写入时机 | 含义 | Agent 动作 |
|------|-------------|-------|-------------|
| `feedback.json` | 用户点击 Submit | 最终选择，流程结束 | 读取并继续 |
| `feedback-pending.json` | 用户点击 Regenerate / More Like This | 用户想要新方案 | 读取后删除，生成新变体并刷新 board |
| `feedback.json`（第 2 轮及以后） | 用户在重新生成后点击 Submit | 多轮迭代后的最终选择 | 读取并继续 |

### 状态机

```
  $D serve starts
       │
       ▼
  ┌──────────┐
  │ SERVING  │◄──────────────────────────────────────┐
  │          │                                        │
  │ Board is │  POST /api/feedback                    │
  │ live,    │  {regenerated: true}                   │
  │ waiting  │──────────────────►┌──────────────┐     │
  │          │                   │ REGENERATING │     │
  │          │                   │              │     │
  └────┬─────┘                   │ Agent has    │     │
       │                         │ 10 min to    │     │
       │  POST /api/feedback     │ POST new     │     │
       │  {regenerated: false}   │ board HTML   │     │
       │                         └──────┬───────┘     │
       ▼                                │             │
  ┌──────────┐                POST /api/reload        │
  │  DONE    │                {html: "/new/board"}    │
  │          │                          │             │
  │ exit 0   │                          ▼             │
  └──────────┘                   ┌──────────────┐     │
                                 │  RELOADING   │─────┘
                                 │              │
                                 │ Board auto-  │
                                 │ refreshes    │
                                 │ (same tab)   │
                                 └──────────────┘
```

### 端口发现

agent 会把 `$D serve` 放到后台运行，并从 stderr 中读取端口：

```
SERVE_STARTED: port=54321 html=/path/to/board.html
SERVE_BROWSER_OPENED: url=http://127.0.0.1:54321
```

agent 会从 stderr 中解析出 `port=XXXXX`。后续如果用户请求重新生成，agent 需要这个端口来向 `/api/reload` 发 POST。只要 agent 丢了这个端口号，就无法刷新 board。

### 为什么用 127.0.0.1，而不是 localhost

在某些系统上，`localhost` 可能会解析到 IPv6 的 `::1`，而 Bun.serve() 只监听 IPv4。更重要的是，`localhost` 会附带开发者当前机器上所有本地域名相关的开发 cookie。在一个同时跑着多个活跃会话的机器上，这很容易把 Bun 默认的 header size limit 顶爆，最终触发 HTTP 431。使用 `127.0.0.1` 可以同时规避这两个问题。

## 全部边界情况与陷阱

### 1. Zombie Form 问题

**现象：** 用户提交反馈后，POST 成功，server 退出。但这个 HTML 页面仍然开着，看起来还是可以交互。用户可能继续修改反馈，再点一次 Submit。但此时什么都不会发生，因为 server 已经没了。

**修复方式：** 成功 POST 后，board 的 JS 会：

- 禁用**所有**输入（按钮、单选、文本域、星级评分）
- 直接隐藏整个 Regenerate bar
- 把 Submit 按钮替换成：`"Feedback received! Return to your coding agent."`
- 显示：`"Want to make more changes? Run /design-shotgun again."`
- 页面变成一份只读的已提交记录

**实现位置：** `compare.ts:showPostSubmitState()`（第 484 行）

### 2. Dead Server 问题

**现象：** server 超时（默认 10 分钟）或崩溃了，但用户的 board 页面还在 Chrome 里开着。用户点击 Submit，`fetch()` 静默失败。

**修复方式：** `postFeedback()` 带有 `.catch()` 处理器。网络失败时：

- 显示红色错误横幅：`"Connection lost"`
- 把当前已收集到的 feedback JSON 显示在一个可复制的 `<pre>` 块里
- 用户可以手动把这段 JSON 复制粘贴回 coding agent

**实现位置：** `compare.ts:showPostFailure()`（第 546 行）

### 3. 过期的 Regeneration Spinner

**现象：** 用户点击 Regenerate 后，board 显示 spinner，并每 2 秒轮询一次 `/api/progress`。如果 agent 崩溃了，或者生成新变体太慢，spinner 会永远转下去。

**修复方式：** 进度轮询有硬性 5 分钟超时（150 次轮询 × 2 秒）。超过 5 分钟后：

- spinner 替换为：`"Something went wrong."`
- 显示：`"Run /design-shotgun again in your coding agent."`
- 停止轮询
- 页面转为只提供信息

**实现位置：** `compare.ts:startProgressPolling()`（第 511 行）

### 4. `file://` URL 问题（最初的那个 缺陷）

**现象：** skill 模板最开始用的是 `$B goto file:///path/to/board.html`。但 `browse/src/url-validation.ts:71` 出于安全原因会拦截 `file://` URL。后备方案 `open file://...` 虽然能在用户的 macOS 浏览器里打开页面，但 `$B eval` 轮询的是 Playwright 的 headless 浏览器，那是另一个进程，根本没加载这个页面。结果 agent 会永远对着一个空 DOM 轮询。

**修复方式：** `$D serve` 必须通过 HTTP 提供页面。永远不要把 comparison board 走 `file://`。`$D compare` 上的 `--serve` 标志已经把 board 生成和 HTTP 提供合并成一个命令。

**证据：** 可参见 `.context/attachments/image-v2.png`，真实用户确实踩到了这个 bug。agent 当时的诊断是正确的：

1. `$B goto` 会拒绝 `file://` URL
2. 即使有 browse daemon，也不存在对应的轮询闭环

### 5. 双击提交竞态

**现象：** 用户快速连点两次 Submit。两次 POST 都打到 server。第一次会把状态设为 `"done"` 并在 100ms 后调度 `exit(0)`。第二次请求可能正好在这 100ms 窗口内到达。

**当前状态：** 还没有完全防住。`handleFeedback()` 顶部没有检查当前 state 是否已经是 `"done"`。第二个 POST 仍然会成功，并写出第二份 `feedback.json`（通常无害，因为内容相同）。100ms 后退出仍然会发生。

**风险：** 低。因为在第一个成功响应之后，board 会立即禁用所有输入。想打出第二次点击，基本要发生在 ~1ms 量级内，而且两次写入的内容通常相同。

**潜在修复：** 在 `handleFeedback()` 顶部加入：

`if (state === 'done') return Response.json({error: 'already submitted'}, {status: 409})`

### 6. 端口协同问题

**现象：** agent 把 `$D serve` 放到后台跑，并从 stderr 里拿到 `port=54321`。后续做 regeneration 时，它还得用这个端口向 `/api/reload` 发请求。如果 agent 丢失上下文（对话被压缩、上下文窗口被填满），它可能就记不住这个端口。

**当前状态：** 端口只会在 stderr 中打印一次。agent 必须自己记住。当前没有把端口写到磁盘。

**潜在修复：** 启动时在 board HTML 旁边写一个 `serve.pid` 或 `serve.port` 文件。这样 agent 可以随时读：

```bash
cat "$_DESIGN_DIR/serve.port"  # → 54321
```

### 7. 反馈文件清理问题

**现象：** 某一轮 regeneration 生成的 `feedback-pending.json` 留在磁盘上。如果 agent 在读取前崩溃，下一次 `$D serve` 会看到这个过期文件。

**当前状态：** resolver template 中的轮询循环会要求 agent 在读取后删除 `feedback-pending.json`。但这依赖 agent 完全按说明执行。过期文件仍有可能干扰下一次会话。

**潜在修复：** `$D serve` 在启动时自动检查并删除过期 feedback 文件。或者把文件加上时间戳，例如 `feedback-pending-1711555200.json`。

### 8. 串行生成规则

**现象：** 底层 OpenAI GPT Image API 会对并发图像生成请求做限流。如果 3 个 `$D generate` 并行发起，通常只会有 1 个成功，另外 2 个会被中止。

**修复方式：** skill 模板必须明确写出：**“一次只生成一张。不要并行执行 `$D generate`。”** 这是 prompt 层约束，而不是代码锁。设计二进制本身并不会强制串行执行。

**风险：** 高。agent 天生倾向于把独立工作并行化。如果没有显式说明，它就会尝试同时跑 3 个 generate。这会浪费 API 调用和成本。

### 9. AskUserQuestion 冗余

**现象：** 用户已经通过 board 提交了反馈，其中包含偏好方案、评分和备注，结果 agent 又追问一次：“你更喜欢哪个方案？” 这会很烦。board 的意义本来就是避免这种重复追问。

**修复方式：** skill 模板必须写明：**不要**用 AskUserQuestion 去重新询问用户偏好。直接读取 `feedback.json`，里面已经有用户选择。最多只用 AskUserQuestion 确认你理解得是否正确，而不是重新问一遍。

### 10. CORS 问题

**现象：** 如果 board HTML 引用了外部资源（比如 CDN 字体、CDN 图片），浏览器会带着 `Origin: http://127.0.0.1:PORT` 去请求。大多数 CDN 会允许，但有些可能会拦截。

**当前状态：** server 没有设置 CORS headers。board HTML 当前是完全自包含的（图片做成 base64、样式内联），所以现实里还没出现过问题。

**风险：** 在当前设计下风险很低。如果未来 board 开始依赖外部资源，这个问题才会真正出现。

### 11. 大 payload 问题

**现象：** `/api/feedback` 的 POST body 目前没有大小限制。如果 board 某次意外发出了一个多 MB 的 payload，`req.json()` 会整块读进内存。

**当前状态：** 实际中的 feedback JSON 通常只有 ~500 字节到 ~2KB，风险更偏理论层面。board 的 JS 本身生成的是固定 shape 的 JSON。

### 12. `fs.writeFileSync` 错误

**现象：** `serve.ts:138` 里写 `feedback.json` 时使用 `fs.writeFileSync()`，但没有 try/catch。如果磁盘满了，或者目录是只读的，这里会直接 throw 并把 server 打崩。用户看到的会是一个永远转下去的 spinner（server 已死，但 board 并不知道）。

**风险：** 实际中很低，因为 board HTML 刚刚才写到同一个目录，这至少证明目录在当下是可写的。但用 try/catch 包一层，再返回 500 会更稳。

## 完整流程（逐步）

### Happy Path：用户第一次就选中

```
1. Agent runs: $D compare --images "A.png,B.png,C.png" --output board.html --serve &
2. $D serve starts Bun.serve() on random port (e.g. 54321)
3. $D serve opens http://127.0.0.1:54321 in user's browser
4. $D serve prints to stderr: SERVE_STARTED: port=54321 html=/path/board.html
5. $D serve writes board HTML with injected __GSTACK_SERVER_URL
6. User sees comparison board with 3 variants side by side
7. User picks Option B, rates A: 3/5, B: 5/5, C: 2/5
8. User writes "B has better spacing, go with that" in overall feedback
9. User clicks Submit
10. Board JS POSTs to http://127.0.0.1:54321/api/feedback
    Body: {"preferred":"B","ratings":{"A":3,"B":5,"C":2},"overall":"B has better spacing","regenerated":false}
11. Server writes feedback.json to disk (next to board.html)
12. Server prints feedback JSON to stdout
13. Server responds {received:true, action:"submitted"}
14. Board disables all inputs, shows "Return to your coding agent"
15. Server exits with code 0 after 100ms
16. Agent's polling loop finds feedback.json
17. Agent reads it, summarizes to user, proceeds
```

### Regeneration Path：用户想看不同方向

```
1-6.  Same as above
7.  User clicks "Totally different" chiclet
8.  User clicks Regenerate
9.  Board JS POSTs to /api/feedback
    Body: {"regenerated":true,"regenerateAction":"different","preferred":"","ratings":{},...}
10. Server writes feedback-pending.json to disk
11. Server state → "regenerating"
12. Server responds {received:true, action:"regenerate"}
13. Board shows spinner: "Generating new designs..."
14. Board starts polling GET /api/progress every 2s

    Meanwhile, in the agent:
15. Agent's polling loop finds feedback-pending.json
16. Agent reads it, deletes it
17. Agent runs: $D variants --brief "totally different direction" --count 3
    (ONE AT A TIME, not parallel)
18. Agent runs: $D compare --images "new-A.png,new-B.png,new-C.png" --output board-v2.html
19. Agent POSTs: curl -X POST http://127.0.0.1:54321/api/reload -d '{"html":"/path/board-v2.html"}'
20. Server swaps htmlContent to new board
21. Server state → "serving" (from reloading)
22. Board's next /api/progress poll returns {"status":"serving"}
23. Board auto-refreshes: window.location.reload()
24. User sees new board with 3 fresh variants
25. User picks one, clicks Submit → happy path from step 10
```

### “More Like This” 路径

```
与 regeneration 相同，区别是：
- regenerateAction 是 "more_like_B"（会引用某个变体）
- Agent 使用 $D iterate --image B.png --brief "more like this, keep the spacing"
  而不是 $D variants
```

### 回退路径：`$D serve` 失败

```
1. Agent tries $D compare --serve, it fails (binary missing, port error, etc.)
2. Agent falls back to: open file:///path/board.html
3. Agent uses AskUserQuestion: "I've opened the design board. Which variant
   do you prefer? Any feedback?"
4. User responds in text
5. Agent proceeds with text feedback (no structured JSON)
```

## 对应实现文件

| 文件 | 角色 |
|------|------|
| `design/src/serve.ts` | HTTP server、状态机、文件写入、浏览器启动 |
| `design/src/compare.ts` | board HTML 生成、评分 / 选择 / regen 的 JS、POST 逻辑、提交后生命周期 |
| `design/src/cli.ts` | CLI 入口，接入 `serve` 和 `compare --serve` 命令 |
| `design/src/commands.ts` | 命令注册表，定义 `serve` 与 `compare` 及其参数 |
| `scripts/resolvers/design.ts` | `generateDesignShotgunLoop()`，会输出轮询循环与 reload 指令的模板解析器 |
| `design-shotgun/SKILL.md.tmpl` | 编排完整流程的 skill 模板，包括上下文收集、变体生成、`{{DESIGN_SHOTGUN_LOOP}}`、反馈确认 |
| `design/test/serve.test.ts` | HTTP 端点与状态迁移的单元测试 |
| `design/test/feedback-roundtrip.test.ts` | E2E 测试：浏览器点击 → JS fetch → HTTP POST → 磁盘文件 |
| `browse/test/compare-board.test.ts` | comparison board UI 的 DOM 级测试 |

## 还有哪些地方可能出问题

### 已知风险（按可能性排序）

1. **agent 不遵守串行生成规则**，大多数 LLM 都倾向并行化。如果二进制层面不强制，这个提示就有可能被忽略。
2. **agent 丢了端口号**，上下文压缩后，stderr 中的端口输出消失，agent 无法 reload board。缓解方案是把端口写入文件。
3. **过期 feedback 文件**，来自崩溃会话的 `feedback-pending.json` 会干扰下一次运行。缓解方案是启动时清理。
4. **`fs.writeFileSync` 崩溃**，写 feedback 文件时没有 try/catch。如果磁盘已满，server 会静默死亡，用户只会看到无限 spinner。
5. **进度轮询漂移**，`setInterval(fn, 2000)` 跑满 5 分钟时，理论上可能会漂移。尤其当标签页在后台时，Chrome 可能把定时器节流到每分钟一次。

### 已经做得不错的部分

1. **双通道反馈**，前台模式走 stdout，后台模式走文件。两条通道始终同时存在，agent 可以择优使用。
2. **自包含 HTML**，board 的 CSS、JS、图片全都内联或 base64，不依赖外部资源，离线也能工作。
3. **同一标签页内完成 regeneration**，用户停留在一个 tab 里。board 通过 `/api/progress` 轮询 + `window.location.reload()` 自动刷新，不会越开越多标签页。
4. **优雅降级**，POST 失败时给出可复制 JSON，progress 超时时给出清晰错误提示，没有静默失败。
5. **提交后的生命周期收口**，用户提交后 board 自动转成只读，不会留下 zombie form，并且明确告诉用户下一步要回到 coding agent。

## 测试覆盖

### 已覆盖内容

| 流程 | 测试 | 文件 |
|------|------|------|
| Submit → feedback.json 落盘 | 浏览器点击 → 文件出现 | `feedback-roundtrip.test.ts` |
| 提交后 UI 锁定 | 输入禁用、成功提示显示 | `feedback-roundtrip.test.ts` |
| Regenerate → feedback-pending.json | 点击 chiclet + regen → 文件出现 | `feedback-roundtrip.test.ts` |
| “More like this” → 特定 action | JSON 中写入 `more_like_B` | `feedback-roundtrip.test.ts` |
| regen 后 spinner 显示 | DOM 展示 loading 文本 | `feedback-roundtrip.test.ts` |
| 完整 regen → reload → submit | 两轮闭环 | `feedback-roundtrip.test.ts` |
| server 启动随机端口 | 端口 0 绑定 | `serve.test.ts` |
| server URL 注入 HTML | 检查 `__GSTACK_SERVER_URL` | `serve.test.ts` |
| 非法 JSON 拒绝 | 400 响应 | `serve.test.ts` |
| HTML 文件校验 | 文件缺失时 exit 1 | `serve.test.ts` |
| 超时行为 | 超时后 exit 1 | `serve.test.ts` |
| board DOM 结构 | radios、stars、chiclets | `compare-board.test.ts` |

### 尚未覆盖内容

| 缺口 | 风险 | 优先级 |
|-----|------|----------|
| 双击提交竞态 | 低，第一次响应后会立刻禁用输入 | P3 |
| 进度轮询超时（150 次） | 中，5 分钟太长，不适合普通测试 | P2 |
| regeneration 期间 server 崩溃 | 中，用户会看到无限 spinner | P2 |
| POST 时网络超时 | 低，localhost 通常很快 | P3 |
| 后台标签页导致定时器节流 | 中，可能把 5 分钟拖成 30+ 分钟 | P2 |
| 巨大 feedback payload | 低，board 生成的是固定 shape JSON | P3 |
| 并发会话（两个 board、一个 server） | 低，每次 `$D serve` 都会分配自己端口 | P3 |
| 上一轮留下的过期 feedback 文件 | 中，可能干扰新一轮轮询 | P2 |

## 潜在改进

### 短期（本分支内）

1. **把端口写进文件**，`serve.ts` 启动时把 `serve.port` 写到磁盘。agent 可随时读取。5 行左右。
2. **启动时清理过期文件**，`serve.ts` 启动前删除 `feedback*.json`。3 行左右。
3. **防双击提交**，在 `handleFeedback()` 顶部判断 `state === 'done'`。2 行左右。
4. **给文件写入加 try/catch**，把 `fs.writeFileSync` 包起来，失败时返回 500。5 行左右。

### 中期（后续跟进）

5. **用 WebSocket 取代轮询**，把 `setInterval` + `GET /api/progress` 替换成 WebSocket。新 HTML 准备好时，board 能立即收到通知。这样可以消除轮询漂移和后台标签页节流。大概是 `serve.ts` 50 行 + `compare.ts` 20 行。

6. **给 agent 用的端口文件**，把 `{"port": 54321, "pid": 12345, "html": "/path/board.html"}` 写进 `$_DESIGN_DIR/serve.json`。agent 以后直接读文件，不再依赖 stderr。对抗上下文丢失更稳。

7. **反馈 schema 校验**，在写入前用 JSON schema 校验 POST body。这样 malformed feedback 会被更早挡住，不会把问题带到后续 agent 逻辑里。

### 长期（设计方向）

8. **持久化设计 server**，不是每次会话都启动一次 `$D serve`，而是像 browse daemon 一样跑一个长期 design daemon。多个 board 共用一个 server。这样就没有 cold start，但 daemon 生命周期管理会更复杂。

9. **实时协作**，允许两个 agent，或者一个 agent + 一个真人，同时在同一块 board 上工作。server 通过 WebSocket 广播状态变化。届时就需要处理反馈冲突。
