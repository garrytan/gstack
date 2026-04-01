# Greptile 评论分诊

这是一份共享参考文档，用于在 GitHub PR 中抓取、过滤和分类 Greptile 的 review 评论。`/review`（Step 2.5）和 `/ship`（Step 3.75）都会引用本文件。

---

## 抓取

运行下面的命令来识别 PR 并抓取评论。两个 API 调用并行执行。

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)
PR_NUMBER=$(gh pr view --json number --jq '.number' 2>/dev/null)
```

**如果任一命令失败或结果为空：** 静默跳过 Greptile 分诊。这个集成只是增强项，没有它流程也能正常工作。

```bash
# 并行抓取行级 审查 评论和 PR 顶层评论
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  --jq '.[] | select(.user.login == "greptile-apps[bot]") | select(.position != null) | {id: .id, path: .path, line: .line, body: .body, html_url: .html_url, source: "line-level"}' > /tmp/greptile_line.json &
gh api repos/$REPO/issues/$PR_NUMBER/comments \
  --jq '.[] | select(.user.login == "greptile-apps[bot]") | {id: .id, body: .body, html_url: .html_url, source: "top-level"}' > /tmp/greptile_top.json &
wait
```

**如果 API 出错，或者两个端点都没有 Greptile 评论：** 静默跳过。

行级评论上的 `position != null` 过滤会自动忽略因为 force-push 而失效的旧评论。

---

## 抑制规则检查

先推导项目专属的历史文件路径：

```bash
REMOTE_SLUG=$(browse/bin/remote-slug 2>/dev/null || ~/.claude/skills/gstack/browse/bin/remote-slug 2>/dev/null || basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
PROJECT_HISTORY="$HOME/.gstack/projects/$REMOTE_SLUG/greptile-history.md"
```

如果 `$PROJECT_HISTORY` 存在，则读取它（按项目级别的 suppressions）。每一行都记录一次历史分诊结果：

```
<date> | <repo> | <type:fp|fix|already-fixed> | <file-pattern> | <category>
```

**类别**（固定集合）：`race-condition`、`null-check`、`error-handling`、`style`、`type-safety`、`security`、`performance`、`correctness`、`other`

对每一条抓取到的评论，匹配满足以下条件的历史项：

- `type == fp`（只抑制已知误报，不抑制曾经修复过的真实问题）
- `repo` 与当前仓库一致
- `file-pattern` 能匹配评论对应的文件路径
- `category` 与评论中的问题类型一致

命中的评论标记为 **SUPPRESSED** 并跳过。

如果历史文件不存在，或某些行无法解析，就跳过这些行继续处理。绝不要因为历史文件格式坏了而让流程失败。

---

## 分类

对每一条未被抑制的评论：

1. **行级评论：** 读取指向的 `path:line` 以及上下文（±10 行）
2. **顶层评论：** 读取完整评论正文
3. 将评论与完整 diff（`git diff origin/main`）和 review checklist 交叉比对
4. 分类为：
   - **VALID & ACTIONABLE**：当前代码里确实存在的真实 bug、竞态条件、安全问题或正确性问题
   - **VALID BUT ALREADY FIXED**：是真问题，但已在该分支后续某次提交中修复。需要指出修复提交 SHA。
   - **FALSE POSITIVE**：评论误解了代码，指出的是其他地方已处理的情况，或只是风格噪声
   - **SUPPRESSED**：在前面的 suppressions 检查中已被过滤

---

## 回复 API

给 Greptile 评论回复时，要根据评论来源使用正确的端点：

**行级评论**（来自 `pulls/$PR/comments`）：

```bash
gh api repos/$REPO/pulls/$PR_NUMBER/comments/$COMMENT_ID/replies \
  -f body="<reply text>"
```

**顶层评论**（来自 `issues/$PR/comments`）：

```bash
gh api repos/$REPO/issues/$PR_NUMBER/comments \
  -f body="<reply text>"
```

**如果回复 POST 失败**（例如 PR 已关闭、没有写权限）：给出 warning 并继续。不要因为回复失败而中断整个流程。

---

## 回复模板

每次回复 Greptile 评论都使用这些模板。必须包含具体证据，不要发模糊回复。

### Tier 1（首次回应）——友好、带证据

**用于 FIXES（用户选择修复该问题）：**

```
**Fixed** in `<commit-sha>`.

\`\`\`diff
- <old problematic line(s)>
+ <new fixed line(s)>
\`\`\`

**Why:** <1-sentence explanation of what was wrong and how the fix addresses it>
```

**用于 ALREADY FIXED（问题已在本分支先前提交中解决）：**

```
**Already fixed** in `<commit-sha>`.

**What was done:** <1-2 sentences describing how the existing commit addresses this issue>
```

**用于 FALSE POSITIVES（评论本身不成立）：**

```
**Not a bug.** <1 sentence directly stating why this is incorrect>

**Evidence:**
- <specific code reference showing the pattern is safe/correct>
- <e.g., "The nil check is handled by `ActiveRecord::FinderMethods#find` which raises RecordNotFound, not nil">

**Suggested re-rank:** This appears to be a `<style|noise|misread>` issue, not a `<what Greptile called it>`. Consider lowering severity.
```

### Tier 2（Greptile 在已有回复后再次标记）——坚定、证据压实

当下面的升级检测判断同一线程里已经有过 GStack 回复时，使用 Tier 2。要尽可能给出完整证据，目的就是结束争论。

```
**This has been reviewed and confirmed as [intentional/already-fixed/not-a-bug].**

\`\`\`diff
<full relevant diff showing the change or safe pattern>
\`\`\`

**Evidence chain:**
1. <file:line permalink showing the safe pattern or fix>
2. <commit SHA where it was addressed, if applicable>
3. <architecture rationale or design decision, if applicable>

**Suggested re-rank:** Please recalibrate — this is a `<actual category>` issue, not `<claimed category>`. [Link to specific file change permalink if helpful]
```

---

## 升级检测

在生成回复前，先检查这个评论线程里是否已经有过 GStack 的回复：

1. **对于行级评论：** 通过 `gh api repos/$REPO/pulls/$PR_NUMBER/comments/$COMMENT_ID/replies` 抓取回复。检查是否有回复正文包含 GStack 标记：`**Fixed**`、`**Not a bug.**`、`**Already fixed**`。

2. **对于顶层评论：** 在抓取到的 issue comments 中，寻找发布时间晚于该 Greptile 评论、且正文中包含 GStack 标记的回复。

3. **如果已存在 GStack 回复，并且 Greptile 又在相同 file+category 上再次发评论：** 使用 Tier 2（坚定型）模板。

4. **如果不存在 GStack 回复：** 使用 Tier 1（友好型）模板。

如果升级检测失败（API 出错、线程归属不明确），默认退回 Tier 1。只要存在歧义，就不要升级。

---

## 严重度评估与重分级

在分类评论时，也要评估 Greptile 隐含的严重度是否符合事实：

- 如果 Greptile 把某事标成 **security / correctness / race-condition**，但实际只是 **style / performance** 层面的提示，就在回复里加入 `**Suggested re-rank:**`，要求修正类别。
- 如果 Greptile 把一个低严重度的样式问题描述得像关键问题一样，也要在回复中明确反驳。
- 说明为什么要重分级时必须具体，要引用代码与行号，而不是意见表达。

---

## 历史文件写入

写入前，先确保目录存在：

```bash
REMOTE_SLUG=$(browse/bin/remote-slug 2>/dev/null || ~/.claude/skills/gstack/browse/bin/remote-slug 2>/dev/null || basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
mkdir -p "$HOME/.gstack/projects/$REMOTE_SLUG"
mkdir -p ~/.gstack
```

对每一条分诊结果，同时向下面两个文件各追加一行（项目级用于 suppressions，全局级用于 retro）：

- `~/.gstack/projects/$REMOTE_SLUG/greptile-history.md`（项目级）
- `~/.gstack/greptile-history.md`（全局聚合）

格式：

```
<YYYY-MM-DD> | <owner/repo> | <type> | <file-pattern> | <category>
```

示例：

```
2026-03-13 | garrytan/myapp | fp | app/services/auth_service.rb | race-condition
2026-03-13 | garrytan/myapp | fix | app/models/user.rb | null-check
2026-03-13 | garrytan/myapp | already-fixed | lib/payments.rb | error-handling
```

---

## 输出格式

在输出头部加入 Greptile 汇总：

```
+ N Greptile comments (X valid, Y fixed, Z FP)
```

对每条分类后的评论，展示：

- 分类标签：`[VALID]`、`[FIXED]`、`[FALSE POSITIVE]`、`[SUPPRESSED]`
- `file:line` 引用（行级评论）或 `[top-level]`（顶层评论）
- 一行正文摘要
- 永久链接 URL（`html_url` 字段）
