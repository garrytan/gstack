# Architecture

この document は、gstack が **なぜ** この形で作られているのかを説明します。setup と commands については CLAUDE.md、contributing については CONTRIBUTING.md を参照してください。

## The core idea

gstack は Claude Code に persistent browser と、思想のはっきりした workflow skills を与えます。難しいのは browser 側で、それ以外はすべて Markdown です。

重要な洞察はこうです。browser を操作する AI agent には **sub-second latency** と **persistent state** が必要です。command のたびに browser を cold-start すると、tool call ごとに 3-5 秒待たされます。commands の間で browser が落ちると、cookies、tabs、login session も失われます。だから gstack は長寿命の Chromium daemon を動かし、CLI は localhost HTTP 経由でそれと通信します。

```
Claude Code                     gstack
─────────                      ──────
                               ┌──────────────────────┐
  Tool call: $B snapshot -i    │  CLI (compiled binary)│
  ─────────────────────────→   │  • state file を読む   │
                               │  • localhost:PORT に   │
                               │    POST /command      │
                               └──────────┬───────────┘
                                          │ HTTP
                               ┌──────────▼───────────┐
                               │  Server (Bun.serve)   │
                               │  • command を dispatch │
                               │  • Chromium と通信     │
                               │  • plain text を返す   │
                               └──────────┬───────────┘
                                          │ CDP
                               ┌──────────▼───────────┐
                               │  Chromium (headless)   │
                               │  • persistent tabs     │
                               │  • cookies を維持      │
                               │  • 30min idle timeout  │
                               └───────────────────────┘
```

最初の call で全体が起動します（約 3 秒）。それ以降の call は毎回およそ 100-200ms です。

## Why Bun

Node.js でも動きます。ただ、この用途では Bun の方が良い理由が 3 つあります。

1. **Compiled binaries.** `bun build --compile` で単一の約 58MB executable を作れます。runtime に `node_modules` は不要で、`npx` も PATH 設定も要りません。binary をそのまま実行できます。gstack は `~/.claude/skills/` に install され、user はそこを Node.js project として管理したくないので、これは重要です。

2. **Native SQLite.** cookie の decrypt では Chromium の SQLite cookie database を直接読みます。Bun には `new Database()` が built-in であり、`better-sqlite3` も native addon compile も gyp も不要です。machine ごとに壊れる要素が 1 つ減ります。

3. **Native TypeScript.** development 中は server を `bun run server.ts` でそのまま起動できます。compile step も `ts-node` も debug 用の source maps も不要です。compiled binary は deployment 用、source files は development 用です。

4. **Built-in HTTP server.** `Bun.serve()` は高速で単純で、Express や Fastify を必要としません。server が扱う routes は 10 個ほどしかないので、framework は過剰です。

bottleneck は常に Chromium であり、CLI や server ではありません。Bun の startup speed（compiled binary なら約 1ms、Node なら約 100ms）は良い点ですが、採用理由の本丸ではありません。決め手は compiled binary と native SQLite です。

## The daemon model

### Why not start a browser per command?

Playwright は Chromium を約 2-3 秒で launch できます。1 枚 screenshot を撮るだけなら十分です。ただ、20+ commands を含む QA session では、browser startup の overhead だけで 40+ 秒になります。しかも state を command 間で失います。cookies、localStorage、login sessions、open tabs はすべて消えます。

daemon model だと次が得られます。

- **Persistent state.** 一度 login すれば、そのまま login し続けられる。tab を開けば、そのまま残る。localStorage も commands をまたいで維持される。
- **Sub-second commands.** 最初の call のあと、各 command は単なる HTTP POST になる。Chromium の仕事を含めても round-trip は約 100-200ms。
- **Automatic lifecycle.** server は最初の use で自動起動し、30 分 idle すると自動停止する。process 管理は不要。

### State file

server は `.gstack/browse.json` を書き出します（tmp + rename の atomic write、mode 0o600）。

```json
{ "pid": 12345, "port": 34567, "token": "uuid-v4", "startedAt": "...", "binaryVersion": "abc123" }
```

CLI はこの file を読んで server を見つけます。file がない、古い、または PID が死んでいれば、CLI は新しい server を spawn します。

### Port selection

port は 10000-60000 の乱数から選び、衝突したら最大 5 回まで retry します。これにより 10 個の Conductor workspaces が、それぞれ独立した browse daemon を設定なしで動かせます。旧方式のように 9400-9409 を走査すると、multi-workspace 環境で常に衝突していました。

### Version auto-restart

