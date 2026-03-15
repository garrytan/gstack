# Changelog

## 0.3.9 — 2026-03-15

### 追加
- **`bin/gstack-config` CLI** — `~/.gstack/config.yaml` 用のシンプルな get/set/list interface。永続設定（`auto_upgrade`, `update_check`）のために update-check と upgrade skill が利用します。
- **Smart update check** — cache TTL を 12 時間に短縮（従来は 24 時間）。ユーザーが upgrade を見送ったときは snooze を指数的に延長（24h → 48h → 1 week）します。check を完全に無効化する `update_check: false` config option も追加しました。新しい version が出ると snooze はリセットされます。
- **Auto-upgrade mode** — config に `auto_upgrade: true` を設定するか、env var `GSTACK_AUTO_UPGRADE=1` を指定すると、upgrade prompt を出さずに自動更新します。
- **4-option upgrade prompt** — "Yes, upgrade now"、"Always keep me up to date"、"Not now"（snooze）、"Never ask again"（無効化）の 4 択を追加しました。
- **Vendored copy sync** — `/gstack-upgrade` が primary install の upgrade 後に、現在の project 内にある vendored copy も検出して更新するようになりました。
- 新規テスト 25 件: gstack-config CLI 用 11 件、update-check の snooze/config path 用 14 件。

### 変更
- README の upgrade / troubleshooting section を簡素化し、長い貼り付け command の代わりに `/gstack-upgrade` を参照する形にしました。
- Upgrade skill template を v1.1.0 に更新し、config 編集用の `Write` tool permission を追加しました。
- すべての SKILL.md preamble を、新しい upgrade flow の説明に更新しました。

## 0.3.8 — 2026-03-14

### 追加
- **TODOS.md as single source of truth** — `TODO.md`（roadmap）と `TODOS.md`（近い予定）を 1 つの file に統合し、skill/component ごと・P0-P4 の優先度順・Completed section 付きで整理しました。
- **`/ship` Step 5.5: TODOS.md management** — diff から完了済み item を自動検出し、version 注記付きで完了扱いにし、`TODOS.md` がない、または構造化されていない場合は作成や再整理を提案します。
- **Cross-skill TODOS awareness** — `/plan-ceo-review`、`/plan-eng-review`、`/retro`、`/review`、`/qa` が project context のために `TODOS.md` を読むようになりました。`/retro` には Backlog Health metric（open 件数、P0/P1 item、churn）も追加しました。
- **Shared `review/TODOS-format.md`** — `/ship` と `/plan-ceo-review` が参照する canonical な TODO item format を追加し、format drift を防ぎます（DRY）。
- **Greptile 2-tier reply system** — 初回返信では Tier 1（柔らかめ、inline diff + explanation）、過去に返信済みの thread で再度 Greptile が flag を立てた場合は Tier 2（強め、完全な evidence chain + re-rank request）を使います。
- **Greptile reply templates** — `greptile-triage.md` に、修正済み（inline diff）、既に修正済み（何をしたか）、false positive（evidence + suggested re-rank）向けの構造化 template を追加しました。曖昧な 1 行返信を置き換えます。
- **Greptile escalation detection** — comment thread 上の過去の GStack reply を検出し、自動で Tier 2 に escalation する明示的な algorithm を追加しました。
- **Greptile severity re-ranking** — Greptile が issue の severity を誤分類した場合、reply に `**Suggested re-rank:**` を含めるようになりました。
- skill 間での `TODOS-format.md` 参照を確認する static validation test を追加しました。

### 修正
- **`.gitignore` append failure が黙って握りつぶされる問題** — `ensureStateDir()` の裸の `catch {}` をやめ、ENOENT のみ黙殺し、非 ENOENT error（EACCES、ENOSPC）は `.gstack/browse-server.log` に記録するようにしました。

### 変更
- `TODO.md` を削除し、すべての item を `TODOS.md` に統合しました。
- `/ship` Step 3.75 と `/review` Step 5 は、`greptile-triage.md` の reply template と escalation detection を参照するようになりました。
- `/ship` Step 6 の commit 順序に、VERSION + CHANGELOG と並んで `TODOS.md` を含めました。
- `/ship` Step 8 の PR body に TODOS section を追加しました。

