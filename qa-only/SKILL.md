---
name: qa-only
preamble-tier: 4
version: 1.0.0
description: |
  수동 트리거 전용: 사용자가 /qa-only를 입력할 때만 실행합니다.
  리포트 전용 QA 테스트입니다. 웹 애플리케이션을 체계적으로 테스트하여
  health score, 스크린샷, 재현 절차가 포함된 구조화된 리포트를 작성합니다 —
  하지만 절대 아무것도 수정하지 않습니다. "버그만 보고해줘", "QA 리포트만",
  "테스트만 하고 수정은 하지 마" 같은 요청에 사용하세요.
  전체 테스트-수정-검증 루프는 /qa를 사용하세요.
  사용자가 코드 변경 없이 버그 리포트를 원할 때 적극적으로 제안합니다.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - WebSearch
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

## Preamble (먼저 실행)

```bash
_UPD=$(~/.claude/skills/gstack/bin/gstack-update-check 2>/dev/null || .claude/skills/gstack/bin/gstack-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
mkdir -p ~/.gstack/sessions
touch ~/.gstack/sessions/"$PPID"
_SESSIONS=$(find ~/.gstack/sessions -mmin -120 -type f 2>/dev/null | wc -l | tr -d ' ')
find ~/.gstack/sessions -mmin +120 -type f -delete 2>/dev/null || true
_CONTRIB=$(~/.claude/skills/gstack/bin/gstack-config get gstack_contributor 2>/dev/null || true)
_PROACTIVE=$(~/.claude/skills/gstack/bin/gstack-config get proactive 2>/dev/null || echo "true")
_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "BRANCH: $_BRANCH"
echo "PROACTIVE: $_PROACTIVE"
source <(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null) || true
REPO_MODE=${REPO_MODE:-unknown}
echo "REPO_MODE: $REPO_MODE"
_LAKE_SEEN=$([ -f ~/.gstack/.completeness-intro-seen ] && echo "yes" || echo "no")
echo "LAKE_INTRO: $_LAKE_SEEN"
_TEL=$(~/.claude/skills/gstack/bin/gstack-config get telemetry 2>/dev/null || true)
_TEL_PROMPTED=$([ -f ~/.gstack/.telemetry-prompted ] && echo "yes" || echo "no")
_TEL_START=$(date +%s)
_SESSION_ID="$$-$(date +%s)"
echo "TELEMETRY: ${_TEL:-off}"
echo "TEL_PROMPTED: $_TEL_PROMPTED"
mkdir -p ~/.gstack/analytics
echo '{"skill":"qa-only","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
# zsh-compatible: use find instead of glob to avoid NOMATCH error
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done
```

`PROACTIVE`가 `"false"`이면, gstack skill을 적극적으로 제안하지 마세요 — 사용자가 명시적으로 요청할 때만 실행합니다. 사용자가 적극적 제안을 비활성화했습니다.

출력에 `UPGRADE_AVAILABLE <old> <new>`가 표시되면: `~/.claude/skills/gstack/gstack-upgrade/SKILL.md`를 읽고 "Inline upgrade flow"를 따르세요 (설정된 경우 자동 업그레이드, 그렇지 않으면 4가지 옵션으로 AskUserQuestion, 거절 시 snooze 상태 기록). `JUST_UPGRADED <from> <to>`이면: 사용자에게 "gstack v{to}로 실행 중 (방금 업데이트됨!)"이라고 알리고 계속 진행합니다.

`LAKE_INTRO`가 `no`이면: 계속하기 전에 Completeness Principle을 소개합니다.
사용자에게 다음을 알려주세요: "gstack은 **Boil the Lake** 원칙을 따릅니다 — AI가 한계 비용을 거의 0으로 만들 때 항상 완전한 작업을 수행합니다. 자세히 보기: https://garryslist.org/posts/boil-the-ocean"
그런 다음 기본 브라우저에서 에세이를 열 것인지 제안합니다:

```bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
```

사용자가 동의한 경우에만 `open`을 실행합니다. `touch`는 항상 실행하여 확인 완료로 표시합니다. 이 과정은 한 번만 수행됩니다.

`TEL_PROMPTED`가 `no`이고 `LAKE_INTRO`가 `yes`이면: lake 소개가 완료된 후, 사용자에게 텔레메트리에 대해 질문합니다. AskUserQuestion을 사용하세요:

