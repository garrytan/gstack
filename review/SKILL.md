---
name: review
preamble-tier: 4
version: 1.0.0
description: |
  수동 트리거 전용: 사용자가 /review를 입력할 때만 실행합니다.
  코드 랜딩 전 PR 리뷰입니다. base branch 대비 diff를 분석하여 SQL 안전성, LLM 신뢰 경계 위반,
  조건부 사이드 이펙트 및 기타 구조적 이슈를 검출합니다. "PR 리뷰해줘", "코드 리뷰",
  "랜딩 전 리뷰", "diff 확인해줘" 등의 요청에 사용합니다.
  사용자가 코드를 merge 또는 land 하려 할 때 선제적으로 제안합니다.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
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
echo '{"skill":"review","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","repo":"'$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")'"}'  >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
# zsh-compatible: use find instead of glob to avoid NOMATCH error
for _PF in $(find ~/.gstack/analytics -maxdepth 1 -name '.pending-*' 2>/dev/null); do [ -f "$_PF" ] && ~/.claude/skills/gstack/bin/gstack-telemetry-log --event-type skill_run --skill _pending_finalize --outcome unknown --session-id "$_SESSION_ID" 2>/dev/null || true; break; done
```

`PROACTIVE`가 `"false"`인 경우, gstack 스킬을 선제적으로 제안하지 마세요 — 사용자가 명시적으로 요청할 때만 실행합니다. 사용자가 선제적 제안을 거부한 상태입니다.

출력에 `UPGRADE_AVAILABLE <old> <new>`가 표시되면: `~/.claude/skills/gstack/gstack-upgrade/SKILL.md`를 읽고 "Inline upgrade flow"를 따르세요 (자동 업그레이드가 설정되어 있으면 자동 실행, 아니면 4개 옵션으로 AskUserQuestion, 거부 시 snooze 상태 저장). `JUST_UPGRADED <from> <to>`가 표시되면: 사용자에게 "gstack v{to} 실행 중 (방금 업데이트됨!)"이라고 알리고 계속 진행합니다.

`LAKE_INTRO`가 `no`인 경우: 계속하기 전에 완전성 원칙을 소개합니다.
사용자에게 다음을 전달하세요: "gstack은 **Boil the Lake** 원칙을 따릅니다 — AI가 한계비용을 거의 0으로 만들 때 항상 완전한 작업을 수행합니다. 자세히 보기: https://garryslist.org/posts/boil-the-ocean"
그런 다음 기본 브라우저에서 에세이를 열 것인지 제안합니다:

```bash
open https://garryslist.org/posts/boil-the-ocean
touch ~/.gstack/.completeness-intro-seen
```

사용자가 동의한 경우에만 `open`을 실행합니다. `touch`는 항상 실행하여 확인 완료를 표시합니다. 이 과정은 한 번만 발생합니다.

`TEL_PROMPTED`가 `no`이고 `LAKE_INTRO`가 `yes`인 경우: lake 소개가 처리된 후 텔레메트리에 대해 사용자에게 질문합니다. AskUserQuestion을 사용하세요:

> gstack 개선에 도움을 주세요! 커뮤니티 모드는 사용 데이터(어떤 스킬을 사용하는지, 소요 시간, 크래시 정보)를 안정적인 디바이스 ID와 함께 공유하여 트렌드 파악과 버그 수정을 돕습니다.
> 코드, 파일 경로, 저장소 이름은 절대 전송되지 않습니다.
> `gstack-config set telemetry off`로 언제든 변경할 수 있습니다.

옵션:
- A) gstack 개선에 도움 주기! (권장)
- B) 아니요, 괜찮습니다

A 선택 시: `~/.claude/skills/gstack/bin/gstack-config set telemetry community` 실행

B 선택 시: 후속 AskUserQuestion을 진행합니다:

> 익명 모드는 어떠세요? *누군가*가 gstack을 사용했다는 것만 알 수 있습니다 — 고유 ID 없이, 세션 연결 불가. 단순히 사용자가 있는지 확인하는 카운터입니다.

옵션:
- A) 네, 익명 모드는 괜찮습니다
- B) 아니요, 완전히 끄겠습니다

B→A: `~/.claude/skills/gstack/bin/gstack-config set telemetry anonymous` 실행
B→B: `~/.claude/skills/gstack/bin/gstack-config set telemetry off` 실행

항상 실행:
```bash
touch ~/.gstack/.telemetry-prompted
```

이 과정은 한 번만 발생합니다. `TEL_PROMPTED`가 `yes`이면 이 단계를 완전히 건너뜁니다.

## AskUserQuestion Format (질문 형식)

**모든 AskUserQuestion 호출에서 이 구조를 반드시 따르세요:**
1. **컨텍스트 재확인:** 프로젝트, 현재 브랜치 (preamble에서 출력된 `_BRANCH` 값 사용 — 대화 기록이나 gitStatus의 브랜치가 아님), 현재 계획/작업을 명시합니다. (1-2문장)
2. **쉽게 설명:** 똑똑한 16세도 이해할 수 있는 쉬운 한국어로 문제를 설명합니다. 함수명, 내부 용어, 구현 세부사항을 쓰지 마세요. 구체적인 예시와 비유를 사용하세요. 이름이 아니라 하는 일을 설명합니다.
3. **추천:** `추천: [X] 선택 — [한 줄 이유]` — 항상 지름길보다 완전한 옵션을 선호합니다 (완전성 원칙 참조). 각 옵션에 `완전성: X/10`을 포함합니다. 기준: 10 = 완전한 구현 (모든 엣지 케이스, 전체 커버리지), 7 = happy path 커버 but 일부 엣지 케이스 누락, 3 = 상당한 작업을 미루는 지름길. 두 옵션 모두 8+ 이면 높은 쪽 선택; 하나가 5 이하이면 표시합니다.
4. **옵션:** 알파벳 옵션: `A) ... B) ... C) ...` — 옵션에 작업이 포함되면 두 가지 척도를 모두 표시: `(사람: ~X / CC: ~Y)`

사용자가 이 창을 20분 동안 보지 않았고 코드를 열지 않은 상태라고 가정하세요. 자신의 설명을 이해하기 위해 소스를 읽어야 한다면, 너무 복잡한 것입니다.

스킬별 지침이 이 기본 형식 위에 추가 포맷 규칙을 더할 수 있습니다.

## Completeness Principle (완전성 원칙) — Boil the Lake

AI는 완전성의 비용을 거의 0으로 만듭니다. 항상 지름길보다 완전한 옵션을 추천하세요 — CC+gstack으로 차이는 몇 분입니다. "lake" (100% 커버리지, 모든 엣지 케이스)는 달성 가능하고, "ocean" (전체 재작성, 다분기 마이그레이션)은 불가능합니다. lake는 끓이고, ocean은 표시하세요.

**작업량 참고표** — 항상 두 가지 척도를 모두 표시합니다:

| Task type | Human team | CC+gstack | Compression |
|-----------|-----------|-----------|-------------|
| Boilerplate | 2 days | 15 min | ~100x |
| Tests | 1 day | 15 min | ~50x |
| Feature | 1 week | 30 min | ~30x |
| Bug fix | 4 hours | 15 min | ~20x |

각 옵션에 `완전성: X/10`을 포함합니다 (10=모든 엣지 케이스, 7=happy path, 3=지름길).

## Repo Ownership (저장소 소유권) — 발견하면 보고하기

`REPO_MODE`에 따라 브랜치 외부 이슈 처리 방법이 달라집니다:
- **`solo`** — 모든 것을 소유합니다. 선제적으로 조사하고 수정을 제안합니다.
- **`collaborative`** / **`unknown`** — AskUserQuestion으로 표시만 하고, 수정하지 않습니다 (다른 사람의 작업일 수 있음).

잘못된 것으로 보이는 것은 항상 표시합니다 — 한 문장으로, 발견한 내용과 그 영향을 설명합니다.

## Search Before Building (먼저 검색하기)

익숙하지 않은 것을 구축하기 전에, **먼저 검색하세요.** `~/.claude/skills/gstack/ETHOS.md`를 참조합니다.
- **Layer 1** (검증된 방법) — 재발명하지 마세요. **Layer 2** (새롭고 인기 있는) — 면밀히 검토하세요. **Layer 3** (제1원리) — 무엇보다 높이 평가하세요.

**Eureka:** 제1원리 추론이 기존 상식과 모순될 때, 이름을 붙이고 기록합니다:
```bash
jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg skill "SKILL_NAME" --arg branch "$(git branch --show-current 2>/dev/null)" --arg insight "ONE_LINE_SUMMARY" '{ts:$ts,skill:$skill,branch:$branch,insight:$insight}' >> ~/.gstack/analytics/eureka.jsonl 2>/dev/null || true
```

## Contributor Mode (기여자 모드)

`_CONTRIB`가 `true`인 경우: **기여자 모드**입니다. 각 주요 워크플로우 단계가 끝날 때 gstack 경험을 0-10으로 평가합니다. 10이 아니고 실행 가능한 버그나 개선점이 있으면 — 필드 리포트를 작성합니다.

**작성 대상:** 입력이 합리적이었으나 gstack이 실패한 gstack 도구 버그만. **제외:** 사용자 앱 버그, 네트워크 오류, 사용자 사이트의 인증 실패.

**작성 방법:** `~/.gstack/contributor-logs/{slug}.md`에 작성합니다:
```
# {Title}
**What I tried:** {action} | **What happened:** {result} | **Rating:** {0-10}
## Repro
1. {step}
## What would make this a 10
{one sentence}
**Date:** {YYYY-MM-DD} | **Version:** {version} | **Skill:** /{skill}
```
Slug: 소문자 하이픈, 최대 60자. 이미 존재하면 건너뜁니다. 세션당 최대 3개. 인라인으로 작성하고, 멈추지 않습니다.

## Completion Status Protocol (완료 상태 프로토콜)

스킬 워크플로우 완료 시, 다음 중 하나로 상태를 보고합니다:
- **DONE** — 모든 단계가 성공적으로 완료되었습니다. 각 주장에 대한 증거를 제공합니다.
- **DONE_WITH_CONCERNS** — 완료되었지만, 사용자가 알아야 할 이슈가 있습니다. 각 우려사항을 나열합니다.
- **BLOCKED** — 진행할 수 없습니다. 차단 원인과 시도한 내용을 명시합니다.
- **NEEDS_CONTEXT** — 계속하기 위해 필요한 정보가 부족합니다. 필요한 내용을 정확히 명시합니다.

### Escalation (에스컬레이션)

"이건 저에게 너무 어렵습니다" 또는 "이 결과에 확신이 없습니다"라고 멈추고 말하는 것은 언제나 괜찮습니다.

잘못된 작업은 작업 안 하는 것보다 나쁩니다. 에스컬레이션해도 불이익은 없습니다.
- 3번 시도해도 성공하지 못하면, 멈추고 에스컬레이션합니다.
- 보안에 민감한 변경이 불확실하면, 멈추고 에스컬레이션합니다.
- 작업 범위가 검증 가능한 범위를 초과하면, 멈추고 에스컬레이션합니다.

에스컬레이션 형식:
```
STATUS: BLOCKED | NEEDS_CONTEXT
REASON: [1-2 sentences]
ATTEMPTED: [what you tried]
RECOMMENDATION: [what the user should do next]
```

## Telemetry (텔레메트리 — 마지막에 실행)

스킬 워크플로우 완료 후 (성공, 오류 또는 중단), 텔레메트리 이벤트를 기록합니다.
이 파일의 YAML frontmatter에서 `name:` 필드로 스킬 이름을 확인합니다.
워크플로우 결과에서 outcome을 결정합니다 (정상 완료 시 success, 실패 시 error,
사용자가 중단한 경우 abort).

**PLAN MODE 예외 — 항상 실행:** 이 명령은 `~/.gstack/analytics/`(사용자 설정 디렉터리, 프로젝트 파일 아님)에 텔레메트리를 기록합니다. 스킬 preamble도 같은 디렉터리에 기록합니다 — 동일한 패턴입니다.
이 명령을 건너뛰면 세션 지속시간과 outcome 데이터가 손실됩니다.

다음 bash를 실행하세요:

```bash
_TEL_END=$(date +%s)
_TEL_DUR=$(( _TEL_END - _TEL_START ))
rm -f ~/.gstack/analytics/.pending-"$_SESSION_ID" 2>/dev/null || true
~/.claude/skills/gstack/bin/gstack-telemetry-log \
  --skill "SKILL_NAME" --duration "$_TEL_DUR" --outcome "OUTCOME" \
  --used-browse "USED_BROWSE" --session-id "$_SESSION_ID" 2>/dev/null &
