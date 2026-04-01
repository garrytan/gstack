# 设计：gstack 可视化设计生成（`design` binary）

由 `/office-hours` 于 2026-03-26 生成  
分支：`garrytan/agent-design-tools`  
仓库：`gstack`  
状态：`DRAFT`  
模式：`Intrapreneurship`

## 背景

gstack 的设计类 skills（`/office-hours`、`/design-consultation`、`/plan-design-review`、`/design-review`）现在产出的都是**文字版设计描述**，比如带十六进制颜色的 `DESIGN.md`、用自然语言写像素规格的计划文档、ASCII 线框图。作者本身是设计师，曾经在 OmniGraffle 里手工设计过 HelloSign，对这种输出方式感到尴尬。

当前价值单元错了。用户不需要更花哨的设计语言，他们需要的是一个可以执行、可以直接看的视觉产物，把对话从“你喜欢这份 spec 吗？”变成“这是不是我们要的界面？”

## 问题陈述

设计类 skill 现在是在“描述设计”，不是“展示设计”。Argus 的 UX overhaul 计划就是例子：487 行关于情绪曲线、字体选择、动画时序的详细规格，结果没有任何视觉产物。一个会“做设计”的 AI coding agent，应该产出你能直接看、能凭直觉做反应的东西。

## 需求证据

创作者兼主要用户认为现在的输出很尴尬。每次设计类 skill 会话都以一堆 prose 结束，而那里本来应该出现的是 mockup。现在 GPT Image API 已经能生成文字渲染准确、接近像素级的 UI mockup，当初只能输出文本的能力缺口已经不存在了。

## 最窄切口

做一个编译后的 TypeScript 二进制（`design/dist/design`），封装 OpenAI Images / Responses API，并允许 skill 模板通过 `$D` 调用，模式和现有 `$B` browse binary 一致。集成优先级：`/office-hours` → `/plan-design-review` → `/design-consultation` → `/design-review`。

## 已达成的前提

1. GPT Image API（通过 OpenAI Responses API）是正确的引擎，Google Stitch SDK 作为备选。
2. **设计类 skill 默认生成视觉 mockup**，并提供简单的跳过路径，不做 opt-in。（根据 Codex 的质疑修正）
3. 这应该是共享工具，不应该每个 skill 各自重写，因此需要一个任何 skill 都能调用的 `design` binary。
4. 优先级按顺序来：先 `/office-hours`，再 `/plan-design-review`、`/design-consultation`、`/design-review`。

## 跨模型视角（Codex）

Codex 独立验证了核心判断：“失败点不在 markdown 里的输出质量，而在于当前价值单元本身就错了。” 关键贡献如下：
- 质疑了前提 #2（从 opt-in 改成 default-on），已采纳
- 提出了 vision 质检门：用 GPT-4o vision 检查生成 mockup 是否存在文字不可读、缺少区块、布局损坏，失败时自动重试一次
- 把原型压缩到 48 小时：共享 `visual_mockup.ts` 工具，只先接入 `/office-hours` 和 `/plan-design-review`，产出 hero mockup + 2 个变体

## 推荐方案：`design` Binary（方案 B）

### 架构

**沿用 browse binary 的编译与分发模式**（`bun build --compile`、setup script、skill 模板里的 `$VARIABLE` 解析），但整体架构更简单，不需要常驻 daemon server、不需要 Chromium、不需要 health check，也不需要 token auth。design binary 是无状态 CLI，职责只是发 OpenAI API 请求并把 PNG 写到磁盘。多轮迭代需要的会话状态放到一个 JSON 文件里。

**新增依赖：** `openai` npm 包（加到 `devDependencies`，不是 runtime deps）。design binary 独立编译，不和 browse 混编，避免 `openai` 把 browse binary 体积带大。

```
design/
├── src/
│   ├── cli.ts            # 入口点，命令分发
│   ├── commands.ts       # 命令注册表（文档与校验的单一真源）
│   ├── generate.ts       # 根据结构化 brief 生成 mockup
│   ├── iterate.ts        # 基于已有 mockup 的多轮迭代
│   ├── variants.ts       # 根据 brief 生成 N 个设计变体
│   ├── check.ts          # 基于 vision 的质量门（GPT-4o）
│   ├── brief.ts          # 结构化 brief 类型与组装辅助
│   └── session.ts        # 会话状态（用于多轮调用的 response ID）
├── dist/
│   ├── design            # 编译后的 binary
│   └── .version          # Git hash
└── test/
    └── design.test.ts    # 集成测试
```

### 命令