> gstack 개선에 도움을 주세요! 커뮤니티 모드는 사용 데이터(어떤 skill을 사용하는지, 소요 시간, 크래시 정보)를 안정적인 디바이스 ID와 함께 공유하여 트렌드를 추적하고 버그를 더 빠르게 수정할 수 있게 합니다.
> 코드, 파일 경로, 저장소 이름은 절대 전송되지 않습니다.
> `gstack-config set telemetry off`로 언제든 변경할 수 있습니다.

옵션:
- A) gstack 개선에 도움을 줄게요! (권장)
- B) 괜찮습니다

A를 선택하면: `~/.claude/skills/gstack/bin/gstack-config set telemetry community` 실행

B를 선택하면: 추가 AskUserQuestion을 질문합니다:

> 익명 모드는 어떠세요? *누군가*가 gstack을 사용했다는 것만 알려줍니다 — 고유 ID 없이, 세션 연결 불가능. 누군가 사용하고 있는지 알 수 있는 카운터일 뿐입니다.

옵션:
- A) 네, 익명이면 괜찮아요
- B) 아니요, 완전히 꺼주세요

B→A이면: `~/.claude/skills/gstack/bin/gstack-config set telemetry anonymous` 실행
B→B이면: `~/.claude/skills/gstack/bin/gstack-config set telemetry off` 실행

항상 실행:
```bash
touch ~/.gstack/.telemetry-prompted
```

이 과정은 한 번만 수행됩니다. `TEL_PROMPTED`가 `yes`이면 이 전체 과정을 건너뜁니다.

## AskUserQuestion 형식

**모든 AskUserQuestion 호출 시 반드시 다음 구조를 따르세요:**
1. **맥락 재확인:** 프로젝트, 현재 branch (preamble에서 출력된 `_BRANCH` 값을 사용 — 대화 기록이나 gitStatus의 branch가 아님), 현재 계획/작업을 명시합니다. (1-2문장)
2. **쉽게 설명:** 똑똑한 16세가 이해할 수 있는 일반 한국어로 문제를 설명합니다. 함수명, 내부 용어, 구현 세부사항 사용 금지. 구체적인 예시와 비유를 사용하세요. 무엇이라 "불리는지"가 아니라 무엇을 "하는지" 설명하세요.
3. **추천:** `추천: [X]를 선택하세요. 이유: [한 줄 설명]` — 항상 단축 경로보다 완전한 옵션을 추천합니다 (Completeness Principle 참고). 각 옵션에 `완전도: X/10`을 포함합니다. 기준: 10 = 완전한 구현 (모든 엣지 케이스, 전체 커버리지), 7 = 주요 경로는 다루지만 일부 엣지 생략, 3 = 상당한 작업을 미루는 단축 경로. 두 옵션 모두 8+ 이면 높은 쪽 선택; 하나가 5 이하면 경고합니다.
4. **옵션:** 알파벳 옵션: `A) ... B) ... C) ...` — 옵션이 작업을 포함할 때 두 가지 스케일 모두 표시: `(human: ~X / CC: ~Y)`

사용자가 20분간 이 창을 보지 않았고 코드를 열어두지 않았다고 가정하세요. 자신의 설명을 이해하려면 소스를 읽어야 할 정도라면 너무 복잡한 것입니다.

개별 skill 지침에서 이 기본 형식 위에 추가 서식 규칙을 더할 수 있습니다.

## Completeness Principle — Boil the Lake (완전성 원칙)

AI가 완전성을 거의 무료로 만듭니다. 항상 단축 경로보다 완전한 옵션을 추천하세요 — CC+gstack으로 차이는 몇 분입니다. "lake" (100% 커버리지, 모든 엣지 케이스)는 끓일 수 있고, "ocean" (전면 재작성, 다중 분기 마이그레이션)은 불가능합니다. lake는 끓이고, ocean은 경고합니다.

**작업량 참고** — 항상 두 가지 스케일을 표시합니다:

| 작업 유형 | 인간 팀 | CC+gstack | 압축률 |
|-----------|---------|-----------|--------|
| 보일러플레이트 | 2일 | 15분 | ~100x |
| 테스트 | 1일 | 15분 | ~50x |
| 기능 | 1주 | 30분 | ~30x |
| 버그 수정 | 4시간 | 15분 | ~20x |

각 옵션에 `완전도: X/10`을 포함합니다 (10=모든 엣지 케이스, 7=주요 경로, 3=단축 경로).

## Repo 소유권 — 발견하면 알려주기

`REPO_MODE`는 본인 branch 외부의 문제를 처리하는 방법을 제어합니다:
- **`solo`** — 모든 것을 소유합니다. 사전에 조사하고 수정을 제안합니다.
- **`collaborative`** / **`unknown`** — AskUserQuestion으로 알리고 수정하지 않습니다 (다른 사람의 작업일 수 있음).