```

`SKILL_NAME`을 frontmatter의 실제 스킬 이름으로, `OUTCOME`을 success/error/abort로, `USED_BROWSE`를 `$B` 사용 여부에 따라 true/false로 대체합니다.
outcome을 결정할 수 없으면 "unknown"을 사용합니다. 백그라운드에서 실행되며 사용자를 차단하지 않습니다.

## Plan Status Footer (계획 상태 푸터)

plan 모드에서 ExitPlanMode를 호출하려 할 때:

1. 계획 파일에 이미 `## GSTACK REVIEW REPORT` 섹션이 있는지 확인합니다.
2. 있으면 — 건너뜁니다 (review 스킬이 이미 더 풍부한 리포트를 작성했습니다).
3. 없으면 — 다음 명령을 실행합니다:

\`\`\`bash
~/.claude/skills/gstack/bin/gstack-review-read
\`\`\`

그런 다음 계획 파일 끝에 `## GSTACK REVIEW REPORT` 섹션을 작성합니다:

- 출력에 리뷰 항목이 포함된 경우 (`---CONFIG---` 앞의 JSONL 라인): 스킬별 실행 횟수/상태/findings를 포함하는 표준 리포트 테이블을 포맷합니다. review 스킬이 사용하는 것과 동일한 형식입니다.
- 출력이 `NO_REVIEWS`이거나 비어 있는 경우: 다음 플레이스홀더 테이블을 작성합니다:

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

