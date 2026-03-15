---
name: gstack
version: 1.1.0
description: |
  QA テストとサイト dogfooding 向けの高速 headless browser。任意の URL への移動、
  要素操作、ページ状態確認、操作前後差分、注釈付きスクリーンショット取得、
  レスポンシブ確認、フォーム/アップロード検証、ダイアログ処理、
  要素状態アサーションに対応。1 コマンドあたり約 100ms。機能テスト、
  デプロイ確認、ユーザーフロー dogfooding、証拠付きバグ報告で使う。
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion

---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Update Check (run first)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
```

If output shows `UPGRADE_AVAILABLE <old> <new>`: read `~/.claude/skills/gstack/gstack-upgrade/SKILL.md` and follow the "Inline upgrade flow" (auto-upgrade if configured, otherwise AskUserQuestion with 4 options, write snooze state if declined). If `JUST_UPGRADED <from> <to>`: tell user "Running gstack v{to} (just updated!)" and continue.

# gstack browse: QA テスト & Dogfooding

永続 headless Chromium。初回呼び出しで自動起動 (~3 秒) し、その後は 1 コマンドあたり約 100-200ms。
30 分アイドルで自動終了。呼び出し間で状態（cookies、tabs、sessions）を保持する。

## SETUP (run this check BEFORE any browse command)

```bash
_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
B=""
[ -n "$_ROOT" ] && [ -x "$_ROOT/.claude/skills/gstack/browse/dist/browse" ] && B="$_ROOT/.claude/skills/gstack/browse/dist/browse"
[ -z "$B" ] && B=~/.claude/skills/gstack/browse/dist/browse
if [ -x "$B" ]; then
  echo "READY: $B"
else
  echo "NEEDS_SETUP"
fi
```

If `NEEDS_SETUP`:
1. Tell the user: "gstack browse needs a one-time build (~10 seconds). OK to proceed?" Then STOP and wait.
2. Run: `cd <SKILL_DIR> && ./setup`
3. If `bun` is not installed: `curl -fsSL https://bun.sh/install | bash`

## 重要

- Bash からコンパイル済み binary を使う: `$B <command>`
- `mcp__claude-in-chrome__*` は絶対に使わない。遅く不安定。
- Browser は呼び出し間で状態を保持し、cookies / login sessions / tabs が引き継がれる。
- Dialogs（alert/confirm/prompt）はデフォルトで自動 accept され、ブラウザが固まらない。

## QA ワークフロー

### ユーザーフローをテストする（login、signup、checkout など）

```bash
# 1. Go to the page
$B goto https://app.example.com/login

# 2. See what's interactive
$B snapshot -i

# 3. Fill the form using refs
$B fill @e3 "test@example.com"
$B fill @e4 "password123"
$B click @e5

# 4. Verify it worked
$B snapshot -D              # diff shows what changed after clicking
$B is visible ".dashboard"  # assert the dashboard appeared
$B screenshot /tmp/after-login.png
```

### デプロイを検証する / prod を確認する

```bash
$B goto https://yourapp.com
$B text                          # read the page — does it load?
$B console                       # any JS errors?
$B network                       # any failed requests?
$B js "document.title"           # correct title?
$B is visible ".hero-section"    # key elements present?
$B screenshot /tmp/prod-check.png
```

### 機能を end-to-end で dogfood する

```bash
# Navigate to the feature
$B goto https://app.example.com/new-feature

# Take annotated screenshot — shows every interactive element with labels
$B snapshot -i -a -o /tmp/feature-annotated.png

# Find ALL clickable things (including divs with cursor:pointer)
$B snapshot -C

# Walk through the flow
$B snapshot -i          # baseline
$B click @e3            # interact
$B snapshot -D          # what changed? (unified diff)

# Check element states
$B is visible ".success-toast"
$B is enabled "#next-step-btn"
$B is checked "#agree-checkbox"

# Check console for errors after interactions
$B console
```

### レスポンシブレイアウトをテストする

```bash
# Quick: 3 screenshots at mobile/tablet/desktop
$B goto https://yourapp.com
$B responsive /tmp/layout

# Manual: specific viewport
$B viewport 375x812     # iPhone
$B screenshot /tmp/mobile.png
$B viewport 1440x900    # Desktop
$B screenshot /tmp/desktop.png

# Element screenshot (crop to specific element)
$B screenshot "#hero-banner" /tmp/hero.png
$B snapshot -i
$B screenshot @e3 /tmp/button.png

# Region crop
$B screenshot --clip 0,0,800,600 /tmp/above-fold.png

# Viewport only (no scroll)
$B screenshot --viewport /tmp/viewport.png
```

### ファイルアップロードをテストする

```bash
$B goto https://app.example.com/upload
$B snapshot -i
$B upload @e3 /path/to/test-file.pdf
$B is visible ".upload-success"
$B screenshot /tmp/upload-result.png
```