## 0.3.7 — 2026-03-14

### 追加
- **Screenshot element/region clipping** — `screenshot` command が、CSS selector または @ref による要素切り抜き（`screenshot "#hero" out.png`, `screenshot @e3 out.png`）、領域切り抜き（`screenshot --clip x,y,w,h out.png`）、viewport のみの mode（`screenshot --viewport out.png`）に対応しました。Playwright native の `locator.screenshot()` と `page.screenshot({ clip })` を使います。full page は既定のままです。
- すべての screenshot mode（viewport、CSS、@ref、clip）と error path（未知の flag、排他制約、無効な座標、path validation、存在しない selector）を covering する新規テスト 10 件。

## 0.3.6 — 2026-03-14

### 追加
- **E2E observability** — heartbeat file（`~/.gstack-dev/e2e-live.json`）、run ごとの log directory（`~/.gstack-dev/e2e-runs/{runId}/`）、`progress.log`、test ごとの NDJSON transcript、永続 failure transcript を追加しました。すべての I/O は non-fatal です。
- **`bun run eval:watch`** — live terminal dashboard が 1 秒ごとに heartbeat と partial eval file を読みます。完了済み test 数、現在の test の turn/tool 情報、stale detection（>10 分）、`progress.log` 用の `--tail` を表示します。
- **Incremental eval saves** — 各 test 完了後に `savePartial()` が `_partial-e2e.json` を書き出します。crash に強く、途中結果は process が kill されても残ります。cleanup はしません。
- **Machine-readable diagnostics** — eval JSON に `exit_reason`、`timeout_at_turn`、`last_tool_call` field を追加しました。自動修復 loop で `jq` query を使えるようにします。
- **API connectivity pre-check** — E2E suite が test budget を消費する前に、ConnectionRefused を即座に投げるようにしました。
- **`is_error` detection** — `claude -p` は API failure 時に `subtype: "success"` と `is_error: true` を返すことがあります。これを正しく `error_api` として分類するようにしました。
- **Stream-json NDJSON parser** — `claude -p --output-format stream-json --verbose` の real-time E2E progress を処理する pure function `parseNDJSON()` を追加しました。
- **Eval persistence** — 結果を `~/.gstack-dev/evals/` に保存し、前回 run との差分を自動比較するようにしました。
- **Eval CLI tools** — eval 履歴を確認する `eval:list`、`eval:compare`、`eval:summary` を追加しました。
- **All 9 skills converted to `.tmpl` templates** — plan-ceo-review、plan-eng-review、retro、review、ship が `{{UPDATE_CHECK}}` placeholder を使うようになりました。update check preamble の single source of truth です。
- **3-tier eval suite** — Tier 1: static validation（無料）、Tier 2: `claude -p` 経由の E2E（~$3.85/run）、Tier 3: LLM-as-judge（~$0.15/run）。`EVALS=1` で有効になります。
- **Planted-bug outcome testing** — 既知の bug を入れた eval fixture を追加し、LLM judge が検出を採点します。
- observability の unit test 15 件。heartbeat schema、`progress.log` format、NDJSON naming、`savePartial`、`finalize`、watcher rendering、stale detection、non-fatal I/O を対象にしています。
- plan-ceo-review、plan-eng-review、retro skill 用の E2E test。
- update-check の exit code regression test。
- `test/helpers/skill-parser.ts` — git remote 検出用の `getRemoteSlug()` を追加。

### 修正
- **Browse binary discovery broken for agents** — SKILL.md の setup block で、`find-browse` の間接参照をやめ、明示的な `browse/dist/browse` path に置き換えました。
- **Update check exit code 1 misleading agents** — update がない場合でも non-zero exit にならないよう `|| true` を追加しました。
- **browse/SKILL.md missing setup block** — `{{BROWSE_SETUP}}` placeholder を追加しました。
- **plan-ceo-review timeout** — test directory で git repo を初期化し、codebase exploration を skip し、timeout を 420 秒に伸ばしました。
- planted-bug eval の安定性 — prompt を簡素化し、検出 baseline を下げ、`max_turns` の flake に耐えるようにしました。

