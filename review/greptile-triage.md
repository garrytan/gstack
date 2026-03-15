# Greptile コメントトリアージ

GitHub PR 上の Greptile レビューコメントを取得・フィルタ・分類するための共通リファレンスです。`/review`（Step 2.5）と `/ship`（Step 3.75）の両方で参照します。

---

## 取得（Fetch）

次のコマンドで PR を特定し、コメントを取得します。API 呼び出しは並列実行します。

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)
PR_NUMBER=$(gh pr view --json number --jq '.number' 2>/dev/null)
```

**どちらかが失敗、または空の場合:** Greptile triage は無言でスキップします。この連携は追加機能であり、なくてもワークフローは成立します。

```bash
# Fetch line-level review comments AND top-level PR comments in parallel
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  --jq '.[] | select(.user.login == "greptile-apps[bot]") | select(.position != null) | {id: .id, path: .path, line: .line, body: .body, html_url: .html_url, source: "line-level"}' > /tmp/greptile_line.json &
gh api repos/$REPO/issues/$PR_NUMBER/comments \
  --jq '.[] | select(.user.login == "greptile-apps[bot]") | {id: .id, body: .body, html_url: .html_url, source: "top-level"}' > /tmp/greptile_top.json &
wait
```

**API エラー、または両エンドポイントで Greptile コメントが 0 件の場合:** 無言でスキップします。

line-level コメントにある `position != null` フィルタにより、force-push 後に古くなったコメントを自動的に除外できます。

---

## Suppressions チェック

プロジェクト固有の履歴パスを組み立てます。
```bash
REMOTE_SLUG=$(browse/bin/remote-slug 2>/dev/null || ~/.claude/skills/gstack/browse/bin/remote-slug 2>/dev/null || basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
PROJECT_HISTORY="$HOME/.gstack/projects/$REMOTE_SLUG/greptile-history.md"
```

`$PROJECT_HISTORY` が存在する場合は読み込みます（プロジェクト単位の suppression）。各行には過去トリアージ結果が記録されています。

```
<date> | <repo> | <type:fp|fix|already-fixed> | <file-pattern> | <category>
```

**Categories**（固定セット）: `race-condition`, `null-check`, `error-handling`, `style`, `type-safety`, `security`, `performance`, `correctness`, `other`

取得した各コメントを、次の条件で履歴エントリと照合します。
- `type == fp`（抑制対象は既知の false positive のみ。過去に修正済みの real issue は抑制しない）
- `repo` が現在の repo と一致
- `file-pattern` がコメントのファイルパスと一致
- `category` がコメント内の issue 種別と一致

一致したコメントは **SUPPRESSED** としてスキップします。

履歴ファイルが存在しない、または一部行がパース不能でも、その行だけスキップして続行します。履歴ファイル不備で失敗してはいけません。

---

## 分類（Classify）

抑制されなかったコメントごとに実施:

1. **Line-level comments:** 指定 `path:line` と前後コンテキスト（±10 行）を読む
2. **Top-level comments:** コメント本文全体を読む
3. フル diff（`git diff origin/main`）と review checklist を照合する
4. 次のいずれかに分類する:
   - **VALID & ACTIONABLE**: 現在コードに実在する bug / race condition / security issue / correctness 問題
   - **VALID BUT ALREADY FIXED**: 実在した問題だが、同一ブランチの後続 commit で修正済み（修正 commit SHA を特定）
   - **FALSE POSITIVE**: コード誤読、別箇所で担保済み、またはスタイルノイズ
   - **SUPPRESSED**: 上記 suppression チェックで既に除外

---

## Reply APIs

Greptile コメントへの返信は、コメント種別に応じて正しい endpoint を使います。

**Line-level comments**（`pulls/$PR/comments` 由来）:
```bash
gh api repos/$REPO/pulls/$PR_NUMBER/comments/$COMMENT_ID/replies \
  -f body="<reply text>"
```

**Top-level comments**（`issues/$PR/comments` 由来）:
```bash
gh api repos/$REPO/issues/$PR_NUMBER/comments \
  -f body="<reply text>"
```

**返信 POST が失敗した場合**（例: PR が closed、書き込み権限なし）: 警告を出して継続します。返信失敗でワークフローを止めません。

---

## 返信テンプレート

Greptile への返信は必ず以下テンプレートを使います。曖昧な返信は避け、具体的な根拠を必ず含めてください。

### Tier 1（初回返信）— 丁寧に、根拠付き

**FIXES（実際に修正した場合）:**

```
**Fixed** in `<commit-sha>`.

\`\`\`diff
- <old problematic line(s)>
+ <new fixed line(s)>
\`\`\`

**Why:** <1-sentence explanation of what was wrong and how the fix addresses it>
```

**ALREADY FIXED（同ブランチ内の過去 commit で既に解消済み）:**

```
**Already fixed** in `<commit-sha>`.

**What was done:** <1-2 sentences describing how the existing commit addresses this issue>
```

**FALSE POSITIVE（指摘自体が誤り）:**

```
**Not a bug.** <1 sentence directly stating why this is incorrect>

**Evidence:**
- <specific code reference showing the pattern is safe/correct>
- <e.g., "The nil check is handled by `ActiveRecord::FinderMethods#find` which raises RecordNotFound, not nil">

**Suggested re-rank:** This appears to be a `<style|noise|misread>` issue, not a `<what Greptile called it>`. Consider lowering severity.
```

### Tier 2（過去返信後に Greptile が再指摘）— 強めに、証拠を厚く

下記の escalation detection で、同スレッドに過去の GStack 返信が確認できた場合に Tier 2 を使います。議論を終わらせるため、証拠を最大限提示します。

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

## Escalation Detection

返信文面を作る前に、同コメントスレッドに GStack の過去返信があるか確認します。

1. **Line-level comments:** `gh api repos/$REPO/pulls/$PR_NUMBER/comments/$COMMENT_ID/replies` で返信を取得し、本文に GStack marker（`**Fixed**`, `**Not a bug.**`, `**Already fixed**`）があるか確認する。
2. **Top-level comments:** 取得済み issue comments から、Greptile コメント後に投稿された GStack marker 付き返信を探す。
3. **同ファイル + 同カテゴリで過去 GStack 返信があり、Greptile が再投稿した場合:** Tier 2（強め）テンプレートを使う。
4. **過去 GStack 返信がない場合:** Tier 1（丁寧）テンプレートを使う。

escalation detection に失敗した場合（API エラー、スレッド判定が曖昧など）は Tier 1 を使います。曖昧な状態で escalation しないこと。

---

## Severity 評価と Re-ranking

分類時には、Greptile が暗黙に示す severity が妥当かも評価します。

- Greptile が **security/correctness/race-condition** として指摘しているが、実態が **style/performance** の軽微な指摘なら、返信に `**Suggested re-rank:**` を入れてカテゴリ修正を依頼する。
- 低 severity のスタイル問題を critical 相当で扱っている場合は、返信で明確に押し返す。
- re-ranking の根拠は必ず具体的に示す。感想ではなくコードと行番号を使う。

---

## 履歴ファイルへの書き込み

書き込み前に、2 つのディレクトリが存在することを確認します。
```bash
REMOTE_SLUG=$(browse/bin/remote-slug 2>/dev/null || ~/.claude/skills/gstack/browse/bin/remote-slug 2>/dev/null || basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
mkdir -p "$HOME/.gstack/projects/$REMOTE_SLUG"
mkdir -p ~/.gstack
```

トリアージ結果 1 件につき 1 行を、次の **両方** に追記します（suppression 用のプロジェクト単位 + retro 用のグローバル集約）。
- `~/.gstack/projects/$REMOTE_SLUG/greptile-history.md`（project ごと）
- `~/.gstack/greptile-history.md`（global）

フォーマット:
```
<YYYY-MM-DD> | <owner/repo> | <type> | <file-pattern> | <category>
```

例:
```
2026-03-13 | garrytan/myapp | fp | app/services/auth_service.rb | race-condition
2026-03-13 | garrytan/myapp | fix | app/models/user.rb | null-check
2026-03-13 | garrytan/myapp | already-fixed | lib/payments.rb | error-handling
```

---

## 出力形式

出力ヘッダーには Greptile 集計を含めます。
```
+ N Greptile comments (X valid, Y fixed, Z FP)
```

分類した各コメントには以下を含めます。
- 分類タグ: `[VALID]`, `[FIXED]`, `[FALSE POSITIVE]`, `[SUPPRESSED]`
- `file:line`（line-level）または `[top-level]`（top-level）
- 本文の 1 行要約
- パーマリンク URL（`html_url` フィールド）