```bash
# 根据结构化 brief 生成 hero mockup
$D generate --brief "Dashboard for a coding assessment tool. Dark theme, cream accents. Shows: builder name, score badge, narrative letter, score cards. Target: technical users." --output /tmp/mockup-hero.png

# 生成 3 个设计变体
$D variants --brief "..." --count 3 --output-dir /tmp/mockups/

# 基于反馈迭代已有 mockup
$D iterate --session /tmp/design-session.json --feedback "Make the score cards larger, move the narrative above the scores" --output /tmp/mockup-v2.png

# Vision 质量检查（返回 PASS/FAIL + 问题）
$D check --image /tmp/mockup-hero.png --brief "Dashboard with builder name, score badge, narrative"

# 一次生成，带 quality gate 和自动重试
$D generate --brief "..." --output /tmp/mockup.png --check --retry 1

# 通过 JSON 文件传入结构化 brief
$D generate --brief-file /tmp/brief.json --output /tmp/mockup.png

# 生成用于用户评审的对比看板 HTML
$D compare --images /tmp/mockups/variant-*.png --output /tmp/design-board.html

# 引导式 API key 配置 + smoke 测试
$D setup
```

**Brief 输入模式：**
- `--brief "plain text"`，自由文本提示词，简单模式
- `--brief-file path.json`，结构化 JSON，匹配 `DesignBrief` 接口，丰富模式
- skills 负责构造 JSON brief，写到 `/tmp`，然后通过 `--brief-file` 传进去

**所有命令都注册在 `commands.ts` 里**，包括 `generate` 上的 `--check` 和 `--retry` 标志位。

### 设计探索工作流（来自 eng 审查）

这个工作流是串行的，不是并行的。PNG 用于视觉探索，面向人；HTML wireframe 用于实现，面向 agent：

```
1. $D variants --brief "..." --count 3 --output-dir /tmp/mockups/
   → 生成 2-5 个 PNG mockup 变体

2. $D compare --images /tmp/mockups/*.png --output /tmp/design-board.html
   → 生成 HTML 对比看板（规格见下）

3. $B goto file:///tmp/design-board.html
   → 用户在 headed Chrome 里查看所有变体

4. 用户选择喜欢的方案、评分、评论，点击 [Submit]
   Agent 轮询：$B eval document.getElementById('status').textContent
   Agent 读取：$B eval document.getElementById('feedback-result').textContent
   → 不用剪贴板，不用复制粘贴。agent 直接从页面读取反馈。

5. Claude 生成与已批准方向一致的 HTML wireframe，使用 DESIGN_SKETCH
   → agent 按可检查的 HTML 实现，而不是对 opaque PNG 猜测
```

### 对比看板设计规格（来自 `/plan-design-review`）

**分类器：APP UI**（任务导向、工具型页面），不涉及产品 branding。

**布局：单列、全宽 mockup。** 每个变体都吃满可用视口宽度，优先保证图片清晰度。用户纵向滚动浏览多个变体。

```
┌─────────────────────────────────────────────────────────────┐
│  HEADER BAR                                                 │
│  "Design Exploration" . project name . "3 variants"         │
│  模式指示：[Wide exploration] | [Matching DESIGN.md]        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              VARIANT A（全宽）                         │  │
│  │         [ mockup PNG, max-width: 1200px ]             │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ (●) Pick   ★★★★☆   [你喜欢/不喜欢什么？____]         │  │
│  │            [More like this]                            │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              VARIANT B（全宽）                         │  │
│  │         [ mockup PNG, max-width: 1200px ]             │  │
│  ├───────────────────────────────────────────────────────┤  │
│  │ ( ) Pick   ★★★☆☆   [你喜欢/不喜欢什么？____]         │  │
│  │            [More like this]                            │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ...（继续下滚查看更多变体）                                 │
│                                                             │
│  ─── 分隔线 ────────────────────────────────────────────    │
│  整体方向（可选，默认折叠）                                │
│  [textarea, 3 行，聚焦时展开]                              │
│                                                             │
│  ─── REGENERATE BAR（#f7f7f7 背景）───────────────────    │
│  “还想继续探索吗？”                                       │
│  [Totally different]  [Match my design]  [Custom: ______]  │
│                                          [Regenerate ->]   │
│  ────────────────────────────────────────────────────────  │
│                                        [ ✓ Submit ]        │
└─────────────────────────────────────────────────────────────┘
```

**视觉规格：**
- 背景：`#fff`。不要阴影，不要 card 边框。不同 variant 之间用 `1px #e5e5e5` 分隔线。
- 字体：system font stack。Header：`16px semibold`。Label：`14px semibold`。反馈占位符：`13px regular #999`。
- 星级评分：5 颗可点击星星，选中 `#000`，未选中 `#ddd`。不使用彩色，不做动画。
- 单选按钮 `Pick`：明确选出一个 favorite，每个 variant 只能选一个。
- `More like this` 按钮：每个 variant 独立，触发以该方案风格为种子的再生成。
- Submit 按钮：黑底白字，右对齐，唯一主 CTA。
- Regenerate bar：`#f7f7f7` 背景，视觉上要和反馈区明显分离。
- mockup 图片 `max-width: 1200px`，居中。左右边距：`24px`。

