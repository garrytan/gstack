---
name: unfreeze
version: 0.1.0
description: |
  清除由 /freeze 设置的编辑边界，重新允许对所有目录进行修改。
  适用于在不结束会话的前提下扩大编辑范围。
  当用户说 “unfreeze”、“unlock edits”、“remove freeze”
  或 “allow all edits” 时使用。（gstack）
allowed-tools:
  - Bash
  - Read
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /unfreeze — 清除 Freeze 边界

移除 `/freeze` 设置的编辑限制，重新允许对所有目录进行修改。

```bash
mkdir -p ~/.gstack/analytics
echo '{"skill":"unfreeze","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## 清除边界

```bash
STATE_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.gstack}"
if [ -f "$STATE_DIR/freeze-dir.txt" ]; then
  PREV=$(cat "$STATE_DIR/freeze-dir.txt")
  rm -f "$STATE_DIR/freeze-dir.txt"
  echo "Freeze boundary cleared (was: $PREV). Edits are now allowed everywhere."
else
  echo "No freeze boundary was set."
fi
```

把结果告诉用户。并说明：本次会话中的 `/freeze` hooks 依然处于注册状态，
只是因为状态文件不存在，它们现在会放行一切。
如果想重新启用限制，再运行一次 `/freeze` 即可。
