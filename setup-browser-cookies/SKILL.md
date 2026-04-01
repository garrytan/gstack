---
name: setup-browser-cookies
preamble-tier: 1
version: 1.0.0
description: |
  将真实 Chromium 浏览器中的 cookies 导入到 headless browse 会话中。
  会打开一个交互式选择器 UI，让你挑选要导入哪些域名的 cookies。
  适用于在 QA 测试需要登录态的页面之前使用。也适用于用户要求“导入 cookies”、
  “登录站点”或“让浏览器完成认证”时。（gstack）
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble（先运行）

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -exec rm {} + 2>/dev/null || true
_CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_PROACTIVE_PROMPTED=$([ -f ~/.gstack/.proactive-prompted ] && echo "yes" || echo "no")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
_SKILL_PREFIX=$(~/.claude/skills/gstack/bin/gstack-config get skill_prefix 2>/dev/null || echo "false")
echo "PROACTIVE: $_PROACTIVE"
echo "PROACTIVE_PROMPTED: $_PROACTIVE_PROMPTED"
echo "SKILL_PREFIX: $_SKILL_PREFIX"
source <(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null) || true
REPO_MODE=${REPO_MODE:-unknown}
echo "REPO_MODE: $REPO_MODE"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
_TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: ${_TEL:-off}"
echo "TEL_PROMPTED: $_TEL_PROMPTED"
mkdir -p ~/.gstack/analytics
if [ "${_TEL:-off}" != "off" ]; then
  echo '{"skill":"setup-browser-cookies","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
fi
# zsh-compatible: use find instead of glob to avoid NOMATCH error
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do
  if [ -f "$_PF" ]; then
    if [ "$_TEL" != "off" ] && [ -x "~/.claude/skills/gstack/bin/gstack-telemetry-log" ]; then
      ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true
    fi
    rm -f "$_PF" 2>/dev/null || true
  fi
  break
done
# Learnings count
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" 2>/dev/null || true
_LEARN_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG:-unknown}/learnings.jsonl"
if [ -f "$_LEARN_FILE" ]; then
  _LEARN_COUNT=$(wc -l < "$_LEARN_FILE" 2>/dev/null | tr -d ' ')
  echo "LEARNINGS: $_LEARN_COUNT entries loaded"
else
  echo "LEARNINGS: 0"
fi
# Check if CLAUDE.md has routing rules
_HAS_ROUTING="no"
if [ -f CLAUDE.md ] && grep -q "## Skill routing" CLAUDE.md 2>/dev/null; then
  _HAS_ROUTING="yes"
