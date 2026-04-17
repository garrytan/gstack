# Feature: Phase 3 — 검증 (다층 방어)

> 이 파일은 `/bams:feature`의 Phase 3을 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트
- slug: {엔트리포인트에서 결정된 slug}
- 이전 Phase 산출물:
  - `.crew/artifacts/prd/{slug}-prd.md`
  - `.crew/artifacts/design/{slug}-design.md`
  - `.crew/artifacts/implementation/{slug}-impl.md` (Phase 2 완료 요약)
  - 수정/생성된 소스 파일 목록

---

**bams-plugin 스킬 미설치 시**: Step 5, 6, 7을 일괄 `skipped (bams 스킬 미설치)` 처리 후 Step 8로.

**스킬 미설치 시 대체 행동**:
- **Step 5 (QA)**: AskUserQuestion — "수동 QA 체크리스트를 생성할까요? / Playwright 테스트 코드를 생성할까요? / 건너뛰기"
- **Step 6 (성능)**: AskUserQuestion — "Lighthouse CLI로 측정할까요? (`npx lighthouse <url> --output json`) / 건너뛰기"
- **Step 7 (보안)**: `/bams:review`에 보안 관점을 추가하여 코드 기반 보안 점검을 자동 수행합니다.
- **Step 9 (Ship)**: 수동 PR 생성 가이드 제공 — `git push` → `gh pr create` 명령어 안내
- **Step 11 (문서)**: CHANGELOG.md와 README.md 업데이트를 직접 수행합니다.

스킬 설치를 권장하는 메시지: "bams-plugin 스킬을 설치하면 이 단계를 자동화할 수 있습니다."

---

### Step 4. 5관점 코드 리뷰 (QA부장 위임)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 4 "5관점 코드 리뷰" "Phase 3: 검증"
```

이전 리뷰(24시간 이내, 이후 변경 없음) 있으면 `git diff HEAD`로 변경분만 리뷰.

**dev 리뷰 캐시**: `/bams:dev`에서 이미 리뷰 완료된 경우 `.crew/artifacts/review/[slug]-review.md`가 존재하고, 리뷰 이후 코드 변경이 없으면 (`git diff --stat [review-commit]..HEAD`가 비어있으면) **5관점 리뷰를 스킵**하고 기존 리뷰 결과를 재활용합니다. 변경이 있으면 변경분만 리뷰합니다.

리뷰 캐시가 없으면 **루프 B — Advisor 조언 후 메인이 qa-strategy 직접 spawn, QA부장은 내부에서 5관점 specialist 병렬 실행.**

### Step 4-a. pipeline-orchestrator 조언 요청 (Advisor)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-4-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7" "Step 4: 5관점 리뷰 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"** — **조언자 모드**:

> **Phase 3 Step 4 Advisor 호출 — 5관점 코드 리뷰 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 3
> slug: {slug}
> pipeline_type: feature
> prd: .crew/artifacts/prd/{slug}-prd.md
> design: .crew/artifacts/design/{slug}-design.md
> changed_files: [{수정/생성된 모든 파일 목록}]
> config: .crew/config.md
> ```
>
> **요청:** 메인이 직접 spawn할 부서장(qa-strategy 권고)과 위임 메시지 템플릿, 5관점(기능적 정확성, 보안, 성능, 코드 품질, 유지보수성) 커버리지 요구사항, Phase 3 게이트 기준을 Advisor Response로 반환하세요. 직접 spawn 금지(harness 깊이 2 제약).

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-4-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 4 Advisor 응답 수신"
```

### Step 4-b. 메인이 qa-strategy(QA부장) 직접 spawn

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "qa-strategy-4-$(date -u +%Y%m%d)" "qa-strategy" "claude-opus-4-7" "Step 4: 5관점 코드 리뷰"
```

Task tool, subagent_type: **"bams-plugin:qa-strategy"** — 메인이 직접 호출:

> **Phase 3 Step 4 — 5관점 병렬 코드 리뷰**
>
> ```
> task_description: "5관점 병렬 코드 리뷰를 실행하라"
> input_artifacts:
>   - .crew/artifacts/prd/{slug}-prd.md
>   - {변경된 파일 목록}
> expected_output:
>   type: review_report
>   paths: [.crew/artifacts/review/{slug}-review.md]
> quality_criteria:
>   - 5관점 모두 커버 (기능적 정확성, 보안, 성능, 코드 품질, 유지보수성)
>   - 심각도별 분류 (Critical/Major/Minor)
>   - 중복 제거
> gotchas:
>   - {관련 gotchas를 중점 확인 대상으로 전달}
> ```
>
> QA부장은 자신의 도메인 내에서 automation-qa specialist를 최대 1회 추가 spawn 가능(harness 깊이 2 한도). 5관점 리뷰는 QA부장 내부에서 단일 specialist 호출 또는 순차 분석으로 병합 처리합니다.
>
> **기대 산출물**: 5관점 리뷰 리포트

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "qa-strategy-4-$(date -u +%Y%m%d)" "qa-strategy" "success" {duration_ms} "Step 4 완료: 5관점 코드 리뷰 완료"
```

**Critical 이슈 발견 시:** 사용자에게 제시 후 수정+재리뷰 제안.

Step 4 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 4 "done" {duration_ms}
```