build 時に `git rev-parse HEAD` を `browse/dist/.version` へ書き込みます。CLI は毎回起動時に、自分の version と実行中 server の `binaryVersion` を比較します。一致しなければ旧 server を kill して新しく起動します。これで "stale binary" 系のバグは完全に防げます。binary を rebuild すれば、次の command から自動で新しいものに切り替わります。

## Security model

### Localhost only

HTTP server は `0.0.0.0` ではなく `localhost` に bind します。network からは到達できません。

### Bearer token auth

各 server session は random UUID token を生成し、mode 0o600（owner-only read）で state file に書きます。すべての HTTP request は `Authorization: Bearer <token>` を含む必要があります。token が一致しなければ server は 401 を返します。

これにより、同じ machine 上の別 process があなたの browse server に勝手に話しかけるのを防ぎます。cookie picker UI（`/cookie-picker`）と health check（`/health`）だけは例外で、localhost 限定かつ command 実行を伴わないため token 不要です。

### Cookie security

gstack が扱う中で、cookies はもっとも sensitive な data です。設計は次の通りです。

1. **Keychain access には user approval が必要。** browser ごとの初回 cookie import では macOS Keychain dialog が出ます。user が "Allow" または "Always Allow" を押さなければなりません。gstack が認証情報へ黙ってアクセスすることはありません。

2. **Decrypt は process 内だけで行う。** cookie values は memory 上で decrypt（PBKDF2 + AES-128-CBC）され、Playwright context に読み込まれ、plaintext として disk に書かれません。cookie picker UI に cookie values は表示されず、domain names と counts だけが見えます。

3. **Database は read-only。** gstack は Chromium の cookie DB を temp file へ copy してから開きます。これは起動中 browser の SQLite lock conflict を避けるためです。その file は read-only で開かれ、実 browser の cookie database 自体を変更することはありません。

4. **Key cache は per-session。** Keychain password とそこから導出した AES key は server の lifetime 中だけ memory に cache されます。server が shutdown すると（idle timeout でも explicit stop でも）、cache も消えます。

5. **Logs に cookie value を出さない。** console、network、dialog の logs に cookie values は含めません。`cookies` command が出すのも cookie metadata（domain、name、expiry）であり、values は truncate されます。

### Shell injection prevention

browser registry（Comet、Chrome、Arc、Brave、Edge）は hardcoded です。database paths は user input からではなく、既知の constants から構築されます。Keychain access も shell string interpolation ではなく、明示的な argument arrays を持つ `Bun.spawn()` で行います。

## The ref system

refs（`@e1`、`@e2`、`@c1`）は、agent が CSS selectors や XPath を書かずに page elements を指すための仕組みです。

### How it works

```
1. Agent runs: $B snapshot -i
2. Server calls Playwright's page.accessibility.snapshot()
3. Parser walks the ARIA tree, assigns sequential refs: @e1, @e2, @e3...
4. For each ref, builds a Playwright Locator: getByRole(role, { name }).nth(index)
5. Stores Map<string, Locator> on the BrowserManager instance
6. Returns the annotated tree as plain text

Later:
7. Agent runs: $B click @e3
8. Server resolves @e3 → Locator → locator.click()
```

### Why Locators, not DOM mutation

もっとも単純なのは、DOM に `data-ref="@e1"` attributes を inject する方法です。しかしこれは次の理由で破綻します。

- **CSP (Content Security Policy).** 多くの production site は script からの DOM modification を block します。
- **React/Vue/Svelte hydration.** framework の reconciliation で inject した attributes が消えることがあります。
- **Shadow DOM.** 外側から shadow roots の中へ届きません。

Playwright Locators は DOM の外側にあります。Chromium が内部で維持する accessibility tree と `getByRole()` queries を使うので、DOM mutation が不要です。CSP の影響もなく、framework とも衝突しません。

### Ref lifecycle

refs は navigation 時に消去されます（main frame の `framenavigated` event）。これは正しい挙動です。navigation 後は、すべての locators が stale になります。agent は fresh な refs を得るため、再び `snapshot` を走らせる必要があります。これは意図的です。stale refs は静かに誤クリックするのではなく、はっきり fail すべきです。

### Cursor-interactive refs (`@c`)

`-C` flag は、ARIA tree に出てこないが clickable な elements を見つけます。`cursor: pointer` で style されたもの、`onclick` attributes を持つもの、custom `tabindex` を持つものなどです。これらには別 namespace として `@c1`、`@c2` の refs が振られます。framework が実際には button なのに `<div>` として render する custom components を捕まえるためです。

## Logging architecture

3 つの ring buffers（各 50,000 entries、O(1) push）を持ちます。

```
Browser events → CircularBuffer (in-memory) → Async flush to .gstack/*.log
```

