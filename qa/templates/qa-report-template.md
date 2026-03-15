# QA レポート: {APP_NAME}

| 項目 | 値 |
|------|----|
| **Date** | {DATE} |
| **URL** | {URL} |
| **Branch** | {BRANCH} |
| **Commit** | {COMMIT_SHA} ({COMMIT_DATE}) |
| **PR** | {PR_NUMBER} ({PR_URL}) or "—" |
| **Tier** | Quick / Standard / Exhaustive |
| **Scope** | {SCOPE or "Full app"} |
| **Duration** | {DURATION} |
| **Pages visited** | {COUNT} |
| **Screenshots** | {COUNT} |
| **Framework** | {DETECTED or "Unknown"} |
| **Index** | [All QA runs](./index.md) |

## Health Score: {SCORE}/100

| カテゴリ | スコア |
|----------|--------|
| Console | {0-100} |
| Links | {0-100} |
| Visual | {0-100} |
| Functional | {0-100} |
| UX | {0-100} |
| Performance | {0-100} |
| Accessibility | {0-100} |

## 優先して直すべき Top 3

1. **{ISSUE-NNN}: {title}** — {one-line description}
2. **{ISSUE-NNN}: {title}** — {one-line description}
3. **{ISSUE-NNN}: {title}** — {one-line description}

## Console 健全性

| Error | Count | First seen |
|-------|-------|------------|
| {error message} | {N} | {URL} |

## サマリー

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

## Issues

### ISSUE-001: {Short title}

| 項目 | 値 |
|------|----|
| **Severity** | critical / high / medium / low |
| **Category** | visual / functional / ux / content / performance / console / accessibility |
| **URL** | {page URL} |

**Description:** {What is wrong, expected vs actual.}

**再現手順:**

1. Navigate to {URL}
   ![Step 1](screenshots/issue-001-step-1.png)
2. {Action}
   ![Step 2](screenshots/issue-001-step-2.png)
3. **Observe:** {what goes wrong}
   ![Result](screenshots/issue-001-result.png)

---

## Regression（該当する場合）

| Metric | Baseline | Current | Delta |
|--------|----------|---------|-------|
| Health score | {N} | {N} | {+/-N} |
| Issues | {N} | {N} | {+/-N} |

**Fixed since baseline:** {list}  
**New since baseline:** {list}