**交互状态：**
- Loading（页面先打开但图片尚未生成）：每张卡片显示 skeleton pulse，并带 `Generating variant A...`。星级、textarea、pick 都禁用。
- Partial failure（3 个里有 2 个成功）：显示成功项，失败项显示 error card，并带该 variant 的 `[Retry]`。
- Post-submit：显示 `Feedback submitted! Return to your coding agent.`，页面保持打开。
- Regeneration：平滑过渡，先淡出旧变体，再 skeleton pulse，最后淡入新变体。滚动重置回顶部，旧反馈清空。

**反馈 JSON 结构**（写到隐藏的 `#feedback-result` 元素中）：
```json
{
  "preferred": "A",
  "ratings": { "A": 4, "B": 3, "C": 2 },
  "comments": {
    "A": "Love the spacing, header feels right",
    "B": "Too busy, but good color palette",
    "C": "Wrong mood entirely"
  },
  "overall": "Go with A, make the CTA bigger",
  "regenerated": false
}
```

**可访问性：** 星级评分支持键盘操作（方向键）。textarea 有 label（如 `Feedback for Variant A`）。Submit / Regenerate 都支持键盘访问，并有可见 focus ring。所有文字都应保证 `#333+` 在白底上的对比度。

**响应式：**
- `>1200px`：舒适边距
- `768-1200px`：更紧凑的边距
- `<768px`：全宽，不允许横向滚动

**截图同意（仅 `$D evolve` 第一次使用时）：**  
`This will send a screenshot of your live site to OpenAI for design evolution. [Proceed] [Don't ask again]`  
结果写入 `~/.gstack/config.yaml` 的 `design_screenshot_consent`。

为什么必须串行：Codex 的对抗式 review 指出，光栅 PNG 对 agent 来说是 opaque 的，没有 DOM、没有状态、也没法 diff。HTML wireframe 则保留了回到代码实现的桥。PNG 是给人看的，用来判断“对，就是这个方向”；HTML 是给 agent 用的，用来判断“我知道怎么把它做出来”。

### 关键设计决策

**1. 无状态 CLI，不做 daemon**

Browse 需要常驻 Chromium。Design 只是 API 调用，没有理由起 server。多轮迭代需要的会话状态写入 `/tmp/design-session-{id}.json`，里面只存 `previous_response_id`。
- **Session ID：** 用 `${PID}-${timestamp}` 生成，通过 `--session` 传递
- **发现方式：** `generate` 命令创建 session 文件并打印路径，`iterate` 通过 `--session` 读取
- **清理：** `/tmp` 里的 session 文件是临时文件，交给系统清理，不额外处理

**2. 结构化 brief 输入**

Brief 是 skill prose 和图像生成之间的接口。skills 根据设计上下文来构造它：
```typescript
interface DesignBrief {
  goal: string;           // “用于 coding assessment 工具的 dashboard”
  audience: string;       // “技术用户、YC partners”
  style: string;          // “深色主题、奶油色点缀、极简”
  elements: string[];     // ["builder name", "score badge", "narrative letter"]
  constraints?: string;   // “最大宽度 1024px，mobile-first”
  reference?: string;     // 已有截图路径，或 DESIGN.md 摘录
  screenType: string;     // "desktop-dashboard" | "mobile-app" | "landing-page" | 等等
}
```

**3. 设计类 skill 默认开启**

skills 默认生成 mockup。模板里带一段可跳过文案：
```
Generating visual mockup of the proposed design... (say "skip" if you don't need visuals)
```

**4. Vision 质量门**

生成之后，可选择把图片再送进 GPT-4o vision 做检查：
- 文字是否可读（label / heading 看得清吗）
- 布局是否完整（要求的元素都出现了吗）
- 视觉上是否连贯（像真实 UI，而不是拼贴）

失败时自动重试一次。如果还失败，仍然展示给用户，但带 warning。

**5. 输出位置：探索稿放 `/tmp`，最终确认稿放 `docs/designs/`**
- 探索过程中的 variant 放到 `/tmp/gstack-mockups-{session}/`，不提交
- 只有**用户最终确认的版本**保存到 `docs/designs/` 并纳入版本控制
- 默认输出目录可以通过 `CLAUDE.md` 的 `design_output_dir` 配置
- 文件命名模式：`{skill}-{description}-{timestamp}.png`
- 若 `docs/designs/` 不存在，自动 `mkdir -p`
- 设计文档里引用已提交图片路径
- 始终通过 Read tool 展示给用户，这样 Claude Code 能内联渲染图片
- 这样可以避免仓库膨胀，只提交最终确认稿，不保存每次探索产物
- fallback：如果当前不在 git repo，保存到 `/tmp/gstack-mockup-{timestamp}.png`

