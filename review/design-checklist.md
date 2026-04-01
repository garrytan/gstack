# 设计审查清单（Lite）

> **DESIGN_METHODOLOGY 的子集**。如果要在这里新增条目，也必须同步更新 `scripts/gen-skill-docs.ts` 里的 `generateDesignMethodology()`，反之亦然。

## 使用说明

这份清单针对的是 **diff 中涉及的源代码**，不是渲染后的页面结果。请读取每一个变更过的前端文件（完整文件，而不只是 diff hunk），并标记反模式。

**触发条件：** 只有当 diff 触及前端文件时才运行此清单。使用 `gstack-diff-scope` 判断：

```bash
source <(~/.claude/skills/gstack/bin/gstack-diff-scope <base> 2>/dev/null)
```

如果 `SCOPE_FRONTEND=false`，则静默跳过整个设计审查。

**DESIGN.md 校准：** 如果仓库根目录存在 `DESIGN.md` 或 `design-system.md`，请先读取它。所有发现都要以项目声明的设计系统为准。凡是 DESIGN.md 明确认可的模式，**不要**报为问题。如果没有 DESIGN.md，则使用通用设计原则。

---

## 置信度分层

每个条目都带有一个检测置信度等级：

- **[HIGH]**：可以通过 grep / 模式匹配稳定检测到。属于确定性发现。
- **[MEDIUM]**：可以通过模式聚合或启发式方法检测。可以报为发现，但要预期有一定噪声。
- **[LOW]**：需要理解视觉意图。输出时应写成：“可能存在问题，建议目视验证或运行 `/design-review`。”

---

## 分类

**AUTO-FIX**（仅限机械性的 CSS 修复，高置信度，不需要设计判断）：

- `outline: none` 且没有替代方案 → 补上 `outline: revert`，或添加 `&:focus-visible { outline: 2px solid currentColor; }`
- 新增 CSS 中出现 `!important` → 删除并正确调整 specificity
- 正文文本 `font-size` < 16px → 提升到 16px

**ASK**（其余全部情况，需要设计判断）：

- 所有 AI slop 类发现、排版结构、间距选择、交互状态缺失、违反 DESIGN.md 的情况

**LOW 置信度条目** → 统一输出为：“Possible: [描述]。请目视验证或运行 `/design-review`。”绝不能自动修复。

---

## 输出格式

```
Design Review: N issues (X auto-fixable, Y need input, Z possible)

**AUTO-FIXED:**
- [file:line] 问题 → 已应用修复

**NEEDS INPUT:**
- [file:line] 问题描述
  Recommended fix: 建议修复方式

**POSSIBLE (verify visually):**
- [file:line] 可能存在问题 — 请用 /design-review 验证
```

如果没有发现问题：`Design Review: No issues found.`

如果没有改动前端文件：静默跳过，不输出任何内容。

---

## 分类项

### 1. AI Slop 检测（6 项）——最高优先级

这些是 AI 生成界面的典型信号，任何一家像样工作室的设计师都不会直接交付这种东西。

- **[MEDIUM]** 紫色 / 紫罗兰 / 靛蓝渐变背景，或者蓝到紫的配色。查找 `linear-gradient` 中是否出现 `#6366f1`–`#8b5cf6` 范围的值，或者 CSS 自定义属性最终解析为紫 / 紫罗兰色。

- **[LOW]** 三栏功能网格：彩色圆圈里的图标 + 粗体标题 + 两行描述，三列完全对称重复。查找只有 3 个子元素的 grid / flex 容器，并且每个子元素都包含圆形元素 + heading + paragraph。

- **[LOW]** 用彩色圆圈包裹图标，作为分区装饰。查找同时包含 `border-radius: 50%` 和背景色、且用于装图标的元素。

- **[HIGH]** 万物居中：所有标题、描述、卡片都用 `text-align: center`。统计 `text-align: center` 的密度，如果超过 60% 的文本容器都居中，则报出。

- **[MEDIUM]** 所有元素都套同一套圆润大圆角：卡片、按钮、输入框、容器等统一使用同一个较大的圆角值（16px+）。聚合 `border-radius` 的取值；如果超过 80% 的元素都使用相同且 ≥16px 的值，则报出。

- **[MEDIUM]** 通用型 hero 文案，例如 "Welcome to [X]"、"Unlock the power of..."、"Your all-in-one solution for..."、"Revolutionize your..."、"Streamline your workflow"。对 HTML / JSX 内容做模式匹配。

### 2. 排版（4 项）

- **[HIGH]** 正文文字 `font-size` < 16px。检查 `body`、`p`、`.text` 或基础文本样式上的 `font-size` 声明。小于 16px 的值（或在 16px 基准下小于 `1rem`）都应标记。

- **[HIGH]** diff 中引入超过 3 个字体族。统计不同的 `font-family` 声明，超过 3 个就报出。

- **[HIGH]** 标题层级跳跃：同一文件 / 组件里，`h1` 后面直接跟 `h3`，中间没有 `h2`。检查 HTML / JSX 的 heading 标签。

- **[HIGH]** 黑名单字体：Papyrus、Comic Sans、Lobster、Impact、Jokerman。grep `font-family` 中是否出现这些名字。

### 3. 间距与布局（4 项）

- **[MEDIUM]** 当 DESIGN.md 明确规定间距刻度时，使用了不在 4px 或 8px 刻度上的任意值。检查 `margin`、`padding`、`gap` 是否符合声明的 scale。只有 DESIGN.md 定义了 spacing scale 时才报出。

- **[MEDIUM]** 使用固定宽度但没有响应式处理：容器写了 `width: NNNpx`，却没有 `max-width` 或 `@media` 断点。存在移动端横向滚动风险。

- **[MEDIUM]** 文本容器没有 `max-width`：正文或段落容器没有最大宽度约束，导致单行长度超过 75 个字符。检查文本包裹容器是否设置了 `max-width`。

- **[HIGH]** 新增 CSS 规则里出现 `!important`。检查新增行中的 `!important`。这几乎总是错误 specificity 的逃生口。

### 4. 交互状态（3 项）

- **[MEDIUM]** 可交互元素（按钮、链接、输入框）缺少 hover / focus 状态。检查新的交互样式是否定义了 `:hover` 与 `:focus` 或 `:focus-visible`。

- **[HIGH]** `outline: none` 或 `outline: 0`，但没有替代性的 focus 指示。grep `outline:\s*none` 或 `outline:\s*0`。这会直接破坏键盘可访问性。

- **[LOW]** 可交互元素点击区域小于 44px。检查按钮、链接上的 `min-height` / `min-width` / `padding`。由于需要综合多个属性计算实际尺寸，因此仅属低置信度。

### 5. 设计.md 违规项（3 项，条件启用）

只有在存在 `DESIGN.md` 或 `design-system.md` 时才启用：

- **[MEDIUM]** 使用了不在设计调色板中的颜色。将变更过的 CSS 颜色与 DESIGN.md 中定义的 palette 对比。

- **[MEDIUM]** 使用了不在设计排版章节中的字体。将 `font-family` 与 DESIGN.md 中列出的字体清单对比。

- **[MEDIUM]** 使用了不在设计间距刻度中的 spacing 值。将 `margin`、`padding`、`gap` 与 DESIGN.md 的 spacing scale 对比。

---

## 抑制规则

不要对以下内容报问题：

- DESIGN.md 中明确说明为有意设计的模式
- 第三方 / vendor CSS 文件（`node_modules`、vendor 目录）
- CSS reset 或 normalize 样式表
- 测试夹具文件
- 生成的 / 压缩后的 CSS
