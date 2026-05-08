# 浏览器 — 完整参考

gstack 的浏览器功能全集于一文。无头 Chromium 守护进程、约70+条命令、基于引用的元素选择、可编程浏览器技能、带 Chrome 侧边栏的真实浏览器模式、内嵌 Claude PTY 的侧边栏、ngrok 配对智能体流程，以及分层提示注入防御——所有这些都在一个编译好的 CLI 后面，以纯文本输出到 stdout。每次调用约100-200ms。零上下文 Token 开销。

如果你在过去一两个版本中使用过 gstack，生产力循环是新的亮点：`/scrape <意图>` 驱动一次页面，`/skillify` 将该流程编程为确定性 Playwright 脚本，下次对同一意图的 `/scrape` 运行在约200ms内完成，而不是约30秒的智能体重新探索。

---

## 快速开始

```bash
# 一次性：构建二进制文件 (browse/dist/browse, ~58MB)
bun install && bun run build

# 设置 $B 一次就不用再想了
B=./browse/dist/browse           # 或 ~/.claude/skills/gstack/browse/dist/browse

# 驱动页面
$B goto https://news.ycombinator.com
$B snapshot -i                   # 可以点击/填写/检查的 @e 引用
$B click @e30                    # 点击快照中的引用30
$B text                          # 获取干净的页面文本
$B screenshot /tmp/hn.png

# 编程重复流程
/scrape latest hacker news stories
/skillify                        # 写入 ~/.gstack/browser-skills/hn-front/...
/scrape hacker news front page   # 第二次调用：通过编程技能，200ms

# 实时观看 Claude 工作
$B connect                       # 有头 Chromium + 侧边栏扩展
```

---

## 目录

