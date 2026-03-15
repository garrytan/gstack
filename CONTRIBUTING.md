# Contributing to gstack

gstack をより良くしたいと思ってくれてありがとうございます。skill prompt の typo 修正でも、まったく新しい workflow の追加でも、このガイドを読めばすぐに開発を始められます。

## Quick start

gstack の skills は、Claude Code が `skills/` directory から見つける Markdown files です。通常は `~/.claude/skills/gstack/` に置かれます（global install）。ただし gstack 自体を開発するときは、Claude Code に *working tree 内の skills* を読ませたいはずです。そうすれば copy や deploy をしなくても、編集内容が即座に反映されます。

それを実現するのが dev mode です。repo を local の `.claude/skills/` directory へ symlink し、Claude Code が checkout 中の skills をそのまま読むようにします。

```bash
git clone <repo> && cd gstack
bun install                    # 依存を install
bin/dev-setup                  # dev mode を有効化
```

これで任意の `SKILL.md` を編集し、Claude Code でその skill（例: `/review`）を呼び出すと、変更がその場で反映されます。開発が終わったら:

```bash
bin/dev-teardown               # 無効化して global install に戻す
```

## How dev mode works

`bin/dev-setup` は repo 内に `.claude/skills/` directory を作成し（gitignore 済み）、working tree へ戻る symlinks を並べます。Claude Code は local の `skills/` を先に見るので、global install よりあなたの編集が優先されます。

```
gstack/                          <- あなたの working tree
├── .claude/skills/              <- dev-setup が作成（gitignored）
│   ├── gstack -> ../../         <- repo root への symlink
│   ├── review -> gstack/review
│   ├── ship -> gstack/ship
│   └── ...                      <- skill ごとに 1 つ symlink
├── review/
│   └── SKILL.md                 <- ここを編集し、/review で確認
├── ship/
│   └── SKILL.md
├── browse/
│   ├── src/                     <- TypeScript source
│   └── dist/                    <- compiled binary（gitignored）
└── ...
```

## Day-to-day workflow

```bash
# 1. dev mode に入る
bin/dev-setup

# 2. skill を編集
vim review/SKILL.md

# 3. Claude Code でテスト — 変更はそのまま反映される
#    > /review

# 4. browse source を触ったなら binary を rebuild
bun run build

# 5. その日の作業が終わったら解除
bin/dev-teardown
```

## Testing & evals

### Setup

```bash
# 1. .env.example をコピーして API key を入れる
cp .env.example .env
# .env を編集 → ANTHROPIC_API_KEY=sk-ant-... を設定

# 2. 依存を install（まだなら）
bun install
```

Bun は `.env` を自動で読み込みます。追加設定は不要です。Conductor workspaces は main worktree から `.env` を自動で引き継ぎます（後述の「Conductor workspaces」を参照）。

### Test tiers

| Tier | Command | Cost | テスト内容 |
|------|---------|------|-----------|
| 1 — Static | `bun test` | Free | Command validation、snapshot flags、SKILL.md correctness、TODOS-format.md refs、observability unit tests |
| 2 — E2E | `bun run test:e2e` | ~$3.85 | `claude -p` subprocess 経由の完全な skill 実行 |
| 3 — LLM eval | `bun run test:evals` | ~$0.15 standalone | 生成された SKILL.md docs を LLM-as-judge で採点 |
| 2+3 | `bun run test:evals` | ~$4 combined | E2E + LLM-as-judge（両方実行） |

```bash
bun test                     # Tier 1 のみ（毎 commit で実行、<5s）
bun run test:e2e             # Tier 2: E2E のみ（EVALS=1 が必要、Claude Code 内では実行不可）
bun run test:evals           # Tier 2 + 3 をまとめて実行（~$4/run）
```

### Tier 1: Static validation（無料）

`bun test` で自動実行されます。API keys は不要です。

- **Skill parser tests** (`test/skill-parser.test.ts`) — SKILL.md の bash code blocks からすべての `$B` command を抽出し、`browse/src/commands.ts` の command registry と突き合わせます。typo、削除済み command、無効な snapshot flag を検出します。
- **Skill validation tests** (`test/skill-validation.test.ts`) — SKILL.md files が実在する commands と flags だけを参照しているか、また command descriptions が品質 threshold を満たしているかを検証します。
- **Generator tests** (`test/gen-skill-docs.test.ts`) — template system のテストです。placeholders が正しく解決されるか、flags の value hints（例: `-d <N>` であって単なる `-d` ではない）が出力に含まれるか、主要 commands の descriptions が充実しているか（例: `is` は有効な states を列挙し、`press` は key の例を示す）を確認します。