---

### Step 5-6-7. QA + 성능 + 보안 (QA부장 + 평가부장 병렬)

Bash로 다음을 동시에 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 5 "브라우저 QA" "Phase 3: 검증"
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 6 "성능 베이스라인" "Phase 3: 검증"
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 7 "보안 감사" "Phase 3: 검증"
```

**루프 B — Advisor 조언 후 메인이 qa-strategy + product-analytics 병렬 직접 spawn.**

### Step 5-6-7-a. pipeline-orchestrator 조언 요청 (Advisor)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-567-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7" "Step 5-6-7: QA/성능/보안 조언 요청"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"** — **조언자 모드**:

> **Phase 3 Step 5-6-7 Advisor 호출 — QA + 성능 + 보안 라우팅 권고**
>
> **컨텍스트:**
> ```
> phase: 3
> slug: {slug}
> pipeline_type: feature
> prd: .crew/artifacts/prd/{slug}-prd.md
> design: .crew/artifacts/design/{slug}-design.md
> changed_files: [{수정/생성된 모든 파일 목록}]
> config: .crew/config.md
> review_report: .crew/artifacts/review/{slug}-review.md
> ```
>
> **요청:** 병렬 spawn할 부서장 목록(qa-strategy — 브라우저 QA + 보안 감사, product-analytics — 성능 베이스라인 권고), 각 부서장별 위임 메시지 템플릿, 스킵 조건(보안 관련 파일 변경 없음, 기존 성능 베이스라인 존재), Phase 3 게이트 기준을 Advisor Response로 반환하세요. 직접 spawn 금지.

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-567-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 5-6-7 Advisor 응답 수신"
```

### Step 5-6-7-b. 메인이 QA부장 + 평가부장 병렬 직접 spawn (단일 메시지 복수 Task)

병렬 호출 전 2개의 agent_start를 일괄 emit (qa-strategy / product-analytics).

**단일 메시지에 2개 Task tool 호출을 묶어** 병렬 spawn합니다:

1. Task tool, subagent_type: **"bams-plugin:qa-strategy"** — 브라우저 QA + 보안 감사 (Step 5 + Step 7):

> **Step 5 — 브라우저 QA:**
> ```
> task_description: "브라우저 기반 QA 테스트를 실행하라"
> input_artifacts:
>   - .crew/artifacts/prd/{slug}-prd.md
>   - {config.md의 URL 정보}
> expected_output:
>   type: qa_report
>   paths: [.crew/artifacts/qa/{slug}-qa.md]
> quality_criteria:
>   - 핵심 유저 플로우 검증
>   - 스크린샷 포함
> ```
> URL 있으면 `_QA_SKILL` 실행. URL은 config.md에서 확인하거나 AskUserQuestion.
>
> **Step 7 — 보안 감사:**
> ```
> task_description: "보안 감사를 실행하라"
> input_artifacts:
>   - {변경된 파일 목록}
> expected_output:
>   type: security_report
>   paths: [.crew/artifacts/security/{slug}-security.md]
> quality_criteria:
>   - OWASP Top 10 체크
>   - 시크릿 노출 확인
> ```
> `git diff --name-only` 기반으로 보안 관련 파일(인증, 암호화, .env, 의존성 등) 변경 여부 확인. 변경 없으면 건너뜀. 변경 있거나 이전 감사 없으면 `_CSO_SKILL` 실행(일일 모드).
>
> QA부장은 automation-qa / defect-triage specialist를 최대 1회 추가 spawn 가능(harness 깊이 2).

2. Task tool, subagent_type: **"bams-plugin:product-analytics"** — 성능 베이스라인 (Step 6):

> **Step 6 — 성능 베이스라인:**
> ```
> task_description: "성능 베이스라인을 측정하라"
> input_artifacts:
>   - {config.md의 URL 정보}
> expected_output:
>   type: performance_report
>   paths: [.crew/artifacts/performance/{slug}-performance.md]
> quality_criteria:
>   - Core Web Vitals 측정
>   - 이전 베이스라인 대비 비교 (있는 경우)
> ```
> `performance-*.md` 중 `mode: baseline`, `status: completed` 파일 확인. 없으면 `_BENCHMARK_SKILL`로 `--baseline` 캡처, 있으면 비교 모드.
>
> 평가부장은 performance-evaluation specialist를 최대 1회 추가 spawn 가능.