**6. 信任边界说明**

默认开启的生成会把设计 brief 文本发给 OpenAI。这是一个新的对外数据流，和现有完全本地的 HTML wireframe 路径不同。brief 只包含抽象设计描述（目标、风格、元素），永远不包含源码和用户数据。通过 `$B` 拿到的截图**不会**发给 OpenAI（`DesignBrief.reference` 只是一个 agent 本地可见路径，不会上传）。这部分需要记录到 `CLAUDE.md`。

**7. Rate limit 缓解**

variant 生成使用带间隔的并发：每个 API 调用间隔 1 秒启动，使用 `Promise.allSettled()` 配合延迟。这能避开图像生成 `5-7 RPM` 的限制，同时仍比完全串行快。若任一调用返回 `429`，则按指数退避重试（`2s`、`4s`、`8s`）。

### 模板集成

**加到现有 resolver：** `scripts/resolvers/design.ts`（**不要新建文件**）
- 新增 `generateDesignSetup()`，用于 `{{DESIGN_SETUP}}` 占位符，模式对齐 `generateBrowseSetup()`
- 新增 `generateDesignMockup()`，用于 `{{DESIGN_MOCKUP}}` 占位符，承载完整探索流程
- 所有设计 resolver 保持集中在一个文件里，符合现有代码库风格

**新增 HostPaths 字段：** `types.ts`
```typescript
// claude host:
designDir: '~/.claude/skills/gstack/design/dist'
// codex host:
designDir: '$GSTACK_DESIGN'
```
说明：Codex 运行时的 setup 流程也必须导出 `GSTACK_DESIGN` 环境变量，模式和 `GSTACK_BROWSE` 一样。

**`$D` 解析 bash 片段**（由 `{{DESIGN_SETUP}}` 生成）：
```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
D=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/gstack/design/dist/design" ] && D="$_ROOT/.claude/skills/gstack/design/dist/design"
[ -z "$D" ] && D=~/.claude/skills/gstack/design/dist/design
if [ -x "$D" ]; then
  echo "DESIGN_READY: $D"
else
  echo "DESIGN_NOT_AVAILABLE"
fi
```
如果输出 `DESIGN_NOT_AVAILABLE`，skills 回退到 HTML wireframe 生成（现有 `DESIGN_SKETCH` 模式）。Design mockup 只是渐进增强，不是硬依赖。

**现有 resolver 中新增函数：** `scripts/resolvers/design.ts`
- 新增 `generateDesignSetup()`，用于 `{{DESIGN_SETUP}}`
- 新增 `generateDesignMockup()`，用于 `{{DESIGN_MOCKUP}}`
- 所有设计 resolver 继续放在一个文件中

### 技能 集成（按优先级）

**1. `/office-hours`，替换 Visual Sketch 部分**
- 在 approach selection（Phase 4）后生成 hero mockup + 2 个变体
- 通过 Read tool 一起展示给用户，让用户挑选
- 如有需要再迭代
- 选中的 mockup 和 design doc 一起保存

**2. `/plan-design-review`，补上“更好的样子是什么”**
- 当某个设计维度评分低于 `7/10` 时，生成一张 `10/10` 应该长什么样的 mockup
- 左右对比：当前版本（通过 `$B` 截图） vs. 提案版本（通过 `$D` 生成）

**3. `/design-consultation`，设计系统预览**
- 生成拟议设计系统的可视化预览（字体、颜色、组件）
- 用真正的 mockup 替换当前 `/tmp` HTML preview 页

**4. `/design-review`，设计意图对比**
- 根据 plan / `DESIGN.md` 规格生成一张“设计意图” mockup
- 再和线上页面截图做视觉差异对比

### 需要创建的文件

| 文件 | 用途 |
|------|------|
| `design/src/cli.ts` | 入口点，命令分发 |
| `design/src/commands.ts` | 命令注册表 |
| `design/src/generate.ts` | 通过 Responses API 做 GPT Image 生成 |
| `design/src/iterate.ts` | 带 session 状态的多轮迭代 |
| `design/src/variants.ts` | 生成 N 个设计变体 |
| `design/src/check.ts` | 基于 vision 的质量门 |
| `design/src/brief.ts` | 结构化 brief 类型与辅助 |
| `design/src/session.ts` | session 状态管理 |
| `design/src/compare.ts` | HTML 对比看板生成器 |
| `design/test/design.test.ts` | 集成测试（mock OpenAI API） |
| （无，直接改现有 `scripts/resolvers/design.ts`） | `{{DESIGN_SETUP}}` + `{{DESIGN_MOCKUP}}` resolver |