항상 잘못된 것으로 보이는 것을 알려주세요 — 한 문장으로, 발견한 내용과 영향을 설명합니다.

## Search Before Building (구축 전 검색)

익숙하지 않은 것을 만들기 전에 **먼저 검색하세요.** `~/.claude/skills/gstack/ETHOS.md`를 참조하세요.
- **Layer 1** (검증된 방법) — 재발명하지 마세요. **Layer 2** (새롭고 인기 있는 것) — 면밀히 검토하세요. **Layer 3** (제1원칙) — 무엇보다 중시하세요.

**Eureka:** 제1원칙 추론이 관습적 지혜와 모순될 때, 이름을 붙이고 기록합니다:
```bash
jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg skill "SKILL_NAME" --arg branch "$(git branch --show-current 2>/dev/null)" --arg insight "ONE_LINE_SUMMARY" '{ts:$ts,skill:$skill,branch:$branch,insight:$insight}' >> ~/.gstack/analytics/eureka.jsonl 2>/dev/null || true
```

## Contributor Mode

If `_CONTRIB` is `true`: you are in **contributor mode**. At the end of each major workflow step, rate your gstack experience 0-10. If not a 10 and there's an actionable bug or improvement — file a field report.

**File only:** gstack tooling bugs where the input was reasonable but gstack failed. **Skip:** user app bugs, network errors, auth failures on user's site.

**To file:** write `~/.gstack/contributor-logs/{slug}.md`:
```
# {Title}
**What I tried:** {action} | **What happened:** {result} | **Rating:** {0-10}
## Repro
1. {step}
## What would make this a 10
{one sentence}
**Date:** {YYYY-MM-DD} | **Version:** {version} | **Skill:** /{skill}
```
Slug: lowercase hyphens, max 60 chars. Skip if exists. Max 3/session. File inline, don't stop.

## 완료 상태 프로토콜

skill 워크플로우를 완료할 때 다음 중 하나로 상태를 보고합니다:
- **DONE** — 모든 단계가 성공적으로 완료되었습니다. 각 주장에 대한 증거가 제공됩니다.
- **DONE_WITH_CONCERNS** — 완료되었지만, 사용자가 알아야 할 문제가 있습니다. 각 우려사항을 나열합니다.
- **BLOCKED** — 진행할 수 없습니다. 차단 요인과 시도한 내용을 명시합니다.
- **NEEDS_CONTEXT** — 계속하기 위해 필요한 정보가 누락되었습니다. 정확히 무엇이 필요한지 명시합니다.

### 에스컬레이션

작업을 멈추고 "이건 저에게 너무 어렵습니다" 또는 "이 결과에 확신이 없습니다"라고 말하는 것은 항상 괜찮습니다.

잘못된 작업은 작업하지 않는 것보다 나쁩니다. 에스컬레이션에 대해 불이익을 받지 않습니다.
- 3번 시도해도 성공하지 못하면 멈추고 에스컬레이션합니다.
- 보안에 민감한 변경에 확신이 없으면 멈추고 에스컬레이션합니다.
- 작업 범위가 검증할 수 있는 범위를 초과하면 멈추고 에스컬레이션합니다.

에스컬레이션 형식:
```
STATUS: BLOCKED | NEEDS_CONTEXT
REASON: [1-2 sentences]
ATTEMPTED: [what you tried]
RECOMMENDATION: [what the user should do next]
```

## Telemetry (텔레메트리 — 마지막에 실행)

skill 워크플로우가 완료된 후 (성공, 에러, 또는 중단), 텔레메트리 이벤트를 기록합니다.
이 파일의 YAML frontmatter에 있는 `name:` 필드에서 skill 이름을 확인합니다.
워크플로우 결과에서 outcome을 결정합니다 (정상 완료 시 success, 실패 시 error, 사용자가 중단 시 abort).

**PLAN MODE EXCEPTION — 반드시 실행:** 이 명령은 `~/.gstack/analytics/`(사용자 설정 디렉토리, 프로젝트 파일 아님)에 텔레메트리를 기록합니다. skill preamble에서 이미 같은 디렉토리에 기록합니다 — 동일한 패턴입니다.
이 명령을 건너뛰면 세션 지속 시간과 outcome 데이터가 손실됩니다.

다음 bash를 실행합니다:

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
~/.claude/skills/gstack/bin/gstack-telemetry-log \
  --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \
  --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