### 変更
- **Template system expanded** — `gen-skill-docs.ts` に `{{UPDATE_CHECK}}` と `{{BROWSE_SETUP}}` placeholder を追加しました。browse を使うすべての skill が single source of truth から生成されます。
- 14 個の command description を強化し、具体的な arg format、有効値、error behavior、return type を含めました。
- setup block は workspace-local path を先に確認し（development 用）、なければ global install に fallback するようにしました。
- LLM eval judge を Haiku から Sonnet 4.6 に上げました。
- `generateHelpText()` を `COMMAND_DESCRIPTIONS` から自動生成するようにし、手書きの help text を置き換えました。

## 0.3.3 — 2026-03-13

### 追加
- **SKILL.md template system** — `.tmpl` file に `{{COMMAND_REFERENCE}}` と `{{SNAPSHOT_FLAGS}}` placeholder を導入し、build 時に source code から自動生成するようにしました。構造的に docs と code の command drift を防ぎます。
- **Command registry** (`browse/src/commands.ts`) — category と強化された説明付きで、すべての browse command をまとめた single source of truth。副作用はなく、build script や test から安全に import できます。
- **Snapshot flags metadata**（`browse/src/snapshot.ts` の `SNAPSHOT_FLAGS` array） — hand-coded の switch/case を metadata-driven parser に置き換えました。1 か所で flag を追加すれば、parser、docs、tests が一緒に更新されます。
- **Tier 1 static validation** — 43 test。SKILL.md の code block から `$B` command を parse し、command registry と snapshot flag metadata に照らして validate します。
- **Tier 2 E2E tests** via Agent SDK — 実際の Claude session を起動し、skill を実行し、browse error を走査します。`SKILL_E2E=1` env var で有効（~$0.50/run）。
- **Tier 3 LLM-as-judge evals** — Haiku が生成 docs の明瞭さ・完全性・実行可能性を採点（閾値は 4/5 以上）し、手書き baseline との regression test も行います。`ANTHROPIC_API_KEY` で有効です。
- **`bun run skill:check`** — すべての skill、command 数、validation 状態、template freshness を表示する health dashboard。
- **`bun run dev:skill`** — template または source file が変わるたびに SKILL.md を再生成し validate する watch mode。
- **CI workflow**（`.github/workflows/skill-docs.yml`） — push/PR 時に `gen:skill-docs` を実行し、生成結果が commit 済み file と異なれば fail します。
- 手動再生成用の `bun run gen:skill-docs` script。
- LLM-as-judge evals 用の `bun run test:eval`。
- `test/helpers/skill-parser.ts` — Markdown から `$B` command を抽出して validate します。
- `test/helpers/session-runner.ts` — error pattern scan と transcript 保存を備えた Agent SDK wrapper。
- **ARCHITECTURE.md** — daemon model、security、ref system、logging、crash recovery に関する設計判断のドキュメント。
- **Conductor integration**（`conductor.json`） — workspace setup/teardown の lifecycle hook。
- **`.env` propagation** — `bin/dev-setup` が main worktree から Conductor workspace へ `.env` を自動コピーするようにしました。
- API key 設定用の `.env.example` template。

### 変更
- build が binary compile 前に `gen:skill-docs` を実行するようになりました。
- `parseSnapshotArgs` を metadata-driven に変更し、switch/case ではなく `SNAPSHOT_FLAGS` を走査するようにしました。
- `server.ts` は command set を inline 定義せず、`commands.ts` から import するようにしました。
- SKILL.md と browse/SKILL.md は生成 file になりました（編集は `.tmpl` 側で行います）。

## 0.3.2 — 2026-03-13