### 需要修改的文件

| 文件 | 变更 |
|------|------|
| `scripts/resolvers/types.ts` | 给 `HostPaths` 增加 `designDir` |
| `scripts/resolvers/index.ts` | 注册 `DESIGN_SETUP` + `DESIGN_MOCKUP` resolver |
| `package.json` | 增加 `design` build 命令 |
| `setup` | 在 browse 之外一并构建 design binary |
| `scripts/resolvers/preamble.ts` | 为 Codex host 导出 `GSTACK_DESIGN` 环境变量 |
| `test/gen-skill-docs.test.ts` | 更新 `DESIGN_SKETCH` 相关测试套件 |
| `setup` | 增加 design binary 构建，以及 Codex/Kiro 资产链接 |
| `office-hours/SKILL.md.tmpl` | 用 `{{DESIGN_MOCKUP}}` 替换 Visual Sketch 段落 |
| `plan-design-review/SKILL.md.tmpl` | 增加 `{{DESIGN_SETUP}}`，并在低分维度里生成 mockup |

### 可复用的现有代码

| 代码 | 位置 | 用途 |
|------|------|------|
| Browse CLI 模式 | `browse/src/cli.ts` | 命令分发架构 |
| `commands.ts` 注册表 | `browse/src/commands.ts` | 单一真源模式 |
| `generateBrowseSetup()` | `scripts/resolvers/browse.ts` | `generateDesignSetup()` 模板 |
| `DESIGN_SKETCH` resolver | `scripts/resolvers/design.ts` | `DESIGN_MOCKUP` resolver 模板 |
| HostPaths 系统 | `scripts/resolvers/types.ts` | 多 host 路径解析 |
| 构建流水线 | `package.json` build script | `bun build --compile` 模式 |

### API 细节

**Generate：** OpenAI Responses API + `image_generation` tool
```typescript
const response = await openai.responses.create({
  model: "gpt-4o",
  input: briefToPrompt(brief),
  tools: [{ type: "image_generation", size: "1536x1024", quality: "high" }],
});
// 从 response output items 中提取图像
const imageItem = response.output.find(item => item.type === "image_generation_call");
const base64Data = imageItem.result; // base64 编码 PNG
fs.writeFileSync(outputPath, Buffer.from(base64Data, "base64"));
```

**Iterate：** 同一个 API，但加上 `previous_response_id`
```typescript
const response = await openai.responses.create({
  model: "gpt-4o",
  input: feedback,
  previous_response_id: session.lastResponseId,
  tools: [{ type: "image_generation" }],
});
```
**注意：** 基于 `previous_response_id` 的多轮图像迭代目前只是一个假设，还需要原型验证。Responses API 支持会话线程，但它是否能保留已生成图像的视觉上下文以支持类似 edit 的迭代，文档没有确认。**Fallback：** 如果多轮不成立，`iterate` 就退化为“原始 brief + 累积反馈”一次性重生。

**Check：** GPT-4o vision
```typescript
const check = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{
    role: "user",
    content: [
      { type: "image_url", image_url: { url: `data:image/png;base64,${imageData}` } },
      { type: "text", text: `Check this UI mockup. Brief: ${brief}. Is text readable? Are all elements present? Does it look like a real UI? Return PASS or FAIL with issues.` }
    ]
  }]
});
```

**成本：** 每次设计会话约 `$0.10-$0.40`（1 张 hero + 2 个变体 + 1 次质量检查 + 1 次迭代）。和每次 skill 调用本身已经消耗的 LLM 成本相比，这个量级可以接受。

### 鉴权（已通过 smoke 测试 验证）

**Codex OAuth token 不能用于图像生成。** 2026-03-26 测试结果：Images API 和 Responses API 都会拒绝 `~/.codex/auth.json` 的 `access_token`，报错为 `Missing scopes: api.model.images.request`。Codex CLI 也没有原生 `imagegen` 能力。

**鉴权解析顺序：**
1. 读取 `~/.gstack/openai.json` → `{ "api_key": "sk-..." }`（文件权限 `0600`）
2. 回退到 `OPENAI_API_KEY` 环境变量
3. 如果两者都不存在，进入引导式 setup：
   - 告诉用户：`Design mockups need an OpenAI API key with image generation permissions. Get one at platform.openai.com/api-keys`
   - 提示用户粘贴 key
   - 写入 `~/.gstack/openai.json`，权限设为 `0600`
   - 运行 smoke test（生成一张 `1024x1024` 测试图）验证 key 是否可用
   - 若 smoke test 成功，继续；若失败，展示错误并回退到 `DESIGN_SKETCH`