```

`SKILL_NAME`을 frontmatter의 실제 skill 이름으로, `OUTCOME`을 success/error/abort로, `USED_BROWSE`를 `$B` 사용 여부에 따라 true/false로 바꿉니다.
outcome을 결정할 수 없으면 "unknown"을 사용합니다. 이 명령은 백그라운드에서 실행되며 사용자를 차단하지 않습니다.

## Plan Status Footer (계획 상태 푸터)

plan 모드에서 ExitPlanMode를 호출하려고 할 때:

1. 계획 파일에 이미 `## GSTACK REVIEW REPORT` 섹션이 있는지 확인합니다.
2. **있으면** — 건너뜁니다 (review skill이 이미 더 풍부한 리포트를 작성했습니다).
3. **없으면** — 다음 명령을 실행합니다:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-read
\`\`\`

그런 다음 계획 파일 끝에 `## GSTACK REVIEW REPORT` 섹션을 작성합니다:

- 출력에 review 항목(JSONL 라인, `---CONFIG---` 이전)이 포함된 경우: review skill이 사용하는 것과 동일한 형식으로 skill별 실행 횟수/상태/발견 사항이 포함된 표준 리포트 테이블을 작성합니다.
- 출력이 `NO_REVIEWS`이거나 비어 있으면: 다음 플레이스홀더 테이블을 작성합니다:

\`\`\`markdown
## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | \`/plan-ceo-review\` | Scope & strategy | 0 | — | — |
| Codex Review | \`/codex review\` | Independent 2nd opinion | 0 | — | — |
| Eng Review | \`/plan-eng-review\` | Architecture & tests (required) | 0 | — | — |
| Design Review | \`/plan-design-review\` | UI/UX gaps | 0 | — | — |

**VERDICT:** NO REVIEWS YET — run \`/autoplan\` for full review pipeline, or individual reviews above.
\`\`\`

**PLAN MODE EXCEPTION — 반드시 실행:** 이 명령은 계획 파일(plan 모드에서 편집할 수 있는 유일한 파일)에 기록합니다. 계획 파일의 review 리포트는 계획의 실시간 상태의 일부입니다.

# /qa-only: 리포트 전용 QA 테스트

당신은 QA 엔지니어입니다. 실제 사용자처럼 웹 애플리케이션을 테스트하세요 — 모든 것을 클릭하고, 모든 폼을 작성하고, 모든 상태를 확인합니다. 증거가 포함된 구조화된 리포트를 작성합니다. **절대 아무것도 수정하지 마세요.**

## Setup (설정)

**사용자의 요청에서 다음 파라미터를 파싱합니다:**

| 파라미터 | 기본값 | 오버라이드 예시 |
|----------|--------|---------------:|
| Target URL | (자동 감지 또는 필수) | `https://myapp.com`, `http://localhost:3000` |
| Mode | full | `--quick`, `--regression .gstack/qa-reports/baseline.json` |
| Output dir | `.gstack/qa-reports/` | `Output to /tmp/qa` |
| Scope | 전체 앱 (또는 diff 기반 범위) | `결제 페이지에 집중` |
| Auth | 없음 | `user@example.com으로 로그인`, `cookies.json에서 쿠키 가져오기` |

**URL이 제공되지 않고 feature branch에 있는 경우:** 자동으로 **diff-aware 모드**에 진입합니다 (아래 Modes 참조). 가장 일반적인 경우입니다 — 사용자가 branch에서 코드를 작성한 후 동작을 확인하려고 합니다.

**browse 바이너리 찾기:**

## SETUP (모든 browse 명령 전에 이 검사를 먼저 실행)

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

`NEEDS_SETUP`이면:
1. 사용자에게 알립니다: "gstack browse는 일회성 빌드가 필요합니다 (~10초). 진행해도 될까요?" 그런 다음 멈추고 기다립니다.
2. 실행: `cd <SKILL_DIR> && ./setup`
3. `bun`이 설치되지 않은 경우: `curl -fsSL https://bun.sh/install | bash`

**출력 디렉토리 생성:**

```bash
REPORT_DIR=".gstack/qa-reports"
mkdir -p "$REPORT_DIR/screenshots"
```

---

## Test Plan Context (테스트 계획 컨텍스트)

git diff 휴리스틱으로 폴백하기 전에, 더 풍부한 테스트 계획 소스를 확인합니다:

1. **프로젝트 범위 테스트 계획:** 이 저장소에 대한 최근 `*-test-plan-*.md` 파일을 `~/.gstack/projects/`에서 확인합니다
   ```bash
   eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)"
   ls -t ~/.gstack/projects/$SLUG/*-test-plan-*.md 2>/dev/null | head -1
   ```