병렬 완료 후 2개의 agent_end를 일괄 emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "qa-strategy-567-$(date -u +%Y%m%d)" "qa-strategy" "success" {duration_ms} "QA + 보안 감사 완료"
[ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "product-analytics-567-$(date -u +%Y%m%d)" "product-analytics" "success" {duration_ms} "성능 베이스라인 완료"
```

3개 결과를 모두 수집한 후, 각 Step의 완료 이벤트를 Bash로 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 5 "{status}" {duration_ms}
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 6 "{status}" {duration_ms}
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 7 "{status}" {duration_ms}
```
(`{status}`는 각 Step의 결과에 따라 `done` 또는 `skipped`)

---

### Step 8. CI/CD 프리플라이트 + 검증→배포 핸드오프

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 8 "CI/CD 프리플라이트" "Phase 3: 검증"
```

**루프 B — Advisor 조언 + 게이트 판정 후 메인이 platform-devops → cross-department-coordinator 순차/병렬 직접 spawn.**

### Step 8-a. pipeline-orchestrator 조언 요청 (Advisor)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-8-$(date -u +%Y%m%d)" "pipeline-orchestrator" "claude-opus-4-7" "Step 8: CI/CD + 검증→배포 게이트 조언"
```

Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"** — **조언자 모드**:

> **Phase 3 CI/CD + Phase 3 → Phase 4 Advisor 호출**
>
> **컨텍스트:**
> ```
> phase: 3→4 handoff
> slug: {slug}
> pipeline_type: feature
> prd: .crew/artifacts/prd/{slug}-prd.md
> review_report: .crew/artifacts/review/{slug}-review.md
> qa_report: .crew/artifacts/qa/{slug}-qa.md
> performance_report: .crew/artifacts/performance/{slug}-performance.md
> security_report: .crew/artifacts/security/{slug}-security.md
> config: .crew/config.md
> ```
>
> **요청:**
> 1. 메인이 spawn할 부서장 목록(platform-devops — CI/CD 프리플라이트 `/bams:verify`, cross-department-coordinator — 검증→배포 핸드오프 조율 권고)과 위임 메시지 템플릿.
> 2. Phase 3 완료 조건 판정(GO/NO-GO/CONDITIONAL-GO) — 테스트 전체 통과, QA 리포트 생성, 성능 기준 충족, 코드 리뷰 승인, 보안 스캔 통과.
>
> 직접 spawn 금지. Advisor Response로 반환.

반환 후 agent_end emit + Advisor Response 파싱 + CHAIN_VIOLATION 체크:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-8-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 8 Advisor 응답 수신"
```

### Step 8-b. 메인이 platform-devops 직접 spawn (CI/CD 프리플라이트)

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "platform-devops-8-$(date -u +%Y%m%d)" "platform-devops" "claude-opus-4-7" "Step 8: CI/CD 프리플라이트"
```

Task tool, subagent_type: **"bams-plugin:platform-devops"** — 메인이 직접 호출:

> **CI/CD 프리플라이트 실행 (`/bams:verify`)**
>
> - 빌드, 린트, 타입체크, 테스트 실행
> - FAIL 시 자동 수정(최대 2회) / 수동 / 무시 선택 — 결과 보고
>
> **기대 산출물**: CI/CD 결과 리포트

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "platform-devops-8-$(date -u +%Y%m%d)" "platform-devops" "success" {duration_ms} "Step 8 CI/CD 완료"
```

### Step 8-c. 메인이 cross-department-coordinator 직접 spawn (검증→배포 핸드오프)

Advisor 판정이 GO 또는 CONDITIONAL-GO인 경우에 진행. NO-GO이면 미충족 항목을 사용자에게 보고하고 해결 후 재시도.

Bash로 agent_start emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "cross-department-coordinator-8-$(date -u +%Y%m%d)" "cross-department-coordinator" "claude-opus-4-7" "Step 8: 검증→배포 핸드오프 조율"
```

Task tool, subagent_type: **"bams-plugin:cross-department-coordinator"** — 메인이 직접 호출:

> **Phase 3→4 핸드오프 조율**
>
> - QA부장/평가부장 산출물이 배포 단계에 올바르게 전달되는지 확인
> - 배포 대상 아티팩트, 릴리스 노트 입력 확인
>
> **기대 산출물**: 핸드오프 체크리스트 결과

반환 후 agent_end emit:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "cross-department-coordinator-8-$(date -u +%Y%m%d)" "cross-department-coordinator" "success" {duration_ms} "Step 8 검증→배포 핸드오프 완료"
```

**Phase 게이트 결과가 NO-GO이면**: 미충족 항목을 사용자에게 보고하고, 해결 후 재시도합니다.

AskUserQuestion — "모든 검증 완료. Ship 할까요?"
- **Ship (Recommended)**
- **검증까지만** — `status: paused_at_step_8` 기록 후 종료.

Step 8 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 8 "done" {duration_ms}
```
