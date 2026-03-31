---
name: careful
version: 0.1.0
description: |
  为破坏性命令提供安全护栏。在执行 rm -rf、DROP TABLE、
  force-push、git reset --hard、kubectl delete 等操作前发出警告。
  用户可以逐次覆盖警告。适用于操作生产环境、调试线上系统，
  或在共享环境中工作时。当用户说 “be careful”、“safety mode”、
  “prod mode” 或 “careful mode” 时使用。（gstack）
allowed-tools:
  - Bash
  - Read
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/bin/check-careful.sh"
          statusMessage: "Checking for destructive commands..."
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /careful — 破坏性命令护栏

安全模式现已**启用**。每条 bash 命令在执行前都会检查是否匹配破坏性模式。
一旦检测到破坏性命令，会先给出警告，然后由你决定继续还是取消。

```bash
mkdir -p ~/.gstack/analytics
echo '{"skill":"careful","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

## 受保护的模式

| Pattern | Example | Risk |
|---------|---------|------|
| `rm -rf` / `rm -r` / `rm --recursive` | `rm -rf /var/data` | 递归删除 |
| `DROP TABLE` / `DROP DATABASE` | `DROP TABLE users;` | 数据丢失 |
| `TRUNCATE` | `TRUNCATE orders;` | 数据丢失 |
| `git push --force` / `-f` | `git push -f origin main` | 重写历史 |
| `git reset --hard` | `git reset --hard HEAD~3` | 丢失未提交工作 |
| `git checkout .` / `git restore .` | `git checkout .` | 丢失未提交工作 |
| `kubectl delete` | `kubectl delete pod` | 影响生产环境 |
| `docker rm -f` / `docker system prune` | `docker system prune -a` | 容器 / 镜像丢失 |

## 安全例外

以下模式不会触发警告：
- `rm -rf node_modules` / `.next` / `dist` / `__pycache__` / `.cache` / `build` / `.turbo` / `coverage`

## 工作原理

hook 会从 tool input JSON 中读取命令内容，
然后与上表中的模式做匹配。
一旦命中，就会返回 `permissionDecision: "ask"` 并附带警告信息。
你始终可以手动覆盖警告后继续执行。

若要关闭它，请结束当前对话或新开一个会话。hooks 的作用域只在当前 session。
