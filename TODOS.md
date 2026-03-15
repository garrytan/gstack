# TODOS

## Browse

### コンパイル済み binary に server.ts を bundle する

**何をするか:** `resolveServerScript()` の fallback chain を完全になくし、compiled browse binary に server.ts を bundle する。

**理由:** 現在の fallback chain（`cli.ts` の隣を確認し、次に global install を確認する方式）は脆く、v0.3.2 でも bug の原因になりました。単一の compiled binary の方が単純で信頼性も高いです。

**背景:** Bun の `--compile` flag では複数の entry point を bundle できます。server は現在 runtime の file path lookup で解決されていますが、bundle すればこの解決手順自体をなくせます。

**工数:** M
**優先度:** P2
**依存:** なし

### Sessions（分離された browser instance）

**何をするか:** cookie / storage / history を分離した browser instance を、名前付きで扱えるようにする。

**理由:** 異なる user role の並列 test、A/B test の検証、auth state のクリーンな管理が可能になります。

**背景:** Playwright の browser context 分離が必要です。各 session は独立した cookie / localStorage を持つ context になります。video recording（きれいな context lifecycle が必要）と auth vault の前提条件でもあります。

**工数:** L
**優先度:** P3

### Video recording

**何をするか:** browser 操作を video として記録する（start/stop control）。

**理由:** QA report や PR body に video の証跡を載せられます。現状は `recreateContext()` が page state を壊すため deferred です。

**背景:** きれいな context lifecycle のために Sessions が必要です。Playwright は context ごとの video recording をサポートしています。PR に埋め込むには WebM → GIF 変換も必要です。

**工数:** M
**優先度:** P3
**依存:** Sessions

### v20 encryption format support

**何をするか:** 将来の Chromium cookie DB version（現在は v10）に向けて AES-256-GCM をサポートする。

**理由:** 将来の Chromium が encryption format を変える可能性があります。先回りで対応しておけば破損を防げます。

**工数:** S
**優先度:** P3

### State persistence

**何をするか:** cookie + localStorage を JSON file に保存・復元できるようにし、再現可能な test session を作れるようにする。

**理由:** QA session で「前回の続きから再開する」と、再現可能な auth state を両立できます。

**工数:** M
**優先度:** P3
**依存:** Sessions

### Auth vault

**何をするか:** 名前参照できる暗号化 credential storage を追加する。LLM には password を見せない。

**理由:** security のためです。現状では auth credential が LLM context を流れてしまいます。vault に入れれば secret を AI の視界から外せます。

**工数:** L
**優先度:** P3
**依存:** Sessions, state persistence

### Iframe support

**何をするか:** cross-frame 操作用に `frame <sel>` と `frame main` command を追加する。

**理由:** 多くの web app が iframe（embed、payment form、ad）を使っています。現状の browse では見えません。

**工数:** M
**優先度:** P4

### Semantic locators

**何をするか:** action を紐づけた `find role/label/text/placeholder/testid` を追加する。

**理由:** CSS selector や ref 番号よりも壊れにくい要素選択になります。

**工数:** M
**優先度:** P4

### Device emulation presets

**何をするか:** mobile / tablet test 用に `set device "iPhone 16 Pro"` のような preset を追加する。

**理由:** 手動で viewport を調整しなくても responsive layout を test できます。

**工数:** S
**優先度:** P4

### Network mocking/routing

**何をするか:** network request の intercept、block、mock を行えるようにする。

**理由:** error state、loading state、offline behavior を test できるようにするためです。

**工数:** M
**優先度:** P4

### Download handling

**何をするか:** click で始まる download を path 指定付きで扱えるようにする。

**理由:** file download flow を end-to-end で test できるようにするためです。

**工数:** S
**優先度:** P4

### Content safety

**何をするか:** `--max-output` による切り詰めと、`--allowed-domains` による filter を追加する。

**理由:** context window の overflow を防ぎ、安全な domain だけに navigation を制限できます。

**工数:** S
**優先度:** P4

### Streaming（WebSocket live preview）

**何をするか:** pair browsing session 向けに、WebSocket ベースの live preview を追加する。

**理由:** 人間が AI の browsing をリアルタイムで見られるようにするためです。

**工数:** L
**優先度:** P4

### CDP mode

**何をするか:** Chrome DevTools Protocol を使って、すでに起動中の Chrome / Electron app に接続する。

**理由:** 新しい instance を立ち上げずに、本番 app、Electron app、既存の browser session を test できるようにするためです。

**工数:** M
**優先度:** P4

### Linux/Windows cookie decryption

**何をするか:** macOS 以外の cookie import 向けに GNOME Keyring / kwallet / DPAPI をサポートする。

**理由:** cookie import を cross-platform にするためです。現状は macOS-only（Keychain）です。