4. 如果 auth 存在但 API 调用失败，则回退到 `DESIGN_SKETCH`（现有 HTML wireframe 路径）。Design mockup 只是渐进增强，绝不做硬依赖。

**新增命令：** `$D setup`，引导式 API key 配置 + smoke test，可随时运行用于更新 key。

## 原型阶段需要验证的假设

1. **图像质量：** “像素级 UI mockup” 只是目标，不是既成事实。GPT Image 生成可能无法稳定产出真正达到 UI fidelity 的文字、对齐和间距。vision 质量门能兜底一部分，但“生成结果是否足够让开发直接实现”必须在原型阶段先验证。
2. **多轮迭代：** `previous_response_id` 是否真的保留视觉上下文尚未证实（见 API Details）。
3. **成本模型：** `$0.10-$0.40 / session` 只是预估，需要真实运行校验。

**原型验证计划：** 先做 Commit 1（核心 generate + check），然后跑 10 组不同 screen type 的 design brief，先评估输出质量，再决定是否继续技能层集成。

## CEO 扩展范围（通过 `/plan-ceo-review` 接受的 SCOPE EXPANSION）

### 1. 设计 Memory + Exploration Width Control
- 从已批准 mockup 中自动提取视觉语言，写回 `DESIGN.md`
- 如果已有 `DESIGN.md`，后续 mockup 自动约束到既有设计语言
- 如果没有 `DESIGN.md`（bootstrap 阶段），就做宽探索
- 约束强度渐进增强：设计体系越成型，探索带宽越窄
- 对比看板增加 REGENERATE 区域，支持探索控制：
  - `Something totally different`（宽探索）
  - `More like option ___`（围绕 favorite 做窄探索）
  - `Match my existing design`（约束到 `DESIGN.md`）
  - 自由文本输入，表达具体方向变化
  - Regenerate 后页面刷新，agent 轮询新的提交结果

### 2. Mockup Diffing
- `$D diff --before old.png --after new.png` 生成视觉 diff
- 左右并排，并高亮变化区域
- 使用 GPT-4o vision 识别差异
- 用于：`/design-review`、迭代反馈、PR review

### 3. Screenshot-to-Mockup Evolution
- `$D evolve --screenshot current.png --brief "make it calmer"`
- 输入线上页面截图，输出“它本来应该长什么样”的 mockup
- 直接从现实界面出发，不从空白画布开始
- 连接 `/design-review` 的批评与“如何修”视觉提案之间的缺口

### 4. 设计 Intent Verification
- 在 `/design-review` 中，把已批准 mockup（`docs/designs/`）叠加到线上截图上
- 高亮偏差：`你设计的是 X，你实现的是 Y，这里是差距`
- 把全链路补齐：design → implement → visual verify
- 组合 `$B` 截图、`$D diff` 和 vision 分析

### 5. Responsive Variants
- `$D variants --brief "..." --viewports desktop,tablet,mobile`
- 自动生成多个视口尺寸下的 mockup
- 对比看板展示响应式网格，支持同时审批
- 让 responsive design 从 mockup 阶段就成为一等公民

### 6. 设计-to-Code Prompt
- 对比看板批准后，自动生成结构化实现 prompt
- 通过 vision 分析，从已批准 PNG 中提取颜色、字体、布局
- 再结合 `DESIGN.md` 和 HTML wireframe，组成结构化 spec
- 把“设计已批准”到“agent 开始编码”之间的解释损耗降到零

### 未来引擎（**不在本方案范围内**）
- Magic Patterns 集成（从现有设计中提取 pattern）
- Variant API（等他们发布后，支持多变体 React 代码 + 预览）
- Figma MCP（双向设计文件访问）
- Google Stitch SDK（免费的 TypeScript 替代方案）

## 未决问题

1. Variant 未来如果发布 API，集成路径是什么？（作为 design binary 的另一个 engine，还是单独的 Variant binary？）
2. Magic Patterns 应该怎么接？（作为 `$D` 的另一种 engine，还是独立工具？）
3. 什么时候 design binary 需要引入 plugin / engine 架构，以支持多个生成后端？

## 成功标准

- 跑 `/office-hours` 时，针对一个 UI 点子能产出真实 PNG mockup，而不是只有 design doc
- 跑 `/plan-design-review` 时，能展示“更好的样子是什么”，且形式是 mockup，不是 prose
- mockup 质量足够高，开发者可以据此实现
- 质量门能抓住明显损坏的 mockup，并自动重试
- 每次设计会话成本控制在 `$0.50` 以内

## 分发计划

design binary 和 browse binary 一起构建与分发：
- `bun build --compile design/src/cli.ts --outfile design/dist/design`
- 在 `./setup` 和 `bun run build` 中构建
- 通过现有 `~/.claude/skills/gstack/` 安装路径做符号链接

## 下一步（实现顺序）