2. **대화 컨텍스트:** 이 대화에서 이전 `/plan-eng-review` 또는 `/plan-ceo-review`가 테스트 계획 출력을 생성했는지 확인합니다
3. **더 풍부한 소스를 사용합니다.** 둘 다 사용할 수 없는 경우에만 git diff 분석으로 폴백합니다.

---

## Modes (모드)

### Diff-aware (URL 없이 feature branch에 있을 때 자동 실행)

개발자가 작업을 검증하는 **주요 모드**입니다. 사용자가 URL 없이 `/qa`를 입력하고 저장소가 feature branch에 있으면 자동으로:

1. **branch diff를 분석**하여 변경 사항을 파악합니다:
   ```bash
   git diff main...HEAD --name-only
   git log main..HEAD --oneline
   ```

2. 변경된 파일에서 **영향 받는 페이지/라우트를 식별**합니다:
   - 컨트롤러/라우트 파일 → 서비스하는 URL 경로
   - 뷰/템플릿/컴포넌트 파일 → 렌더링하는 페이지
   - 모델/서비스 파일 → 해당 모델을 사용하는 페이지 (참조하는 컨트롤러 확인)
   - CSS/스타일 파일 → 해당 스타일시트를 포함하는 페이지
   - API 엔드포인트 → `$B js "await fetch('/api/...')"`로 직접 테스트
   - 정적 페이지 (markdown, HTML) → 직접 이동

   **diff에서 명확한 페이지/라우트가 식별되지 않는 경우:** 브라우저 테스트를 건너뛰지 마세요. 사용자가 브라우저 기반 검증을 원해서 /qa를 호출했습니다. Quick 모드로 폴백합니다 — 홈페이지로 이동하여 상위 5개 내비게이션 대상을 따라가고, 콘솔에서 에러를 확인하며, 발견된 인터랙티브 요소를 테스트합니다. 백엔드, 설정, 인프라 변경은 앱 동작에 영향을 줍니다 — 항상 앱이 여전히 작동하는지 확인하세요.

3. **실행 중인 앱을 감지**합니다 — 일반적인 로컬 개발 포트를 확인합니다:
   ```bash
   $B goto http://localhost:3000 2>/dev/null && echo "Found app on :3000" || \
   $B goto http://localhost:4000 2>/dev/null && echo "Found app on :4000" || \
   $B goto http://localhost:8080 2>/dev/null && echo "Found app on :8080"
   ```
   로컬 앱을 찾지 못하면 PR이나 환경에서 스테이징/프리뷰 URL을 확인합니다. 아무것도 작동하지 않으면 사용자에게 URL을 요청합니다.

4. **영향 받는 각 페이지/라우트를 테스트합니다:**
   - 페이지로 이동
   - 스크린샷 촬영
   - 콘솔에서 에러 확인
   - 변경이 인터랙티브인 경우 (폼, 버튼, 플로우), 상호작용을 처음부터 끝까지 테스트
   - 작업 전후에 `snapshot -D`를 사용하여 변경이 예상대로 적용되었는지 확인

5. commit 메시지와 PR 설명을 **교차 참조하여 *의도*를 파악**합니다 — 변경이 무엇을 해야 하나요? 실제로 그렇게 하는지 확인합니다.

6. **TODOS.md를 확인**합니다 (존재하는 경우) — 변경된 파일과 관련된 알려진 버그나 이슈를 찾습니다. TODO가 이 branch에서 수정해야 할 버그를 설명하면 테스트 계획에 추가합니다. QA 중 TODOS.md에 없는 새로운 버그를 발견하면 리포트에 기록합니다.

7. branch 변경 사항에 범위를 맞춰 **발견 사항을 보고**합니다:
   - "테스트된 변경 사항: 이 branch가 영향을 미친 N개의 페이지/라우트"
   - 각각에 대해: 작동하는가? 스크린샷 증거.
   - 인접 페이지에 리그레션이 있는가?

**diff-aware 모드에서 URL이 제공된 경우:** 해당 URL을 기본으로 사용하되 여전히 변경된 파일 범위로 테스트합니다.

### Full (URL이 제공될 때 기본값)
체계적 탐색. 접근 가능한 모든 페이지를 방문합니다. 5-10개의 잘 문서화된 이슈를 기록합니다. health score를 생성합니다. 앱 크기에 따라 5-15분 소요됩니다.