**工数:** L
**優先度:** P4

## Ship

### Ship log  `/ship` 実行の永続記録

**何をするか:** `/ship` の各 run の最後に、構造化 JSON entry を `.gstack/ship-log.json` に追記する（version、date、branch、PR URL、review findings、Greptile stats、完了した todos、test result）。

**理由:** shipping velocity について `/retro` には構造化データがありません。ship log があれば、週あたり PR 数の trend、review findings の率、Greptile signal の推移、test suite の増加を見られます。

**背景:** `/retro` はすでに `greptile-history.md` を読んでおり、同じ pattern が使えます。`eval-store.ts` を見ると JSON append pattern は codebase にあります。ship template では約 15 行の変更です。

**工数:** S
**優先度:** P2
**依存:** なし

### Post-deploy verification（ship + browse）

**何をするか:** push 後に staging / preview URL を browse し、主要 page の screenshot を取り、console の JS error を確認し、snapshot diff で staging と prod を比較する。検証 screenshot も PR body に含める。critical error が見つかったら STOP する。

**理由:** merge 前に deployment 時の regression（JS error、崩れた layout）を拾うためです。

**背景:** PR 用 screenshot のために S3 upload 基盤が必要です。visual PR annotation と組み合わせて使います。

**工数:** L
**優先度:** P2
**依存:** /setup-gstack-upload, visual PR annotations

### PR body 内の screenshot を使った visual verification

**何をするか:** `/ship` Step 7.5 として、push 後に主要 page を screenshot し、PR body に埋め込む。

**理由:** PR に視覚的な証跡を残せます。reviewer は local deploy せずに何が変わったかを確認できます。

**背景:** Phase 3.6 の一部です。image hosting のために S3 upload が必要です。

**工数:** M
**優先度:** P2
**依存:** /setup-gstack-upload

## Review

### Inline PR annotations

**何をするか:** `/ship` と `/review` が `gh api` を使って、特定の file:line に inline review comment を投稿できるようにする。

**理由:** top-level comment よりも line-level annotation の方が action に直結します。PR thread が Greptile、Claude、人間 reviewer の行単位の会話になります。

**背景:** GitHub は `gh api repos/$REPO/pulls/$PR/reviews` 経由で inline review comment をサポートしています。Phase 3.6 の visual annotation と自然に組み合わさります。

**工数:** S
**優先度:** P2
**依存:** なし

### Greptile training feedback export

**何をするか:** `greptile-history.md` を集約し、false positive pattern の machine-readable な JSON summary を作って Greptile team に渡せるようにする。

**理由:** feedback loop を閉じるためです。Greptile 側が FP data を使って、同じ mistake を codebase で繰り返さないようにできます。

**背景:** もともとは P3 の Future Idea でした。`greptile-history.md` の data 基盤ができたので P2 に上げています。signal data 自体はすでに収集中で、ここでは export 可能にするだけです。実装は約 40 行。

**工数:** S
**優先度:** P2
**依存:** 十分な FP data の蓄積（10 件以上）

### annotated screenshot を使った visual review

**何をするか:** `/review` Step 4.5 として、PR の preview deploy を browse し、変更 page の annotated screenshot を取り、本番と比較し、responsive layout を確認し、accessibility tree を検証する。

**理由:** layout regression のような code review だけでは見落とす差分を visual diff で拾えるようにするためです。

**背景:** Phase 3.6 の一部です。image hosting のために S3 upload が必要です。

**工数:** M
**優先度:** P2
**依存:** /setup-gstack-upload

## QA

### QA trend tracking

**何をするか:** `baseline.json` を時系列で比較し、QA run をまたいだ regression を検出する。

**理由:** 品質 trend を把握するためです。app が良くなっているのか、悪くなっているのかを見たい。

**背景:** QA はすでに構造化 report を書いています。ここでは run 間比較を追加します。

**工数:** S
**優先度:** P2

### CI/CD QA integration

**何をするか:** `/qa` を GitHub Action step として実行し、health score が下がったら PR を fail させる。

**理由:** CI の自動 quality gate として使い、merge 前に regression を拾うためです。

**工数:** M
**優先度:** P2

### Smart default QA tier

**何をするか:** 何度か run した後は `index.md` を見て、普段 user が選ぶ tier を推定し、AskUserQuestion を省略する。

**理由:** 繰り返し使う user の friction を減らすためです。

**工数:** S
**優先度:** P2

### Accessibility audit mode

**何をするか:** accessibility に絞った test 用に `--a11y` flag を追加する。

**理由:** 一般的な QA checklist を超えて、専用の accessibility test を行えるようにするためです。

**工数:** S
**優先度:** P3

## Retro

### Deployment health tracking（retro + browse）