fi
_ROUTING_DECLINED=$(~/.claude/skills/gstack/bin/gstack-config get routing_declined 2>/dev/null || echo "false")
echo "HAS_ROUTING: $_HAS_ROUTING"
echo "ROUTING_DECLINED: $_ROUTING_DECLINED"
```

如果 `PROACTIVE` 是 `"false"`，就不要主动推荐 gstack skills，也不要根据对话上下文自动调用 skill。只在用户显式输入 skill 时才运行（例如 `/qa`、`/ship`）。如果本来会自动调用某个 skill，就改成简短提示：

“我觉得 /skillname 可能适合这里，要我运行吗？”

然后等待确认。说明用户已经选择退出主动模式。

如果 `SKILL_PREFIX` 是 `"true"`，说明用户启用了带命名空间前缀的 skill 名称。此时在建议或调用其他 gstack skill 时，要使用 `/gstack-` 前缀（例如 `/gstack-qa`，而不是 `/qa`；`/gstack-ship`，而不是 `/ship`）。磁盘路径不受影响，读取 skill 文件时仍然一律使用 `~/.claude/skills/gstack/[skill-name]/SKILL.md`。

如果输出包含 `UPGRADE_AVAILABLE <old> <new>`：读取 `~/.claude/skills/gstack/gstack-upgrade/SKILL.md`，并按其中的 “Inline upgrade flow” 执行（若已配置自动升级则直接升级，否则通过 AskUserQuestion 给出 4 个选项；如果用户拒绝，则写入 snooze 状态）。如果输出包含 `JUST_UPGRADED <from> <to>`：告诉用户 “Running gstack v{to}（刚刚已更新）”，然后继续。

如果 `LAKE_INTRO` 为 `no`：继续前先介绍 Completeness Principle。告诉用户：

“gstack 遵循 **Boil the Lake** 原则，也就是当 AI 让边际成本接近于零时，就应该优先做完整方案。更多背景见：https://garryslist.org/posts/boil-the-ocean”

然后询问是否要在默认浏览器里打开这篇文章：

```bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
```

只有在用户同意时才运行 `open`。但无论如何都要运行 `touch`，把它标记成已介绍。这个流程只发生一次。

如果 `TEL_PROMPTED` 为 `no` 且 `LAKE_INTRO` 为 `yes`：在处理完 lake intro 之后，询问用户是否启用 telemetry。使用 AskUserQuestion：

> Help gstack get better! Community mode shares usage data (which skills you use, how long they take, crash info) with a stable device ID so we can track trends and fix bugs faster. No code, file paths, or repo names are ever sent. Change anytime with `gstack-config set telemetry off`.

选项：
- A) Help gstack get better!（推荐）
- B) No thanks

如果选 A：运行 `~/.claude/skills/gstack/bin/gstack-config set telemetry community`

如果选 B：继续追问一次 AskUserQuestion：

> How about anonymous mode? We just learn that *someone* used gstack — no unique ID, no way to connect sessions. Just a counter that helps us know if anyone's out there.

选项：
- A) Sure, anonymous is fine
- B) No thanks, fully off

如果是 B→A：运行 `~/.claude/skills/gstack/bin/gstack-config set telemetry anonymous`  
如果是 B→B：运行 `~/.claude/skills/gstack/bin/gstack-config set telemetry off`

始终运行：

```bash
touch ~/.gstack/.telemetry-prompted
```

这个流程只发生一次。如果 `TEL_PROMPTED` 是 `yes`，就完全跳过。

如果 `PROACTIVE_PROMPTED` 为 `no` 且 `TEL_PROMPTED` 为 `yes`：在处理完 telemetry 后，询问用户是否启用 proactive 行为。使用 AskUserQuestion：

> gstack can proactively figure out when you might need a skill while you work — like suggesting /qa when you say "does this work?" or /investigate when you hit a bug. We recommend keeping this on — it speeds up every part of your workflow.

选项：
- A) Keep it on（推荐）
- B) Turn it off — I'll type /commands myself

如果选 A：运行 `~/.claude/skills/gstack/bin/gstack-config set proactive true`  
如果选 B：运行 `~/.claude/skills/gstack/bin/gstack-config set proactive false`

始终运行：

```bash
touch ~/.gstack/.proactive-prompted
```

这个流程只发生一次。如果 `PROACTIVE_PROMPTED` 是 `yes`，就完全跳过。

如果 `HAS_ROUTING` 为 `no`、`ROUTING_DECLINED` 为 `false`，且 `PROACTIVE_PROMPTED` 为 `yes`：
检查项目根目录是否存在 `CLAUDE.md`。如果不存在，则创建一个。

使用 AskUserQuestion：

> gstack works best when your project's CLAUDE.md includes skill routing rules. This tells Claude to use specialized workflows (like /ship, /investigate, /qa) instead of answering directly. It's a one-time addition, about 15 lines.

选项：
- A) Add routing rules to CLAUDE.md（推荐）
- B) No thanks, I'll invoke skills manually

如果选 A：将下面这段追加到 `CLAUDE.md` 末尾：

```markdown

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
```

然后提交这个改动：`git add CLAUDE.md && git commit -m "chore: add gstack skill routing rules to CLAUDE.md"`

如果选 B：运行 `~/.claude/skills/gstack/bin/gstack-config set routing_declined true`
然后告诉用户：

“没问题。以后如果想加 routing 规则，可以运行 `gstack-config set routing_declined false`，然后重新执行任意 skill。”

这个流程每个项目只发生一次。如果 `HAS_ROUTING` 为 `yes` 或 `ROUTING_DECLINED` 为 `true`，就直接跳过。

## 语气

**语气要求：** 直接、具体、锋利，不要 corporate，也不要 academic。听起来像 builder，不像顾问。直接点文件名、函数名、命令名。不要铺垫，不要废话。

**写作规则：** 不要用 em dash（改用逗号、句号或 `...`）。不要用 AI 常见词汇（如 delve、crucial、robust、comprehensive、nuanced 等）。段落要短。结尾明确告诉用户下一步做什么。

用户永远掌握着你没有的上下文。跨模型一致意见只是建议，不是决策。最后拍板的是用户。

## Contributor Mode

如果 `_CONTRIB` 为 `true`，说明你处在 **contributor mode**。每完成一个主要工作流阶段，都要给 gstack 体验打一个 0-10 分。如果不是 10 分，并且存在一个可执行的 bug 或改进点，就提交一份 field report。

**只记录：** 输入本身合理，但 gstack 工具出了问题的情况。  
**不要记录：** 用户自己的应用 bug、网络错误、目标网站认证失败。

**写入方式：** 把文件写到 `~/.gstack/contributor-logs/{slug}.md`

```
# {Title}
**What I tried:** {action} | **What happened:** {result} | **Rating:** {0-10}
## Repro
1. {step}
## What would make this a 10
{one sentence}
**Date:** {YYYY-MM-DD} | **Version:** {version} | **Skill:** /{skill}
```

Slug 使用小写连字符，最长 60 个字符。若同名文件已存在就跳过。每个会话最多记 3 条。直接内联记录，不要中断工作流。

## 完成状态协议

当一个 skill 工作流结束时，必须用以下状态之一汇报：

- **DONE** — 所有步骤都已成功完成，并且每条结论都有证据
- **DONE_WITH_CONCERNS** — 工作已完成，但有用户应该知道的问题。要逐条列出 concern
- **BLOCKED** — 无法继续。说明阻塞点，以及你已经尝试过什么
- **NEEDS_CONTEXT** — 缺少继续所需的信息。明确指出具体缺什么

### 升级处理

你随时都可以停下来明确说：“这对我来说太难了”或“我对这个结果没有信心”。

糟糕的结果比没有结果更糟。因为选择升级处理而停下，不会受到惩罚。

- 如果你已经尝试同一任务 3 次仍然失败，立即停止并升级处理
- 如果你对一个安全敏感变更没有把握，立即停止并升级处理
- 如果工作范围超出你能验证的边界，立即停止并升级处理

升级处理格式：

```
STATUS: BLOCKED | NEEDS_CONTEXT
REASON: [1-2 sentences]
ATTEMPTED: [what you tried]
RECOMMENDATION: [what the user should do next]
```

## Telemetry（最后运行）

当 skill 工作流结束后（不管是成功、失败还是中断），都要记录 telemetry 事件。
skill 名称取自本文件 YAML frontmatter 里的 `name:` 字段。
结果状态根据工作流实际结果判断（正常完成则为 success，失败为 error，用户打断为 abort）。

**PLAN MODE 例外：必须始终运行。** 这个命令会把 telemetry 写到 `~/.gstack/analytics/`（用户配置目录，不是项目文件）。skill preamble 之前已经往同一目录写过数据，所以这是同一种模式。跳过这一步就会丢失会话耗时与结果数据。

运行下面的 bash：

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
# Local + remote telemetry (both gated by _TEL setting)
if [ "$_TEL" != "off" ]; then
  echo '{"skill":"SKILL_NAME","duration_s":"'"$_TEL_DUR"'","outcome":"OUTCOME","browse":"USED_BROWSE","session":"'"$_SESSION_ID"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
  if [ -x ~/.claude/skills/gstack/bin/gstack-telemetry-log ]; then
    ~/.claude/skills/gstack/bin/gstack-telemetry-log \
      --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \
      --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
  fi
fi
```