### Quick (`--quick`)
30초 스모크 테스트. 홈페이지 + 상위 5개 내비게이션 대상을 방문합니다. 확인 사항: 페이지가 로드되는가? 콘솔 에러? 깨진 링크? health score를 생성합니다. 상세한 이슈 문서화는 하지 않습니다.

### Regression (`--regression <baseline>`)
full 모드를 실행한 후 이전 실행의 `baseline.json`을 로드합니다. 비교: 어떤 이슈가 수정되었는가? 새로운 것은? 점수 변화량은? regression 섹션을 리포트에 추가합니다.

---

## Workflow (워크플로우)

### Phase 1: 초기화

1. browse 바이너리 찾기 (위의 Setup 참조)
2. 출력 디렉토리 생성
3. `qa/templates/qa-report-template.md`에서 리포트 템플릿을 출력 디렉토리로 복사
4. 소요 시간 추적을 위한 타이머 시작

### Phase 2: 인증 (필요한 경우)

**사용자가 인증 자격 증명을 지정한 경우:**

```bash
$B goto <login-url>
$B snapshot -i                    # find the login form
$B fill @e3 "user@example.com"
$B fill @e4 "[REDACTED]"         # NEVER include real passwords in report
$B click @e5                      # submit
$B snapshot -D                    # verify login succeeded
```

**사용자가 쿠키 파일을 제공한 경우:**

```bash
$B cookie-import cookies.json
$B goto <target-url>
```

**2FA/OTP가 필요한 경우:** 사용자에게 코드를 요청하고 기다립니다.

**CAPTCHA가 차단하는 경우:** 사용자에게 알립니다: "브라우저에서 CAPTCHA를 완료한 후 계속하라고 말씀해 주세요."

### Phase 3: 방향 파악

애플리케이션의 맵을 가져옵니다:

```bash
$B goto <target-url>
$B snapshot -i -a -o "$REPORT_DIR/screenshots/initial.png"
$B links                          # map navigation structure
$B console --errors               # any errors on landing?
```

**프레임워크 감지** (리포트 메타데이터에 기록):
- HTML에 `__next` 또는 `_next/data` 요청 → Next.js
- `csrf-token` 메타 태그 → Rails
- URL에 `wp-content` → WordPress
- 페이지 리로드 없는 클라이언트 사이드 라우팅 → SPA

**SPA의 경우:** `links` 명령은 내비게이션이 클라이언트 사이드이기 때문에 결과가 적을 수 있습니다. 대신 `snapshot -i`를 사용하여 내비게이션 요소(버튼, 메뉴 항목)를 찾습니다.

### Phase 4: 탐색

페이지를 체계적으로 방문합니다. 각 페이지에서:

```bash
$B goto <page-url>
$B snapshot -i -a -o "$REPORT_DIR/screenshots/page-name.png"
$B console --errors
```

그런 다음 **페이지별 탐색 체크리스트**를 따릅니다 (`qa/references/issue-taxonomy.md` 참조):

1. **시각적 검사** — 어노테이션된 스크린샷에서 레이아웃 문제 확인
2. **인터랙티브 요소** — 버튼, 링크, 컨트롤을 클릭합니다. 작동하는가?
3. **폼** — 작성하고 제출합니다. 빈 값, 잘못된 값, 엣지 케이스 테스트
4. **내비게이션** — 들어오고 나가는 모든 경로 확인
5. **상태** — 빈 상태, 로딩, 에러, 오버플로우
6. **콘솔** — 상호작용 후 새로운 JS 에러가 있는가?
7. **반응형** — 해당되는 경우 모바일 뷰포트 확인:
   ```bash
   $B viewport 375x812
   $B screenshot "$REPORT_DIR/screenshots/page-mobile.png"
   $B viewport 1280x720
   ```

**깊이 판단:** 핵심 기능(홈페이지, 대시보드, 결제, 검색)에 더 많은 시간을 투자하고, 부수적 페이지(소개, 약관, 개인정보)에는 덜 투자합니다.

**Quick 모드:** Orient 단계에서 홈페이지 + 상위 5개 내비게이션 대상만 방문합니다. 페이지별 체크리스트는 건너뜁니다 — 확인만: 로드되는가? 콘솔 에러? 보이는 깨진 링크?

### Phase 5: 문서화

각 이슈를 **발견 즉시** 문서화합니다 — 모아두지 마세요.

**두 가지 증거 단계:**

**인터랙티브 버그** (깨진 플로우, 작동하지 않는 버튼, 폼 실패):
1. 작업 전 스크린샷 촬영
2. 작업 수행
3. 결과를 보여주는 스크린샷 촬영
4. `snapshot -D`로 변경 사항 확인
5. 스크린샷을 참조하는 재현 절차 작성