**何をするか:** 本番状態の screenshot を取り、perf metric（page load time）を確認し、主要 page の console error 数を数え、retro window をまたぐ trend を追跡する。

**理由:** retro には code metric だけでなく、本番 health も含めるべきだからです。

**背景:** browse integration が必要です。screenshot と metric を retro output に流し込みます。

**工数:** L
**優先度:** P3
**依存:** Browse sessions

## Infrastructure

### /setup-gstack-upload skill（S3 bucket）

**何をするか:** image hosting 用の S3 bucket を設定する。visual PR annotation のための one-time setup。

**理由:** `/ship` と `/review` の visual PR annotation の前提条件だからです。

**工数:** M
**優先度:** P2

### gstack-upload helper

**何をするか:** `browse/bin/gstack-upload` を追加し、file を S3 に upload して public URL を返すようにする。

**理由:** PR に image を埋め込む必要があるすべての skill で共有できる utility にするためです。

**工数:** S
**優先度:** P2
**依存:** /setup-gstack-upload

### WebM to GIF conversion

**何をするか:** PR の video 証跡向けに、ffmpeg ベースの WebM → GIF 変換を追加する。

**理由:** GitHub の PR body は WebM を render せず GIF は render するため、video recording の証跡に必要です。

**工数:** S
**優先度:** P3
**依存:** Video recording

### Deploy-verify skill

**何をするか:** 軽量な post-deploy smoke test を追加する。主要 URL にアクセスし、200 を確認し、critical page の screenshot を撮り、console error を確認し、baseline snapshot と比較する。evidence 付きで pass/fail を返す。

**理由:** full QA とは別に、素早い post-deploy confidence check を行うためです。

**工数:** M
**優先度:** P2

### GitHub Actions eval upload

**何をするか:** CI で eval suite を実行し、result JSON を artifact として upload し、summary comment を PR に投稿する。

**理由:** CI integration により merge 前の quality regression を検出でき、PR ごとの永続 eval record も残せます。

**背景:** CI secret に `ANTHROPIC_API_KEY` が必要です。cost は約 $4/run。eval persistence system（v0.3.6）は JSON を `~/.gstack-dev/evals/` に書くので、CI では GitHub Actions artifact として upload し、`eval:compare` で差分 comment を投稿します。

**工数:** M
**優先度:** P2
**依存:** Eval persistence（v0.3.6 で実装済み）

### E2E model pinning

**何をするか:** E2E test を cost 効率のため `claude-sonnet-4-6` に pin し、flaky な LLM response 向けに `retry:2` を追加する。

**理由:** E2E test の cost と flakiness を下げるためです。

**工数:** XS
**優先度:** P2

### Eval web dashboard

**何をするか:** `bun run eval:dashboard` で local HTML を配信し、cost trend、detection rate、pass/fail history の chart を表示する。

**理由:** CLI tool よりも visual chart の方が trend を見つけやすいからです。

**背景:** `~/.gstack-dev/evals/*.json` を読みます。Bun HTTP server と chart.js を使った HTML 約 200 行の想定です。

**工数:** M
**優先度:** P3
**依存:** Eval persistence（v0.3.6 で実装済み）

## Completed

### Phase 1: Foundations (v0.2.0)
- gstack へ rename
- monorepo layout へ再構成
- skill symlink 用 setup script
- ref ベースの要素選択を行う snapshot command
- snapshot test
**完了:** v0.2.0

### Phase 2: Enhanced Browser (v0.2.0)
- annotated screenshot、snapshot diffing、dialog handling、file upload
- cursor-interactive element、要素状態 check
- CircularBuffer、async buffer flush、health check
- Playwright error wrapping、useragent fix
- 統合テスト 148 件
**完了:** v0.2.0

### Phase 3: QA Testing Agent (v0.3.0)
- 6 phase workflow と 3 mode（full/quick/regression）を持つ `/qa` SKILL.md
- issue taxonomy、severity classification、exploration checklist
- report template、health score rubric、framework detection
- wait/console/cookie-import command、find-browse binary
**完了:** v0.3.0

### Phase 3.5: Browser Cookie Import (v0.3.x)
- `cookie-import-browser` command（Chromium cookie DB の復号）
- cookie picker web UI、`/setup-browser-cookies` skill
- unit test 18 件、browser registry（Comet、Chrome、Arc、Brave、Edge）
**完了:** v0.3.1

### E2E test cost tracking
- API の累積 spend を追跡し、threshold 超過時に warn する
**完了:** v0.3.6

### Auto-upgrade mode + smart update check
- Config CLI（`bin/gstack-config`）、`~/.gstack/config.yaml` 経由の auto-upgrade、12h cache TTL、指数的 snooze backoff（24h→48h→1wk）、"never ask again" option、upgrade 時の vendored copy sync
**完了:** v0.3.8