### Tier 2: `claude -p` による E2E（~$3.85/run）

`claude -p` を `--output-format stream-json --verbose` 付きの subprocess として起動し、real-time progress のために NDJSON を stream しつつ、browse errors を走査します。これは「この skill が本当に end to end で動くか」を確認する最も近いテストです。

```bash
# 通常の terminal から実行する必要があります — Claude Code や Conductor の中にネストできません
EVALS=1 bun test test/skill-e2e.test.ts
```

- `EVALS=1` env var で gate されます（高価な run の誤実行防止）
- Claude Code 内で動いている場合は自動 skip（`claude -p` をネストできないため）
- API connectivity の事前チェックあり。ConnectionRefused なら budget を消費する前に fail fast
- stderr に real-time progress を出力: `[Ns] turn T tool #C: Name(...)`
- debugging 用に完全な NDJSON transcripts と failure JSON を保存
- tests は `test/skill-e2e.test.ts`、runner logic は `test/helpers/session-runner.ts`

### E2E observability

E2E tests は実行中に、machine-readable な artifacts を `~/.gstack-dev/` に出力します。

| Artifact | Path | 用途 |
|----------|------|------|
| Heartbeat | `e2e-live.json` | 現在の test status（tool call ごとに更新） |
| Partial results | `evals/_partial-e2e.json` | 完了済み tests（途中 kill されても残る） |
| Progress log | `e2e-runs/{runId}/progress.log` | append-only の text log |
| NDJSON transcripts | `e2e-runs/{runId}/{test}.ndjson` | test ごとの raw `claude -p` output |
| Failure JSON | `e2e-runs/{runId}/{test}-failure.json` | failure 時の diagnostic data |

**Live dashboard:** もう 1 つ terminal を開き、`bun run eval:watch` を実行すると、完了済み tests、現在実行中の test、cost を live dashboard で見られます。`--tail` を付けると progress.log の末尾 10 行も表示します。

**Eval history tools:**

```bash
bun run eval:list            # すべての eval runs を一覧表示
bun run eval:compare         # 2 つの runs を比較（最新を自動選択）
bun run eval:summary         # 全 runs の stats を集計
```

artifacts は自動削除されません。`~/.gstack-dev/` に蓄積され、post-mortem debugging や trend analysis に使えます。

### Tier 3: LLM-as-judge（~$0.15/run）

Claude Sonnet を使って、生成された SKILL.md docs を 3 つの観点で採点します。

- **Clarity** — AI agent が曖昧さなく instructions を理解できるか
- **Completeness** — すべての commands、flags、usage patterns が文書化されているか
- **Actionability** — doc の情報だけで agent が task を実行できるか

各観点は 1-5 点で採点されます。threshold は各観点とも **4 以上**。さらに `origin/main` 上の手メンテ baseline と generated docs を比較する regression test もあり、generated の方が同等以上の点数である必要があります。

```bash
# .env に ANTHROPIC_API_KEY が必要 — bun run test:evals に含まれています
```

- scoring stability のため `claude-sonnet-4-6` を使用
- tests は `test/skill-llm-eval.test.ts`
- Anthropic API を直接呼ぶため、`claude -p` ではなく、Claude Code 内からでも実行可能

### CI

GitHub Action（`.github/workflows/skill-docs.yml`）が push と PR のたびに `bun run gen:skill-docs --dry-run` を実行します。生成される SKILL.md files が commit 済みのものと違えば CI は fail します。これにより、古い docs が merge されるのを防ぎます。

tests は browse binary に対して直接実行されるため、dev mode は不要です。

## Editing SKILL.md files

SKILL.md files は `.tmpl` templates から **生成** されます。`.md` を直接編集しないでください。次回 build 時に上書きされます。

```bash
# 1. template を編集
vim SKILL.md.tmpl              # または browse/SKILL.md.tmpl

# 2. 再生成
bun run gen:skill-docs

# 3. 健全性を確認
bun run skill:check

# または watch mode を使う — 保存時に自動再生成
bun run dev:skill
```

browse command を追加するには `browse/src/commands.ts` に追加します。snapshot flag を追加するには `browse/src/snapshot.ts` の `SNAPSHOT_FLAGS` に追加します。その後 rebuild してください。