1. [它是什么](#它是什么)
2. [生产力循环 — `/scrape` + `/skillify`](#生产力循环)
3. [架构](#架构)
4. [命令参考](#命令参考)
5. [快照系统 + 基于引用的选择](#快照系统)
6. [浏览器技能运行时](#浏览器技能运行时)
7. [领域技能（每站点智能体笔记）](#领域技能)
8. [真实浏览器模式（`$B connect`）](#真实浏览器模式)
9. [侧边栏 + 侧边栏智能体](#侧边栏--侧边栏智能体)
10. [配对智能体 — 通过 ngrok 隧道的远程智能体](#配对智能体)
11. [认证 + Token](#认证)
12. [提示注入安全栈（L1–L6）](#安全栈)
13. [截图、PDF、视觉检查](#截图-pdf-视觉)
14. [本地 HTML — `goto file://` 与 `load-html`](#本地-html)
15. [批量端点](#批量端点)
16. [控制台、网络、对话框捕获](#捕获)
17. [JS 执行 — `js` + `eval`](#js-执行)
18. [标签页、框架、状态、监视、收件箱](#标签页框架状态)
19. [CDP 逃生舱 + CSS 检查器](#cdp)
20. [性能 + 规模](#性能)
21. [多工作区隔离](#多工作区)
22. [环境变量](#环境变量)
23. [源码映射](#源码映射)
24. [开发 + 测试](#开发)
25. [交叉引用](#交叉引用)
26. [致谢](#致谢)

---

## 它是什么

一个编译好的 CLI 二进制文件，通过 HTTP 与持久本地 Chromium 守护进程通信。CLI 是一个瘦客户端——它读取状态文件，发送命令，将响应打印到 stdout。守护进程通过 [Playwright](https://playwright.dev/) 做真正的工作。

早期的 Chrome MCP 服务器现在都通过纯 stdout 完成。没有 JSON 模式框架，没有协议协商，没有持久 WebSocket——Claude 的 Bash 工具已经存在，所以我们使用它。

三种递进模式：

- **无头**（默认）。守护进程运行没有可见窗口的 Chromium。最快、最省成本，`/qa`、`/design-review`、`/benchmark` 等技能默认使用。
- **通过 `$B connect` 有头**。相同的守护进程，但 Chromium 是可见的（重命名为"GStack Browser"），侧边栏扩展自动加载。你实时观看每个命令的执行。
- **通过隧道的配对智能体**。守护进程绑定 ngrok 转发的第二个监听器。远程智能体（Codex、OpenClaw、Hermes，任何可以说 HTTP 的东西）通过26条命令的白名单和作用域单次使用 Token 驱动你的本地浏览器。

---

## 生产力循环

v1.19.0.0 发布的亮点。两个 gstack 技能包装了浏览器技能运行时，这样第二次让 Claude 抓取页面时，它在约200ms内运行。

### `/scrape <意图>`

拉取页面数据的一个入口。底层有三条路径：

1. **匹配路径（约200ms）**——智能体运行 `$B skill list`，将意图与每个技能的 `triggers:` 数组 + `description` + `host` 进行语义匹配，如果存在有把握的匹配则运行 `$B skill run <名称>`。
2. **原型路径（约30秒）**——没有匹配，智能体使用 `$B goto`、`$B text`、`$B html`、`$B links` 等驱动页面，返回 JSON，并附加一行"说 `/skillify`"的建议。
3. **变更意图拒绝**——*提交*、*点击*、*填写*等动词路由到 `/automate`（第2b阶段，`TODOS.md` 中的P0）。`/scrape` 合约上是只读的。

### `/skillify`

将最近成功的 `/scrape` 原型编程为磁盘上的永久浏览器技能。十一步，三个锁定的合约：

- **D1——来源守卫。** 回溯最多10个智能体轮次，找到明确界定的 `/scrape` 结果。如果冷启动，拒绝并附上一条特定消息。不从聊天片段进行静默合成。
- **D2——合成输入切片。** 仅提取产生用户接受的 JSON 的最终尝试 `$B` 调用，加上用户的意图字符串。丢弃失败的选择器，丢弃聊天，丢弃早期会话内容。
- **D3——原子写入。** 将所有内容暂存到 `~/.gstack/.tmp/skillify-<spawnId>/`，针对临时目录运行 `$B skill test`，只有在测试通过 + 用户批准后才重命名到最终层路径。测试失败或拒绝：完全 `rm -rf` 临时目录。没有任何半写的技能出现在 `$B skill list` 中。

变更流程的兄弟 `/automate` 在 `TODOS.md` 中作为P0分离，在下一个分支发布——同样的 skillify 机制，非编程运行时的每个变更步骤确认门控。

参见 [`docs/designs/BROWSER_SKILLS_V1.md`](docs/designs/BROWSER_SKILLS_V1.md) 获取完整的设计 + 决策路径。

---

## 架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code                                                    │
│                                                                 │
│  $B goto https://staging.myapp.com                              │
│       │                                                         │
│       ▼                                                         │
│  ┌──────────┐    HTTP POST     ┌──────────────┐                 │
│  │ browse   │ ──────────────── │ Bun HTTP     │                 │
│  │ CLI      │  127.0.0.1:rand  │ 守护进程      │                 │
│  │          │  Bearer token    │              │                 │
│  │ 编译     │ ◄──────────────  │  Playwright  │──── Chromium    │
│  │ 二进制   │  纯文本          │  API 调用    │    (无头        │
│  └──────────┘                  └──────────────┘     或有头)    │
│   ~1ms 启动                    持久守护进程                       │
│                                第一次调用时自动启动               │
│                                空闲30分钟后自动停止               │
└─────────────────────────────────────────────────────────────────┘
```

### 守护进程生命周期

1. **第一次调用。** CLI 检查 `<项目>/.gstack/browse.json` 中是否有运行中的服务器。未找到——它在后台生成 `bun run browse/src/server.ts`。守护进程通过 Playwright 启动无头 Chromium，随机选择端口（10000–60000），生成 Bearer Token，写入状态文件（chmod 600），开始接受请求。约3秒。
2. **后续调用。** CLI 读取状态文件，使用 Bearer Token 发送 HTTP POST，打印响应。约100-200ms 往返。
3. **空闲关闭。** 30分钟无命令后，守护进程关闭并清理状态文件。下次调用重新启动。
4. **崩溃恢复。** 如果 Chromium 崩溃，守护进程立即退出——不自愈，不隐藏故障。CLI 在下次调用时检测到死守护进程并启动新的。

### 多工作区隔离

每个项目根（通过 `git rev-parse --show-toplevel` 检测）获得自己的守护进程、端口、状态文件、Cookie 和日志。无跨工作区冲突。状态在 `<项目>/.gstack/browse.json`。

| 工作区 | 状态文件 | 端口 |
|--------|---------|------|
| `/code/project-a` | `/code/project-a/.gstack/browse.json` | 随机 (10000–60000) |
| `/code/project-b` | `/code/project-b/.gstack/browse.json` | 随机 (10000–60000) |

---

## 命令参考

约70条命令，涵盖读取、写入和元操作。选择器接受 CSS、`snapshot` 中的 `@e` 引用，或 `snapshot -C` 中的 `@c` 引用。完整表格：

### 读取

| 命令 | 描述 |
|------|------|
| `text [sel]` | 干净的页面文本（或限定到选择器的范围） |
| `html [sel]` | innerHTML，或无选择器时的完整页面 HTML |
| `links` | 所有链接，格式为 `文本 → href` |
| `forms` | 表单字段，JSON 格式 |
| `accessibility` | 完整的 ARIA 树 |
| `media [--images\|--videos\|--audio] [sel]` | 媒体元素，带 URL、尺寸、类型 |
| `data [--jsonld\|--og\|--meta\|--twitter]` | 结构化数据：JSON-LD、OG、Twitter 卡片、元标签 |

### 检查

| 命令 | 描述 |
|------|------|
| `js <expr>` | 在页面上下文中运行内联 JavaScript 表达式，以字符串形式返回 |
| `eval <file>` | 从文件运行 JS（路径在 /tmp 或 cwd 下；与 `js` 相同的沙盒） |
| `css <sel> <prop>` | 计算后的 CSS 值 |
| `attrs <sel\|@ref>` | 元素属性，JSON 格式 |
| `is <prop> <sel\|@ref>` | 状态检查：visible、hidden、enabled、disabled、checked、editable、focused |
| `console [--clear\|--errors]` | 捕获的控制台消息 |
| `network [--clear]` | 捕获的网络请求 |
| `dialog [--clear]` | 捕获的对话框消息 |
| `cookies` | 所有 Cookie，JSON 格式 |
| `storage` / `storage set <key> <val>` | 读取 localStorage + sessionStorage；设置 localStorage |
| `perf` | 页面加载时序 |
| `inspect [sel] [--all] [--history]` | 通过 CDP 的深度 CSS——完整规则级联、盒模型、计算样式 |
| `ux-audit` | 行为分析的页面结构：站点 ID、导航、标题、文本块、交互元素 |
| `cdp <Domain.method> [json-params]` | 原始 CDP 方法调度（默认拒绝；`cdp-allowlist.ts` 中的白名单） |

### 导航

| 命令 | 描述 |
|------|------|
| `goto <url>` | 导航到 URL（`http://`、`https://`、`file://`） |
| `load-html <file>` | 在内存中加载本地 HTML（无 `file://` URL；在视口缩放变化时存活） |
| `back`、`forward`、`reload` | 标准导航 |
| `url` | 当前页面 URL |
| `wait <sel\|--networkidle\|--load>` | 等待元素、网络空闲或页面加载（15秒超时） |

### 交互

| 命令 | 描述 |
|------|------|
| `click <sel\|@ref>` | 点击元素 |
| `fill <sel> <val>` | 填写输入 |
| `select <sel> <val>` | 选择下拉选项（值、标签或可见文本） |
| `hover <sel>` | 悬停元素 |
| `type <text>` | 在聚焦元素中输入 |
| `press <key>` | Playwright 键盘键（区分大小写：Enter、Tab、ArrowUp、Shift+Enter、Control+A、...） |
| `scroll [sel\|@ref]` | 将元素滚动到视图中，或无选择器时跳转到页面底部 |
| `viewport [<WxH>] [--scale <n>]` | 设置视口大小 + 可选 `deviceScaleFactor` 1-3（Retina 截图） |
| `upload <sel> <file> [...]` | 上传文件 |
| `dialog-accept [text]` | 自动接受下一个 alert/confirm/prompt；文本发送到 prompt |
| `dialog-dismiss` | 自动关闭下一个对话框 |

### 样式 + 清理

| 命令 | 描述 |
|------|------|
| `style <sel> <prop> <val>` | 修改 CSS 属性（支持撤销） |
| `style --undo [N]` | 撤销最后 N 次样式更改 |
| `cleanup [--ads\|--cookies\|--sticky\|--social\|--all]` | 移除页面杂乱内容 |
| `prettyscreenshot [--scroll-to <sel\|text>] [--cleanup] [--hide <sel>...] [path]` | 干净截图，可选清理、滚动、隐藏 |

### 视觉

| 命令 | 描述 |
|------|------|
| `screenshot [--selector <css>] [--viewport] [--clip x,y,w,h] [--base64] [sel\|@ref] [path]` | 五种模式：全页、视口、元素裁剪、区域剪辑、Base64 |
| `pdf [path] [--format letter\|a4\|legal] [...]` | 完整布局的 PDF：格式、宽度/高度、边距、页眉/页脚模板、页码、`--tagged` 用于可访问性，`--toc` 等待 Paged.js |
| `responsive [prefix]` | 三张截图：移动（375x812）、平板（768x1024）、桌面（1280x720） |
| `diff <url1> <url2>` | 两个 URL 之间的文本差异 |

### Cookie + 请求头

| 命令 | 描述 |
|------|------|
| `cookie <name>=<value>` | 在当前页面域设置 Cookie |
| `cookie-import <json>` | 从 JSON 文件导入 Cookie |
| `cookie-import-browser [browser] [--domain d]` | 从已安装的 Chromium 浏览器导入（交互式选择器，或 `--domain` 直接导入） |
| `header <name>:<value>` | 设置自定义请求头（敏感值自动脱敏） |
| `useragent <string>` | 设置用户代理（触发上下文重建，使引用失效） |

### 标签页 + 框架

| 命令 | 描述 |
|------|------|
| `tabs` | 列出所有打开的标签页 |
| `tab <id>` | 切换到标签页 |
| `newtab [url] [--json]` | 打开新标签页；`--json` 返回 `{tabId, url}` 用于编程使用 |
| `closetab [id]` | 关闭标签页 |
| `tab-each <command> [args...]` | 在每个打开的标签页上扇出命令；返回 JSON |
| `frame <sel\|@ref\|--name n\|--url pattern\|main>` | 切换到 iframe 上下文（或返回主框架）；清除引用 |

### 提取

| 命令 | 描述 |
|------|------|
| `download <url\|@ref> [path] [--base64]` | 使用浏览器 Cookie 下载 URL 或媒体元素 |
| `scrape <images\|videos\|media> [--selector] [--dir] [--limit]` | 批量下载页面中的所有媒体；写入 `manifest.json` |
| `archive [path]` | 通过 CDP 将完整页面保存为 MHTML |

### 快照

| 命令 | 描述 |
|------|------|
| `snapshot [-i] [-c] [-d N] [-s sel] [-D] [-a] [-o path] [-C]` | 带 `@e` 引用的可访问性树；`-i` 仅交互，`-c` 紧凑，`-d N` 深度，`-s` 范围，`-D` 与之前差异，`-a` 带注释截图，`-C` 光标交互 `@c` 引用 |

### 服务器生命周期

| 命令 | 描述 |
|------|------|
| `status` | 守护进程健康 + 模式（无头/有头/cdp） |
| `stop` | 关闭守护进程 |
| `restart` | 重启守护进程 |
| `connect` | 启动带侧边栏扩展的有头 GStack 浏览器 |
| `disconnect` | 关闭有头 Chrome，返回无头模式 |
| `focus [@ref]` | 将有头 Chrome 带到前台（macOS）；`@ref` 也滚动到视图中 |
| `state save\|load <name>` | 保存或加载浏览器状态（Cookie + URL） |

### 切换

| 命令 | 描述 |
|------|------|
| `handoff [reason]` | 在当前页面打开可见 Chrome 供用户接管（CAPTCHA、MFA、复杂认证） |
| `resume` | 用户接管后重新快照，将控制权返回给 AI |

### 元 + 链

| 命令 | 描述 |
|------|------|
| `chain`（通过 stdin 的 JSON） | 运行一系列命令。将 `[["cmd","arg1",...],...]` 管道到 `$B chain`。遇到第一个错误停止。 |
| `inbox [--clear]` | 列出来自侧边栏侦察员收件箱的消息 |
| `watch [stop]` | 被动观察——用户浏览时定期快照；`stop` 返回摘要 |

### 浏览器技能运行时

| 命令 | 描述 |
|------|------|
| `skill list` | 列出所有浏览器技能，附带解析的层级（项目 > 全局 > 捆绑） |
| `skill show <name>` | 打印 SKILL.md |
| `skill run <name> [--arg k=v...] [--timeout=Ns]` | 使用每次生成的作用域 Token 生成技能脚本 |
| `skill test <name>` | 针对捆绑固件运行技能的 `script.test.ts` |
| `skill rm <name> [--global]` | 为用户层技能创建墓碑 |

### 领域技能

| 命令 | 描述 |
|------|------|
| `domain-skill save\|list\|show\|edit\|promote-to-global\|rollback\|rm <host?>` | 每站点智能体笔记（主机从活动标签页派生）。生命周期：隔离 → 活跃（N=3次成功使用且无分类器标记后）→ 全局（显式提升） |

别名：`setcontent`、`set-content`、`setContent` → `load-html`（在范围检查前规范化，因此只读范围 Token 不能使用别名运行写命令）。

---

## 快照系统

浏览器的关键创新是基于 Playwright 可访问性树 API 构建的**基于引用的元素选择**。没有 DOM 变化。没有注入脚本。只有 Playwright 的原生 AX API。

### `@ref` 工作原理

1. `page.locator(scope).ariaSnapshot()` 返回类似 YAML 的可访问性树。
2. 快照解析器为每个元素分配引用（`@e1`、`@e2`、...）。
3. 对于每个引用，它构建一个 Playwright `Locator`（使用 `getByRole` + nth-child）。
4. ref→Locator 映射存储在 `BrowserManager` 上。
5. 后续命令如 `click @e3` 查找 Locator 并调用 `locator.click()`。

### 引用过期检测

SPA 可以在没有导航的情况下变化 DOM（React router、标签切换、模态框）。当这发生时，从之前 `snapshot` 收集的引用可能指向不再存在的元素。`resolveRef()` 在使用任何引用之前运行异步 `count()` 检查——如果元素数量为0，它立即抛出错误，告诉智能体重新运行 `snapshot`。快速失败（约5ms），而不是等待 Playwright 的30秒操作超时。

### 扩展快照功能

- **`--diff`（`-D`）。** 将每个快照存储为基准。在下次 `-D` 调用时，返回显示更改内容的统一差异。用于验证操作（点击、填写等）是否真的起了作用。
- **`--annotate`（`-a`）。** 在每个引用的边界框处注入临时覆盖 div，拍摄带有可见引用标签的截图，然后移除覆盖层。使用 `-o <path>` 控制输出。
- **`--cursor-interactive`（`-C`）。** 使用 `page.evaluate` 扫描非 ARIA 交互元素（带有 `cursor:pointer`、`onclick`、`tabindex>=0` 的 div）。分配带有确定性 `nth-child` CSS 选择器的 `@c1`、`@c2`... 引用。这些是 ARIA 树遗漏但用户仍然可以点击的元素。

---

## 浏览器技能运行时

将重复的浏览器流程编程为确定性 Playwright 脚本的每任务目录。复利层。

### 浏览器技能的解剖

```
browser-skills/<name>/
├── SKILL.md                        # 前置内容 + 散文合约
├── script.ts                       # 确定性 Playwright-via-browse-client 逻辑
├── _lib/browse-client.ts           # 供应商化的 SDK 副本（约3KB，与规范字节相同）
├── fixtures/<host>-<date>.html     # 用于固件重播测试的捕获页面
└── script.test.ts                  # 针对固件的解析器测试（不需要守护进程）
```

捆绑的参考是 `browser-skills/hackernews-frontpage/`：抓取 HN 首页，返回30个故事的 JSON。试试它：

```bash
$B skill list                            # 显示 hackernews-frontpage（捆绑）
$B skill show hackernews-frontpage
$B skill run hackernews-frontpage        # 约200ms内30个故事的 JSON
$B skill test hackernews-frontpage       # 针对固件运行 script.test.ts
```

### 三层存储

`$B skill list` 按优先顺序遍历所有三层；第一个命中获胜。解析的层级在每个技能名称旁打印：

| 层级 | 路径 | 时机 |
|------|------|------|
| **项目** | `<项目>/.gstack/browser-skills/<name>/` | 项目特定技能（已提交或被忽略） |
| **全局** | `~/.gstack/browser-skills/<name>/` | 每用户技能，所有项目 |
| **捆绑** | `<gstack-安装>/browser-skills/<name>/` | 随 gstack 发布，只读 |

### 信任模型

两个正交轴——守护进程侧能力和进程侧环境——独立配置。

| 轴 | 机制 | 默认 |
|----|------|------|
| **守护进程侧能力** | 每次生成的作用域 Token，绑定到读写范围（浏览器驱动命令减去管理命令：`eval`、`js`、`cookies`、`storage`）。单次使用 clientId 编码技能名称 + 生成 ID。生成退出时撤销。 | 始终作用域——从不使用守护进程根 Token |
| **进程侧环境** | `trusted: true` 前置内容传递 `process.env` 减去 `GSTACK_TOKEN`。`trusted: false`（默认）只保留最小白名单（LANG、LC_ALL、TERM、TZ）并模式剥离密钥（TOKEN/KEY/SECRET/PASSWORD、AWS_*、ANTHROPIC_*、OPENAI_*、GITHUB_* 等） | 不受信任（必须选择加入） |

`GSTACK_PORT` 和 `GSTACK_SKILL_TOKEN` 最后注入，因此父进程无法覆盖它们。

### 输出协议

stdout = JSON。stderr = 流式日志。退出0/非零。默认60秒超时，通过 `--timeout=Ns` 覆盖。最大 stdout 1MB（超过则截断 + 非零退出）。匹配 `gh` / `kubectl` / `docker` 约定。

### SDK 分发工作原理

每个技能在 `_lib/browse-client.ts` 处发布自己的 `browse-client.ts` 副本，与规范的 `browse/src/browse-client.ts` 字节相同。`/skillify` 在每个生成的脚本旁复制规范 SDK。每个技能完全自包含：将目录复制到任何地方，它都能运行。版本漂移不可能——SDK 在技能编写时被冻结在该版本。

### 原子写入规范（`/skillify` D3）

`browse/src/browser-skill-write.ts` 提供三个原语：

- `stageSkill(opts)` ——以限制性权限将文件写入 `~/.gstack/.tmp/skillify-<spawnId>/<name>/`。
- `commitSkill(opts)` ——将 `fs.renameSync` 原子化到最终层路径。拒绝跟随符号链接的暂存目录（`lstat` 检查），拒绝覆盖现有技能，在层根上运行 `realpath` 规范。
- `discardStaged(stagedDir)` ——`rm -rf` 暂存目录 + 每次生成的包装器。幂等。在测试失败或批准拒绝时调用。

不存在"几乎发布"的状态。测试通过 + 用户批准 = 原子重命名。测试失败或用户拒绝 = 暂存消失。

参见 [`docs/designs/BROWSER_SKILLS_V1.md`](docs/designs/BROWSER_SKILLS_V1.md) 获取完整的设计理由。

---

## 领域技能

与浏览器技能不同的思维模型：智能体编写的关于站点的*笔记*（不是确定性脚本）。每个主机名一个。生命周期：

1. `domain-skill save <host>` ——智能体写下关于站点的笔记（例如，"GitHub：PR 创建对于非员工需要 `--draft` 标志"，"X.com：时间线使用游标分页，而不是页码"）。默认状态：**隔离**。
2. **N=3** 次成功使用且 L4 提示注入分类器未标记该笔记后，自动提升到**活跃**状态。
3. `domain-skill promote-to-global <host>` 将其提升到全局层（全机器范围，所有项目）。
4. `domain-skill rollback <host>` 降级；`domain-skill rm <host>` 创建墓碑。

分类器标记由 L4 提示注入扫描自动设置；智能体不手动设置它。

存储：
- 每项目：`<项目>/.gstack/domain-skills/<host>.md`
- 全局：`~/.gstack/domain-skills/<host>.md`

来源：`browse/src/domain-skills.ts`、`domain-skill-commands.ts`。

---

## 真实浏览器模式

`$B connect` 启动 **GStack 浏览器**——由 Playwright 控制的带有侧边栏扩展自动加载和反机器人隐身补丁的重命名 Chromium。你实时观看每个命令在可见窗口中执行。

```bash
$B connect              # 启动 GStack 浏览器，有头
$B goto https://app.com # 在可见窗口中导航
$B snapshot -i          # 来自真实页面的引用
$B click @e3            # 在真实窗口中点击
$B focus                # 将窗口带到前台（macOS）
$B status               # 显示模式：cdp
$B disconnect           # 返回无头模式
```

窗口顶部有一条微妙的金色闪光线，右下角有一个浮动的"gstack"药丸，这样你总能知道哪个 Chrome 窗口正在被控制。

### "GStack 浏览器"是什么意思

不是你的日常 Chrome——一个带有自定义品牌的 Playwright 管理的 Chromium，在 Dock 和菜单栏中，反机器人隐身（Google 和纽约时报等站点无需验证码即可工作），自定义用户代理，以及通过 `launchPersistentContext` 预加载的 gstack 扩展。你的带有标签页和书签的常规 Chrome 不受影响。

### 何时使用有头模式

- **QA 测试**，你想观看 Claude 在你的应用中点击
- **设计审查**，你需要看到 Claude 看到的内容
- **调试**，无头行为与真实 Chrome 不同的地方
- **演示**，你在分享屏幕
- **配对智能体**会话（远程智能体驱动你的本地浏览器）

### CDP 感知技能

在真实浏览器模式下，`/qa` 和 `/design-review` 自动跳过 Cookie 导入提示和无头解决方案——有头浏览器已经拥有你登录的任何会话。

---

## 侧边栏 + 侧边栏智能体

随 GStack 浏览器内置发布的 Chrome 扩展在侧边栏中显示每个 browse 命令的实时活动源，加上页面上的 `@ref` 覆盖层，加上侧边栏内的交互式 Claude PTY。

### 终端面板（亮点）

侧边栏的主要界面是**终端面板**——你可以直接从侧边栏输入的实时 `claude -p` PTY。活动/引用/检查器是页脚 `debug` 切换后面的调试覆盖层。WebSocket 认证使用 `Sec-WebSocket-Protocol`（浏览器无法在 WebSocket 升级时设置 `Authorization`），PTY 会话 Token 是通过 `POST /pty-session` 铸造的30分钟 HttpOnly Cookie。

工具栏的清理按钮和检查器的"发送到代码"操作都通过 `window.gstackInjectToTerminal(text)` 将文本管道到实时 Claude PTY 中，由 `sidepanel-terminal.js` 暴露。没有单独的 `/sidebar-command` POST——实时 REPL 是唯一的执行界面。

### 活动源

每个 browse 命令的滚动源——名称、参数、持续时间、状态、错误。Claude 工作时实时显示。由 SSE（`/activity/stream`）支持，接受 Bearer Token 或 HttpOnly `gstack_sse` 会话 Cookie（通过 `POST /sse-session` 铸造的30分钟流范围 Cookie）。

### 引用标签

`$B snapshot` 后，显示当前 `@ref` 列表（角色 + 名称），这样你可以看到 Claude 正在瞄准什么。

### CSS 检查器

由 `$B inspect`（基于 CDP）驱动。点击页面上的任何元素查看完整的 CSS 规则级联、计算样式、盒模型和修改历史。"发送到代码"按钮将描述注入 Claude PTY。

### 侧边栏架构

| 组件 | 位置 | 注释 |
|------|------|------|
| 侧边栏 UI | `extension/sidepanel.js`、`sidepanel-terminal.js` | Chrome 扩展界面 |
| 后台 SW | `extension/background.js` | 管理标签事件、端口管理 |
| 内容脚本 | `extension/content.js` | 页面覆盖层、`gstack` 药丸 |
| 终端智能体 | `browse/src/terminal-agent.ts` | PTY 生成、生命周期、认证 |
| 侧边栏工具 | `browse/src/sidebar-utils.ts` | URL 净化 + 助手 |

在修改这些之前，请阅读 `CLAUDE.md` 中"侧边栏架构"下的注释块——这里的静默失败通常是由于不理解跨组件流。

### 手动安装（针对你的普通 Chrome）

如果你想在日常 Chrome 中使用扩展（不是 Playwright 控制的那个）：

```bash
bin/gstack-extension    # 打开 chrome://extensions，将路径复制到剪贴板
```

或手动操作：`chrome://extensions` → 切换开发者模式 → 加载未打包 → 导航到 `~/.claude/skills/gstack/extension` → 固定扩展 → 从 `$B status` 输入端口。

---

## 配对智能体

远程 AI 智能体（Codex、OpenClaw、Hermes，任何可以说 HTTP 的东西）可以通过 ngrok 隧道驱动你的本地浏览器。整个流程由26条命令的白名单、作用域 Token 和拒绝日志控制。

### 工作原理

```bash
/pair-agent                     # 生成设置密钥，打印连接说明
# 将说明复制给远程智能体
# 远程智能体运行：
#   POST <隧道-url>/connect，使用设置密钥 → 获得作用域 Token（24小时，单客户端）
#   POST <隧道-url>/command，使用 Token → 运行允许的命令
```

### 双监听器架构（v1.6.0.0+）

当 `pair-agent` 激活时，守护进程绑定**两个 HTTP 监听器**：

- **本地监听器**（`127.0.0.1:LOCAL_PORT`）。完整命令界面。从不被 ngrok 转发。由你的 Claude Code、侧边栏、机器上的任何东西使用。
- **隧道监听器**（`127.0.0.1:TUNNEL_PORT`）。锁定白名单——`/connect`、`/command`（作用域 Token + 26条命令浏览器驱动白名单）、`/sidebar-chat`。ngrok 只转发这个端口。

通过隧道发送的根 Token 返回403。SSE 端点使用30分钟 HttpOnly `gstack_sse` Cookie（从不对 `/command` 有效）。

### 26条命令隧道白名单

在 `browse/src/server.ts` 中定义为 `TUNNEL_COMMANDS`。纯门函数 `canDispatchOverTunnel(command)` 导出用于单元测试。集合：

```
goto, click, text, screenshot, html, links, forms, accessibility,
attrs, media, data, scroll, press, type, select, wait, eval,
newtab, tabs, back, forward, reload, snapshot, fill, url, closetab
```

显著缺失：`pair`、`unpair`、`cookies`、`setup`、`launch`、`restart`、`stop`、`tunnel-start`、`token-mint`、`state`、`connect`、`disconnect`。尝试这些的远程智能体会收到403加上拒绝日志中的新条目。

### 隧道拒绝日志

`~/.gstack/security/attempts.jsonl` ——仅追加，仅对来源 + 域进行加盐 SHA-256（不包含原始 IP、不包含完整请求体），在10MB时轮转，保留5代。每台设备盐在 `~/.gstack/security/device-salt`（模式0600）。

参见 [`docs/REMOTE_BROWSER_ACCESS.md`](docs/REMOTE_BROWSER_ACCESS.md) 获取完整的操作员指南。

### 标签所有权

作用域 Token 默认为 `tabPolicy: 'own-only'`。配对智能体可以使用 `newtab` 创建自己的标签并自由驱动该标签，但它不能在另一个调用者拥有的标签上执行 `goto`、`fill` 或 `click`。`tabs` 列出所有标签元数据（接受的权衡——参见 ARCHITECTURE.md），但未拥有标签的 `text`/`html`/`snapshot` 内容被所有权检查阻止。

---

## 认证

三种 Token 类型，三种生命周期，三种范围。

| Token | 由谁生成 | 生命周期 | 范围 |
|-------|----------|---------|------|
| **根 Token** | 守护进程启动时（随机 UUID） | 守护进程进程生命周期 | 完整命令界面，仅本地监听器——通过隧道返回403 |
| **设置密钥** | `POST /pair` | 5分钟，一次性使用 | 单次兑换：在 `/connect` 处出示，获得作用域 Token |
| **作用域 Token** | `POST /connect`（使用设置密钥） | 24小时 | 每客户端，白名单绑定，可选标签作用域 |

根 Token 写入 `<项目>/.gstack/browse.json`，chmod 600。每个变更浏览器状态的命令都必须包含 `Authorization: Bearer <token>`。

### SSE 会话 Cookie（v1.6.0.0+）

SSE 端点（`/activity/stream`、`/inspector/events`）接受 Bearer Token 或通过 `POST /sse-session` 铸造的30分钟 HttpOnly `gstack_sse` Cookie。不再支持 `?token=<ROOT>` 查询参数认证。这使 Chrome 扩展可以订阅活动源，而无需将根 Token 放入扩展存储。

### PTY 会话 Cookie

终端面板使用单独的会话 Cookie `gstack_pty`，通过 `POST /pty-session` 铸造。不同范围——可以生成/驱动实时 `claude` PTY，不能分发任意 `/command` 调用。`/health` 端点不能暴露此 Token。

### Token 注册表

`browse/src/token-registry.ts` 处理所有三种类型的铸造/验证/撤销，加上每 Token 的速率限制。设置密钥是一次性使用的；作用域 Token 有一个滑动24小时窗口；根 Token 在每次守护进程启动时轮转。

---

## 安全栈

针对提示注入的分层防御。每一层都在每条用户消息和每个可能携带不受信任内容的工具输出（读取、Glob、Grep、WebFetch、来自 `$B` 的页面文本）上同步运行。

| 层级 | 模块 | 位置 |
|------|------|------|
| **L1** 数据标记 | `content-security.ts` | 服务器 + 侧边栏智能体两者 |
| **L2** 隐藏元素剥离 | `content-security.ts` | 两者 |
| **L3** ARIA + URL 黑名单 + 信封包装 | `content-security.ts` | 两者 |
| **L4** TestSavantAI ML 分类器（22MB ONNX） | `security-classifier.ts` | 仅侧边栏智能体* |
| **L4b** Claude Haiku 转录检查 | `security-classifier.ts` | 仅侧边栏智能体 |
| **L5** 金丝雀 Token（会话外泄检测） | `security.ts` | 两者——在编译中注入，在智能体中检查 |
| **L6** `combineVerdict` 集成 | `security.ts` | 两者 |

\* `security-classifier.ts` 不能从编译的 browse 二进制文件导入——`@huggingface/transformers` v4 需要 `onnxruntime-node`，它无法从 Bun 编译的临时提取目录中 `dlopen`。编译的二进制文件只运行 L1–L3、L5、L6。

### 阈值

- `BLOCK: 0.85` ——如果交叉确认会导致 BLOCK 的单层分数
- `WARN: 0.75` ——交叉确认阈值。当 L4 和 L4b 都 >= 0.75 时 → BLOCK
- `LOG_ONLY: 0.40` ——门控转录分类器（当所有层 < 0.40 时跳过 Haiku）
- `SOLO_CONTENT_BLOCK: 0.92` ——无标签内容分类器的单层阈值

### 集成规则

只有当 ML 内容分类器和转录分类器都报告 >= WARN 时才 BLOCK。单层高置信度降级为 WARN——这是 Stack Overflow 指令编写 FP 缓解。**金丝雀泄漏始终 BLOCK（确定性）。**

### 环境控制

- `GSTACK_SECURITY_OFF=1` ——紧急终止开关。即使已预热，分类器也保持关闭。金丝雀仍被注入；只是 ML 扫描被跳过。
- `GSTACK_SECURITY_ENSEMBLE=deberta` ——选择加入 DeBERTa-v3 集成。添加 ProtectAI DeBERTa-v3-base-injection-onnx 作为 L4c 分类器。首次运行下载721MB。启用集成后，BLOCK 需要3个 ML 分类器中的2个在 >= WARN 时达成一致。
- 分类器模型缓存：`~/.gstack/models/testsavant-small/`（112MB，仅首次运行）加上 `~/.gstack/models/deberta-v3-injection/`（721MB，仅在启用集成时）。
- 攻击日志：`~/.gstack/security/attempts.jsonl`（加盐 SHA-256 + 仅域名，在10MB时轮转，5代）。
- 每台设备盐：`~/.gstack/security/device-salt`（0600）。
- 会话状态：`~/.gstack/security/session-state.json`（跨进程，原子）。

侧边栏标题中的盾牌图标显示实时状态。参见 ARCHITECTURE.md §"提示注入防御"了解完整的威胁模型。

---

## 截图、PDF、视觉

### 截图模式

| 模式 | 语法 | Playwright API |
|------|------|----------------|
| 全页（默认） | `screenshot [path]` | `page.screenshot({ fullPage: true })` |
| 仅视口 | `screenshot --viewport [path]` | `page.screenshot({ fullPage: false })` |
| 元素裁剪（标志） | `screenshot --selector <css> [path]` | `locator.screenshot()` |
| 元素裁剪（位置） | `screenshot "#sel" [path]` 或 `screenshot @e3 [path]` | `locator.screenshot()` |
| 区域剪辑 | `screenshot --clip x,y,w,h [path]` | `page.screenshot({ clip })` |

元素裁剪接受 CSS 选择器（`.class`、`#id`、`[attr]`）或 `@e`/`@c` 引用。**标签选择器如 `button` 不会被位置启发式捕获**——使用 `--selector` 标志形式。

`--base64` 返回 `data:image/png;base64,...` 而不是写入磁盘——与 `--selector`、`--clip`、`--viewport` 组合使用。

互斥：`--clip` + 选择器，`--viewport` + `--clip`，以及 `--selector` + 位置选择器都会抛出错误。

### Retina 截图——`viewport --scale`

`viewport --scale <n>` 设置 Playwright 的 `deviceScaleFactor`（上下文级别，1-3上限）：

```bash
$B viewport 480x600 --scale 2
$B load-html /tmp/card.html
$B screenshot /tmp/card.png --selector .card
# .card 在 400x200 CSS 像素 → card.png 是 800x400 像素
```

仅 `--scale N`（无 `WxH`）保持当前视口大小。缩放更改触发上下文重建，这会使 `@e`/`@c` 引用失效——缩放后重新运行 `snapshot`。通过 `load-html` 加载的 HTML 通过内存重播在重建中存活。在有头模式下拒绝（真实浏览器控制缩放）。

### PDF 生成

`pdf` 接受完整的 Playwright 界面加上一些附加功能：

- **布局：** `--format letter|a4|legal`、`--width <dim>`、`--height <dim>`、`--margins <dim>`、`--margin-top/right/bottom/left <dim>`
- **结构：** `--toc`（如果加载则等待 Paged.js）、`--outline`、`--tagged`（PDF/A 可访问性）、`--print-background`、`--prefer-css-page-size`
- **品牌：** `--header-template <html>`、`--footer-template <html>`、`--page-numbers`
- **标签页：** `--tab-id <N>` 渲染特定标签页
- **大载荷：** `--from-file <payload.json>`（避免 shell argv 限制）

### 响应式截图

`responsive [prefix]` ——一次调用三张截图：移动（375x812）、平板（768x1024）、桌面（1280x720）。保存为 `{prefix}-mobile.png` 等。

### `prettyscreenshot`

在一次调用中组合清理 + 滚动 + 元素隐藏：

```bash
$B prettyscreenshot --cleanup --scroll-to "hero section" --hide ".cookie-banner" /tmp/clean.png
```

---

## 本地 HTML

渲染不在 Web 服务器上的 HTML 的两种方法：

| 方法 | 时机 | URL 之后 | 相对资源 |
|------|------|---------|---------|
| `goto file://<abs-path>` | 文件已在磁盘上 | `file:///...` | 相对于文件目录解析 |
| `goto file://./<rel>`、`goto file://~/<rel>` | 智能解析为绝对路径 | `file:///...` | 相同 |
| `load-html <file>` | 内存中生成的 HTML，不需要父目录上下文 | `about:blank` | 损坏（仅自包含 HTML） |

两者都通过与 `eval` 相同的安全目录策略限定到 cwd 或 `$TMPDIR` 下的文件。`file://` URL 保留查询字符串和片段（SPA 路由工作）。

`load-html` 有扩展白名单（`.html`、`.htm`、`.xhtml`、`.svg`）和魔术字节嗅探以拒绝重命名为 HTML 的二进制文件。50MB 大小上限（通过 `GSTACK_BROWSE_MAX_HTML_BYTES` 覆盖）。

`load-html` 内容通过内存重播在后续 `viewport --scale` 调用中存活（TabSession 跟踪已加载的 HTML + waitUntil）。重播纯粹在内存中——HTML 永远不会通过 `state save` 持久化到磁盘，以避免泄漏密钥或客户数据。

---

## 批量端点

`POST /batch` 在单个 HTTP 请求中发送多个命令。消除每命令的往返延迟——对于通过 ngrok 的远程智能体至关重要，每次 HTTP 调用耗费2-5秒。

```json
POST /batch
Authorization: Bearer <token>

{
  "commands": [
    {"command": "text", "tabId": 1},
    {"command": "text", "tabId": 2},
    {"command": "snapshot", "args": ["-i"], "tabId": 3},
    {"command": "click", "args": ["@e5"], "tabId": 4}
  ]
}
```

每个命令通过 `handleCommandInternal` 路由——每个命令都强制执行完整的安全管道（范围检查、域验证、标签所有权、内容包装）。每命令错误隔离：一个失败不会中止批次。每批最多50条命令。拒绝嵌套批次。速率限制：1批 = 1个请求，针对每智能体限制。

模式：智能体爬取20个页面，打开20个标签（单独的 `newtab` 或批次），然后 `POST /batch` 包含20条 `text` 命令 → 约2-3秒内获得20个页面内容，而不是约40-100秒的串行。

---

## 捕获

控制台、网络和对话框事件流入 O(1) 循环缓冲区（各50,000容量），通过 `Bun.write()` 异步刷新到磁盘：

- 控制台：`.gstack/browse-console.log`
- 网络：`.gstack/browse-network.log`
- 对话框：`.gstack/browse-dialog.log`

`console`、`network` 和 `dialog` 命令从内存缓冲区读取（不是磁盘），因此即使磁盘很慢，捕获也是实时的。

对话框（alert、confirm、prompt）默认自动接受，以防止浏览器锁定。`dialog-accept <text>` 控制 prompt 响应文本。

---

## JS 执行

`js` 运行内联表达式。`eval` 运行 JS 文件。两者在**相同的 JS 沙盒**中运行——唯一的区别是内联与文件。两者都支持 `await`——包含 `await` 的表达式自动包装在异步上下文中：

```bash
$B js "await fetch('/api/data').then(r => r.json())"   # 自动包装
$B js "document.title"                                  # 不需要包装
$B eval my-script.js                                    # 带 await 的文件
```

对于 `eval` 文件，单行文件直接返回表达式值。多行文件使用 `await` 时需要显式 `return`。包含字面 token "await" 的注释不触发包装。

路径安全：`eval` 拒绝 cwd 或 `/tmp` 之外的路径。`js` 根本不读取文件。

---

## 标签页、框架、状态

### 标签页

```bash
$B tabs                          # 列出所有打开的标签页
$B tab 3                         # 切换到标签页3
$B newtab https://example.com    # 打开新标签页，切换到它
$B newtab --json                 # 编程式：返回 {"tabId":N,"url":...}
$B closetab                      # 关闭当前标签页
$B closetab 2                    # 关闭标签页2
$B tab-each "text"               # 在每个标签页上运行 "text"，返回 JSON
```

`tab-each <command>` 在每个打开的标签页上扇出命令并返回 JSON 数组——适合"给我所有打开标签页的文本"。

### 框架

```bash
$B frame "#stripe-iframe"        # 通过选择器切换到 iframe
$B frame @e7                     # 通过引用
$B frame --name "checkout"       # 通过名称属性
$B frame --url "stripe.com"      # 通过 URL 模式匹配
$B frame main                    # 返回顶层框架
```

切换时引用被清除（iframe 有自己的 AX 树）。

### 状态保存/加载

```bash
$B state save my-session         # 将 Cookie + URL 保存到 .gstack/browse-state-my-session.json
$B state load my-session         # 恢复
```

内存中的 `load-html` 内容故意不持久化（避免将密钥泄漏到磁盘）。

### 监视

```bash
$B watch                         # 被动观察：用户浏览时每5秒快照一次
$B watch stop                    # 返回更改摘要
```

当你手动驱动浏览器并希望 Claude 在结束时看到你做了什么而不是垃圾邮件式地调用 `snapshot` 时很有用。

### 收件箱

```bash
$B inbox                         # 列出来自侧边栏侦察员的消息
$B inbox --clear                 # 读取后清除
```

侧边栏侦察员（Chrome 扩展可以生成的后台进程）在用户发现他们想要注意的东西时为 Claude 留下笔记。存储在 `.gstack/browser-scout.jsonl` 中。

---

## CDP

### `$B cdp` ——原始 Chrome DevTools 协议调度

默认拒绝。只有 `browse/src/cdp-allowlist.ts` 中枚举的方法（`CDP_ALLOWLIST` const）是可达的；任何其他方法返回403。每个白名单条目声明范围（标签 vs 浏览器）和输出（可信 vs 不可信）。不可信方法（数据外泄形状，例如 `Network.getResponseBody`）获得 UNTRUSTED 信封包装输出。

```bash
$B cdp Page.getLayoutMetrics
$B cdp Network.enable
$B cdp Accessibility.getFullAXTree --json '{"max_depth":5}'
```

发现允许的方法：读取 `browse/src/cdp-allowlist.ts`。

### `$B inspect` ——基于 CDP 的 CSS 检查器

```bash
$B inspect ".header"                # 标题的完整规则级联
$B inspect ".header" --all          # 包括用户代理规则
$B inspect ".header" --history      # 显示修改历史
```

返回带有特异性的匹配规则级联、计算样式、盒模型，以及（使用 `--history`）自页面加载以来通过 `$B style` 进行的每次 CSS 修改。由 `browse/src/cdp-inspector.ts` 中每页的持久 CDP 会话驱动。

### `$B ux-audit`

```bash
$B ux-audit
```

返回 JSON，包含站点标识、导航、标题（上限50）、文本块、交互元素（上限200）——用于行为分析的页面结构，无需倾倒完整的 HTML。由 `/qa` 和 `/design-review` 用于廉价的覆盖率映射。

---

## 性能

| 工具 | 首次调用 | 后续调用 | 每次调用的上下文开销 |
|------|---------|---------|-------------------|
| Chrome MCP | 约5秒 | 约2-5秒 | 约2000 tokens（模式 + 协议） |
| Playwright MCP | 约3秒 | 约1-3秒 | 约1500 tokens（模式 + 协议） |
| **gstack browse** | **约3秒** | **约100-200ms** | **0 tokens**（纯文本 stdout） |
| **gstack browse + 编程技能** | **约3秒** | **约200ms** | **0 tokens**（单次技能调用） |

在20条命令的浏览器会话中，MCP 工具仅在协议框架上就消耗30,000–40,000 tokens。gstack 消耗零。编程技能路径将20条命令的会话减少到一次 `$B skill run` 调用。

### 为什么选择 CLI 而不是 MCP

MCP 对远程服务很有效。对于本地浏览器自动化，它增加了纯粹的开销：

- **上下文膨胀** ——每次 MCP 调用都包含完整的 JSON 模式。一个简单的"获取页面文本"消耗的上下文 tokens 是应有的10倍。
- **连接脆弱性** ——持久的 WebSocket/stdio 连接断开并无法重新连接。
- **不必要的抽象** ——Claude 已经有一个 Bash 工具。打印到 stdout 的 CLI 是最简单的接口。

gstack 跳过了所有这些。编译好的二进制文件。纯文本输入，纯文本输出。没有协议。没有模式。没有连接管理。

---

## 多工作区

每个项目根（通过 `git rev-parse --show-toplevel` 检测）获得自己的守护进程、端口、状态文件、Cookie 和日志。无跨工作区冲突。

| 工作区 | 状态文件 | 端口 |
|--------|---------|------|
| `/code/project-a` | `/code/project-a/.gstack/browse.json` | 随机 (10000–60000) |
| `/code/project-b` | `/code/project-b/.gstack/browse.json` | 随机 (10000–60000) |

浏览器技能三层查找遍历项目 → 全局 → 捆绑，因此 `/code/project-a/.gstack/browser-skills/foo/` 处的项目层技能只在 project-a 内部屏蔽全局 `~/.gstack/browser-skills/foo/`。

---

## 环境变量

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `BROWSE_PORT` | 0（随机 10000–60000） | HTTP 服务器的固定端口（调试覆盖） |
| `BROWSE_IDLE_TIMEOUT` | 1800000（30分钟） | 空闲关闭超时，毫秒 |
| `BROWSE_STATE_FILE` | `.gstack/browse.json` | 状态文件路径 |
| `BROWSE_SERVER_SCRIPT` | 自动检测 | `server.ts` 路径 |
| `BROWSE_CDP_URL` | （无） | 设置为 `channel:chrome` 用于真实浏览器模式 |
| `BROWSE_CDP_PORT` | 0 | CDP 端口（内部使用） |
| `BROWSE_HEADLESS_SKIP` | 0 | 完全跳过 Chromium 启动（仅测试用） |
| `BROWSE_TUNNEL` | 0 | 激活双监听器隧道架构（需要 `NGROK_AUTHTOKEN`） |
| `BROWSE_TUNNEL_LOCAL_ONLY` | 0 | 仅测试——在本地绑定两个监听器，不使用 ngrok |
| `GSTACK_BROWSE_MAX_HTML_BYTES` | 52428800（50MB） | `load-html` 大小上限 |
| `GSTACK_SECURITY_OFF` | 未设置 | 紧急终止开关——禁用 ML 分类器 |
| `GSTACK_SECURITY_ENSEMBLE` | 未设置 | 设置为 `deberta` 用于3分类器集成（721MB 下载） |

---

## 源码映射

```
browse/
├── src/
│   ├── cli.ts                   # 瘦客户端——读取状态，发送 HTTP，打印
│   ├── server.ts                # Bun HTTP 守护进程——路由命令，双监听器
│   ├── browser-manager.ts       # Chromium 生命周期，标签页，引用映射，崩溃检测
│   ├── browse-client.ts         # 规范 SDK——技能导入为 _lib/browse-client.ts
│   ├── snapshot.ts              # AX 树 → @e/@c 引用 → 定位器映射；-D/-a/-C 处理
│   ├── read-commands.ts         # 非变更：text, html, links, js, css, is, dialog, ...
│   ├── write-commands.ts        # 变更：goto, click, fill, upload, dialog-accept, ...
│   ├── meta-commands.ts         # state, watch, inbox, frame, ux-audit, chain, diff, ...
│   ├── browser-skills.ts        # 三层遍历 + 前置内容解析器 + 墓碑
│   ├── browser-skill-commands.ts # $B skill list/show/run/test/rm + spawnSkill
│   ├── browser-skill-write.ts   # D3 原子暂存/提交/丢弃助手，用于 /skillify
│   ├── skill-token.ts           # mintSkillToken / revokeSkillToken（每次生成，作用域）
│   ├── domain-skills.ts         # 每站点智能体笔记（状态机：隔离→活跃→全局）
│   ├── domain-skill-commands.ts # $B domain-skill save/list/show/edit/promote/rollback/rm
│   ├── cdp-allowlist.ts         # 默认拒绝的 CDP 方法白名单
│   ├── cdp-bridge.ts            # CDP 会话生命周期桥
│   ├── cdp-commands.ts          # $B cdp 调度器
│   ├── cdp-inspector.ts         # $B inspect——每页持久 CDP 会话
│   ├── activity.ts              # ActivityEntry, CircularBuffer, SSE 订阅者，隐私过滤
│   ├── buffers.ts               # 控制台/网络/对话框循环缓冲区（O(1) 环）
│   ├── tab-session.ts           # 每标签会话状态（load-html 重播，引用映射范围）
│   ├── token-registry.ts        # 根 + 设置密钥 + 作用域 Token 的铸造/验证/撤销
│   ├── sse-session-cookie.ts    # 30分钟 HttpOnly Cookie，用于 /activity/stream + /inspector/events
│   ├── pty-session-cookie.ts    # 单独范围：实时 Claude PTY 认证
│   ├── tunnel-denial-log.ts     # ~/.gstack/security/attempts.jsonl 写入器（加盐）
│   ├── path-security.ts         # validateOutputPath / validateReadPath / validateTempPath
│   ├── url-validation.ts        # goto 的 URL 安全检查
│   ├── content-security.ts      # L1-L3：数据标记，隐藏剥离，ARIA，URL 黑名单，信封
│   ├── security.ts              # L5 金丝雀 + L6 裁决组合器 + 阈值
│   ├── security-classifier.ts   # L4 ML 分类器（TestSavant + 可选 DeBERTa 集成）
│   ├── terminal-agent.ts        # 侧边栏 Claude PTY 管理器（认证 + 生命周期）
│   ├── sidebar-utils.ts         # 侧边栏 URL 净化 + 助手
│   ├── cookie-import-browser.ts # 解密 + 从真实 Chromium 浏览器导入 Cookie
│   ├── cookie-picker-routes.ts  # /cookie-picker/* 的 HTTP 路由
│   ├── cookie-picker-ui.ts      # Cookie 选择器的自包含 HTML/CSS/JS
│   ├── network-capture.ts       # $B network 的网络请求捕获
│   ├── media-extract.ts         # $B media 的媒体元素提取
│   ├── project-slug.ts          # 状态路径的项目 slug 派生
│   ├── error-handling.ts        # safeUnlink / safeKill / isProcessAlive
│   ├── platform.ts              # OS 检测（macOS、Linux、Windows）
│   ├── telemetry.ts             # 匿名选择加入使用遥测
│   ├── find-browse.ts           # 定位运行中的守护进程或引导
│   └── config.ts                # 配置解析（env / 文件）
├── test/                        # 集成测试 + HTML 固件
└── dist/
    └── browse                   # 编译好的二进制文件（约58MB，Bun --compile）

browser-skills/
└── hackernews-frontpage/        # 捆绑的参考技能
    ├── SKILL.md
    ├── script.ts
    ├── _lib/browse-client.ts
    ├── fixtures/hn-2026-04-26.html
    └── script.test.ts

scrape/SKILL.md.tmpl             # /scrape gstack 技能——匹配或原型化入口点
skillify/SKILL.md.tmpl           # /skillify gstack 技能——将最后一次 /scrape 编程为永久技能
```

---

## 开发

### 前提条件

- [Bun](https://bun.sh/) v1.0+
- Playwright 的 Chromium（通过 `bun install` 自动安装）

### 快速开始

```bash
bun install                      # 安装依赖 + Playwright Chromium
bun test                         # 所有集成测试（仅 browse，约3秒）
bun run dev <cmd>                # 从源码运行 CLI（无需编译）
bun run build                    # 编译为 browse/dist/browse
```

### 开发模式 vs 编译好的二进制文件

在开发期间，使用 `bun run dev` 而不是编译好的二进制文件。它用 Bun 直接运行 `browse/src/cli.ts`，因此你可以立即获得反馈：

```bash
bun run dev goto https://example.com
bun run dev text
bun run dev snapshot -i
bun run dev click @e3
```

编译好的二进制文件（`bun run build`）只用于分发。它使用 Bun 的 `--compile` 标志在 `browse/dist/browse` 处生成一个约58MB的可执行文件。

### 运行测试

```bash
bun test                                    # 所有测试
bun test browse/test/commands               # 命令集成测试
bun test browse/test/snapshot               # 快照测试
bun test browse/test/cookie-import-browser  # Cookie 导入单元测试
bun test browse/test/browser-skill-write    # D3 原子写入助手测试
bun test browse/test/tunnel-gate-unit       # canDispatchOverTunnel 纯测试
```

测试启动一个本地 HTTP 服务器（`browse/test/test-server.ts`），从 `browse/test/fixtures/` 提供 HTML 固件，然后针对这些页面测试 CLI。

### 添加新命令

1. 在 `read-commands.ts`（非变更）或 `write-commands.ts`（变更），或 `meta-commands.ts`（服务器/生命周期）中添加处理器。
2. 在 `server.ts` 中注册路由。
3. 将条目添加到 `browse/src/commands.ts` 中的 `COMMAND_DESCRIPTIONS`（带有清晰的 `description` 和 `usage`——`gen-skill-docs` 验证套件强制在 `description` 中没有 `|` 字符）。
4. 如果需要，在 `browse/test/commands.test.ts` 中添加测试用例和 HTML 固件。
5. 运行 `bun test` 验证。
6. 运行 `bun run build` 编译。
7. 运行 `bun run gen:skill-docs` 重新生成 SKILL.md（命令出现在下游的命令参考表中）。

### 添加新浏览器技能

对于手写技能：复制 `browser-skills/hackernews-frontpage/`，更新 SKILL.md 前置内容，针对目标站点重写 `script.ts`，重新捕获固件，更新解析器测试。`bun test` 验证 SKILL.md 合约（同级 SDK 字节一致性，前置内容模式）。

对于智能体写的技能：用 `/scrape <意图>` 驱动一次页面，说 `/skillify`，在批准门接受建议的名称。技能在测试通过后落到 `~/.gstack/browser-skills/<name>/`。

### 部署到活动技能

活动技能位于 `~/.claude/skills/gstack/`。进行更改后：

```bash
cd ~/.claude/skills/gstack
git fetch origin && git reset --hard origin/main
bun run build
```

或直接复制二进制文件：

```bash
cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse
```

---

## 交叉引用

- [`ARCHITECTURE.md`](ARCHITECTURE.md) ——系统级架构，双监听器隧道设计，提示注入防御威胁模型
- [`CLAUDE.md`](CLAUDE.md) ——项目级说明，侧边栏架构注释，安全栈约束
- [`docs/REMOTE_BROWSER_ACCESS.md`](docs/REMOTE_BROWSER_ACCESS.md) ——`/pair-agent` 的操作员指南（设置密钥，作用域 Token，拒绝日志）
- [`docs/designs/BROWSER_SKILLS_V1.md`](docs/designs/BROWSER_SKILLS_V1.md) ——浏览器技能运行时的设计文档（第1 + 2a阶段 + 路线图）
- [`scrape/SKILL.md`](scrape/SKILL.md) ——`/scrape` 技能：匹配或原型化数据提取
- [`skillify/SKILL.md`](skillify/SKILL.md) ——`/skillify` 技能：将最后一次 `/scrape` 编程为永久技能
- [`TODOS.md`](TODOS.md) ——`/automate`（第2b阶段P0），第3阶段解析器注入，第4阶段评估 + 沙盒

---

## 致谢

浏览器自动化层构建在 Microsoft 的 [Playwright](https://playwright.dev/) 之上。Playwright 的可访问性树 API、定位器系统和无头 Chromium 管理使基于引用的交互成为可能。快照系统——将 `@ref` 标签分配给 AX 树节点并将它们映射回 Playwright 定位器——完全建立在 Playwright 的原语之上。感谢 Playwright 团队建立了如此坚实的基础。

提示注入 L4 层使用 [TestSavantAI/distilbert-v1.1-32](https://huggingface.co/TestSavantAI/distilbert-v1.1-32)（112MB ONNX），可选集成层使用 [ProtectAI/deberta-v3-base-prompt-injection-v2](https://huggingface.co/protectai/deberta-v3-base-prompt-injection-v2)（721MB ONNX）——两者都通过 `@huggingface/transformers` 在本地运行。

CDP 逃生舱由白名单控制，直接受到 v1.4 设计过程中 Codex 的 T2 外部审查的启发：默认拒绝加上显式白名单，而不是默认允许加上黑名单。