**PLAN MODE 예외 — 항상 실행:** 이 명령은 계획 파일에 기록하며, 이는 plan 모드에서 편집이 허용된 유일한 파일입니다. 계획 파일의 리뷰 리포트는 계획의 실시간 상태의 일부입니다.

## Step 0: Base branch 감지

이 PR이 타겟팅하는 branch를 결정합니다. 이후 모든 단계에서 "the base branch"로 사용합니다.

1. 이 branch에 대한 PR이 이미 있는지 확인합니다:
   `gh pr view --json baseRefName -q .baseRefName`
   성공하면, 출력된 branch 이름을 base branch로 사용합니다.

2. PR이 없으면 (명령 실패), 저장소의 기본 branch를 감지합니다:
   `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`

3. 두 명령 모두 실패하면, `main`으로 폴백합니다.

감지된 base branch 이름을 출력합니다. 이후의 모든 `git diff`, `git log`,
`git fetch`, `git merge`, `gh pr create` 명령에서, 지침에 "the base branch"라고
표시된 곳에 감지된 branch 이름을 대입합니다.

---

# Pre-Landing PR Review (랜딩 전 PR 리뷰)

`/review` 워크플로우를 실행합니다. 현재 branch의 diff를 base branch 대비 분석하여 테스트가 잡지 못하는 구조적 이슈를 찾습니다.

---

## Step 1: Branch 확인

1. `git branch --show-current`를 실행하여 현재 branch를 확인합니다.
2. base branch에 있으면, **"리뷰할 내용이 없습니다 — base branch에 있거나 base branch 대비 변경사항이 없습니다."** 를 출력하고 중지합니다.
3. `git fetch origin <base> --quiet && git diff origin/<base> --stat`를 실행하여 diff가 있는지 확인합니다. diff가 없으면 같은 메시지를 출력하고 중지합니다.

---

## Step 1.5: Scope Drift Detection (범위 이탈 감지)

코드 품질을 리뷰하기 전에 확인합니다: **요청된 것만 빌드했는지 — 더하지도 빼지도 않았는지?**

1. `TODOS.md`를 읽습니다 (존재하는 경우). PR 설명을 읽습니다 (`gh pr view --json body --jq .body 2>/dev/null || true`).
   commit 메시지를 읽습니다 (`git log origin/<base>..HEAD --oneline`).
   **PR이 없는 경우:** commit 메시지와 TODOS.md에 의존하여 명시된 의도를 파악합니다 — /review는 /ship이 PR을 생성하기 전에 실행되므로 이것이 일반적인 케이스입니다.
2. **명시된 의도** 를 식별합니다 — 이 branch가 달성해야 할 것은 무엇이었나요?
3. `git diff origin/<base>...HEAD --stat`를 실행하고 변경된 파일을 명시된 의도와 비교합니다.
4. 회의적으로 평가합니다:

   **SCOPE CREEP (범위 확장) 감지:**
   - 명시된 의도와 관련 없는 변경된 파일
   - 계획에 언급되지 않은 새로운 기능이나 리팩터링
   - "이왕 손대는 김에..." 변경으로 영향 범위가 확대된 경우

   **MISSING REQUIREMENTS (누락된 요구사항) 감지:**
   - TODOS.md/PR 설명의 요구사항이 diff에서 처리되지 않은 경우
   - 명시된 요구사항에 대한 테스트 커버리지 부족
   - 부분 구현 (시작했지만 완료되지 않은 것)

5. 출력 (메인 리뷰 시작 전):
   ```
   Scope Check: [CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING]
   Intent: <1-line summary of what was requested>
   Delivered: <1-line summary of what the diff actually does>
   [If drift: list each out-of-scope change]
   [If missing: list each unaddressed requirement]
   ```

6. 이것은 **정보 제공용** 입니다 — 리뷰를 차단하지 않습니다. Step 2로 진행합니다.

---

## Step 2: Checklist 읽기

`.claude/skills/review/checklist.md`를 읽습니다.

**파일을 읽을 수 없으면, 중지하고 오류를 보고합니다.** checklist 없이 진행하지 마세요.

---

## Step 2.5: Greptile 리뷰 코멘트 확인

`.claude/skills/review/greptile-triage.md`를 읽고 fetch, filter, classify, 및 **에스컬레이션 감지** 단계를 따릅니다.

**PR이 없거나, `gh`가 실패하거나, API가 오류를 반환하거나, Greptile 코멘트가 0개인 경우:** 이 단계를 조용히 건너뜁니다. Greptile 통합은 부가적입니다 — 리뷰는 이것 없이도 작동합니다.

**Greptile 코멘트가 발견된 경우:** 분류 결과를 저장합니다 (VALID & ACTIONABLE, VALID BUT ALREADY FIXED, FALSE POSITIVE, SUPPRESSED) — Step 5에서 필요합니다.

---

## Step 3: Diff 가져오기

최신 base branch를 fetch하여 오래된 로컬 상태로 인한 오탐을 방지합니다:

```bash
git fetch origin <base> --quiet
```

`git diff origin/<base>`를 실행하여 전체 diff를 가져옵니다. 최신 base branch 대비 commit된 변경과 commit되지 않은 변경 모두를 포함합니다.

---

## Step 4: Two-pass review (2단계 리뷰)

checklist를 diff에 대해 2단계로 적용합니다:

1. **Pass 1 (CRITICAL):** SQL 및 데이터 안전성, Race Condition 및 동시성, LLM Output Trust Boundary, Enum 및 값 완전성
2. **Pass 2 (INFORMATIONAL):** 조건부 Side Effect, Magic Number 및 문자열 커플링, Dead Code 및 일관성, LLM 프롬프트 이슈, 테스트 격차, View/프론트엔드, 성능 및 번들 영향

**Enum 및 값 완전성은 diff 외부의 코드를 읽어야 합니다.** diff에서 새로운 enum 값, 상태, 티어 또는 타입 상수를 도입하면, Grep으로 형제 값을 참조하는 모든 파일을 찾고, Read로 해당 파일을 읽어 새 값이 처리되고 있는지 확인합니다. 이것은 diff 내 리뷰만으로는 부족한 유일한 카테고리입니다.

**수정 추천 전 검색:** 수정 패턴을 추천할 때 (특히 동시성, 캐싱, 인증, 프레임워크 특화 동작):
- 사용 중인 프레임워크 버전의 현재 모범 사례인지 확인합니다
- 우회 방법을 추천하기 전에 최신 버전에 빌트인 솔루션이 있는지 확인합니다
- 현재 문서 대비 API 시그니처를 검증합니다 (API는 버전 간 변경됩니다)

몇 초면 되며, 오래된 패턴 추천을 방지합니다. WebSearch를 사용할 수 없으면 해당 사실을 표기하고 내장 지식으로 진행합니다.

checklist에 명시된 출력 형식을 따릅니다. suppression을 존중합니다 — "DO NOT flag" 섹션에 나열된 항목을 표시하지 마세요.

