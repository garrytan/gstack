# gstack

**gstack は Claude Code を、汎用アシスタント1人から必要なときに呼び出せる専門家チームへ変える。**

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 向けの、思想のはっきりした 8 つのワークフロー skill 集です。企画レビュー、コードレビュー、ワンコマンドでの出荷、ブラウザ自動化、QA テスト、エンジニアリングのレトロスペクティブまで、すべて slash command として使えます。

### gstack なし

- エージェントは依頼をそのまま受け取り、本当に正しいものを作ろうとしているかまでは問い直さない
- 実際のプロダクトがもっと大きいものでも、言われた内容をそのまま実装してしまう
- 「PR をレビューして」と頼んでも、毎回レビューの深さがばらつく
- 「これを ship して」が、何をやるかの長いやり取りに変わる
- エージェントはコードは書けてもアプリは見えないので、半分盲目のまま
- QA はまだ手作業でやる必要がある。ブラウザを開き、クリックし、ページを確認し、レイアウトを目で追う

### gstack あり

| Skill | モード | 役割 |
|-------|------|------|
| `/plan-ceo-review` | Founder / CEO | 問題を考え直す。依頼の中に隠れている 10 つ星プロダクトを見つける。 |
| `/plan-eng-review` | Eng manager / tech lead | アーキテクチャ、データフロー、図、エッジケース、テストを固める。 |
| `/review` | 用心深い staff engineer | CI を通っても本番で爆発するバグを見つける。Greptile のレビューコメントもトリアージする。 |
| `/ship` | Release engineer | main を同期し、テストを実行し、Greptile のレビューを解決し、push して PR を開く。何を作るか決めるためではなく、準備できた branch を着地させるためのもの。 |
| `/browse` | QA engineer | エージェントに目を与える。ログインし、アプリを操作し、スクリーンショットを取り、壊れたところを検出する。60 秒で QA をひと通り回せる。 |
| `/qa` | QA lead | 体系立った QA テスト。feature branch 上で diff を自動解析し、影響ページを特定してテストする。全面探索、クイックスモーク、回帰モードもある。 |
| `/setup-browser-cookies` | Session manager | 実ブラウザの cookies を headless session に取り込む。手でログインせずに認証ページをテストできる。 |
| `/retro` | Engineering manager | チームを意識した retro。自分の深掘りに加えて、全 contributor に対する称賛と成長機会を出す。 |

## デモ: 1 つの機能を 5 つのモードで回す

私はほとんどの機能を、まず plan mode から始めます。何を作りたいかを書き、`/plan-ceo-review` で本当に作るべきものかを問い直します。プロダクトの方向性が固まってから、engineering、review、ship、test へ移ります。

```
You:   [plan mode に入り、機能を説明する]
       出品アプリに seller の写真アップロードを追加したいです。seller が
       商品の写真をアップロードすると、それをもとに出品を作れるように
       したいです。

You:   /plan-ceo-review

Claude: "写真アップロード" 自体が機能ではありません。本当の仕事は seller が
        実際に売れる出品を作れるようにすることです。10 つ星版はこうです:
        写真から商品を自動識別し、web から仕様や価格比較を引き、
        title と description を下書きし、最適な hero image を提案する...

You:   /plan-eng-review

Claude: [Architecture diagram、upload → classify → enrich
        → draft pipeline の state machine、async job の境界、
        failure mode、test matrix]

You:   [plan mode を抜けて実装する]

You:   /review

Claude: Race condition: 2 つの tab が cover photo の選択を上書きできます。
        Trust boundary: web データを draft 生成に取り込むと
        prompt injection の経路になります。Missing: upload 失敗時の orphan cleanup。

You:   (問題を修正する)

You:   /ship

Claude: [main を同期し、テストを実行し、branch を push して PR を開く。6 回の tool call で完了]

You:   /qa

Claude: branch diff を解析中... 8 files changed, 3 routes affected.
        [localhost:3000 に対して /listings/new、/listings/:id、/api/listings をテスト]
        3 routes とも正常です。Upload + enrichment の flow は end to end で通りました。

You:   /setup-browser-cookies staging.myapp.com

Claude: Chrome から staging.myapp.com 用の 8 cookies を取り込みました。

You:   /qa https://staging.myapp.com --quick

Claude: [Smoke test: homepage + 5 pages, 30 seconds]
        Health Score: 91/100. Critical issue はありません。Medium が 1 件: mobile nav の重なり。
```