### バリデーション付きフォームをテストする

```bash
$B goto https://app.example.com/form
$B snapshot -i

# Submit empty — check validation errors appear
$B click @e10                        # submit button
$B snapshot -D                       # diff shows error messages appeared
$B is visible ".error-message"

# Fill and resubmit
$B fill @e3 "valid input"
$B click @e10
$B snapshot -D                       # diff shows errors gone, success state
```

### ダイアログをテストする（削除確認、prompt）

```bash
# Set up dialog handling BEFORE triggering
$B dialog-accept              # will auto-accept next alert/confirm
$B click "#delete-button"     # triggers confirmation dialog
$B dialog                     # see what dialog appeared
$B snapshot -D                # verify the item was deleted

# For prompts that need input
$B dialog-accept "my answer"  # accept with text
$B click "#rename-button"     # triggers prompt
```

### 認証済みページをテストする（実ブラウザ cookies を取り込む）

```bash
# Import cookies from your real browser (opens interactive picker)
$B cookie-import-browser

# Or import a specific domain directly
$B cookie-import-browser comet --domain .github.com

# Now test authenticated pages
$B goto https://github.com/settings/profile
$B snapshot -i
$B screenshot /tmp/github-profile.png
```

### 2 つのページ / 環境を比較する

```bash
$B diff https://staging.app.com https://prod.app.com
```

### 複数ステップ chain（長いフローを効率化）

```bash
echo '[
  ["goto","https://app.example.com"],
  ["snapshot","-i"],
  ["fill","@e3","test@test.com"],
  ["fill","@e4","password"],
  ["click","@e5"],
  ["snapshot","-D"],
  ["screenshot","/tmp/result.png"]
]' | $B chain
```

## クイックアサーション・パターン

```bash
# Element exists and is visible
$B is visible ".modal"

# Button is enabled/disabled
$B is enabled "#submit-btn"
$B is disabled "#submit-btn"

# Checkbox state
$B is checked "#agree"

# Input is editable
$B is editable "#name-field"

# Element has focus
$B is focused "#search-input"

# Page contains text
$B js "document.body.textContent.includes('Success')"

# Element count
$B js "document.querySelectorAll('.list-item').length"

# Specific attribute value
$B attrs "#logo"    # returns all attributes as JSON

# CSS property
$B css ".button" "background-color"
```

## Snapshot System

The snapshot is your primary tool for understanding and interacting with pages.

```
-i        --interactive           @e ref 付きの操作可能要素のみ（button/link/input）
-c        --compact               簡易表示（空の構造ノードを除外）
-d <N>    --depth                 ツリー深さを制限（0 = ルートのみ、既定: 無制限）
-s <sel>  --selector              CSS selector で対象範囲を限定
-D        --diff                  前回 snapshot との差分を unified diff で表示（初回はベースライン保存）
-a        --annotate              ref ラベル付き赤枠オーバーレイの注釈付きスクリーンショット
-o <path> --output                注釈付きスクリーンショットの出力先（既定: /tmp/browse-annotated.png）
-C        --cursor-interactive    cursor-interactive 要素（@c ref: pointer/onclick の div など）
```

All flags can be combined freely. `-o` only applies when `-a` is also used.
Example: `$B snapshot -i -a -C -o /tmp/annotated.png`

**Ref numbering:** @e refs are assigned sequentially (@e1, @e2, ...) in tree order.
@c refs from `-C` are numbered separately (@c1, @c2, ...).

After snapshot, use @refs as selectors in any command:
```bash
$B click @e3       $B fill @e4 "value"     $B hover @e1
$B html @e2        $B css @e5 "color"      $B attrs @e6
$B click @c1       # cursor-interactive ref (from -C)
```

**Output format:** indented accessibility tree with @ref IDs, one element per line.
```
  @e1 [heading] "Welcome" [level=1]
  @e2 [textbox] "Email"
  @e3 [button] "Submit"
```

Refs are invalidated on navigation — run `snapshot` again after `goto`.

## Command Reference

### Navigation
| Command | Description |
|---------|-------------|
| `back` | 履歴を戻る |
| `forward` | 履歴を進む |
| `goto <url>` | URLへ移動 |
| `reload` | ページを再読み込み |
| `url` | 現在のURLを表示 |

### Reading
| Command | Description |
|---------|-------------|
| `accessibility` | ARIAツリー全体 |
| `forms` | フォーム項目をJSONで表示 |
| `html [selector]` | selector の innerHTML（見つからなければエラー）。selector 省略時はページ全体のHTML |
| `links` | すべてのリンクを "text → href" 形式で表示 |
| `text` | 整形済みページテキスト |