---

## Step 4.5: Design Review (디자인 리뷰, 조건부)

## Design Review (조건부, diff 범위 한정)

diff가 프론트엔드 파일을 포함하는지 `gstack-diff-scope`로 확인합니다:

```bash
source <(~/.claude/skills/gstack/bin/gstack-diff-scope <base> 2>/dev/null)
```

**`SCOPE_FRONTEND=false`인 경우:** 디자인 리뷰를 조용히 건너뜁니다. 출력 없음.

**`SCOPE_FRONTEND=true`인 경우:**

1. **DESIGN.md 확인.** 저장소 루트에 `DESIGN.md` 또는 `design-system.md`가 있으면 읽습니다. 모든 디자인 finding은 이 파일을 기준으로 조정됩니다 — DESIGN.md에서 승인된 패턴은 표시하지 않습니다. 없으면 범용 디자인 원칙을 사용합니다.

2. **`.claude/skills/review/design-checklist.md`를 읽습니다.** 파일을 읽을 수 없으면 다음 메모와 함께 디자인 리뷰를 건너뜁니다: "디자인 checklist를 찾을 수 없습니다 — 디자인 리뷰를 건너뜁니다."

3. **변경된 각 프론트엔드 파일을 읽습니다** (diff hunk만이 아닌 전체 파일). 프론트엔드 파일은 checklist에 나열된 패턴으로 식별됩니다.

4. **디자인 checklist를 적용합니다.** 각 항목에 대해:
   - **[HIGH] 기계적 CSS 수정** (`outline: none`, `!important`, `font-size < 16px`): AUTO-FIX로 분류
   - **[HIGH/MEDIUM] 디자인 판단 필요**: ASK로 분류
   - **[LOW] 의도 기반 감지**: "가능성 있음 — 시각적으로 확인하거나 /design-review를 실행하세요"로 제시

5. **finding을 포함합니다.** 리뷰 출력의 "Design Review" 헤더 아래에 checklist의 출력 형식을 따라 포함합니다. 디자인 finding은 코드 리뷰 finding과 합쳐져 동일한 Fix-First 플로우로 진행됩니다.

6. **결과를 기록합니다.** Review Readiness Dashboard용:

```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"design-review-lite","timestamp":"TIMESTAMP","status":"STATUS","findings":N,"auto_fixed":M,"commit":"COMMIT"}'
```

대체: TIMESTAMP = ISO 8601 datetime, STATUS = finding이 0개면 "clean" 아니면 "issues_found", N = 총 finding 수, M = auto-fix 수, COMMIT = `git rev-parse --short HEAD` 출력.

7. **Codex 디자인 보이스** (선택 사항, 사용 가능한 경우 자동):

```bash
which codex 2>/dev/null && echo "CODEX_AVAILABLE" || echo "CODEX_NOT_AVAILABLE"
```

Codex가 사용 가능하면 diff에 대해 경량 디자인 검사를 실행합니다:

```bash
TMPERR_DRL=$(mktemp /tmp/codex-drl-XXXXXXXX)
codex exec "Review the git diff on this branch. Run 7 litmus checks (YES/NO each): 1. Brand/product unmistakable in first screen? 2. One strong visual anchor present? 3. Page understandable by scanning headlines only? 4. Each section has one job? 5. Are cards actually necessary? 6. Does motion improve hierarchy or atmosphere? 7. Would design feel premium with all decorative shadows removed? Flag any hard rejections: 1. Generic SaaS card grid as first impression 2. Beautiful image with weak brand 3. Strong headline with no clear action 4. Busy imagery behind text 5. Sections repeating same mood statement 6. Carousel with no narrative purpose 7. App UI made of stacked cards instead of layout 5 most important design findings only. Reference file:line." -s read-only -c 'model_reasoning_effort="high"' --enable web_search_cached 2>"$TMPERR_DRL"
```

5분 타임아웃을 사용합니다 (`timeout: 300000`). 명령 완료 후 stderr를 읽습니다:
```bash
cat "$TMPERR_DRL" && rm -f "$TMPERR_DRL"
```

**오류 처리:** 모든 오류는 논블로킹입니다. 인증 실패, 타임아웃, 빈 응답 시 — 간단한 메모와 함께 건너뛰고 계속합니다.

Codex 출력을 `CODEX (design):` 헤더 아래에 위의 checklist finding과 합쳐서 제시합니다.

디자인 finding을 Step 4의 finding과 함께 포함합니다. 동일한 Fix-First 플로우를 따릅니다 — 기계적 CSS 수정은 AUTO-FIX, 나머지는 ASK.

---

## Step 4.75: Test Coverage Diagram (테스트 커버리지 다이어그램)

100% 커버리지가 목표입니다. diff에서 변경된 모든 코드 경로를 평가하고 테스트 격차를 식별합니다. 격차는 Fix-First 플로우를 따르는 INFORMATIONAL finding이 됩니다.

### Test Framework Detection (테스트 프레임워크 감지)

커버리지를 분석하기 전에 프로젝트의 테스트 프레임워크를 감지합니다:

1. **CLAUDE.md를 읽습니다** — 테스트 명령과 프레임워크 이름이 포함된 `## Testing` 섹션을 찾습니다. 발견되면 권위 있는 소스로 사용합니다.
2. **CLAUDE.md에 테스트 섹션이 없으면, 자동 감지합니다:**

```bash
# Detect project runtime
[ -f Gemfile ] && echo "RUNTIME:ruby"
[ -f package.json ] && echo "RUNTIME:node"
[ -f requirements.txt ] || [ -f pyproject.toml ] && echo "RUNTIME:python"
[ -f go.mod ] && echo "RUNTIME:go"
[ -f Cargo.toml ] && echo "RUNTIME:rust"
# Check for existing test infrastructure
ls jest.config.* vitest.config.* playwright.config.* cypress.config.* .rspec pytest.ini phpunit.xml 2>/dev/null
ls -d test/ tests/ spec/ __tests__/ cypress/ e2e/ 2>/dev/null
```

3. **프레임워크가 감지되지 않은 경우:** 여전히 커버리지 다이어그램은 생성하되 테스트 생성은 건너뜁니다.

**Step 1. 변경된 모든 코드 경로를 추적합니다.** `git diff origin/<base>...HEAD` 사용:

변경된 모든 파일을 읽습니다. 각 파일에서 데이터가 코드를 통해 어떻게 흐르는지 추적합니다 — 함수 목록만 나열하지 말고, 실제 실행을 따라갑니다:

1. **diff를 읽습니다.** 변경된 각 파일에 대해 컨텍스트를 이해하기 위해 전체 파일을 읽습니다 (diff hunk만이 아님).
2. **데이터 흐름을 추적합니다.** 각 진입점 (route handler, exported function, event listener, component render)에서 시작하여 모든 분기를 통해 데이터를 따라갑니다:
   - 입력은 어디서 오는가? (request params, props, database, API call)
   - 무엇이 변환하는가? (validation, mapping, computation)
   - 어디로 가는가? (database write, API response, rendered output, side effect)
   - 각 단계에서 무엇이 잘못될 수 있는가? (null/undefined, invalid input, network failure, empty collection)
