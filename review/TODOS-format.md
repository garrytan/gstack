# TODOS.md 格式参考

这是统一的 `TODOS.md` 格式参考。`/ship`（Step 5.5）与 `/plan-ceo-review`
（TODOS.md updates 部分）都会引用它，以确保 TODO 条目结构保持一致。

---

## 文件结构

```markdown
# TODOS

## <技能/Component>     ← 例如：## Browse、## Ship、## 审查、## Infrastructure
<items sorted P0 first, then P1, P2, P3, P4>

## Completed
<finished items with completion annotation>
```

**Sections：** 按 skill 或 component 组织（如 `## Browse`、`## Ship`、`## Review`、`## QA`、`## Retro`、`## Infrastructure`）。
每个 section 内部按优先级排序（P0 在最上面）。

---

## TODO 条目格式

每个条目都是所属 section 下的一个 H3：

```markdown
### <Title>

**What:** 用一句话描述要做的工作。

**Why:** 它解决的具体问题，或能释放出的价值。

**Context:** 提供足够背景，保证三个月后再接手的人仍能理解动机、当前状态和切入点。

**Effort:** S / M / L / XL
**Priority:** P0 / P1 / P2 / P3 / P4
**Depends on:** <prerequisites, or "None">
```

**必填字段：** What、Why、Context、Effort、Priority  
**可选字段：** Depends on、Blocked by

---

## 优先级定义

- **P0** —— 阻塞项：必须在下一个 release 前完成
- **P1** —— 关键项：应该在当前周期完成
- **P2** —— 重要项：在 P0 / P1 清空后处理
- **P3** —— Nice-to-have：等有 adoption / usage 数据后再回看
- **P4** —— Someday：是个好想法，但目前不着急

---

## 已完成条目格式

当某个条目完成后，把它移动到 `## Completed` section 中，保留原内容，并在末尾追加：

```markdown
**Completed:** vX.Y.Z (YYYY-MM-DD)
```