### Interaction
| Command | Description |
|---------|-------------|
| `click <sel>` | 要素をクリック |
| `cookie <name>=<value>` | 現在ページのドメインに cookie を設定 |
| `cookie-import <json>` | JSONファイルから cookie を取り込み |
| `cookie-import-browser [browser] [--domain d]` | Comet/Chrome/Arc/Brave/Edge から cookie を取り込み（picker を開くか、--domain で直接取り込み） |
| `dialog-accept [text]` | 次の alert/confirm/prompt を自動 accept。任意テキストは prompt 応答として送信 |
| `dialog-dismiss` | 次のダイアログを自動 dismiss |
| `fill <sel> <val>` | 入力欄に値を入力 |
| `header <name>:<value>` | カスタムリクエストヘッダーを設定（colon区切り。機密値は自動マスク） |
| `hover <sel>` | 要素にホバー |
| `press <key>` | キー入力（Enter, Tab, Escape, ArrowUp/Down/Left/Right, Backspace, Delete, Home, End, PageUp, PageDown, Shift+Enter など） |
| `scroll [sel]` | 要素を表示位置までスクロール。selector 省略時はページ最下部までスクロール |
| `select <sel> <val>` | ドロップダウンを value/label/表示テキストで選択 |
| `type <text>` | フォーカス中の要素へ入力 |
| `upload <sel> <file> [file2...]` | ファイルをアップロード |
| `useragent <string>` | User-Agent を設定 |
| `viewport <WxH>` | ビューポートサイズを設定 |
| `wait <sel|--networkidle|--load>` | 要素、network idle、ページ読み込みを待機（timeout: 15秒） |

### Inspection
| Command | Description |
|---------|-------------|
| `attrs <sel|@ref>` | 要素属性をJSONで表示 |
| `console [--clear|--errors]` | コンソールメッセージ（--errors で error/warning のみ） |
| `cookies` | すべての cookie をJSONで表示 |
| `css <sel> <prop>` | 計算済みCSS値を取得 |
| `dialog [--clear]` | ダイアログメッセージ |
| `eval <file>` | ファイル内の JavaScript を実行し、結果を文字列で返す（path は /tmp または cwd 配下のみ） |
| `is <prop> <sel>` | 状態確認（visible/hidden/enabled/disabled/checked/editable/focused） |
| `js <expr>` | JavaScript 式を実行し、結果を文字列で返す |
| `network [--clear]` | ネットワークリクエスト |
| `perf` | ページ読み込みタイミング |
| `storage [set k v]` | localStorage + sessionStorage をJSONで表示。set <key> <value> で localStorage に書き込み |

### Visual
| Command | Description |
|---------|-------------|
| `diff <url1> <url2>` | ページ間のテキスト差分 |
| `pdf [path]` | PDFとして保存 |
| `responsive [prefix]` | mobile(375x812)/tablet(768x1024)/desktop(1280x720) で撮影。{prefix}-mobile.png 形式で保存 |
| `screenshot [--viewport] [--clip x,y,w,h] [selector|@ref] [path]` | スクリーンショットを保存（CSS/@ref 指定の要素切り抜き、--clip 範囲、--viewport 対応） |

### Snapshot
| Command | Description |
|---------|-------------|
| `snapshot [flags]` | 要素選択用 @e ref 付きアクセシビリティツリー。フラグ: -i interactive のみ, -c compact, -d N 深さ制限, -s sel 範囲指定, -D 前回との差分, -a 注釈付きスクリーンショット, -o 出力パス, -C cursor-interactive @c ref |

### Meta
| Command | Description |
|---------|-------------|
| `chain` | stdin の JSON からコマンドを順に実行。形式: [["cmd","arg1",...],...] |

### Tabs
| Command | Description |
|---------|-------------|
| `closetab [id]` | タブを閉じる |
| `newtab [url]` | 新しいタブを開く |
| `tab <id>` | タブを切り替え |
| `tabs` | 開いているタブ一覧 |

### Server
| Command | Description |
|---------|-------------|
| `restart` | サーバーを再起動 |
| `status` | ヘルスチェック |
| `stop` | サーバーを停止 |

## Tips

1. **1 回移動して何度も確認する。** `goto` でページを読み込んだ後、`text` / `js` / `screenshot` は即時実行できる。
2. **最初に `snapshot -i` を使う。** 対話可能要素を見てから ref で click/fill する。CSS selector 推測は不要。
3. **検証は `snapshot -D`。** baseline → action → diff で変化点を正確に確認できる。
4. **アサーションには `is`。** `is visible .modal` はページ全文解析より速く堅牢。
5. **証拠収集には `snapshot -a`。** 注釈付きスクリーンショットはバグ報告に有効。
6. **難しい UI には `snapshot -C`。** accessibility tree が拾わない clickable div も見つかる。
7. **操作後に `console` を確認。** 見た目に出ない JS エラーを拾える。
8. **長いフローは `chain`。** 1 コマンドで実行し、ステップごとの CLI オーバーヘッドを減らせる。