### 修正
- Cookie import picker が HTML ではなく JSON を返すように修正 — `jsonResponse()` が scope 外の `url` を参照しており、すべての API call が crash していました。
- `help` command を正しく routing するよう修正（`META_COMMANDS` の dispatch 順のせいで到達不能だった）。
- global install の stale server が local change を覆い隠さないように、`resolveServerScript()` から legacy な `~/.claude/skills/gstack` fallback を削除しました。
- crash log の path 参照を `/tmp/` から `.gstack/` に更新しました。

### 追加
- **Diff-aware QA mode** — feature branch 上の `/qa` が `git diff` を自動解析し、影響を受ける page/route を特定し、localhost 上の実行中 app を検出し、変更があった部分だけを test します。URL は不要です。
- **Project-local browse state** — state file、log、その他すべての server state を project root 内の `.gstack/` に置くようにしました（`git rev-parse --show-toplevel` で検出）。`/tmp` の state file はもう使いません。
- **Shared config module** (`browse/src/config.ts`) — CLI と server の path 解決を一元化し、重複していた port/state logic をなくしました。
- **Random port selection** — server は 9400-9409 を scan せず、10000-60000 のランダムな port を選びます。`CONDUCTOR_PORT` magic offset も不要になり、workspace 間の port collision も避けられます。
- **Binary version tracking** — state file に `binaryVersion` SHA を持たせ、binary が rebuild されたら CLI が server を自動再起動するようにしました。
- **Legacy /tmp cleanup** — CLI が古い `/tmp/browse-server*.json` file を scan して削除します。signal を送る前に PID ownership も確認します。
- **Greptile integration** — `/review` と `/ship` が Greptile bot comment を取得して triage し、`/retro` が週ごとの Greptile batting average を追跡します。
- **Local dev mode** — `bin/dev-setup` が repo から skill を symlink し、その場で開発できるようにしました。`bin/dev-teardown` は global install を復元します。
- `help` command — agent が自力で全 command と snapshot flag を発見できるようにしました。
- META signal protocol を使った version-aware `find-browse` — stale binary を検出し、agent に update を促します。
- `origin/main` との git SHA 比較を行うコンパイル済み `browse/dist/find-browse` binary（4 時間 cache）。
- binary version tracking 用に build 時に `.version` file を書き出します。
- cookie picker の route-level test（13 件）と find-browse の version check test（10 件）。
- config 解決の test（14 件）。git root 検出、`BROWSE_STATE_FILE` override、`ensureStateDir`、`readVersionHash`、`resolveServerScript`、version mismatch 検知をカバーします。
- CLAUDE.md に browser 操作ガイドを追加し、Claude が `mcp__claude-in-chrome__*` tool を使わないようにしました。
- quick start、dev mode の説明、他 repo の branch を test する手順を含む CONTRIBUTING.md。

### 変更
- state file の場所を `.gstack/browse.json` に変更（従来は `/tmp/browse-server.json`）。
- log file の場所を `.gstack/browse-{console,network,dialog}.log` に変更（従来は `/tmp/browse-*.log`）。
- state file 書き込みを atomic 化し、`.json.tmp` に書いてから rename するようにしました（partial read を防ぎます）。
- CLI は spawn した server に `BROWSE_STATE_FILE` を渡すようになりました（server 側はここから全 path を導出します）。
- SKILL.md の setup check は META signal を parse し、`META:UPDATE_AVAILABLE` を処理するようになりました。
- `/qa` SKILL.md は 4 mode（diff-aware、full、quick、regression）を説明し、feature branch では diff-aware を既定にしました。
- `jsonResponse` / `errorResponse` は positional parameter の取り違えを防ぐため、options object を使うようにしました。
- build script は `browse` と `find-browse` の両 binary を compile し、`.bun-build` の temp file を cleanup します。
- README を更新し、Greptile setup 手順、diff-aware QA 例、修正版 demo transcript を追加しました。

### 削除
- `CONDUCTOR_PORT` の magic offset（`browse_port = CONDUCTOR_PORT - 45600`）
- 9400-9409 の port scan range
- `~/.claude/skills/gstack/browse/src/server.ts` への legacy fallback
- `DEVELOPING_GSTACK.md`（CONTRIBUTING.md に改名）

## 0.3.1 — 2026-03-12