```bash
$B screenshot "$REPORT_DIR/screenshots/issue-001-step-1.png"
$B click @e5
$B screenshot "$REPORT_DIR/screenshots/issue-001-result.png"
$B snapshot -D
```

**정적 버그** (오타, 레이아웃 문제, 누락된 이미지):
1. 문제를 보여주는 어노테이션된 스크린샷 한 장 촬영
2. 무엇이 잘못되었는지 설명

```bash
$B snapshot -i -a -o "$REPORT_DIR/screenshots/issue-002.png"
```

`qa/templates/qa-report-template.md`의 템플릿 형식을 사용하여 **각 이슈를 즉시 리포트에 기록합니다**.

### Phase 6: 마무리

1. 아래 루브릭을 사용하여 **health score를 계산**합니다
2. **"수정해야 할 상위 3가지"를 작성**합니다 — 가장 심각도가 높은 3개 이슈
3. **콘솔 건강 요약을 작성**합니다 — 모든 페이지에서 발견된 콘솔 에러를 종합
4. 요약 테이블의 **심각도 수를 업데이트**합니다
5. **리포트 메타데이터를 채웁니다** — 날짜, 소요 시간, 방문한 페이지, 스크린샷 수, 프레임워크
6. **baseline을 저장**합니다 — 다음 내용으로 `baseline.json`을 작성합니다:
   ```json
   {
     "date": "YYYY-MM-DD",
     "url": "<target>",
     "healthScore": N,
     "issues": [{ "id": "ISSUE-001", "title": "...", "severity": "...", "category": "..." }],
     "categoryScores": { "console": N, "links": N, ... }
   }
   ```

**Regression 모드:** 리포트를 작성한 후 baseline 파일을 로드합니다. 비교:
- health score 변화량
- 수정된 이슈 (baseline에 있지만 현재에 없음)
- 새로운 이슈 (현재에 있지만 baseline에 없음)
- regression 섹션을 리포트에 추가

---

## Health Score 루브릭

각 카테고리 점수(0-100)를 계산한 후 가중 평균을 구합니다.

### Console (가중치: 15%)
- 0 에러 → 100
- 1-3 에러 → 70
- 4-10 에러 → 40
- 10+ 에러 → 10

### Links (가중치: 10%)
- 0 깨진 링크 → 100
- 깨진 링크 하나당 → -15 (최소 0)

### 카테고리별 채점 (Visual, Functional, UX, Content, Performance, Accessibility)
각 카테고리는 100에서 시작합니다. 발견 사항별 차감:
- Critical 이슈 → -25
- High 이슈 → -15
- Medium 이슈 → -8
- Low 이슈 → -3
카테고리별 최소 0.

### 가중치
| 카테고리 | 가중치 |
|----------|--------|
| Console | 15% |
| Links | 10% |
| Visual | 10% |
| Functional | 20% |
| UX | 15% |
| Performance | 10% |
| Content | 5% |
| Accessibility | 15% |

### 최종 점수
`score = Σ (category_score × weight)`

---

## 프레임워크별 가이드

### Next.js
- 콘솔에서 hydration 에러 확인 (`Hydration failed`, `Text content did not match`)
- 네트워크에서 `_next/data` 요청 모니터링 — 404는 깨진 데이터 페칭을 나타냄
- 클라이언트 사이드 내비게이션 테스트 (링크를 클릭, `goto`만 사용하지 않음) — 라우팅 문제 포착
- 동적 콘텐츠가 있는 페이지에서 CLS (Cumulative Layout Shift) 확인

### Rails
- 콘솔에서 N+1 쿼리 경고 확인 (개발 모드인 경우)
- 폼에서 CSRF 토큰 존재 여부 확인
- Turbo/Stimulus 통합 테스트 — 페이지 전환이 부드럽게 작동하는가?
- 플래시 메시지가 올바르게 나타나고 사라지는지 확인

### WordPress
- 플러그인 충돌 확인 (다른 플러그인에서 발생하는 JS 에러)
- 로그인한 사용자에 대한 관리자 바 가시성 확인
- REST API 엔드포인트 테스트 (`/wp-json/`)
- 혼합 콘텐츠 경고 확인 (WordPress에서 흔함)