console messages、network requests、dialog events はそれぞれ独立した buffer を持ちます。flush は 1 秒ごとに行われ、server は前回以降の新しい entries だけを append します。これにより:

- HTTP request handling が disk I/O で block されない
- server crash 時も logs が残る（最大 1 秒分だけ data loss）
- memory 使用量が上限付きで済む（50K entries × 3 buffers）
- disk files は append-only なので外部 tools から読みやすい

`console`、`network`、`dialog` commands は disk ではなく in-memory buffers から読みます。disk files は post-mortem debugging 用です。

## SKILL.md template system

### The problem

SKILL.md files は、Claude に browse commands の使い方を教える docs です。存在しない flag が docs に載っていたり、新しく追加した command が docs に載っていなかったりすると、agent はすぐ errors にぶつかります。手で保守する docs は、必ず code とずれていきます。

### The solution

```
SKILL.md.tmpl          (人が書く prose + placeholders)
       ↓
gen-skill-docs.ts      (source code metadata を読む)
       ↓
SKILL.md               (commit される auto-generated sections)
```

templates には、workflow、tips、examples のように人の判断が必要な部分を書きます。`{{COMMAND_REFERENCE}}` と `{{SNAPSHOT_FLAGS}}` placeholders は build 時に `commands.ts` と `snapshot.ts` から埋められます。これは構造的に強いです。code に command が存在すれば docs に現れ、存在しなければ docs に現れません。

### Why committed, not generated at runtime?

理由は 3 つあります。

1. **Claude は skill load 時に SKILL.md を読む。** user が `/browse` を呼んだときに build step は存在しません。file はあらかじめ存在し、正しい必要があります。
2. **CI で freshness を検証できる。** `gen:skill-docs --dry-run` と `git diff --exit-code` によって stale docs を merge 前に検出できます。
3. **Git blame が効く。** command がいつ追加され、どの commit で入ったかを追えます。

### Template test tiers

| Tier | 内容 | Cost | Speed |
|------|------|------|-------|
| 1 — Static validation | SKILL.md 内のすべての `$B` command を parse し、registry に対して検証 | Free | <2s |
| 2 — E2E via `claude -p` | 実際の Claude session を起動し、各 skill を実行して errors を確認 | ~$3.85 | ~20min |
| 3 — LLM-as-judge | Sonnet が docs の clarity/completeness/actionability を採点 | ~$0.15 | ~30s |

Tier 1 は毎回 `bun test` で走ります。Tier 2+3 は `EVALS=1` で gate されます。考え方は単純で、95% の問題は無料で潰し、LLMs は judgment call と統合確認にだけ使う、ということです。

## Command dispatch

commands は side effects ごとに分類されています。

- **READ** (`text`、`html`、`links`、`console`、`cookies`、...): mutation なし。retry しても安全。page state を返す。
- **WRITE** (`goto`、`click`、`fill`、`press`、...): page state を mutate する。idempotent ではない。
- **META** (`snapshot`、`screenshot`、`tabs`、`chain`、...): read/write にきれいに収まらない server-level operations。

これは単なる整理ではありません。server は dispatch にこの分類を使います。

```typescript
if (READ_COMMANDS.has(cmd))  → handleReadCommand(cmd, args, bm)
if (WRITE_COMMANDS.has(cmd)) → handleWriteCommand(cmd, args, bm)
if (META_COMMANDS.has(cmd))  → handleMetaCommand(cmd, args, bm, shutdown)
```

`help` command は 3 つの set を全部返すので、agent は available commands を自力で見つけられます。

## Error philosophy

errors の相手は人間ではなく AI agents です。すべての error message は、次にどうすればよいかが分かる必要があります。

- "Element not found" → "Element not found or not interactable. Run `snapshot -i` to see available elements."
- "Selector matched multiple elements" → "Selector matched multiple elements. Use @refs from `snapshot` instead."
- Timeout → "Navigation timed out after 30s. The page may be slow or the URL may be wrong."

Playwright の native errors は `wrapError()` を通して書き換え、内部 stack traces を落とし、guidance を加えます。agent は error を読めば、人間の介入なしに次の一手が分かるべきです。

### Crash recovery

server は self-heal を試みません。Chromium が crash したら（`browser.on('disconnected')`）、server は即座に exit します。CLI は次の command で server が死んでいることを検出し、自動 restart します。半死状態の browser process へ reconnect しようとするより、この方が単純で信頼できます。

## E2E test infrastructure

### Session runner (`test/helpers/session-runner.ts`)

E2E tests は `claude -p` を、完全に独立した subprocess として spawn します。Agent SDK 経由ではありません。Claude Code session の内側へさらにネストできないからです。runner は次を行います。

