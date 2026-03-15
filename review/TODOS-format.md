# TODOS.md フォーマット参照

標準的な TODOS.md 形式の共通リファレンスです。`/ship`（Step 5.5）と `/plan-ceo-review`（TODOS.md 更新セクション）で参照し、TODO 項目の構造を一貫させます。

---

## ファイル構造

```markdown
# TODOS

## <Skill/Component>     ← 例: ## Browse, ## Ship, ## Review, ## Infrastructure
<items sorted P0 first, then P1, P2, P3, P4>

## Completed
<finished items with completion annotation>
```

**Sections:** skill または component 単位で整理します（`## Browse`, `## Ship`, `## Review`, `## QA`, `## Retro`, `## Infrastructure`）。各セクション内は優先度順（P0 が先頭）に並べます。

---

## TODO 項目フォーマット

各項目は、セクション配下の H3 とします。

```markdown
### <Title>

**What:** One-line description of the work.

**Why:** The concrete problem it solves or value it unlocks.

**Context:** Enough detail that someone picking this up in 3 months understands the motivation, the current state, and where to start.

**Effort:** S / M / L / XL
**Priority:** P0 / P1 / P2 / P3 / P4
**Depends on:** <prerequisites, or "None">
```

**Required fields:** What, Why, Context, Effort, Priority  
**Optional fields:** Depends on, Blocked by

---

## 優先度定義

- **P0** — Blocking: 次リリース前に必須
- **P1** — Critical: 今サイクルで対応すべき
- **P2** — Important: P0/P1 解消後に対応
- **P3** — Nice-to-have: 導入・利用データを見て再検討
- **P4** — Someday: 良いアイデアだが緊急度は低い

---

## Completed 項目フォーマット

項目完了時は、元の内容を保持したまま `## Completed` セクションに移し、次を追記します。

```markdown
**Completed:** vX.Y.Z (YYYY-MM-DD)
```
