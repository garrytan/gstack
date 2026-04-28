# research-stack

Claude Code を研究計算ワークフローに特化させるスキルパック。仮説の構造化、実験コード生成、結果分析までを一貫したプロセスで実行し、再現性とリサーチログ (research log) を自動的に保証します。

## 何ができるか

| スキル | 役割 | 出力 |
|--------|------|------|
| `/hypothesis` | 研究アイデアを構造化された仮説仕様に変換 | `research/hypotheses/<slug>.md` + `research/experiments/<slug>/spec.yaml` |
| `/run-experiment` | 仕様に基づくコード生成 → 承認ゲート → 実行 → リサーチログ記録 | 実験コード + `research-log.json` + `metrics.json` |
| `/report` | 結果分析、ベースライン比較、プロット生成、レポート作成 | `research/reports/<slug>/report.md` + matplotlib プロット |
| `/discuss` | レポートの対話的考察、アノテーション、フォローアップ提案 | `research/discussions/<slug>.md` |
| `/peer-review` | 方法論・統計・コード品質・再現性・結論の批判的レビュー | `research/reviews/<slug>.md` |

### ワークフロー

```
/hypothesis → /run-experiment → /report → /discuss
    |              |                |          |
    v              v                v          v
  仮説文書      コード生成        結果分析    対話的考察
  実験仕様      承認ゲート        ベースライン比較  アノテーション
                実行+リサーチログ プロット+レポート
                                      |
                                      v
                                 /peer-review
                                      |
                                      v
                                 批判的レビュー
                                 ACCEPT/REVISE/REJECT
```

各スキルはプロジェクトの `CLAUDE.md` に記述された研究規約を読み取り、生成コードに反映します。言語、テストコマンド、ライブラリ、命名規則などがプロジェクトごとに統一されます。

## インストール (30秒)

**必要なもの:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+

### グローバルインストール

```bash
git clone https://github.com/FumiKobayashi/research-stack.git ~/.claude/skills/research-stack
cd ~/.claude/skills/research-stack && ./setup
```

### プロジェクトローカルインストール

```bash
git clone https://github.com/FumiKobayashi/research-stack.git .claude/skills/research-stack
cd .claude/skills/research-stack && ./setup --local
```

`./setup` は以下を実行します:
1. 依存関係のインストール (`bun install`)
2. テンプレートから SKILL.md を生成
3. `~/.claude/skills/` にスキルをシンボリックリンク

## プロジェクト設定

対象プロジェクトの `CLAUDE.md` に研究規約セクションを追加してください:

```markdown
## Research conventions

language: python
test_command: pytest
compute_backend: local
random_seed_strategy: explicit
preferred_libraries:
  - numpy
  - matplotlib
  - scipy
naming:
  experiments: snake_case
  hypotheses: snake_case
```

規約が未設定の場合、各スキルが初回実行時にテンプレートを提示して設定を促します。

## 使い方

### 1. `/hypothesis` - 仮説の構造化

Claude Code で `/hypothesis` を実行し、研究アイデアを入力します。

```
You:    /hypothesis
        表面符号のデコーダで、syndrome weightによるunion-find
        の枝刈りが論理誤り率を改善するか検証したい

Claude: [既存の learnings を確認]
        [CLAUDE.md の研究規約を読み取り]
        [仮説文書を生成: research/hypotheses/uf-syndrome-pruning.md]
        [実験仕様を生成: research/experiments/uf-syndrome-pruning/spec.yaml]
        [AskUserQuestion: 仕様の確認と調整]
```

出力される `spec.yaml`:
```yaml
hypothesis_slug: uf-syndrome-pruning
description: "syndrome weightベースのunion-find枝刈りが論理誤り率を改善するか"
parameters:
  code_distances: [3, 5, 7]
  physical_error_rates: [0.001, 0.005, 0.01]
  num_shots: 10000
metrics:
  - logical_error_rate
  - wall_clock_seconds
baseline_slug: uf-baseline
random_seeds: [42, 123, 456]
```

### 2. `/run-experiment` - コード生成と実行

```
You:    /run-experiment

Claude: [spec.yaml を読み込み]
        [研究規約に従ってコードを生成]
        --- APPROVAL GATE ---
        生成されたコードを確認してください:
        A) 承認して実行
        B) 修正を指示
        C) 中止
        ---
You:    A

Claude: [実験を実行]
        [research-log.json を自動生成: git SHA, パッケージバージョン, 乱数シード, 実行時間]
        [metrics.json に結果を記録]
```

承認ゲート (Phase A → Phase B) により、生成コードを研究者が確認してから実行に移ります。

### 3. `/report` - 結果分析とレポート

```
You:    /report

Claude: [results/ から metrics.json + research-log.json を読み込み]
        [baselines/ からベースラインを読み込み]
        [統計分析を実行]
        [matplotlib でプロットを生成]
        [research/reports/<slug>/report.md を作成]
        [AskUserQuestion: 結果の評価]
        A) 仮説を支持 → ベースラインを更新
        B) 仮説を棄却 → 棄却理由を記録
        C) 追加実験が必要
```

### 4. `/discuss` - 対話的考察