## Conductor workspaces

[Conductor](https://conductor.build) で複数の Claude Code sessions を並列実行している場合、`conductor.json` が workspace lifecycle を自動で配線します。

| Hook | Script | 役割 |
|------|--------|------|
| `setup` | `bin/dev-setup` | main worktree から `.env` をコピーし、deps を install し、skills を symlink する |
| `archive` | `bin/dev-teardown` | skill symlinks を削除し、`.claude/` directory を片付ける |

Conductor が新しい workspace を作ると、`bin/dev-setup` が自動で走ります。`git worktree list` から main worktree を検出し、API keys を引き継ぐため `.env` をコピーし、そのまま dev mode を設定します。手作業は不要です。

**初回 setup:** main repo の `.env` に `ANTHROPIC_API_KEY` を入れてください（`.env.example` を参照）。すべての Conductor workspace がそれを自動で継承します。

## Things to know

- **SKILL.md files は generated です。** `.md` ではなく `.tmpl` template を編集し、`bun run gen:skill-docs` で再生成してください。
- **TODOS.md は unified backlog です。** skill/component ごとに P0-P4 priority で整理されています。`/ship` は完了済み item を自動検出します。planning/review/retro 系 skills はすべて context としてこれを読みます。
- **Browse source の変更には rebuild が必要です。** `browse/src/*.ts` を触ったら `bun run build` を実行してください。
- **Dev mode は global install を shadow します。** project-local skills が `~/.claude/skills/gstack` より優先されます。`bin/dev-teardown` で global 側に戻せます。
- **Conductor workspaces は独立しています。** 各 workspace はそれぞれ独立した git worktree です。`bin/dev-setup` が `conductor.json` 経由で自動実行されます。
- **`.env` は worktrees 間で伝播します。** main repo に 1 回設定すれば、すべての Conductor workspaces で使えます。
- **`.claude/skills/` は gitignore 済みです。** symlinks が commit されることはありません。

## Testing a branch in another repo

1 つの workspace で gstack を開発しつつ、別の project で自分の branch を試したいことがあります。たとえば browse の変更を実アプリに対して確認したい場合です。その project で gstack がどう install されているかに応じて、2 つのケースがあります。

### Global install only（project 内に `.claude/skills/gstack/` がない）

global install をその branch に向けます。

```bash
cd ~/.claude/skills/gstack
git fetch origin
git checkout origin/<branch>        # 例: origin/v0.3.2
bun install                         # 依存に変更がある場合に備える
bun run build                       # binary を rebuild
```

その状態で別 project の Claude Code を開くと、自動的に `~/.claude/skills/` の skills が使われます。作業後に main に戻すには:

```bash
cd ~/.claude/skills/gstack
git checkout main && git pull
bun run build
```

### Vendored project copy（project に `.claude/skills/gstack/` が commit されている）

project に gstack を copy して vendor している場合があります（copy 内には `.git` はありません）。project-local skills は global より優先されるので、vendored copy も更新が必要です。手順は 3 段階です。

1. **まず global install を branch に更新する**（source を持つため）:
   ```bash
   cd ~/.claude/skills/gstack
   git fetch origin
   git checkout origin/<branch>      # 例: origin/v0.3.2
   bun install && bun run build
   ```

2. **別 project 側の vendored copy を置き換える**:
   ```bash
   cd /path/to/other-project

   # 古い skill symlinks と vendored copy を削除
   for s in browse plan-ceo-review plan-eng-review review ship retro qa setup-browser-cookies; do
     rm -f .claude/skills/$s
   done
   rm -rf .claude/skills/gstack
   rm -rf .claude/skills/gstack/.git

   # global install から copy（.git は含めず vendor のままにする）
   cp -Rf ~/.claude/skills/gstack .claude/skills/gstack

   # binary を rebuild し、skill symlinks を作り直す
   cd .claude/skills/gstack && ./setup
   ```

3. **変更をテストする** — その project で Claude Code を開き、skills を使います。

あとで main に戻したい場合は、`git checkout origin/<branch>` の代わりに `git checkout main && git pull` を使って手順 1-2 を繰り返してください。

## Shipping your changes

skill の編集に満足したら:

```bash
/ship
```

これで tests を実行し、diff を review し、Greptile comments を triage し（2-tier escalation 付き）、TODOS.md を管理し、version を bump して PR を開きます。詳細な workflow は `ship/SKILL.md` を参照してください。