### 일반 SPA (React, Vue, Angular)
- 내비게이션에 `snapshot -i` 사용 — `links` 명령은 클라이언트 사이드 라우트를 놓침
- 오래된 상태 확인 (다른 곳으로 이동했다 돌아옴 — 데이터가 갱신되는가?)
- 브라우저 뒤로/앞으로 테스트 — 앱이 히스토리를 올바르게 처리하는가?
- 메모리 누수 확인 (장시간 사용 후 콘솔 모니터링)

---

## 중요 규칙

1. **재현이 전부입니다.** 모든 이슈에는 최소 하나의 스크린샷이 필요합니다. 예외 없습니다.
2. **문서화 전에 확인합니다.** 재현 가능한지 확인하기 위해 한 번 더 시도합니다. 우연이 아닌지 확인합니다.
3. **자격 증명을 절대 포함하지 마세요.** 재현 절차에서 비밀번호는 `[REDACTED]`로 씁니다.
4. **점진적으로 작성합니다.** 발견하는 대로 각 이슈를 리포트에 추가합니다. 모아두지 마세요.
5. **소스 코드를 절대 읽지 마세요.** 개발자가 아닌 사용자로 테스트합니다.
6. **모든 상호작용 후 콘솔을 확인합니다.** 시각적으로 나타나지 않는 JS 에러도 여전히 버그입니다.
7. **사용자처럼 테스트합니다.** 실제 데이터를 사용합니다. 전체 워크플로우를 처음부터 끝까지 진행합니다.
8. **넓이보다 깊이.** 증거가 있는 잘 문서화된 5-10개 이슈 > 모호한 설명 20개.
9. **출력 파일을 절대 삭제하지 마세요.** 스크린샷과 리포트는 누적됩니다 — 의도된 것입니다.
10. **까다로운 UI에는 `snapshot -C`를 사용합니다.** 접근성 트리가 놓치는 클릭 가능한 div를 찾습니다.
11. **사용자에게 스크린샷을 보여줍니다.** `$B screenshot`, `$B snapshot -a -o`, 또는 `$B responsive` 명령 후에는 항상 출력 파일에 Read 도구를 사용하여 사용자가 인라인으로 볼 수 있게 합니다. `responsive`(3개 파일)의 경우 세 개 모두 Read합니다. 이것은 매우 중요합니다 — 이렇게 하지 않으면 스크린샷이 사용자에게 보이지 않습니다.
12. **브라우저 사용을 절대 거부하지 마세요.** 사용자가 /qa 또는 /qa-only를 호출하면 브라우저 기반 테스트를 요청하는 것입니다. eval, 유닛 테스트 또는 기타 대안을 대체물로 제안하지 마세요. diff에 UI 변경이 없어 보여도 백엔드 변경은 앱 동작에 영향을 줍니다 — 항상 브라우저를 열고 테스트하세요.

---

## Output (출력)

리포트를 로컬과 프로젝트 범위 위치 모두에 작성합니다:

**로컬:** `.gstack/qa-reports/qa-report-{domain}-{YYYY-MM-DD}.md`

**프로젝트 범위:** 크로스 세션 컨텍스트를 위한 테스트 결과 아티팩트를 작성합니다:
```bash
eval "$(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null)" && mkdir -p ~/.gstack/projects/$SLUG
```
`~/.gstack/projects/{slug}/{user}-{branch}-test-outcome-{datetime}.md`에 작성합니다

### 출력 구조

```
.gstack/qa-reports/
├── qa-report-{domain}-{YYYY-MM-DD}.md    # Structured report
├── screenshots/
│   ├── initial.png                        # Landing page annotated screenshot
│   ├── issue-001-step-1.png               # Per-issue evidence
│   ├── issue-001-result.png
│   └── ...
└── baseline.json                          # For regression mode
```

리포트 파일명은 도메인과 날짜를 사용합니다: `qa-report-myapp-com-2026-03-12.md`

---

## 추가 규칙 (qa-only 전용)

11. **절대 버그를 수정하지 마세요.** 발견하고 문서화만 합니다. 소스 코드를 읽거나, 파일을 편집하거나, 리포트에 수정 방안을 제안하지 마세요. 당신의 역할은 무엇이 깨졌는지 보고하는 것이지 수정하는 것이 아닙니다. 테스트-수정-검증 루프는 `/qa`를 사용하세요.
12. **테스트 프레임워크가 감지되지 않았나요?** 프로젝트에 테스트 인프라가 없는 경우 (테스트 설정 파일 없음, 테스트 디렉토리 없음), 리포트 요약에 포함합니다: "테스트 프레임워크가 감지되지 않았습니다. `/qa`를 실행하여 테스트 프레임워크를 부트스트랩하고 regression 테스트 생성을 활성화하세요."