1. prompt を temp file に書く（shell escaping の問題を避けるため）
2. `sh -c 'cat prompt | claude -p --output-format stream-json --verbose'` を spawn する
3. real-time progress のために stdout から NDJSON を stream する
4. configurable timeout と race させる
5. 完全な NDJSON transcript を parse して structured results にする

`parseNDJSON()` function は pure です。I/O も side effects もないので、単独で test できます。

### Observability data flow

```
  skill-e2e.test.ts
        │
        │ runId を生成し、各 call に testName + runId を渡す
        │
  ┌─────┼──────────────────────────────┐
  │     │                              │
  │  runSkillTest()              evalCollector
  │  (session-runner.ts)         (eval-store.ts)
  │     │                              │
  │  per tool call:              per addTest():
  │  ┌──┼──────────┐              savePartial()
  │  │  │          │                   │
  │  ▼  ▼          ▼                   ▼
  │ [HB] [PL]    [NJ]          _partial-e2e.json
  │  │    │        │             (atomic overwrite)
  │  │    │        │
  │  ▼    ▼        ▼
  │ e2e-  prog-  {name}
  │ live  ress   .ndjson
  │ .json .log
  │
  │  on failure:
  │  {name}-failure.json
  │
  │  ALL files in ~/.gstack-dev/
  │  Run dir: e2e-runs/{runId}/
  │
  │         eval-watch.ts
  │              │
  │        ┌─────┴─────┐
  │     read HB     read partial
  │        └─────┬─────┘
  │              ▼
  │        render dashboard
  │        (stale >10min? warn)
```

**Ownership の分離:** session-runner は heartbeat（現在の test state）を持ち、eval-store は partial results（完了済み test state）を持ちます。watcher はその両方を読みます。どちらも互いを知りません。共有するのは filesystem 上の data だけです。

**すべて non-fatal:** observability の I/O はすべて try/catch で包まれています。write failure が test failure の原因になることはありません。source of truth はあくまで tests 本体で、observability は best-effort です。

**Machine-readable diagnostics:** 各 test result には `exit_reason`（success、timeout、error_max_turns、error_api、exit_code_N）、`timeout_at_turn`、`last_tool_call` が入ります。これにより次のような `jq` query が可能です。

```bash
jq '.tests[] | select(.exit_reason == "timeout") | .last_tool_call' ~/.gstack-dev/evals/_partial-e2e.json
```

### Eval persistence (`test/helpers/eval-store.ts`)

`EvalCollector` は test results を集め、2 通りで書き出します。

1. **Incremental:** `savePartial()` は各 test のたびに `_partial-e2e.json` を書きます（atomic: `.tmp` に書いて `fs.renameSync`）。途中 kill されても残ります。
2. **Final:** `finalize()` は timestamp 付き eval file（例: `e2e-20260314-143022.json`）を書きます。partial file は消しません。observability のため final file と並んで残します。

`eval:compare` は 2 つの eval runs を diff します。`eval:summary` は `~/.gstack-dev/evals/` にある全 runs の stats を集計します。

### Test tiers

| Tier | 内容 | Cost | Speed |
|------|------|------|-------|
| 1 — Static validation | `$B` commands の parse、registry に対する validation、observability unit tests | Free | <5s |
| 2 — E2E via `claude -p` | 実際の Claude session を起動し、各 skill を実行して errors を走査 | ~$3.85 | ~20min |
| 3 — LLM-as-judge | Sonnet が docs の clarity/completeness/actionability を採点 | ~$0.15 | ~30s |

Tier 1 は毎回 `bun test` で走ります。Tier 2+3 は `EVALS=1` で gate されます。考え方は同じで、95% の問題は無料で潰し、LLMs は judgment call と integration testing にだけ使います。

## What's intentionally not here

- **WebSocket streaming は入れていない。** HTTP request/response の方が単純で、curl でも debug でき、十分に速いからです。streaming を入れる複雑さに対して得られる利得は小さいです。
- **MCP protocol は使っていない。** MCP は request ごとに JSON schema overhead があり、persistent connection も要求します。plain HTTP + plain text output の方が token 的に軽く、debug しやすいです。
- **Multi-user support はない。** workspace ごとに server 1 つ、user 1 人です。token auth は multi-tenancy のためではなく defense-in-depth です。
- **Windows/Linux の cookie decryption は未対応。** 対応している credential store は macOS Keychain のみです。Linux（GNOME Keyring/kwallet）や Windows（DPAPI）も architecture 上は可能ですが、未実装です。
- **iframe support はない。** Playwright 自体は iframes を扱えますが、ref system はまだ frame boundary をまたげません。これが現在もっとも要望の多い未対応機能です。