把 `SKILL_NAME` 替换成 frontmatter 中的实际 skill 名称，把 `OUTCOME` 替换成 `success` / `error` / `abort`，再把 `USED_BROWSE` 替换成 `$B` 是否被使用过（`true` / `false`）。如果无法判断结果，就用 `"unknown"`。本地 JSONL 和远程 telemetry 只有在 telemetry 不为 off 时才会运行；远程二进制还要求对应二进制文件实际存在。

## Plan Mode Safe Operations

在 plan mode 中，下面这些操作始终允许执行，因为它们产出的是帮助计划决策的工件，而不是代码修改：

- `$B` 命令（browse：截图、页面检查、导航、快照）
- `$D` 命令（design：生成 mockup、变体、对比板、迭代）
- `codex exec` / `codex review`（outside voice、plan review、对抗式挑战）
- 向 `~/.gstack/` 写入内容（配置、分析、review 日志、设计工件、learnings）
- 向计划文件写入内容（plan mode 本来就允许）
- 用 `open` 打开生成好的工件（对比板、HTML 预览）

这些操作在精神上都属于只读，它们只是检查线上站点、生成视觉工件，或获得独立第二意见。它们**不会**修改项目源码文件。

## Plan Status Footer

当你在 plan mode，并且准备调用 `ExitPlanMode` 时：

1. 先检查计划文件中是否已经存在 `## GSTACK REVIEW REPORT` 章节
2. 如果**已经存在**，就跳过（说明已有 review skill 写入了更丰富的报告）
3. 如果**不存在**，运行这条命令：

```bash
~/.claude/skills/gstack/bin/gstack-review-read
```

然后把一个 `## GSTACK REVIEW REPORT` 章节写到计划文件末尾：

- 如果输出中在 `---CONFIG---` 之前包含 review 记录（JSONL 行），就按 review skills 当前使用的标准格式输出报告表格，列出每个 skill 的 runs / status / findings
- 如果输出是 `NO_REVIEWS` 或为空，就写下面这张占位表：

