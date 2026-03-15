# Browser  技術詳細

このドキュメントでは、gstack の headless browser に関するコマンドリファレンスと内部実装を説明します。

## コマンドリファレンス

| Category | Commands | 用途 |
|----------|----------|------|
| Navigate | `goto`, `back`, `forward`, `reload`, `url` | ページへ移動する |
| Read | `text`, `html`, `links`, `forms`, `accessibility` | コンテンツを抽出する |
| Snapshot | `snapshot [-i] [-c] [-d N] [-s sel] [-D] [-a] [-o] [-C]` | ref の取得、差分確認、注釈付け |
| Interact | `click`, `fill`, `select`, `hover`, `type`, `press`, `scroll`, `wait`, `viewport`, `upload` | ページを操作する |
| Inspect | `js`, `eval`, `css`, `attrs`, `is`, `console`, `network`, `dialog`, `cookies`, `storage`, `perf` | デバッグと検証を行う |
| Visual | `screenshot [--viewport] [--clip x,y,w,h] [sel\|@ref] [path]`, `pdf`, `responsive` | Claude が見ている内容を確認する |
| Compare | `diff <url1> <url2>` | 環境間の差分を見つける |
| Dialogs | `dialog-accept [text]`, `dialog-dismiss` | alert/confirm/prompt の挙動を制御する |
| Tabs | `tabs`, `tab`, `newtab`, `closetab` | 複数ページのワークフローを扱う |
| Cookies | `cookie-import`, `cookie-import-browser` | ファイルまたは実ブラウザから cookie を取り込む |
| Multi-step | `chain` (JSON from stdin) | 複数コマンドを 1 回で実行する |

すべての selector 引数は、CSS selector、`snapshot` 実行後の `@e` ref、または `snapshot -C` 実行後の `@c` ref を受け付けます。cookie import を含めて、コマンドは合計 50 個以上あります。

## 仕組み