3. **실행을 다이어그램으로 그립니다.** 변경된 각 파일에 대해 ASCII 다이어그램을 그립니다:
   - 추가 또는 수정된 모든 function/method
   - 모든 조건 분기 (if/else, switch, ternary, guard clause, early return)
   - 모든 오류 경로 (try/catch, rescue, error boundary, fallback)
   - 다른 함수 호출 (그 함수도 추적 — 테스트되지 않은 분기가 있는가?)
   - 모든 엣지: null 입력이면? 빈 배열이면? 잘못된 타입이면?

이것이 핵심 단계입니다 — 입력에 따라 다르게 실행될 수 있는 모든 코드 라인의 맵을 작성합니다. 이 다이어그램의 모든 분기에 테스트가 필요합니다.

**Step 2. 사용자 플로우, 인터랙션, 오류 상태를 매핑합니다:**

코드 커버리지만으로는 충분하지 않습니다 — 실제 사용자가 변경된 코드와 어떻게 상호작용하는지를 커버해야 합니다. 변경된 각 기능에 대해 다음을 생각합니다:

- **사용자 플로우:** 이 코드에 닿는 사용자 동작 시퀀스는 무엇인가? 전체 여정을 매핑합니다 (예: "사용자가 '결제' 클릭 → 폼 유효성 검사 → API 호출 → 성공/실패 화면"). 여정의 각 단계에 테스트가 필요합니다.
- **인터랙션 엣지 케이스:** 사용자가 예상치 못한 행동을 하면 어떻게 되는가?
  - 더블 클릭/빠른 재제출
  - 작업 중 이탈 (뒤로가기 버튼, 탭 닫기, 다른 링크 클릭)
  - 오래된 데이터로 제출 (페이지가 30분 열려 있었고, 세션 만료)
  - 느린 연결 (API가 10초 걸림 — 사용자에게 무엇이 보이는가?)
  - 동시 작업 (두 개의 탭, 같은 폼)
- **사용자가 볼 수 있는 오류 상태:** 코드가 처리하는 모든 오류에 대해, 사용자가 실제로 경험하는 것은 무엇인가?
  - 명확한 오류 메시지인가 아니면 조용한 실패인가?
  - 사용자가 복구할 수 있는가 (재시도, 뒤로가기, 입력 수정) 아니면 막혀 있는가?
  - 네트워크 없을 때? API에서 500 응답 시? 서버에서 잘못된 데이터가 올 때?
- **빈/0/경계 상태:** 결과가 0개일 때 UI는 무엇을 보여주는가? 10,000개 결과일 때? 단일 문자 입력일 때? 최대 길이 입력일 때?

이것을 코드 분기와 함께 다이어그램에 추가합니다. 테스트가 없는 사용자 플로우는 테스트되지 않은 if/else와 같은 격차입니다.

**Step 3. 각 분기를 기존 테스트와 대조합니다:**

다이어그램을 분기별로 살펴봅니다 — 코드 경로와 사용자 플로우 모두. 각각에 대해 해당 분기를 실행하는 테스트를 찾습니다:
- `processPayment()` 함수 → `billing.test.ts`, `billing.spec.ts`, `test/billing_test.rb` 찾기
- if/else → true와 false 경로 모두를 커버하는 테스트 찾기
- 오류 핸들러 → 해당 특정 오류 조건을 트리거하는 테스트 찾기
- 자체 분기가 있는 `helperFn()` 호출 → 그 분기에도 테스트 필요
- 사용자 플로우 → 여정을 따라가는 통합 또는 E2E 테스트 찾기
- 인터랙션 엣지 케이스 → 예상치 못한 동작을 시뮬레이션하는 테스트 찾기

품질 점수 기준:
- ★★★  엣지 케이스와 오류 경로를 포함한 동작 테스트
- ★★   올바른 동작 테스트, happy path만
- ★    스모크 테스트 / 존재 확인 / 사소한 assertion (예: "렌더링됨", "throw 안 함")

### E2E Test Decision Matrix (E2E 테스트 결정 매트릭스)

각 분기를 확인할 때, 단위 테스트와 E2E/통합 테스트 중 어떤 것이 적합한지도 결정합니다:

**E2E 추천 (다이어그램에 [→E2E]로 표시):**
- 3개 이상의 컴포넌트/서비스에 걸친 일반적인 사용자 플로우 (예: 가입 → 이메일 인증 → 첫 로그인)
- 모킹이 실제 실패를 숨기는 통합 지점 (예: API → 큐 → 워커 → DB)
- 인증/결제/데이터 파괴 플로우 — 단위 테스트만으로는 신뢰할 수 없음

**EVAL 추천 (다이어그램에 [→EVAL]로 표시):**
- 품질 평가가 필요한 중요한 LLM 호출 (예: 프롬프트 변경 → 출력이 여전히 품질 기준 충족하는지 테스트)
- 프롬프트 템플릿, 시스템 지침, 도구 정의 변경

**단위 테스트 유지:**
- 명확한 입출력이 있는 순수 함수
- 사이드 이펙트 없는 내부 헬퍼
- 단일 함수의 엣지 케이스 (null 입력, 빈 배열)
- 고객 대면이 아닌 드물거나 모호한 플로우

### REGRESSION RULE (회귀 규칙, 필수)

**철칙:** 커버리지 감사에서 REGRESSION을 식별하면 — 이전에 작동했지만 diff가 깨뜨린 코드 — 회귀 테스트를 즉시 작성합니다. AskUserQuestion 없음. 건너뛰기 없음. 회귀는 무언가가 깨졌다는 것을 증명하므로 최우선 순위 테스트입니다.

회귀란:
- diff가 기존 동작을 수정하는 경우 (새 코드가 아님)
- 기존 테스트 스위트가 변경된 경로를 커버하지 않는 경우
- 변경으로 기존 호출자에게 새로운 실패 모드가 도입되는 경우

변경이 회귀인지 불확실할 때는, 테스트를 작성하는 쪽으로 판단합니다.

형식: `test: regression test for {what broke}`로 commit

**Step 4. ASCII 커버리지 다이어그램을 출력합니다:**

코드 경로와 사용자 플로우를 모두 같은 다이어그램에 포함합니다. E2E 및 eval 대상 경로를 표시합니다:

```
CODE PATH COVERAGE
===========================
[+] src/services/billing.ts
    │
    ├── processPayment()
    │   ├── [★★★ TESTED] Happy path + card declined + timeout — billing.test.ts:42
    │   ├── [GAP]         Network timeout — NO TEST
    │   └── [GAP]         Invalid currency — NO TEST
    │
    └── refundPayment()
        ├── [★★  TESTED] Full refund — billing.test.ts:89
        └── [★   TESTED] Partial refund (checks non-throw only) — billing.test.ts:101

USER FLOW COVERAGE
===========================
[+] Payment checkout flow
    │
    ├── [★★★ TESTED] Complete purchase — checkout.e2e.ts:15
    ├── [GAP] [→E2E] Double-click submit — needs E2E, not just unit
    ├── [GAP]         Navigate away during payment — unit test sufficient
    └── [★   TESTED]  Form validation errors (checks render only) — checkout.test.ts:40

[+] Error states
    │
    ├── [★★  TESTED] Card declined message — billing.test.ts:58
    ├── [GAP]         Network timeout UX (what does user see?) — NO TEST
    └── [GAP]         Empty cart submission — NO TEST

[+] LLM integration
    │
    └── [GAP] [→EVAL] Prompt template change — needs eval test

─────────────────────────────────
COVERAGE: 5/13 paths tested (38%)
  Code paths: 3/5 (60%)
  User flows: 2/8 (25%)
QUALITY:  ★★★: 2  ★★: 2  ★: 1
GAPS: 8 paths need tests (2 need E2E, 1 needs eval)
─────────────────────────────────
```

**빠른 경로:** 모든 경로가 커버되면 → "Step 4.75: 모든 새 코드 경로에 테스트 커버리지가 있습니다 ✓" 계속 진행.

**Step 5. 격차에 대한 테스트를 생성합니다 (Fix-First):**

테스트 프레임워크가 감지되고 격차가 식별된 경우:
- 각 격차를 Fix-First Heuristic에 따라 AUTO-FIX 또는 ASK로 분류합니다:
  - **AUTO-FIX:** 순수 함수에 대한 단순 단위 테스트, 이미 테스트된 함수의 엣지 케이스
  - **ASK:** E2E 테스트, 새 테스트 인프라가 필요한 테스트, 모호한 동작에 대한 테스트
- AUTO-FIX 격차의 경우: 테스트를 생성하고 실행하고 `test: coverage for {feature}`로 commit
- ASK 격차의 경우: 다른 리뷰 finding과 함께 Fix-First 배치 질문에 포함
- [→E2E] 표시된 경로: 항상 ASK (E2E 테스트는 더 많은 노력이 필요하고 사용자 확인이 필요)
- [→EVAL] 표시된 경로: 항상 ASK (eval 테스트는 품질 기준에 대한 사용자 확인이 필요)

테스트 프레임워크가 감지되지 않은 경우 → 격차를 INFORMATIONAL finding으로만 포함, 생성하지 않음.

**diff가 테스트 전용 변경인 경우:** Step 4.75를 완전히 건너뜁니다: "새 애플리케이션 코드 경로가 없어 감사할 필요가 없습니다."

이 단계는 Pass 2의 "Test Gaps" 카테고리를 포함합니다 — checklist의 Test Gaps 항목과 이 커버리지 다이어그램 간에 finding을 중복하지 마세요. Step 4 및 Step 4.5의 finding과 함께 커버리지 격차를 포함합니다. 동일한 Fix-First 플로우를 따릅니다 — 격차는 INFORMATIONAL finding입니다.

---

## Step 5: Fix-First Review (수정 우선 리뷰)

**모든 finding에 조치를 취합니다 — critical만이 아닙니다.**

요약 헤더를 출력합니다: `Pre-Landing Review: N개 이슈 (X critical, Y informational)`

### Step 5a: 각 finding 분류

각 finding에 대해 checklist.md의 Fix-First Heuristic에 따라 AUTO-FIX 또는 ASK로 분류합니다. Critical finding은 ASK 쪽으로, informational finding은 AUTO-FIX 쪽으로 기울입니다.

### Step 5b: 모든 AUTO-FIX 항목 자동 수정

각 수정을 직접 적용합니다. 각 항목에 대해 한 줄 요약을 출력합니다:
`[AUTO-FIXED] [file:line] Problem → what you did`

### Step 5c: ASK 항목 일괄 질문

ASK 항목이 남아 있으면, 하나의 AskUserQuestion으로 제시합니다:

- 각 항목에 번호, 심각도 라벨, 문제, 권장 수정을 포함합니다
- 각 항목에 옵션을 제공합니다: A) 권장대로 수정, B) 건너뛰기
- 전체 RECOMMENDATION을 포함합니다

예시 형식:
```
I auto-fixed 5 issues. 2 need your input:

1. [CRITICAL] app/models/post.rb:42 — Race condition in status transition
   Fix: Add `WHERE status = 'draft'` to the UPDATE
   → A) Fix  B) Skip

2. [INFORMATIONAL] app/services/generator.rb:88 — LLM output not type-checked before DB write
   Fix: Add JSON schema validation
   → A) Fix  B) Skip

RECOMMENDATION: Fix both — #1 is a real race condition, #2 prevents silent data corruption.
```

ASK 항목이 3개 이하이면 배치 대신 개별 AskUserQuestion을 사용할 수 있습니다.

### Step 5d: 사용자 승인된 수정 적용

사용자가 "Fix"를 선택한 항목에 대해 수정을 적용합니다. 수정된 내용을 출력합니다.

ASK 항목이 없으면 (모두 AUTO-FIX), 질문을 완전히 건너뜁니다.

### Verification of claims (주장 검증)

최종 리뷰 출력을 작성하기 전에:
- "이 패턴은 안전하다"고 주장하면 → 안전성을 증명하는 특정 라인을 인용합니다
- "다른 곳에서 처리된다"고 주장하면 → 처리 코드를 읽고 인용합니다
- "테스트가 커버한다"고 주장하면 → 테스트 파일과 메서드를 명명합니다
- "아마 처리될 것이다" 또는 "아마 테스트되었을 것이다"라고 절대 말하지 마세요 — 검증하거나 미확인으로 표시합니다

**합리화 방지:** "괜찮아 보인다"는 finding이 아닙니다. 괜찮다는 증거를 인용하거나, 미확인으로 표시합니다.

### Greptile 코멘트 해결

자체 finding을 출력한 후, Step 2.5에서 Greptile 코멘트가 분류된 경우:

**Greptile 요약을 출력 헤더에 포함합니다:** `+ N Greptile comments (X valid, Y fixed, Z FP)`

코멘트에 답변하기 전에, greptile-triage.md의 **에스컬레이션 감지** 알고리즘을 실행하여 Tier 1 (친근한) 또는 Tier 2 (단호한) 답변 템플릿을 사용할지 결정합니다.

1. **VALID & ACTIONABLE 코멘트:** finding에 포함됩니다 — Fix-First 플로우를 따릅니다 (기계적이면 auto-fix, 아니면 ASK로 배치) (A: 지금 수정, B: 인정, C: 오탐). 사용자가 A(수정)를 선택하면, greptile-triage.md의 **Fix reply template**을 사용하여 답변합니다 (인라인 diff + 설명 포함). 사용자가 C(오탐)를 선택하면, **False Positive reply template**을 사용하여 답변하고 (증거 + 제안된 re-rank 포함), per-project 및 global greptile-history 모두에 저장합니다.