### Commit 0：原型验证（**必须先过，再建基础设施**）
- 写一个单文件原型脚本（约 50 行），把 3 个不同设计 brief 发给 GPT Image API
- 验证：文字渲染质量、布局准确度、视觉连贯性
- 如果结果还是“尴尬的 AI UI 图”，立刻停，重评方案
- 这是验证核心假设最便宜的方式，避免先搭 8 个文件的基础设施再发现方向错了

### Commit 1：设计 binary 核心（generate + check + compare）
- `design/src/` 下实现 `cli.ts`、`commands.ts`、`generate.ts`、`check.ts`、`brief.ts`、`session.ts`、`compare.ts`
- Auth 模块（读 `~/.gstack/openai.json`，回退 env var，引导式 setup）
- `compare` 命令生成带每个 variant 独立反馈 textarea 的 HTML 对比看板
- `package.json` 构建命令（单独的 `bun build --compile`，不和 browse 混在一起）
- `setup` 脚本集成（包括 Codex + Kiro 资产链接）
- 用 mock OpenAI API server 写单元测试

### Commit 2：Variants + Iterate
- `design/src/variants.ts`、`design/src/iterate.ts`
- 带间隔的并发生成（每次启动相差 1 秒，429 时指数退避）
- 多轮 session 状态管理
- 迭代流程和 rate limit 处理测试

### Commit 3：模板集成
- 在现有 `scripts/resolvers/design.ts` 中新增 `generateDesignSetup()` + `generateDesignMockup()`
- 在 `scripts/resolvers/types.ts` 的 `HostPaths` 中增加 `designDir`
- 在 `scripts/resolvers/index.ts` 注册 `DESIGN_SETUP` + `DESIGN_MOCKUP`
- 在 `scripts/resolvers/preamble.ts` 中为 Codex host 导出 `GSTACK_DESIGN`
- 更新 `test/gen-skill-docs.test.ts`（`DESIGN_SKETCH` 相关测试）
- 重新生成所有 `SKILL.md`

### Commit 4：接入 `/office-hours`
- 用 `{{DESIGN_MOCKUP}}` 替换 Visual Sketch 段落
- 流程：生成变体 → `$D compare` → 用户反馈 → `DESIGN_SKETCH` HTML wireframe
- 只把用户确认稿保存到 `docs/designs/`，探索稿不保存

### Commit 5：接入 `/plan-design-review`
- 增加 `{{DESIGN_SETUP}}`
- 对低分维度生成“10/10 应该长什么样”的 mockup

### Commit 6：设计 Memory + Exploration Width Control（CEO 扩展）
- mockup 确认后，用 GPT-4o vision 提取视觉语言
- 写入 / 更新 `DESIGN.md`，包括颜色、字体、间距、布局 pattern
- 若已存在 `DESIGN.md`，把它作为后续 mockup prompt 的约束上下文
- 对比看板 HTML 增加 REGENERATE 区域（快捷按钮 + 自由文本 + 刷新循环）
- 在构造 brief 时加入渐进约束逻辑

### Commit 7：Mockup Diffing + 设计 Intent Verification（CEO 扩展）
- `$D diff`：对比两张 PNG，用 GPT-4o vision 识别差异，生成 overlay
- `$D verify`：通过 `$B` 截线上页面，和 `docs/designs/` 中已批准 mockup 做对比
- 接入 `/design-review` 模板：当存在确认稿时自动做 verify

### Commit 8：Screenshot-to-Mockup Evolution（CEO 扩展）
- `$D evolve`：输入截图 + brief，生成“它本来应该是什么样”的 mockup
- 把截图作为参考图发给 GPT Image API
- 接入 `/design-review`，作为“应该怎么改”的视觉提案

### Commit 9：Responsive Variants + 设计-to-Code Prompt（CEO 扩展）
- 给 `$D variants` 增加 `--viewports` 标志，用于多尺寸生成
- 对比看板支持响应式网格布局
- 在批准后自动生成结构化实现 prompt
- 通过 vision 分析确认稿 PNG，提取颜色、字体、布局信息写入 prompt

## 任务

告诉 Variant 去做 API。作为他们的投资人，可以直接说：

“我正在构建一个 workflow，让 AI agents 以编程方式生成视觉设计。GPT Image API 今天已经能跑起来，但我更愿意用 Variant，因为多变体方式更适合做设计探索。请做一个 API endpoint：输入 prompt，输出 React 代码 + preview image。我愿意做你们的第一个集成合作伙伴。”

## 验证