```markdown
## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | \`/plan-ceo-review\` | Scope & strategy | 0 | — | — |
| Codex Review | \`/codex review\` | Independent 2nd opinion | 0 | — | — |
| Eng Review | \`/plan-eng-review\` | Architecture & tests (required) | 0 | — | — |
| Design Review | \`/plan-design-review\` | UI/UX gaps | 0 | — | — |

**VERDICT:** NO REVIEWS YET — run \`/autoplan\` for full review pipeline, or individual reviews above.
```

**PLAN MODE 例外：必须始终运行。** 这会写入计划文件，而计划文件正是 plan mode 里允许编辑的那一个文件。这个 review report 本身就是计划状态的一部分。

# Setup Browser Cookies

把真实 Chromium 浏览器中的登录会话导入到 headless browse 会话中。

## CDP 模式检查

先检查 browse 是否已经连接到了用户的真实浏览器：

```bash
$B status 2>/dev/null | grep -q "Mode: cdp" && echo "CDP_MODE=true" || echo "CDP_MODE=false"
```

如果 `CDP_MODE=true`：直接告诉用户：

“不需要导入，你当前已经通过 CDP 连接到了真实浏览器，cookies 和会话已经可用。”

然后停止。此时不需要任何 cookie 导入流程。

## 工作方式

1. 找到 browse 二进制
2. 运行 `cookie-import-browser`，检测已安装浏览器并打开选择器 UI
3. 用户在浏览器里选择要导入哪些域名的 cookies
4. cookies 会被解密并加载到 Playwright 会话中

## 操作步骤

### 1. 找到 browse 二进制

## SETUP（在任何 browse 命令之前先做这个检查）

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/gstack/browse/dist/browse" ] && B="$_ROOT/.claude/skills/gstack/browse/dist/browse"
[ -z "$B" ] && B=~/.claude/skills/gstack/browse/dist/browse
if [ -x "$B" ]; then
  echo "READY: $B"
else
  echo "NEEDS_SETUP"
fi
```

如果输出是 `NEEDS_SETUP`：

1. 先告诉用户：“gstack browse 需要做一次性构建（约 10 秒）。可以继续吗？” 然后停止并等待确认。
2. 运行：`cd <SKILL_DIR> && ./setup`
3. 如果没有安装 `bun`：

   ```bash
   if ! command -v bun >/dev/null 2>&1; then
     BUN_VERSION="1.3.10"
     BUN_INSTALL_SHA="bab8acfb046aac8c72407bdcce903957665d655d7acaa3e11c7c4616beae68dd"
     tmpfile=$(mktemp)
     curl -fsSL "https://bun.sh/install" -o "$tmpfile"
     actual_sha=$(shasum -a 256 "$tmpfile" | awk '{print $1}')
     if [ "$actual_sha" != "$BUN_INSTALL_SHA" ]; then
       echo "ERROR: bun install script checksum mismatch" >&2
       echo "  expected: $BUN_INSTALL_SHA" >&2
       echo "  got:      $actual_sha" >&2
       rm "$tmpfile"; exit 1
     fi
     BUN_VERSION="$BUN_VERSION" bash "$tmpfile"
     rm "$tmpfile"
   fi
   ```

### 2. 打开 cookie picker

```bash
$B cookie-import-browser
```

这个命令会自动检测已安装的 Chromium 浏览器，并在默认浏览器中打开一个交互式选择器 UI。在那里你可以：

- 在多个已安装浏览器之间切换
- 搜索域名
- 点击 “+” 导入某个域名下的 cookies
- 点击垃圾桶图标移除已导入 cookies

告诉用户：**“Cookie picker 已打开，请在浏览器里选择要导入的域名。完成后告诉我。”**

### 3. 直接导入（可选替代）

如果用户直接指定了域名（例如 `/setup-browser-cookies github.com`），就跳过 UI：

```bash
$B cookie-import-browser comet --domain github.com
```

如果用户指定了其他浏览器，把 `comet` 替换成对应浏览器即可。

### 4. 验证

在用户确认完成后，运行：

```bash
$B cookies
```

然后把导入结果汇总给用户看（按域名统计 cookie 数量）。

## 注意事项

- 在 macOS 上，每个浏览器第一次导入时可能会弹出 Keychain 对话框，需要点击 “Allow” / “Always Allow”
- 在 Linux 上，`v11` cookies 可能依赖 `secret-tool` / libsecret；`v10` cookies 则使用 Chromium 的标准回退 key
- Cookie picker 跑在 browse server 的同一端口上，不会额外拉起新进程
- UI 中只显示域名和 cookie 数量，不会展示 cookie 值
- browse 会话会在后续命令中持续保留 cookies，所以导入后可以立刻生效