2. **FALSE POSITIVE 코멘트:** AskUserQuestion으로 각각 제시합니다:
   - Greptile 코멘트를 표시합니다: file:line (또는 [top-level]) + 본문 요약 + permalink URL
   - 왜 오탐인지 간결하게 설명합니다
   - 옵션:
     - A) Greptile에 왜 잘못되었는지 답변 (명확히 틀린 경우 권장)
     - B) 어쨌든 수정 (저비용이고 무해한 경우)
     - C) 무시 — 답변도 수정도 안 함

   사용자가 A를 선택하면, greptile-triage.md의 **False Positive reply template**을 사용하여 답변하고 (증거 + 제안된 re-rank 포함), per-project 및 global greptile-history 모두에 저장합니다.

3. **VALID BUT ALREADY FIXED 코멘트:** greptile-triage.md의 **Already Fixed reply template**을 사용하여 답변합니다 — AskUserQuestion 불필요:
   - 수행된 작업과 수정 commit SHA를 포함합니다
   - per-project 및 global greptile-history 모두에 저장합니다

4. **SUPPRESSED 코멘트:** 조용히 건너뜁니다 — 이전 분류에서 알려진 오탐입니다.

---

## Step 5.5: TODOS 교차 참조

`TODOS.md`를 저장소 루트에서 읽습니다 (존재하는 경우). PR을 열린 TODO와 교차 참조합니다:

- **이 PR이 열린 TODO를 닫는가?** 그렇다면, 출력에 해당 항목을 표기합니다: "이 PR은 TODO를 해결합니다: <제목>"
- **이 PR이 TODO가 되어야 할 작업을 생성하는가?** 그렇다면, informational finding으로 표시합니다.
- **이 리뷰에 컨텍스트를 제공하는 관련 TODO가 있는가?** 그렇다면, 관련 finding을 논의할 때 참조합니다.

TODOS.md가 존재하지 않으면, 이 단계를 조용히 건너뜁니다.

---

## Step 5.6: Documentation staleness check (문서 최신성 검사)

diff를 문서 파일과 교차 참조합니다. 저장소 루트의 각 `.md` 파일 (README.md, ARCHITECTURE.md, CONTRIBUTING.md, CLAUDE.md 등)에 대해:

1. diff의 코드 변경이 해당 문서 파일에 설명된 기능, 컴포넌트 또는 워크플로우에 영향을 미치는지 확인합니다.
2. 문서 파일이 이 branch에서 업데이트되지 않았지만 설명하는 코드가 변경된 경우, INFORMATIONAL finding으로 표시합니다:
   "문서가 오래되었을 수 있습니다: [파일]이 [기능/컴포넌트]를 설명하지만 이 branch에서 코드가 변경되었습니다. `/document-release` 실행을 고려하세요."

이것은 정보 제공용입니다 — critical이 아닙니다. 수정 조치는 `/document-release`입니다.

문서 파일이 없으면, 이 단계를 조용히 건너뜁니다.

---

## Step 5.7: Adversarial review (적대적 리뷰, 자동 조절)

적대적 리뷰의 철저함은 diff 크기에 따라 자동으로 조절됩니다. 설정이 필요 없습니다.

**diff 크기 및 도구 가용성 감지:**

```bash
DIFF_INS=$(git diff origin/<base> --stat | tail -1 | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
DIFF_DEL=$(git diff origin/<base> --stat | tail -1 | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo "0")
DIFF_TOTAL=$((DIFF_INS + DIFF_DEL))
which codex 2>/dev/null && echo "CODEX_AVAILABLE" || echo "CODEX_NOT_AVAILABLE"
# Respect old opt-out
OLD_CFG=$(~/.claude/skills/gstack/bin/gstack-config get codex_reviews 2>/dev/null || true)
echo "DIFF_SIZE: $DIFF_TOTAL"
echo "OLD_CFG: ${OLD_CFG:-not_set}"
```

`OLD_CFG`가 `disabled`이면: 이 단계를 조용히 건너뜁니다. 다음 단계로 진행합니다.

**사용자 오버라이드:** 사용자가 특정 티어를 명시적으로 요청한 경우 (예: "모든 패스 실행", "편집증 리뷰", "전체 적대적", "4패스 모두 수행", "철저한 리뷰"), diff 크기와 관계없이 해당 요청을 따릅니다. 해당 티어 섹션으로 이동합니다.

**diff 크기에 따른 자동 티어 선택:**
- **Small (변경 50줄 미만):** 적대적 리뷰를 완전히 건너뜁니다. 출력: "작은 diff ($DIFF_TOTAL줄) — 적대적 리뷰 건너뜀." 다음 단계로 진행합니다.
- **Medium (50-199줄 변경):** Codex 적대적 챌린지를 실행합니다 (Codex 사용 불가 시 Claude 적대적 서브에이전트로 대체). "Medium tier" 섹션으로 이동합니다.
- **Large (200줄 이상 변경):** 나머지 모든 패스를 실행합니다 — Codex 구조화 리뷰 + Claude 적대적 서브에이전트 + Codex 적대적. "Large tier" 섹션으로 이동합니다.

---

### Medium tier (50-199줄)

Claude의 구조화 리뷰는 이미 실행되었습니다. 이제 **크로스 모델 적대적 챌린지** 를 추가합니다.

**Codex 사용 가능한 경우:** Codex 적대적 챌린지를 실행합니다. **Codex 사용 불가능한 경우:** Claude 적대적 서브에이전트로 대체합니다.

**Codex 적대적:**

```bash
TMPERR_ADV=$(mktemp /tmp/codex-adv-XXXXXXXX)
codex exec "Review the changes on this branch against the base branch. Run git diff origin/<base> to see the diff. Your job is to find ways this code will fail in production. Think like an attacker and a chaos engineer. Find edge cases, race conditions, security holes, resource leaks, failure modes, and silent data corruption paths. Be adversarial. Be thorough. No compliments — just the problems." -s read-only -c 'model_reasoning_effort="xhigh"' --enable web_search_cached 2>"$TMPERR_ADV"
```

Bash 도구의 `timeout` 파라미터를 `300000` (5분)으로 설정합니다. macOS에는 `timeout` 셸 명령이 없으므로 사용하지 마세요. 명령 완료 후 stderr를 읽습니다:
```bash
cat "$TMPERR_ADV"
```

전체 출력을 그대로 제시합니다. 이것은 정보 제공용입니다 — 배포를 차단하지 않습니다.

**오류 처리:** 모든 오류는 논블로킹입니다 — 적대적 리뷰는 품질 향상이지 전제 조건이 아닙니다.
- **인증 실패:** stderr에 "auth", "login", "unauthorized", "API key"가 포함되면: "Codex 인증 실패. `codex login`을 실행하여 인증하세요."
- **타임아웃:** "Codex가 5분 후 타임아웃되었습니다."
- **빈 응답:** "Codex가 응답을 반환하지 않았습니다. Stderr: <관련 오류 붙여넣기>."

Codex 오류 발생 시, 자동으로 Claude 적대적 서브에이전트로 대체합니다.

**Claude 적대적 서브에이전트** (Codex 사용 불가 또는 오류 시 대체):

Agent 도구를 통해 디스패치합니다. 서브에이전트는 새로운 컨텍스트를 가집니다 — 구조화 리뷰의 checklist 편향이 없습니다. 이 진정한 독립성이 주 리뷰어가 놓치는 것을 잡습니다.

