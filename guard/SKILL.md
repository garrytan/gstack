---
name: guard
version: 0.1.0
description: |
  完整安全模式：同时启用破坏性命令警告与目录级编辑限制。
  组合了 /careful（在 rm -rf、DROP TABLE、force-push 等前警告）
  和 /freeze（阻止边界外编辑）。适用于生产环境操作或线上调试时，
  需要最高级别保护的场景。当用户说 “guard mode”、“full safety”、
  “lock it down” 或 “maximum safety” 时使用。（gstack）
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/../careful/bin/check-careful.sh"
          statusMessage: "Checking for destructive commands..."
    - matcher: "Edit"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/../freeze/bin/check-freeze.sh"
          statusMessage: "Checking freeze boundary..."
    - matcher: "Write"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/../freeze/bin/check-freeze.sh"
          statusMessage: "Checking freeze boundary..."
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /guard — 完整安全模式

同时启用破坏性命令警告与目录级编辑限制。
它本质上就是 `/careful` + `/freeze` 的组合命令。

**依赖说明：** 这个 skill 依赖相邻目录中的 `/careful` 和 `/freeze` hook scripts。
二者必须一起安装（gstack 的 setup 脚本会一并处理）。

```bash
mkdir -p ~/.gstack/analytics
echo '{"skill":"guard","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## 设置步骤

先问用户希望把编辑限制在哪个目录。使用 AskUserQuestion：

- 问题："Guard mode: which directory should edits be restricted to? Destructive command warnings are always on. Files outside the chosen path will be blocked from editing."
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
- "**Guard mode active.** 现在有两层保护正在运行："
- "1. **Destructive command warnings** —— rm -rf、DROP TABLE、force-push 等会先警告（可手动覆盖）"
- "2. **Edit boundary** —— 文件编辑被限制在 `<path>/` 内。目录外的编辑会被阻止。"
- "如果只想移除编辑边界，请运行 `/unfreeze`。如果想彻底关闭全部保护，请结束本次会话。"

## 保护范围

完整的破坏性命令模式与安全例外列表，见 `/careful`。
编辑边界如何生效，见 `/freeze`。