gstack の browser は、永続化されたローカルの Chromium daemon と HTTP で通信するコンパイル済み CLI binary です。CLI は薄い client で、state file を読み込み、command を送信し、応答を stdout に出力します。実際の処理は server 側が [Playwright](https://playwright.dev/) を使って行います。

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code                                                    │
│                                                                 │
│  "browse goto https://staging.myapp.com"                        │
│       │                                                         │
│       ▼                                                         │
│  ┌──────────┐    HTTP POST     ┌──────────────┐                 │
│  │ browse   │ ──────────────── │ Bun HTTP     │                 │
│  │ CLI      │  localhost:rand  │ server       │                 │
│  │          │  Bearer token    │              │                 │
│  │ compiled │ ◄──────────────  │  Playwright  │──── Chromium    │
│  │ binary   │  plain text      │  API calls   │    (headless)   │
│  └──────────┘                  └──────────────┘                 │
│   ~1ms startup                  persistent daemon               │
│                                 auto-starts on first call       │
│                                 auto-stops after 30 min idle    │
└─────────────────────────────────────────────────────────────────┘
```

### Lifecycle

1. **初回呼び出し**: CLI は実行中の server を探すために `.gstack/browse.json`（project root 内）を確認します。見つからなければ、`bun run browse/src/server.ts` をバックグラウンドで起動します。server は Playwright 経由で headless Chromium を立ち上げ、ランダムな port（10000-60000）を選び、bearer token を生成し、state file を書き込み、HTTP request の受付を開始します。ここには約 3 秒かかります。

2. **2 回目以降の呼び出し**: CLI は state file を読み込み、bearer token 付きで HTTP POST を送り、response を表示します。round trip は約 100-200ms です。

3. **Idle shutdown**: 30 分間 command が来なければ server は停止し、state file も片付けます。次の呼び出し時に自動で再起動します。

4. **Crash recovery**: Chromium が crash すると server は即座に終了します。自己修復は行いません。失敗を隠さないためです。CLI は次の呼び出し時に server が死んでいることを検知し、新しく起動し直します。

### 主なコンポーネント

```
browse/
├── src/
│   ├── cli.ts              # 薄い client  state file を読み、HTTP を送り、応答を表示する
│   ├── server.ts           # Bun.serve HTTP server  command を Playwright に振り分ける
│   ├── browser-manager.ts  # Chromium の lifecycle  起動、tab、ref map、crash handling
│   ├── snapshot.ts         # Accessibility tree → @ref 割り当て → Locator map + diff/annotate/-C
│   ├── read-commands.ts    # 非破壊 command 群 (text, html, links, js, css, is, dialog など)
│   ├── write-commands.ts   # 変更系 command 群 (click, fill, select, upload, dialog-accept など)
│   ├── meta-commands.ts    # server 管理、chain、diff、snapshot の振り分け
│   ├── cookie-import-browser.ts  # 実ブラウザから cookie を復号して取り込む
│   ├── cookie-picker-routes.ts   # 対話式 cookie picker UI 用の HTTP route
│   ├── cookie-picker-ui.ts       # cookie picker 用の自己完結した HTML/CSS/JS
│   └── buffers.ts          # CircularBuffer<T> + console/network/dialog の capture
├── test/                   # 統合テスト + HTML fixture
└── dist/
    └── browse              # コンパイル済み binary (~58MB, Bun --compile)
```

### snapshot system

browser の中核となる工夫は、Playwright の accessibility tree API を土台にした ref ベースの要素選択です。

1. `page.locator(scope).ariaSnapshot()` が YAML 風の accessibility tree を返す
2. snapshot parser が各要素に ref（`@e1`, `@e2`, ...）を割り当てる
3. 各 ref に対して Playwright `Locator`（`getByRole` + nth-child を使用）を構築する
4. ref-to-Locator map を `BrowserManager` に保存する
5. その後の `click @e3` のような command では Locator を引き当てて `locator.click()` を呼ぶ

DOM は変更しません。script を注入もしません。使うのは Playwright の native な accessibility API だけです。

**snapshot の拡張機能:**
- `--diff` (`-D`): 各 snapshot を baseline として保存し、次回の `-D` 呼び出し時に変更点の unified diff を返します。action（click、fill など）が本当に効いたかの確認に使います。
- `--annotate` (`-a`): 各 ref の bounding box に一時的な overlay div を入れ、ref label が見える状態で screenshot を撮ってから overlay を削除します。出力先は `-o <path>` で指定できます。
- `--cursor-interactive` (`-C`): `page.evaluate` を使って、ARIA には出てこない interactive 要素（`cursor:pointer`、`onclick`、`tabindex>=0` を持つ div など）を走査します。`@c1`, `@c2`... の ref を振り、再現性のある `nth-child` CSS selector を割り当てます。ARIA tree では拾えないがユーザーは click できる要素を扱うための機能です。

### screenshot mode

`screenshot` command は 4 つの mode を持ちます。

| Mode | Syntax | Playwright API |
|------|--------|----------------|
| Full page（既定） | `screenshot [path]` | `page.screenshot({ fullPage: true })` |
| Viewport のみ | `screenshot --viewport [path]` | `page.screenshot({ fullPage: false })` |
| 要素の切り抜き | `screenshot "#sel" [path]` または `screenshot @e3 [path]` | `locator.screenshot()` |
| 領域指定の切り抜き | `screenshot --clip x,y,w,h [path]` | `page.screenshot({ clip })` |

要素の切り抜きは、CSS selector（`.class`, `#id`, `[attr]`）または `snapshot` で得た `@e`/`@c` ref を受け付けます。自動判定のルールは、`@e`/`@c` で始まれば ref、`.`/`#`/`[` で始まれば CSS selector、`--` で始まれば flag、それ以外は出力 path です。

排他制約として、`--clip` と selector の同時指定、`--viewport` と `--clip` の同時指定はどちらも error になります。不明な flag（例: `--bogus`）も error になります。

### Authentication

各 server session は bearer token としてランダムな UUID を生成します。この token は chmod 600 の state file（`.gstack/browse.json`）に書き込まれます。すべての HTTP request は `Authorization: Bearer <token>` を含む必要があります。これにより、同じ machine 上の他プロセスが browser を勝手に操作することを防ぎます。

### console、network、dialog の capture

server は Playwright の `page.on('console')`、`page.on('response')`、`page.on('dialog')` event に hook します。すべての entry は O(1) の circular buffer（各 50,000 件）に保持され、`Bun.write()` で非同期に disk へ flush されます。

- Console: `.gstack/browse-console.log`
- Network: `.gstack/browse-network.log`
- Dialog: `.gstack/browse-dialog.log`

`console`、`network`、`dialog` command は disk ではなく memory 上の buffer を読みます。

### dialog handling

dialog（alert、confirm、prompt）は browser lockup を防ぐため、既定では自動 accept されます。`dialog-accept` と `dialog-dismiss` command でこの挙動を制御します。prompt の場合は `dialog-accept <text>` で応答文字列を渡せます。すべての dialog は type、message、実行した action とともに dialog buffer に記録されます。

### 複数 workspace のサポート

各 workspace は、独立した Chromium process、tab、cookie、log を持つ専用の browser instance を使います。state は project root（`git rev-parse --show-toplevel` で検出）内の `.gstack/` に保存されます。

| Workspace | State file | Port |
|-----------|------------|------|
| `/code/project-a` | `/code/project-a/.gstack/browse.json` | random (10000-60000) |
| `/code/project-b` | `/code/project-b/.gstack/browse.json` | random (10000-60000) |

port collision は起きません。state も共有しません。project ごとに完全に分離されます。

### 環境変数

| Variable | Default | 説明 |
|----------|---------|------|
| `BROWSE_PORT` | 0 (random 10000-60000) | HTTP server の固定 port（debug override） |
| `BROWSE_IDLE_TIMEOUT` | 1800000 (30 min) | idle shutdown までの時間（ms） |
| `BROWSE_STATE_FILE` | `.gstack/browse.json` | state file の path（CLI から server に渡される） |
| `BROWSE_SERVER_SCRIPT` | auto-detected | `server.ts` への path |

### Performance

| Tool | 初回呼び出し | 2 回目以降 | 1 回ごとの context overhead |
|------|-------------|------------|-----------------------------|
| Chrome MCP | ~5s | ~2-5s | ~2000 tokens (schema + protocol) |
| Playwright MCP | ~3s | ~1-3s | ~1500 tokens (schema + protocol) |
| **gstack browse** | **~3s** | **~100-200ms** | **0 tokens** (plain text stdout) |

context overhead の差はすぐに積み上がります。20 command の browser session では、MCP tool は protocol framing だけで 30,000-40,000 tokens を消費します。gstack はゼロです。

### なぜ CLI であって MCP ではないのか

MCP（Model Context Protocol）は remote service には向いていますが、ローカルの browser automation に対しては純粋な overhead を増やします。

- **Context bloat**: MCP call には毎回 full JSON schema と protocol framing が含まれます。単純な「ページの text を取る」だけでも、本来必要な量の 10 倍近い context token を消費します。
- **Connection fragility**: 永続的な WebSocket/stdio 接続は切れやすく、再接続にも失敗しがちです。
- **Unnecessary abstraction**: Claude Code にはすでに Bash tool があります。stdout に結果を出す CLI が、最も単純な interface です。

gstack はこの層を丸ごと省きます。compiled binary。plain text in, plain text out。protocol なし。schema なし。connection management も不要です。

## 謝辞

browser automation layer は Microsoft の [Playwright](https://playwright.dev/) の上に成り立っています。ref ベースの操作を可能にしているのは、Playwright の accessibility tree API、locator system、headless Chromium 管理です。accessibility tree node に `@ref` label を割り当てて Playwright Locator に戻す snapshot system も、すべて Playwright の primitive の上に構築されています。堅実な土台を作ってくれた Playwright team に感謝します。

## Development

### 前提条件

- [Bun](https://bun.sh/) v1.0+
- Playwright の Chromium（`bun install` で自動インストール）

### Quick start

```bash
bun install              # 依存関係 + Playwright Chromium をインストール
bun test                 # 統合テストを実行 (~3s)
bun run dev <cmd>        # source から CLI を実行（compile 不要）
bun run build            # browse/dist/browse に compile
```

### dev mode と compiled binary の違い

開発中は compiled binary ではなく `bun run dev` を使ってください。Bun で `browse/src/cli.ts` を直接実行するため、compile の手順なしに素早く確認できます。

```bash
bun run dev goto https://example.com
bun run dev text
bun run dev snapshot -i
bun run dev click @e3
```

compiled binary（`bun run build`）が必要なのは配布時だけです。Bun の `--compile` flag を使って、`browse/dist/browse` に約 58MB の単一 executable を出力します。

### テスト実行

```bash
bun test                         # すべてのテストを実行
bun test browse/test/commands              # command 統合テストのみ実行
bun test browse/test/snapshot              # snapshot テストのみ実行
bun test browse/test/cookie-import-browser # cookie import の unit test のみ実行
```

テストは、`browse/test/fixtures/` の HTML fixture を配信するローカル HTTP server（`browse/test/test-server.ts`）を立ち上げ、そのページに対して CLI command を実行します。3 ファイルで 203 テスト、合計約 15 秒です。

### source map

| File | 役割 |
|------|------|
| `browse/src/cli.ts` | Entry point。`.gstack/browse.json` を読み、server に HTTP を送り、応答を表示する。 |
| `browse/src/server.ts` | Bun HTTP server。command を適切な handler に振り分ける。idle timeout も管理する。 |
| `browse/src/browser-manager.ts` | Chromium の lifecycle。起動、tab 管理、ref map、crash 検知を担当する。 |
| `browse/src/snapshot.ts` | accessibility tree を parse し、`@e`/`@c` ref を振り、Locator map を構築する。`--diff`、`--annotate`、`-C` もここで処理する。 |
| `browse/src/read-commands.ts` | 非破壊 command 群: `text`, `html`, `links`, `js`, `css`, `is`, `dialog`, `forms` など。`getCleanText()` を export する。 |
| `browse/src/write-commands.ts` | 変更系 command 群: `goto`, `click`, `fill`, `upload`, `dialog-accept`, `useragent`（context 再生成あり）など。 |
| `browse/src/meta-commands.ts` | server 管理、chain の routing、diff（`getCleanText` を DRY に利用）、snapshot の委譲を担当する。 |
| `browse/src/cookie-import-browser.ts` | macOS Keychain + PBKDF2/AES-128-CBC を使って Chromium cookie を復号する。インストール済み browser も自動検出する。 |
| `browse/src/cookie-picker-routes.ts` | `/cookie-picker/*` 用の HTTP route。browser list、domain search、import、remove を扱う。 |
| `browse/src/cookie-picker-ui.ts` | 対話式 cookie picker 用の自己完結した HTML generator（dark theme、framework なし）。 |
| `browse/src/buffers.ts` | `CircularBuffer<T>`（O(1) ring buffer）と、console/network/dialog capture の非同期 disk flush を担当する。 |

### active skill への反映

active skill は `~/.claude/skills/gstack/` にあります。変更後は以下を実行してください。

1. branch を push する
2. skill directory で pull する: `cd ~/.claude/skills/gstack && git pull`
3. rebuild する: `cd ~/.claude/skills/gstack && bun run build`

または、binary を直接コピーします: `cp browse/dist/browse ~/.claude/skills/gstack/browse/dist/browse`

### 新しい command を追加する

1. `read-commands.ts`（非破壊）または `write-commands.ts`（変更系）に handler を追加する
2. `server.ts` に route を登録する
3. 必要なら HTML fixture と一緒に `browse/test/commands.test.ts` に test case を追加する
4. `bun test` を実行して検証する
5. `bun run build` を実行して compile する
