# gstack 開発ガイド

## コマンド

```bash
bun install          # 依存関係をインストール
bun test             # 無料のテストを実行 (browse + snapshot + skill validation)
bun run test:evals   # 有料 eval を実行: LLM judge + E2E (~$4/run)
bun run test:e2e     # E2E テストのみ実行 (~$3.85/run)
bun run dev <cmd>    # dev mode で CLI を実行。例: bun run dev goto https://example.com
bun run build        # ドキュメント生成 + binary を compile
bun run gen:skill-docs  # template から SKILL.md を再生成
bun run skill:check  # 全 skill の health dashboard
bun run dev:skill    # watch mode: 変更に応じて自動再生成 + validate
bun run eval:list    # ~/.gstack-dev/evals/ にある eval 実行結果を一覧表示
bun run eval:compare # 2 つの eval 実行結果を比較 (既定では最新同士)
bun run eval:summary # 全 eval 実行結果の統計を集計
```

`test:evals` には `ANTHROPIC_API_KEY` が必要です。E2E テストは進捗をリアルタイムで stream し、`--output-format stream-json --verbose` を tool 単位で出力します。結果は `~/.gstack-dev/evals/` に保存され、前回実行との差分比較も自動で行われます。

## project 構成

```
gstack/
├── browse/          # headless browser CLI (Playwright)
│   ├── src/         # CLI + server + commands
│   │   ├── commands.ts  # command registry (single source of truth)
│   │   └── snapshot.ts  # SNAPSHOT_FLAGS metadata array
│   ├── test/        # 統合テスト + fixture
│   └── dist/        # コンパイル済み binary
├── scripts/         # build + DX tooling
│   ├── gen-skill-docs.ts  # Template → SKILL.md generator
│   ├── skill-check.ts     # health dashboard
│   └── dev-skill.ts       # watch mode
├── test/            # skill validation + eval tests
│   ├── helpers/     # skill-parser.ts, session-runner.ts, llm-judge.ts, eval-store.ts
│   ├── fixtures/    # 正解 JSON、planted-bug fixture、eval baseline
│   ├── skill-validation.test.ts  # Tier 1: static validation (無料、<1s)
│   ├── gen-skill-docs.test.ts    # Tier 1: generator quality (無料、<1s)
│   ├── skill-llm-eval.test.ts   # Tier 3: LLM-as-judge (~$0.15/run)
│   └── skill-e2e.test.ts         # Tier 2: `claude -p` 経由の E2E (~$3.85/run)
├── ship/            # Ship workflow skill
├── review/          # PR review skill
├── plan-ceo-review/ # /plan-ceo-review skill
├── plan-eng-review/ # /plan-eng-review skill
├── retro/           # Retrospective skill
├── setup            # 初回 setup: binary を build して skill を symlink
├── SKILL.md         # SKILL.md.tmpl から生成 (直接編集しない)
├── SKILL.md.tmpl    # template。ここを編集して `gen:skill-docs` を実行する
└── package.json     # browse 用 build script
```

## SKILL.md workflow

SKILL.md file は `.tmpl` template から**生成**されます。ドキュメントを更新する手順は次のとおりです。

1. `.tmpl` file を編集する（例: `SKILL.md.tmpl` または `browse/SKILL.md.tmpl`）
2. `bun run gen:skill-docs` を実行する（`bun run build` でも自動実行される）
3. `.tmpl` と生成された `.md` file の両方を commit する

新しい browse command を追加する場合は `browse/src/commands.ts` に追加して rebuild します。snapshot flag を追加する場合は `browse/src/snapshot.ts` の `SNAPSHOT_FLAGS` に追加して rebuild します。

## browser 操作

browser を操作する必要があるとき（QA、dogfooding、cookie setup など）は、`/browse` skill を使うか、`$B <command>` で browse binary を直接実行してください。`mcp__claude-in-chrome__*` tool は絶対に使わないでください。遅く、不安定で、この project が使う手段でもありません。

## active skill への反映

active skill は `~/.claude/skills/gstack/` にあります。変更後は次を実行します。

1. branch を push する
2. skill directory で fetch と reset を行う: `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`
3. rebuild する: `cd ~/.claude/skills/gstack && bun run build`

または、binary を直接コピーします: `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`