```
You:    /discuss threshold-scaling

Claude: [レポート・metrics・research-log・hypothesis をロード]
        [コンテキスト要約を表示]
        [AskUserQuestion: 何について議論しますか？]

You:    distance=7 のときだけ論理誤り率が悪化しているのはなぜ？

Claude: [metrics.json を参照して具体的な数値で回答]
        Data ref: metrics.json — distance=7, p=0.005, logical_error_rate=0.12
        [AskUserQuestion: 次は？]
```

議論ログは `research/discussions/<slug>.md` に保存されます。アノテーション (observation/concern/TODO/correction) の追加やフォローアップ実験の提案も可能です。

### 5. `/peer-review` - 批判的レビュー

```
You:    /peer-review threshold-scaling

Claude: [hypothesis, code, results, report, research-log を全てロード]
        [5カテゴリでレビュー: Methodology, Statistics, Code quality, Reproducibility, Conclusions]
        [Finding 1 [major] Statistics: seeds が 3 つでは統計的有意性が不十分]
        [Finding 2 [minor] Code quality: シード設定が一部の RNG に適用されていない]
        [AskUserQuestion: Verdict: REVISE]
```

レビュー結果は `research/reviews/<slug>.md` に保存。各 finding に severity (critical/major/minor) が付き、研究者は accept/dispute/defer で応答できます。

## ディレクトリ構造

スキルが生成・管理するファイルは以下の構造に従います:

```
research/
  hypotheses/          # 仮説文書 (.md)
  experiments/         # 実験ごとのディレクトリ
    <slug>/
      spec.yaml        # 実験仕様
      run.py           # 実験コード
      research-log.json  # リサーチログ (再現用記録)
  results/
    <slug>/
      metrics.json     # 実験結果
      <timestamp>/     # タイムスタンプ付き結果
  baselines/
    <slug>/
      metrics.json     # ベースライン値
  reports/
    <slug>/
      report.md        # 分析レポート
      plots/           # matplotlib プロット
  discussions/
    <slug>.md          # 対話的考察ログ
  reviews/
    <slug>.md          # ピアレビュー文書
```

## リサーチログ (Research Log)

全ての実験実行で以下が自動記録されます (`research-log.json`):

```json
{
  "git_sha": "abc1234",
  "experiment_spec": "spec.yaml の内容",
  "package_versions": {"numpy": "1.26.0", "stim": "1.14.0"},
  "random_seeds": [42, 123, 456],
  "wall_clock_seconds": 142.3,
  "timestamp": "2026-04-07T10:30:00Z",
  "compute_backend": "local",
  "hostname": "researcher-mbp"
}
```

## 過去のデータの移行 (v1.0.0 以前のユーザー向け)

v1.1.0 で `provenance` という用語を「リサーチログ (research log)」にリネームしました。実験結果ディレクトリのファイル名も `provenance.json` → `research-log.json` に変更されています。

- **読み込み側は後方互換あり** — `/report`, `/discuss`, `/peer-review` は `research-log.json` を優先し、無ければ `provenance.json` にフォールバックします。何もしなくても過去の実験は引き続き利用できます。
- **一括リネームしたい場合** — 以下のスクリプトを実行してください:

```bash
# まずドライランで対象を確認
bin/rstack-migrate-provenance --dry-run

# 実行
bin/rstack-migrate-provenance
```

## 開発

```bash
bun install              # 依存関係インストール
bun test                 # スキルバリデーションテスト
bun run gen:skill-docs   # SKILL.md を再生成
bun run build            # gen:skill-docs のエイリアス
```

SKILL.md ファイルはテンプレート (`.tmpl`) から生成されます。直接編集せず、`.tmpl` を編集してから `bun run gen:skill-docs` で再生成してください。

## プロジェクト構成

```
research-stack/
  hypothesis/           # /hypothesis スキル
    SKILL.md.tmpl       # テンプレート
    SKILL.md            # 生成済み (編集不可)
  run-experiment/       # /run-experiment スキル
    SKILL.md.tmpl
    SKILL.md
  report/               # /report スキル
    SKILL.md.tmpl
    SKILL.md
  discuss/              # /discuss スキル
    SKILL.md.tmpl
    SKILL.md
  peer-review/          # /peer-review スキル
    SKILL.md.tmpl
    SKILL.md
  scripts/
    gen-skill-docs.ts   # テンプレート → SKILL.md ジェネレータ
    resolvers/          # テンプレート変数リゾルバ
      research.ts       # 研究固有: 規約読み取り、リサーチログ仕様、ディレクトリ構造
      preamble.ts       # セッション管理、コンテキスト復旧
      utility.ts        # slug生成、ブランチ検出
  bin/                  # CLI ユーティリティ
  test/                 # バリデーションテスト
  setup                 # インストールスクリプト
  SKILL.md.tmpl         # ルートスキル (ルーティング)
  SKILL.md              # 生成済み
```

## 背景

[gstack](https://github.com/garrytan/gstack) (Garry Tan 作の Claude Code スキルパック) のテンプレートシステム (`.tmpl` → `SKILL.md` 生成パイプライン)、learnings システム、セッション管理をベースに、数値計算研究のワークフローに特化したスキルを構築しました。

## ライセンス

MIT