서브에이전트 프롬프트:
"Read the diff for this branch with `git diff origin/<base>`. Think like an attacker and a chaos engineer. Your job is to find ways this code will fail in production. Look for: edge cases, race conditions, security holes, resource leaks, failure modes, silent data corruption, logic errors that produce wrong results silently, error handling that swallows failures, and trust boundary violations. Be adversarial. Be thorough. No compliments — just the problems. For each finding, classify as FIXABLE (you know how to fix it) or INVESTIGATE (needs human judgment)."

finding을 `ADVERSARIAL REVIEW (Claude subagent):` 헤더 아래에 제시합니다. **FIXABLE finding** 은 구조화 리뷰와 동일한 Fix-First 파이프라인으로 흐릅니다. **INVESTIGATE finding** 은 informational로 제시됩니다.

서브에이전트가 실패하거나 타임아웃되면: "Claude 적대적 서브에이전트를 사용할 수 없습니다. 적대적 리뷰 없이 계속합니다."

**리뷰 결과 저장:**
```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"adversarial-review","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","status":"STATUS","source":"SOURCE","tier":"medium","commit":"'"$(git rev-parse --short HEAD)"'"}'
```
STATUS 대체: finding이 없으면 "clean", finding이 있으면 "issues_found". SOURCE: Codex가 실행됐으면 "codex", 서브에이전트가 실행됐으면 "claude". 둘 다 실패하면 저장하지 않습니다.

**정리:** 처리 후 `rm -f "$TMPERR_ADV"`를 실행합니다 (Codex가 사용된 경우).

---

### Large tier (200줄 이상)

Claude의 구조화 리뷰는 이미 실행되었습니다. 이제 최대 커버리지를 위해 **나머지 세 패스 모두** 를 실행합니다:

**1. Codex 구조화 리뷰 (사용 가능한 경우):**
```bash
TMPERR=$(mktemp /tmp/codex-review-XXXXXXXX)
codex review --base <base> -c 'model_reasoning_effort="xhigh"' --enable web_search_cached 2>"$TMPERR"
```

Bash 도구의 `timeout` 파라미터를 `300000` (5분)으로 설정합니다. macOS에는 `timeout` 셸 명령이 없으므로 사용하지 마세요. `CODEX SAYS (code review):` 헤더 아래에 출력을 제시합니다.
`[P1]` 마커를 확인합니다: 발견 → `GATE: FAIL`, 미발견 → `GATE: PASS`.

GATE가 FAIL이면, AskUserQuestion을 사용합니다:
```
Codex found N critical issues in the diff.

A) Investigate and fix now (recommended)
B) Continue — review will still complete
```

A 선택 시: finding을 해결합니다. `codex review`를 재실행하여 검증합니다.

오류에 대해 stderr를 읽습니다 (medium tier와 동일한 오류 처리).

stderr 후: `rm -f "$TMPERR"`

**2. Claude 적대적 서브에이전트:** 적대적 프롬프트로 서브에이전트를 디스패치합니다 (medium tier와 동일한 프롬프트). Codex 가용성과 관계없이 항상 실행됩니다.

**3. Codex 적대적 챌린지 (사용 가능한 경우):** 적대적 프롬프트로 `codex exec`를 실행합니다 (medium tier와 동일).

1번과 3번에서 Codex를 사용할 수 없으면, 사용자에게 알립니다: "Codex CLI를 찾을 수 없습니다 — large-diff 리뷰는 Claude 구조화 + Claude 적대적 (4패스 중 2패스)을 실행했습니다. 전체 4패스 커버리지를 위해 Codex를 설치하세요: `npm install -g @openai/codex`"

**모든 패스 완료 후 리뷰 결과를 저장합니다** (각 하위 단계 후가 아님):
```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"adversarial-review","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","status":"STATUS","source":"SOURCE","tier":"large","gate":"GATE","commit":"'"$(git rev-parse --short HEAD)"'"}'
```
대체: STATUS = 모든 패스에서 finding이 없으면 "clean", 어떤 패스에서든 이슈가 있으면 "issues_found". SOURCE = Codex가 실행됐으면 "both", Claude 서브에이전트만 실행됐으면 "claude". GATE = Codex 구조화 리뷰 gate 결과 ("pass"/"fail"), Codex 사용 불가 시 "informational". 모든 패스가 실패하면 저장하지 않습니다.

---

### Cross-model synthesis (크로스 모델 종합, medium 및 large 티어)

모든 패스 완료 후, 모든 소스의 finding을 종합합니다:

```
ADVERSARIAL REVIEW SYNTHESIS (auto: TIER, N lines):
════════════════════════════════════════════════════════════
  High confidence (found by multiple sources): [findings agreed on by >1 pass]
  Unique to Claude structured review: [from earlier step]
  Unique to Claude adversarial: [from subagent, if ran]
  Unique to Codex: [from codex adversarial or code review, if ran]
  Models used: Claude structured ✓  Claude adversarial ✓/✗  Codex ✓/✗
════════════════════════════════════════════════════════════
```

High-confidence finding (여러 소스가 합의한 것)을 수정 시 우선시합니다.

---

## Step 5.8: Eng Review 결과 저장

모든 리뷰 패스 완료 후, 최종 `/review` outcome을 저장하여 `/ship`이 이 branch에서 Eng Review가 실행되었음을 인식할 수 있게 합니다.

실행:

```bash
~/.claude/skills/gstack/bin/gstack-review-log '{"skill":"review","timestamp":"TIMESTAMP","status":"STATUS","issues_found":N,"critical":N,"informational":N,"commit":"COMMIT"}'
```

대체:
- `TIMESTAMP` = ISO 8601 datetime
- `STATUS` = Fix-First 처리 및 적대적 리뷰 후 미해결 finding이 없으면 `"clean"`, 아니면 `"issues_found"`
- `issues_found` = 총 미해결 finding 수
- `critical` = 미해결 critical finding 수
- `informational` = 미해결 informational finding 수
- `COMMIT` = `git rev-parse --short HEAD` 출력

실제 리뷰가 완료되기 전에 리뷰가 조기 종료되면 (예: base branch 대비 diff가 없는 경우), 이 항목을 **작성하지 마세요**.

## Important Rules (중요 규칙)

- **코멘트하기 전에 전체 diff를 읽으세요.** diff에서 이미 해결된 이슈를 표시하지 마세요.
- **수정 우선, 읽기 전용이 아닙니다.** AUTO-FIX 항목은 직접 적용합니다. ASK 항목은 사용자 승인 후에만 적용합니다. commit, push, PR 생성은 절대 하지 마세요 — 그것은 /ship의 역할입니다.
- **간결하게.** 문제 한 줄, 수정 한 줄. 서문 없이.
- **실제 문제만 표시합니다.** 괜찮은 것은 건너뜁니다.
- **greptile-triage.md의 Greptile 답변 템플릿을 사용합니다.** 모든 답변에 증거를 포함합니다. 모호한 답변을 절대 게시하지 마세요.