### Phase 3.5: Browser cookie import

- `cookie-import-browser` command — 実際の Chromium browser（Comet、Chrome、Arc、Brave、Edge）から cookie を復号して import
- browse server が提供する対話式 cookie picker web UI（dark theme、2 ペイン layout、domain search、import/remove）
- 非対話利用向けに `--domain` flag を使った直接 CLI import
- Claude Code integration 用の `/setup-browser-cookies` skill
- macOS Keychain への非同期 10 秒 timeout 付き access（event loop を block しない）
- browser ごとの AES key cache（browser ごと・session ごとに 1 回だけ Keychain prompt）
- DB lock fallback: lock された cookie DB を安全に読むため `/tmp` へコピー
- 暗号化された cookie fixture を使う unit test 18 件

## 0.3.0 — 2026-03-12

### Phase 3: /qa skill — systematic QA testing

- 6 phase workflow（Initialize、Authenticate、Orient、Explore、Document、Wrap up）を持つ新しい `/qa` skill
- 3 mode: full（体系的、5-10 issue）、quick（30 秒 smoke test）、regression（baseline と比較）
- 7 category、4 severity level、page ごとの exploration checklist からなる issue taxonomy
- health score（0-100、7 category で重み付け）付きの構造化 report template
- Next.js、Rails、WordPress、SPA 向け framework detection guidance
- `git rev-parse --show-toplevel` を使った DRY な binary discovery `browse/bin/find-browse`

### Phase 2: Enhanced browser

- dialog handling: auto-accept/dismiss、dialog buffer、prompt text 対応
- file upload: `upload <sel> <file1> [file2...]`
- 要素状態の確認: `is visible|hidden|enabled|disabled|checked|editable|focused <sel>`
- ref label を重ねた annotated screenshot（`snapshot -a`）
- 前回 snapshot との差分表示（`snapshot -D`）
- ARIA に出ない clickable 要素を拾う cursor-interactive element scan（`snapshot -C`）
- `wait --networkidle` / `--load` / `--domcontentloaded` flag
- `console --errors` filter（error + warning のみ）
- page URL から domain を自動補完する `cookie-import <json-file>`
- console/network/dialog buffer 用の CircularBuffer O(1) ring buffer
- `Bun.write()` による非同期 buffer flush
- `page.evaluate` + 2 秒 timeout による health check
- AI agent 向けの実用的な Playwright error wrapping
- context 再生成時にも cookie/storage/URL を保持（useragent fix）
- 10 個の workflow pattern を備えた QA 指向 playbook へ SKILL.md を刷新
- 統合テスト 166 件（従来は約 63 件）

## 0.0.2 — 2026-03-12

- project-local の `/browse` install を修正 — コンパイル済み binary が global install を前提にせず、自身の directory から `server.ts` を解決するようになりました
- `setup` は stale binary も rebuild し、build failure 時には non-zero で終了するようにしました
- `chain` command が write command の実際の error を飲み込む問題を修正（例: navigation timeout が "Unknown meta command" と誤報される）
- 同じ command で server が繰り返し crash したときの無限 restart loop を修正
- console/network buffer を上限 50k entry の ring buffer に変更し、無限に増えないようにした
- buffer が 50k 上限に達した後、disk flush が黙って止まる問題を修正
- upgrade 時に入れ子 symlink を作らないよう、setup の `ln -snf` を修正
- upgrade では `git pull` ではなく `git fetch && git reset --hard` を使うようにした（force-push に対応）
- install を簡素化し、global-first + 任意の project copy にした（submodule approach を置き換え）
- README を再構成し、hero、before/after、demo transcript、troubleshooting section を追加
- skill は 6 個（`/retro` を追加）

## 0.0.1 — 2026-03-11

Initial release.

- skill は 5 個: `/plan-ceo-review`、`/plan-eng-review`、`/review`、`/ship`、`/browse`
- 40 個以上の command、ref ベース操作、永続 Chromium daemon を備えた headless browser CLI
- Claude Code skill として 1 command で install（submodule または global clone）
- binary compile と skill symlink を行う `setup` script
