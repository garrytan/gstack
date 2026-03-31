---
name: freeze
version: 0.1.0
description: |
  在当前会话中把文件编辑限制到某个特定目录。阻止对允许路径外的
  Edit 和 Write 操作。适用于调试时防止误改无关代码，或当你希望
  把改动范围严格限制在某个模块时使用。
  当用户说 “freeze”、“restrict edits”、“only edit this folder”
  或 “lock down edits” 时使用。（gstack）
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
hooks:
  PreToolUse:
    - matcher: "Edit"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/bin/check-freeze.sh"
          statusMessage: "Checking freeze boundary..."
    - matcher: "Write"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/bin/check-freeze.sh"
          statusMessage: "Checking freeze boundary..."
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /freeze — 将编辑限制在某个目录内

把文件编辑锁定到指定目录。任何指向该目录外文件的 Edit 或 Write 操作都会被**直接阻止**，而不只是提示。

```bash
mkdir -p ~/.gstack/analytics
echo '{"skill":"freeze","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## 设置步骤

先问用户要把编辑限制在哪个目录。使用 AskUserQuestion：

- 问题："Which directory should I restrict edits to? Files outside this path will be blocked from editing."
- 使用文本输入（不是多选）—— 由用户直接输入路径。

拿到目录路径后：

1. 解析为绝对路径：
```bash
FREEZE_DIR=$(cd "<user-provided-path>" 2>/dev/null && pwd)
echo "$FREEZE_DIR"
```

2. 补齐末尾斜杠，并保存到 freeze 状态文件：
```bash
FREEZE_DIR="${FREEZE_DIR%/}/"
STATE_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.gstack}"
mkdir -p "$STATE_DIR"
echo "$FREEZE_DIR" > "$STATE_DIR/freeze-dir.txt"
echo "Freeze boundary set: $FREEZE_DIR"
```

告诉用户：
"Edits are now restricted to `<path>/`. Any Edit or Write outside this directory will be blocked. To change the boundary, run `/freeze` again. To remove it, run `/unfreeze` or end the session."

## 工作原理

hook 会从 Edit / Write 的 tool input JSON 中读取 `file_path`，
再检查该路径是否以 freeze 目录作为前缀。
如果不是，就返回 `permissionDecision: "deny"` 直接阻止操作。

freeze 边界通过状态文件在本次 session 中持续有效。
hook script 会在每次 Edit / Write 调用时重新读取它。

## 说明

- freeze 目录末尾的 `/` 用来防止 `/src` 错误匹配 `/src-old`
- freeze 只影响 Edit 和 Write，不影响 Read、Bash、Glob、Grep
- 这只是为了防止误改，不是安全边界；像 `sed` 这样的 Bash 命令仍可能改到边界外文件
- 如需关闭，运行 `/unfreeze` 或直接结束会话
