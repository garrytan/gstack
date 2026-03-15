# Pre-Landing レビューチェックリスト

## 手順

以下の観点で `git diff origin/main` の出力をレビューしてください。`file:line` を明示し、修正案まで書いてください。問題がない箇所はスキップし、実害のある指摘だけを挙げます。

**2段階レビュー:**
- **Pass 1 (CRITICAL):** 先に SQL & Data Safety と LLM Output Trust Boundary を実施します。これらは `/ship` をブロックし得ます。
- **Pass 2 (INFORMATIONAL):** 残りのカテゴリを実施します。PR 本文には含めますが、ブロッカーではありません。

**出力形式:**

```
Pre-Landing Review: N issues (X critical, Y informational)

**CRITICAL** (blocking /ship):
- [file:line] Problem description
  Fix: suggested fix

**Issues** (non-blocking):
- [file:line] Problem description
  Fix: suggested fix
```

問題がなければ `Pre-Landing Review: No issues found.` を返します。

簡潔に書いてください。各 issue は「問題 1 行 + 修正 1 行」のみ。前置き、総評、`looks good overall` のような文は不要です。

---

## レビューカテゴリ

### Pass 1 — CRITICAL

#### SQL & Data Safety
- SQL 内で文字列補間している（値が `.to_i` / `.to_f` でも不可。`sanitize_sql_array` または Arel を使う）
- TOCTOU race: check-then-set パターンで、本来は `WHERE` + `update_all` の原子的更新にすべき箇所
- 制約がある（またはあるべき）フィールドに対する `update_column` / `update_columns` によりバリデーションを回避している箇所
- N+1 クエリ: ループ / view で使う関連に `.includes()` がない（特に avatar, attachments）

#### Race Conditions & Concurrency
- 一意制約や `rescue RecordNotUnique; retry` なしの read-check-write（例: `where(hash:).first` → `save!` で同時 insert 未考慮）
- unique DB index がない列への `find_or_create_by`（同時実行で重複作成され得る）
- `WHERE old_status = ? UPDATE SET new_status` の原子的遷移でない status 更新（遷移スキップ / 二重適用の可能性）
- ユーザー入力由来データへの `html_safe`（XSS）。`.html_safe`、`raw()`、`html_safe` 出力への文字列補間を確認

#### LLM Output Trust Boundary
- LLM 生成値（email, URL, name）をフォーマット検証なしで DB 保存 / mailer 連携している。保存前に軽量ガード（`EMAIL_REGEXP`, `URI.parse`, `.strip`）を入れる。
- 構造化 tool 出力（array, hash）を型 / shape 検証なしで DB 書き込みに使っている。

### Pass 2 — INFORMATIONAL

#### Conditional Side Effects
- 条件分岐の片側で副作用の適用漏れがある。例: verified へ昇格するが、二次条件が真のときだけ URL を付与し、偽側では URL なしで昇格して不整合が出る。
- 実際には条件でスキップされた処理を、ログだけ「実行した」と記録している。ログは実際の挙動と一致させる。

#### Magic Numbers & String Coupling
- 複数ファイルに裸の数値リテラルがある。名前付き定数にして、定義を集約する。
- エラーメッセージ文字列を別箇所でクエリ条件として使っている（その文字列で grep して依存を確認）

#### Dead Code & Consistency
- 代入されたが参照されない変数
- PR title と VERSION / CHANGELOG のバージョン不一致
- CHANGELOG の説明が実装と不一致（例: 「X から Y に変更」とあるが X が元から存在しない）
- コード変更後に古い挙動を説明し続けているコメント / docstring

#### LLM Prompt Issues
- プロンプト内で 0-indexed の列挙（LLM は 1-indexed を返しがち）
- 利用可能な tool / capability の説明と、実際の `tool_classes` / `tools` 配線が不一致
- 複数箇所に記載された word/token 制限が乖離しうる

#### Test Gaps
- 異常系テストで型 / status だけを見て、副作用（URL 付与 / フィールド更新 / callback 発火）を見ていない
- 文字列の存在だけを検証し、形式まで検証していない（例: title はあるが URL 形式を未検証）
- 外部サービスを呼ばないべき分岐で `.expects(:something).never` がない
- ブロッキング / rate limiting / auth などのセキュリティ強制機能に、強制経路を end-to-end で検証する統合テストがない

#### Crypto & Entropy
- ハッシュ化ではなく切り詰め（SHA-256 の代わりに末尾 N 文字）でエントロピーを落としている
- セキュリティ用途に `rand()` / `Random.rand` を使っている（`SecureRandom` を使う）
- 秘密情報 / token の比較に定数時間比較でない `==` を使っている（タイミング攻撃の余地）

#### Time Window Safety
- 日付キー参照で「today が 24 時間を覆う」と仮定している。例: PT 8am のレポートが当日 0:00→8:00 しか見ない
- 関連機能間で time window が不一致（片方は hourly bucket、片方は daily key）

#### Type Coercion at Boundaries
- Ruby→JSON→JS をまたぐ値で型が変わり得る（number vs string）。hash/digest 入力は型正規化する。
- hash/digest 入力で `.to_s` 等を使わずに直列化している（`{ cores: 8 }` と `{ cores: "8" }` でハッシュが変わる）

#### View/Frontend
- partial 内のインライン `<style>` ブロック（毎回再パースされる）
- view の O(n*m) 参照（ループ内 `Array#find`。`index_by` hash で置換可能）
- DB 結果を Ruby 側 `.select{}` でフィルタしている（先頭ワイルドカード `LIKE` 回避など意図がある場合を除く）

---

## Gate Classification

```
CRITICAL (blocks /ship):          INFORMATIONAL (in PR body):
├─ SQL & Data Safety              ├─ Conditional Side Effects
├─ Race Conditions & Concurrency  ├─ Magic Numbers & String Coupling
└─ LLM Output Trust Boundary      ├─ Dead Code & Consistency
                                   ├─ LLM Prompt Issues
                                   ├─ Test Gaps
                                   ├─ Crypto & Entropy
                                   ├─ Time Window Safety
                                   ├─ Type Coercion at Boundaries
                                   └─ View/Frontend
```

---

## Suppressions — これらは指摘しない

- 可読性向上に寄与する無害な冗長性（例: `present?` と `length > 20` の併記）を「冗長」とだけ指摘すること
- 「この閾値 / 定数の理由コメントを追加すべき」という指摘（閾値は調整で変わり、コメントが陳腐化しやすい）
- 既に挙動を十分カバーしているアサーションに対して「もっと厳密にできる」とだけ言うこと
- 一貫性だけを目的にした変更提案（別定数に合わせるためだけに条件分岐で包む等）
- 入力制約上発生しない edge case X を理由に Regex を指摘すること
- 「テストが複数ガードを同時に検証している」こと自体の指摘（分離は必須ではない）
- Eval 閾値（max_actionable, min scores）への指摘（経験的に調整され続ける）
- 無害な no-op（例: 配列に存在しない要素を `.reject` する）
- レビュー対象 diff で既に解消済みの内容（コメント前に FULL diff を確認する）