## これは誰向けか

すでに Claude Code を深く使っていて、ぐにゃっとした 1 つの汎用モードではなく、一貫して厳密なワークフローが欲しい人向けです。今この瞬間にどの頭脳を使わせるかを model に伝えたい。founder の審美眼、engineering の厳密さ、用心深い review、あるいは高速実行です。

これは初心者向けの prompt pack ではありません。作って出す人のための operating system です。

## 飛ばし方: 10 セッション同時運用

gstack は Claude Code 1 セッションでも強力です。10 セッションになると質が変わります。

[Conductor](https://conductor.build) は複数の Claude Code セッションを並列で動かせます。それぞれが独立した workspace を持つので、あるセッションで staging に対して `/qa` を走らせ、別のセッションで PR に `/review` をかけ、3 つ目で機能実装を進め、残り 7 つで別 branch を並行作業できます。全部同時です。

各 workspace には独立した browser instance が自動で割り当てられます。Chromium process、cookies、tabs、logs はそれぞれの project root 内の `.gstack/` に保存されます。port の衝突も共有 state もなく、設定も不要です。`/browse` と `/qa` のセッションは、10 個並列に動かしても互いに干渉しません。

これが私の使い方です。1 人で 10 体の並列エージェントを走らせ、それぞれに合った cognitive mode を使わせる。これは小さな改善ではありません。ソフトウェアの作り方そのものが変わります。

## Install

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Git](https://git-scm.com/)、[Bun](https://bun.sh/) v1.0+。`/browse` は native binary を compile するので、macOS と Linux（x64 / arm64）で動きます。

### Step 1: 自分のマシンに install する

Claude Code を開いて、これを貼り付けてください。あとは Claude が進めます。

> gstack を install して: `git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup` を実行し、そのあと CLAUDE.md に "gstack" セクションを追加して、web 閲覧には必ず gstack の /browse skill を使い、mcp\_\_claude-in-chrome\_\_\* tools は決して使わないこと、利用可能な skills として /plan-ceo-review、/plan-eng-review、/review、/ship、/browse、/qa、/setup-browser-cookies、/retro を列挙してください。その後、team でも使えるように current project にも gstack を追加するか user に確認してください。

### Step 2: repo に追加して teammates も使えるようにする（任意）

> この project に gstack を追加して: `cp -Rf ~/.claude/skills/gstack .claude/skills/gstack && rm -rf .claude/skills/gstack/.git && cd .claude/skills/gstack && ./setup` を実行し、そのあとこの project の CLAUDE.md に "gstack" セクションを追加して、web 閲覧には必ず gstack の /browse skill を使い、mcp\_\_claude-in-chrome\_\_\* tools は決して使わず、利用可能な skills として /plan-ceo-review、/plan-eng-review、/review、/ship、/browse、/qa、/setup-browser-cookies、/retro を列挙し、もし gstack skills が動かなければ `cd .claude/skills/gstack && ./setup` を実行して binary を build し skill を登録するよう Claude に伝えてください。

実ファイルが repo に commit されるので、submodule ではありません。`git clone` だけで使えます。binary と node\_modules は gitignore 済みなので、teammate は一度 `cd .claude/skills/gstack && ./setup` を実行して build するだけです（または `/browse` を初回実行すれば自動で処理されます）。

### Install されるもの

- `~/.claude/skills/gstack/` に置かれる skill files（project install の場合は `.claude/skills/gstack/`）
- `~/.claude/skills/browse`、`~/.claude/skills/qa`、`~/.claude/skills/review` など、gstack directory を指す symlink
- `browse/dist/browse` に置かれる browser binary（約 58MB、gitignore 済み）
- `node_modules/`（gitignore 済み）
- `/retro` が trend tracking のために project 内 `.context/retros/` へ保存する JSON snapshot

すべて `.claude/` の中で完結します。PATH を触ったり、裏で常駐 process を走らせたりはしません。

---

```
+----------------------------------------------------------------------------+
|                                                                            |
|   1 日 10K LOC 書いて、Garry のように 1 日 10 PR を着地させるのが好きな     |
|   最高の software engineer ですか?                                         |
|                                                                            |
|   YC で一緒に働きませんか: ycombinator.com/software                        |
|                                                                            |
|   給与と equity は非常に競争力があります。                                 |
|   現在 San Francisco, Dogpatch District で採用中です。                     |
|   この革命に参加してください。                                             |
|                                                                            |
+----------------------------------------------------------------------------+
```

---

## 私がこれらの skills をどう使っているか

[Garry Tan](https://x.com/garrytan)（[Y Combinator](https://www.ycombinator.com/) President & CEO）によって作られました。

私は、AI coding tools が 1 つの曖昧なモードに閉じ込められるのが嫌で gstack を作りました。

Planning は review ではありません。review は shipping ではありません。founder の審美眼は engineering の厳密さとは別物です。全部を混ぜると、たいていは 4 つ全部が中途半端になります。

私は明確な gear が欲しい。

この skills は、今この瞬間に model にどんな頭脳を使わせたいかを明示できます。founder、eng manager、paranoid reviewer、release machine。必要な認知モードへその場で切り替えられる。それが本質です。

---

## `/plan-ceo-review`

これは私の **founder mode** です。

ここでは、model に審美眼、野心、user empathy、長期視点を持って考えてほしい。依頼を字面どおり受け取ってほしくありません。まず先に、もっと重要な問いを立ててほしいのです。

**この product は、実際には何のためにあるのか?**

私はこれを **Brian Chesky mode** と考えています。

ポイントは、見えている ticket をそのまま実装することではありません。user の視点から問題を捉え直し、必然性があり、気持ちよく、少し魔法のように感じられる形を見つけることです。

### Example

たとえば Craigslist 風の listing app を作っていて、こう言ったとします。

> 「seller が item の写真を upload できるようにして」

弱い assistant なら file picker を追加して画像を保存するでしょう。

それは本当の product ではありません。

`/plan-ceo-review` では、"写真 upload" そのものが機能なのかを model に問い直してほしいのです。本当の機能は、「売れる listing を作るのを助けること」かもしれません。

そこが本当の仕事なら、計画はすべて変わります。

すると model は次のように考えるべきです。

* 写真から product を識別できるか?
* SKU や model number を推定できるか?
* web を検索して title と description を自動で下書きできるか?
* specs、category、pricing comps を引けるか?
* どの写真を hero image にすると最も変換率が高いか提案できるか?
* upload された写真が ugly、dark、cluttered、low-trust かを検出できるか?
* 2007 年の死んだ form のようではなく premium に感じる体験へできるか?

それが `/plan-ceo-review` が私にもたらすものです。

単に「この機能をどう追加するか?」ではありません。
問うのは **「この依頼の中に隠れている 10 つ星 product は何か?」** です。

まったく違う力です。

---

## `/plan-eng-review`

これは私の **eng manager mode** です。

product の方向が正しくなったら、欲しい intelligence の種類はまったく変わります。もう広がり続ける ideation は要りません。「こうだったら cool では?」も要りません。model には最高の technical lead になってほしい。

この mode がしっかり押さえるべきものは次です。

* architecture
* system boundaries
* data flow
* state transitions
* failure modes
* edge cases
* trust boundaries
* test coverage

そして私にとって意外なほど大きい unlock が **diagram** です。

system を描かせると、LLM はずっと完全になります。sequence diagram、state diagram、component diagram、data-flow diagram、test matrix まで。diagram は隠れた前提を表に引きずり出します。ふわっとした planning をずっとしにくくします。

だから `/plan-eng-review` は、product vision を支えられる technical spine を model に組み立てさせる場所です。

### Example

同じ listing app の例を使います。

`/plan-ceo-review` はすでに役目を果たしたとします。写真 upload だけではなく、本当の機能は次を含む smart listing flow だと決まりました。

* 写真を upload する
* product を識別する
* web から listing を enrich する
* 強い title と description を下書きする
* 最適な hero image を提案する

ここから `/plan-eng-review` の出番です。

ここでは model に、次のような問いへ答えてほしい。

* upload、classification、enrichment、draft generation の architecture はどうなるか?
* どの step が synchronous で、どれを background jobs に送るか?
* app server、object storage、vision model、search/enrichment APIs、listing database の境界はどこか?
* upload は成功したのに enrichment が失敗したらどうするか?
* product identification の confidence が低い場合はどうするか?
* retries はどう扱うか?
* duplicate jobs はどう防ぐか?
* 何をいつ persist し、何なら安全に recompute できるか?

そしてここで diagram が欲しいのです。architecture diagrams、state models、data-flow diagrams、test matrices。diagram は隠れた前提を表に出します。ふわっとした planning をしにくくします。

それが `/plan-eng-review` です。

「アイデアを小さくする」ことではない。
**アイデアを build 可能にする。**

---

## `/review`

これは私の **paranoid staff engineer mode** です。

テストが通っているからといって、branch が安全だとは限りません。

`/review` があるのは、CI を抜けても本番で顔面に飛んでくる種類のバグが確実に存在するからです。この mode は大きな夢を見るためのものではありません。plan をきれいにするためのものでもありません。問うのはただ 1 つです。

**まだ何が壊れうるか?**

これは style の細かい指摘ではなく、構造監査です。model には次のようなものを探してほしい。

* N+1 queries
* stale reads
* race conditions
* bad trust boundaries
* missing indexes
* escaping bugs
* broken invariants
* bad retry logic
* 本当の failure mode を外したまま通っている tests

### Example

smart listing flow が実装され、tests も green だとします。

それでも `/review` は、まだ次を問うべきです。

* listing photos や draft suggestions の描画時に N+1 query を入れていないか?
* actual file を検証せず、client 提供の file metadata を信用していないか?
* 2 つの tab が競合して cover photo の選択や item details を上書きできないか?
* 失敗した uploads が storage に orphaned files を永遠に残さないか?
* concurrency 下で "hero image は必ず 1 枚だけ" という rule が壊れないか?
* enrichment APIs が部分的に失敗したとき、graceful に degrade するか、それとも garbage を保存するか?
* web データを draft generation に取り込むことで、prompt injection や trust-boundary の問題を作っていないか?

それが `/review` の役目です。

ここではお世辞はいりません。
本番 incident が起きる前に、それを model に想像してほしいのです。

---

## `/ship`

これは私の **release machine mode** です。

何を作るかを決め、technical plan を固め、本気の review を回したら、もう会話は要りません。欲しいのは execution です。

`/ship` は最後の 1 マイルのためにあります。準備できた branch を着地させるためのもので、何を作るか決めるためのものではありません。

ここで model には brainstorm partner の振る舞いをやめ、規律ある release engineer になってほしい。main と同期し、必要な tests を回し、branch state が健全か確認し、repo が求めるなら changelog や versioning も更新し、push して PR を作るか更新する。

ここでは momentum が重要です。

面白い work が終わり、退屈な release 作業だけが残った branch はよく死にます。人間はそこを先延ばしにする。AI はそうであってはいけません。

### Example

smart listing flow が完成したとします。

product thinking は終わった。
architecture も終わった。
review pass も終わった。
あとは branch を landed させるだけです。

それが `/ship` の仕事です。

私は次のような反復的な release hygiene に energy を使いたくありません。

* main との同期
* tests の再実行
* おかしな branch state の確認
* changelog/version metadata の更新
* branch の push
* PR の作成または更新

この段階で欲しいのは、もう ideation ではありません。
着陸です。

---

## Greptile integration

[Greptile](https://greptile.com) は YC の company で、PR を自動レビューしてくれます。race condition や security issue、CI を通って本番で壊れる類いの問題を実際に拾います。本当に何度も助けられました。

**Setup:** [greptile.com](https://greptile.com) で GitHub repo に Greptile を install してください。30 秒ほどで終わります。PR の review が始まれば、gstack はそのコメントを自動で拾います。追加設定は不要です。

どんな自動 reviewer にも共通する問題は triage です。Greptile は優秀ですが、すべてのコメントが本物の issue とは限りません。false positive もあります。3 commits 前に直した内容をまだ指摘することもあります。triage 層がないとコメントが積み上がり、やがて無視するようになり、本来の価値が消えます。

gstack はそこを解決します。`/review` と `/ship` は Greptile-aware です。Greptile のコメントを読み、1 件ずつ分類して対応します。

- **Valid issues** は critical findings に追加し、shipping 前に修正する
- **Already-fixed issues** には、気づきを認める auto-reply を返す
- **False positives** には押し返す。確認を取り、なぜ誤りかを説明する reply を送る

結果として review は 2 層になります。Greptile が PR 上で非同期に問題を拾い、その findings を `/review` と `/ship` が通常ワークフローの一部として triage する。どれも取りこぼされません。

しかも学習します。あなたが false positive と確認した内容は `~/.gstack/greptile-history.md` に保存されます。以後の run では、その codebase で既知の FP pattern を自動 skip します。さらに `/retro` は Greptile の打率も追跡するので、signal-to-noise ratio が改善しているか見られます。

### Example

```
You:   /ship

Claude: [main を同期し、tests を実行し、着地前 review を開始...]

        この PR で Greptile が 3 件の comment を見つけました:

        [VALID] app/services/payment_service.rb:47 — Race condition:
        concurrent charges が二重課金を起こせます。charge block のまわりに
        DB-level advisory lock を推奨します。
        → https://github.com/you/app/pull/42#discussion_r123

        [ALREADY FIXED] app/models/user.rb:12 — email に downcase する前の
        null check がありません。
        → commit abc1234 ですでに修正済みです。Auto-reply します。

        [FALSE POSITIVE] lib/auth.rb:88 — "Token comparison should
        use constant-time comparison." という指摘ですが、ここではすでに
        ActiveSupport::SecurityUtils.secure_compare を使っています。
        → https://github.com/you/app/pull/42#discussion_r125

        payment_service.rb の race condition を修正中...
        advisory lock を適用しました。Committed: fix: address Greptile
        review — advisory lock on concurrent charges

        auth token の comment は false positive です。すでに
        secure_compare を使っています。

        false positive への対応 options:
          A) Greptile に説明付きで reply する（推奨）
          B) それでも修正する
          C) 無視する

You:    A

Claude: Greptile に reply しました。修正後に tests を再実行しています...
        すべて通りました。version bump を続けます。

        [Greptile Review section 付きで PR を作成]
        PR: https://github.com/you/app/pull/42
```

Greptile comments は 3 件。本当の修正は 1 件。1 件は自動 acknowledge。1 件は false positive として説明付きで押し返す。追加時間は合計約 30 秒。しかも PR body には完全な監査ログが残ります。

---

## `/browse`

これは私の **QA engineer mode** です。

`/browse` はループを閉じる skill です。これ以前は、エージェントは考えたりコードを書いたりはできても、UI state、auth flow、redirect、console errors、empty state、broken layouts を推測するしかなく、やはり半分盲目でした。今は実際に見に行けます。

これは本当に段差のある変化です。全体の cycle が、plan、code、app を動かす、UI を確認する、bug を再現する、fix を検証する、ship する、という形で閉じます。QA は「手でクリックして確認する作業」ではなく、同じ agentic loop の一部になります。エージェントに目を与えるのです。すると、アプリを操作し、壊れたところを見つけ、fix を確かめ、さらに進むという、文脈の重い退屈な QA を自分で回せるようになります。本当に operator が中に入った感覚です。

これは [Playwright](https://playwright.dev/) を使い、Microsoft 製の persistent Chromium daemon と通信する compiled binary です。最初の call は browser 起動で約 3 秒。その後は毎回 100-200ms ほど。browser は commands 間で生き続けるので、cookies、tabs、localStorage が引き継がれます。

branch を push したあと、私は Claude に staging を確認させます。すると QA pass 全体を代わりにやってくれます。

```
You:   /browse staging.myapp.com — ログインして signup flow を試し、
       この branch で変えたすべての page を確認して

Claude: [18 tool calls, ~60 seconds]

        > browse goto https://staging.myapp.com/signup
        > browse snapshot -i
        > browse fill @e2 "test@example.com"
        > browse fill @e3 "password123"
        > browse click @e5                    (Submit)
        > browse screenshot /tmp/signup.png
        > Read /tmp/signup.png

        Signup は成功です。onboarding へ redirect されました。変更した pages を確認します。

        > browse goto https://staging.myapp.com/dashboard
        > browse screenshot /tmp/dashboard.png
        > Read /tmp/dashboard.png
        > browse console

        Dashboard は正常に読み込まれています。console errors はありません。charts も sample data で表示されています。

        > browse goto https://staging.myapp.com/settings/billing
        > browse screenshot /tmp/billing.png
        > Read /tmp/billing.png

        Billing page は正常です。plan selector には Free/Pro/Enterprise が表示されています。
        Stripe elements も正しく描画されています。

        > browse goto https://staging.myapp.com/api/health
        > browse text

        API health endpoint は {"status":"ok","version":"2.4.1"} を返しました。

        4 pages とも正しく読み込まれました。console errors はありません。レイアウト崩れもありません。
        Signup → onboarding → dashboard flow は end to end で正常です。
```

18 回の tool call で、およそ 1 分。test user を signup させ、変更した page をすべて巡回し、screenshots を取り、それを読み、console errors を確認し、API も検証しました。完全な QA pass です。私は browser を開いていません。

documentation の閲覧、deployment の確認、form の入力、screenshot の取得、環境間での page 比較など、Claude に live URL を見る目が必要な作業なら何にでも使えます。

**Security note:** `/browse` は persistent な Chromium session を使います。cookies、localStorage、session state は commands 間で引き継がれます。意図がない限り、sensitive な production 環境には使わないでください。本物の browser であり、本物の state を持ちます。session は 30 分 idle すると自動終了します。

完全な command reference、technical internals、architecture details は [BROWSER.md](BROWSER.md) を参照してください。

---

## `/qa`

これは私の **QA lead mode** です。

`/browse` がエージェントに目を与え、`/qa` は testing methodology を与えます。

もっとも一般的な使い方はこうです。feature branch 上で coding を終え、全部ちゃんと動くか確認したい。そんなときは `/qa` とだけ言えばよい。git diff を読み、変更が影響する pages と routes を特定し、browser を起動してそれぞれをテストします。URL は不要。手動の test plan も不要。変更した code から何をテストすべきかを自分で判断します。

```
You:   /qa

Claude: main に対する branch diff を解析中...
        12 files changed: 3 controllers, 2 views, 4 services, 3 tests

        Affected routes: /listings/new, /listings/:id, /api/listings
        localhost:3000 で app が動作していることを検出しました。

        [影響を受けた各 page をテスト。navigate、form 入力、button click、
        screenshot、console errors の確認を実施]

        QA Report: 3 routes tested, all working.
        - /listings/new: upload + enrichment flow は end to end で動作
        - /listings/:id: detail page は正しく描画
        - /api/listings: 期待どおりの shape で 200 を返す
        console errors はありません。隣接 pages への regression もありません。
```

モードは 4 つあります。

- **Diff-aware**（feature branches では自動）: `git diff main` を読み、影響ページを特定してそこを重点的にテストする。「今 code を書いた」から「ちゃんと動く」までの最短経路です。
- **Full**: app 全体を体系的に探索する。app の規模によって 5-15 分。根拠のある issues を 5-10 件ほど文書化します。
- **Quick**（`--quick`）: 30 秒の smoke test。homepage と上位 5 つの nav target を確認する。読み込めるか? console errors はないか? broken links はないか?
- **Regression**（`--regression baseline.json`）: full mode を実行したあと、以前の baseline と diff を取る。何が直ったか? 何が新しく増えたか? score はどう変化したか?

```
You:   /qa https://staging.myapp.com

Claude: [12 pages を探索し、3 forms を入力し、2 flows をテスト]

        QA Report: staging.myapp.com — Health Score: 72/100

        Top 3 Issues:
        1. CRITICAL: Checkout form が required fields 空のまま submit できる
        2. HIGH: Mobile nav menu が item 選択後に閉じない
        3. MEDIUM: Dashboard chart が 1024px 未満で sidebar と重なる

        [screenshots 付きの full report を .gstack/qa-reports/ に保存]
```

reports と screenshots は `.gstack/qa-reports/` に蓄積されるので、時間経過で quality を追跡したり、run 同士を比較したりできます。

**認証が必要な pages をテストするには:** 先に `/setup-browser-cookies` で普段の browser session を取り込みます。そうすれば `/qa` で login 後の pages もテストできます。

---

## `/setup-browser-cookies`

これは私の **session manager mode** です。

`/qa` や `/browse` が認証済み pages をテストするには cookies が必要です。毎回 headless browser から手で login する代わりに、`/setup-browser-cookies` は普段使っている browser から実 session を直接 import します。

install 済みの Chromium 系 browser（Comet、Chrome、Arc、Brave、Edge）を自動検出し、macOS Keychain 経由で cookies を decrypt して、Playwright session に読み込みます。interactive picker UI で import する domain を正確に選べます。cookie value が表示されることはありません。

```
You:   /setup-browser-cookies

Claude: Cookie picker が開きました。browser UI で import したい domains を選び、
        完了したら知らせてください。

        [browser UI で github.com、myapp.com を選択]

You:    done

Claude: 2 domains（47 cookies）を取り込みました。session の準備ができています。
```

UI を使わずに直接指定することもできます。

```
You:   /setup-browser-cookies github.com

Claude: Comet から github.com 用の 12 cookies を取り込みました。
```

browser ごとの初回 import 時には macOS Keychain の prompt が出ます。"Allow" または "Always Allow" を押してください。

---

## `/retro`

これは私の **engineering manager mode** です。

週の終わりには、実際に何が起きたのかを知りたい。雰囲気ではなく data が欲しい。`/retro` は commit history、work patterns、shipping velocity を解析し、率直な retrospective を書きます。

これは team-aware です。誰が command を実行しているかを識別し、自分の work を最も深く扱ったうえで、各 contributor ごとに具体的な praise と growth opportunities を出します。実際の 1:1 で伝えるような feedback です。commits、LOC、test ratio、PR sizes、fix ratio などの metrics を計算し、commit timestamps から coding sessions を推定し、hotspot files を見つけ、shipping streaks を追い、その週最大の ship も特定します。

```
You:   /retro

Claude: Mar 1 の週: 47 commits（3 contributors）, 3.2k LOC, 38% tests, 12 PRs, peak: 10pm | Streak: 47d

        ## あなたの週
        32 commits, +2.4k LOC, 41% tests. Peak hours: 9-11pm.
        Biggest ship: cookie import system（browser decryption + picker UI）。
        良かった点: encryption、UI、18 個の unit tests を含む完全な機能を、
        集中した 1 回の push で着地させた...

        ## Team Breakdown

        ### Alice
        app/services/ に集中した 12 commits。すべての PR が 200 LOC 未満で規律的。
        Opportunity: test ratio が 12% なので、payment が複雑になる前に投資する価値がある。

        ### Bob
        3 commits — dashboard の N+1 query を修正。小さいが高インパクト。
        Opportunity: 今週の active day は 1 日だけ。何か block されていないか確認したい。

        [team の wins 上位 3 件、改善点 3 件、来週の habits 3 件]
```

JSON snapshot を `.context/retros/` に保存するので、次回の run では trend を表示できます。`/retro compare` を使えば今週と先週を横並びで比較できます。

---

## Troubleshooting

**Claude Code に skill が出てこない?**  
`cd ~/.claude/skills/gstack && ./setup` を実行してください（project install の場合は `cd .claude/skills/gstack && ./setup`）。symlink を張り直し、Claude が skills を見つけられるようにします。

**`/browse` が失敗する、または binary が見つからない?**  
`cd ~/.claude/skills/gstack && bun install && bun run build` を実行してください。browser binary を compile します。Bun v1.0+ が必要です。

**Project copy が古い?**  
`/gstack-upgrade` を実行してください。global install と vendored project copy の両方を自動更新します。

**`bun` が入っていない?**  
これで install できます: `curl -fsSL https://bun.sh/install | bash`

## Upgrading

Claude Code で `/gstack-upgrade` を実行してください。install 形態（global か vendored か）を判別し、upgrade し、project copies も同期し、変更点を表示します。

または `~/.gstack/config.yaml` で `auto_upgrade: true` を設定すると、新 version が利用可能なとき自動 upgrade されます。

## Uninstalling

これを Claude Code に貼り付けてください。

> gstack を uninstall して: `for s in browse plan-ceo-review plan-eng-review review ship retro qa setup-browser-cookies; do rm -f ~/.claude/skills/$s; done` を実行して skill symlinks を削除し、そのあと `rm -rf ~/.claude/skills/gstack` を実行して CLAUDE.md から gstack section を削除してください。この project にも `.claude/skills/gstack` がある場合は、`for s in browse plan-ceo-review plan-eng-review review ship retro qa setup-browser-cookies; do rm -f .claude/skills/$s; done && rm -rf .claude/skills/gstack` を実行して削除し、project の CLAUDE.md からも gstack section を削除してください。

## Development

setup、testing、dev mode は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。design decisions と system internals は [ARCHITECTURE.md](ARCHITECTURE.md) を参照してください。browse command reference は [BROWSER.md](BROWSER.md) を参照してください。

### Testing

```bash
bun test                     # 無料の static tests (<5s)
EVALS=1 bun run test:evals   # 完全な E2E + LLM evals (~$4, ~20min)
bun run eval:watch           # E2E 実行中の live dashboard
```

E2E tests は real-time progress を stream し、machine-readable diagnostics を書き出し、途中 kill されても残る partial results を保存します。eval infrastructure 全体は CONTRIBUTING.md を参照してください。

## License

MIT。法的効力を持つ正本は英語版の [LICENSE](LICENSE) です。日本語参考訳は [LICENSE.ja.md](LICENSE.ja.md) を参照してください。