1. `bun run build` 能编译出 `design/dist/design` binary
2. `$D generate --brief "Landing page for a developer tool" --output /tmp/test.png` 能输出真实 PNG
3. `$D check --image /tmp/test.png --brief "Landing page"` 返回 `PASS/FAIL`
4. `$D variants --brief "..." --count 3 --output-dir /tmp/variants/` 能生成 3 张 PNG
5. 对一个 UI 想法运行 `/office-hours` 时，mockup 能在会话中内联显示
6. `bun test` 通过（skill 校验、gen-skill-docs）
7. `bun run test:evals` 通过（E2E tests）

## 我观察到你的思考方式

- 你说“那不叫设计”，指的是文本描述和 ASCII art。这是设计师直觉。你清楚“描述一件东西”和“把它展示出来”之间的差别。很多做 AI 工具的人没意识到这一层，因为他们本来就不是设计师。
- 你优先做 `/office-hours`，这是上游杠杆点。如果 brainstorm 阶段就能产出真实 mockup，下游 skill（`/plan-design-review`、`/design-review`）就有可视化对象可以直接引用，不用重新解读 prose。
- 你投了 Variant，然后第一反应是“他们应该有 API”。这是投资人兼用户的思路。你不是在评价公司，而是在设计他们的产品如何嵌进你的 workflow。
- 当 Codex 质疑 opt-in 前提时，你立刻接受了，没有防御 ego。这是最快到达正确答案的方式。

## Spec 审查 结果

文档经历了 1 轮对抗式 review，活下来了。抓到并修复了 11 个问题。  
质量评分：`7/10` → 修复后预计 `8.5/10`

已修复问题：
1. 声明了 OpenAI SDK 依赖
2. 明确了图像数据提取路径（`response.output` item 形态）
3. 正式把 `--check` 和 `--retry` 注册进命令注册表
4. 明确了 brief 输入模式（plain text vs JSON file）
5. 修正了 resolver 文件冲突（改为加到现有 `design.ts`）
6. 记录了 HostPaths 的 Codex env var 配置
7. 把“镜像 browse”改写成“复用其编译/分发模式”
8. 明确了 session 状态（ID 生成、发现方式、清理）
9. 把“pixel-perfect”标记为需要原型验证的假设
10. 把多轮迭代标记为未证实，并给出 fallback
11. 完整定义了 `$D` 发现用的 bash 片段，并说明可回退到 `DESIGN_SKETCH`

## Eng 审查 完成摘要

- Step 0：Scope Challenge，范围按原样接受（用户覆盖了缩减建议）
- Architecture Review：发现 5 个问题（openai 依赖隔离、graceful degrade、输出目录配置、auth 模型、trust boundary）
- Code Quality Review：发现 1 个问题（8 个文件 vs 5 个文件，最终保留 8 个）
- Test Review：产出图，识别出 42 个缺口，并写出测试计划
- Performance Review：发现 1 个问题（variant 需要错峰启动的并发）
- 不在范围内：Google Stitch SDK、Figma MCP、Variant API（延期）
- 已有可复用内容：browse CLI 模式、`DESIGN_SKETCH` resolver、HostPaths 系统、gen-skill-docs pipeline
- 外部声音：4 轮（Claude structured 12 个问题，Codex structured 8 个问题，Claude adversarial 1 个 fatal flaw，Codex adversarial 1 个 fatal flaw）。关键洞见：串行 `PNG → HTML` 工作流解决了“raster 不可检查”的 fatal flaw。
- Failure modes：0 个关键缺口（所有已识别 failure mode 都有错误处理和测试计划）
- Lake Score：`7/7`，所有建议都选择了完整方案

## GSTACK 审查 报告

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Office Hours | `/office-hours` | 设计 brainstorm | 1 | DONE | 4 个前提，其中 1 个被修正（Codex：opt-in→default-on） |
| CEO Review | `/plan-ceo-review` | 范围与策略 | 1 | CLEAR | EXPANSION：提了 6 个，接受 6 个，延期 0 个 |
| Eng Review | `/plan-eng-review` | 架构与测试（必需） | 1 | CLEAR | 7 个问题，0 个关键缺口，4 个 outside voices |
| Design Review | `/plan-design-review` | UI/UX 缺口 | 1 | CLEAR | 评分：`2/10 → 8/10`，做了 5 个关键决策 |
| Outside Voice | structured + adversarial | 独立挑战 | 4 | DONE | 串行 `PNG→HTML` 工作流，trust boundary 已记录 |

**CEO EXPANSIONS：** Design Memory + Exploration Width、Mockup Diffing、Screenshot Evolution、Design Intent Verification、Responsive Variants、Design-to-Code Prompt。  
**DESIGN DECISIONS：** 单列全宽布局、每卡片 `More like this`、显式 radio Pick、平滑淡入淡出再生成、skeleton loading 状态。  
**UNRESOLVED：** 0  
**VERDICT：** CEO + ENG + DESIGN 全部通过，可以开始实现。先从 Commit 0（原型验证）开始。
