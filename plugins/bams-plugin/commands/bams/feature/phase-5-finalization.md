# Feature: Phase 5 — 마무리

> 이 파일은 `/bams:feature`의 Phase 5 및 Phase 5.5를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다 (엔트리포인트에서 이미 로드됨).

## 입력 컨텍스트
- slug: {엔트리포인트에서 결정된 slug}
- 이전 Phase 산출물:
  - PR 번호 (Step 9 결과)
  - 배포 결과 (Step 10 결과, 선택)
  - `.crew/artifacts/` 전체

---

### Step 11. 문서 갱신 (기획부장 위임) — Ship 직후 시작

**최적화**: 문서 갱신은 Deploy(Step 10)와 독립적이므로, **Step 9(Ship) 완료 직후 백그라운드로 시작**합니다.
Step 10(Deploy) 선택 시 문서 갱신과 배포가 병렬로 진행됩니다.

**스킬 미설치 시**: Step 11 `skipped`.

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 11 "문서 갱신" "Phase 5: 마무리"
```

pipeline-orchestrator에게 문서 갱신을 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-11-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "Step 11: 문서 갱신 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 5 마무리 실행 — 문서 갱신**
>
> **위임 메시지:**
> ```
> phase: 5
> slug: {slug}
> pipeline_type: feature
> context:
>   all_artifacts: .crew/artifacts/
>   config: .crew/config.md
> ```
>
> **수행할 작업:**
> product-strategy(기획부장)에게 문서 갱신을 위임합니다:
>
> ```
> task_description: "Ship된 피처에 맞춰 프로젝트 문서를 갱신하라"
> input_artifacts:
>   - .crew/artifacts/prd/{slug}-prd.md
>   - .crew/artifacts/design/{slug}-design.md
> expected_output:
>   type: documentation_update
>   paths: [README.md, CHANGELOG.md, ARCHITECTURE.md]
> quality_criteria:
>   - README.md 피처 반영
>   - CHANGELOG.md 엔트리 추가
>   - 아키텍처 문서 변경 반영 (해당 시)
> ```
>
> 기획부장은 `_DOCRELEASE_SKILL`을 활용하여 문서를 갱신합니다.
>
> **기대 산출물**: 갱신된 문서 파일 목록

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-11-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 11 완료: 문서 갱신 완료"
```

Step 11 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 11 "{status}" {duration_ms}
```

---

### Step 12. 스프린트 종료 (project-governance 위임)

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 12 "스프린트 종료" "Phase 5: 마무리"
```

pipeline-orchestrator에게 스프린트 종료를 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-12-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "Step 12: 스프린트 종료 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 5 마무리 실행 — 스프린트 종료**
>
> **위임 메시지:**
> ```
> phase: 5
> slug: {slug}
> pipeline_type: feature
> context:
>   board: .crew/board.md
>   config: .crew/config.md
> ```
>
> **수행할 작업:**
> project-governance에게 스프린트 종료를 위임합니다:
>
> ```
> task_description: "이 피처의 스프린트를 종료하라"
> input_artifacts:
>   - .crew/board.md
> expected_output:
>   type: sprint_closure
>   paths: [.crew/board.md]
> quality_criteria:
>   - 모든 태스크가 Done으로 이동
>   - 스프린트 통계 기록
> ```
>
> `.crew/board.md`에서 이 feature의 모든 태스크 완료 시 `/bams:sprint close` 제안.
>
> **기대 산출물**: 스프린트 종료 결과, 업데이트된 board.md

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-12-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 12 완료: 스프린트 종료 완료"
```

Step 12 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 12 "done" {duration_ms}
```

---

### Step 13. 자동 강제 회고 (executive-reporter + 부서장들)

**이 단계는 건너뛸 수 없습니다. 자동으로 강제 실행됩니다.**

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 13 "자동 강제 회고" "Phase 5: 마무리"
```

pipeline-orchestrator에게 회고를 지시합니다.

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "pipeline-orchestrator-13-$(date -u +%Y%m%d)" "pipeline-orchestrator" "sonnet" "Step 13: 자동 강제 회고 위임"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, model: **"sonnet"**):

> **Phase 5 자동 강제 회고 실행**
>
> retro-protocol.md에 따라 파이프라인 회고를 **반드시** 실행합니다. 이 단계는 스킵할 수 없습니다.
>
> **위임 메시지:**
> ```
> phase: 5-retro
> slug: {slug}
> pipeline_type: feature
> context:
>   all_artifacts: .crew/artifacts/
>   board: .crew/board.md
>   history: .crew/history.md
>   review_report: .crew/artifacts/review/{slug}-review.md
>   evaluation_report: .crew/artifacts/evaluation/{slug}-eval.md
>   qa_report: .crew/artifacts/qa/{slug}-qa.md
>   performance_report: .crew/artifacts/performance/{slug}-performance.md
>   security_report: .crew/artifacts/security/{slug}-security.md
> ```
>
> **수행할 작업 (retro-protocol.md 절차):**
> 1. executive-reporter에게 정량 데이터 수집 요청:
>    - 총 소요 시간, Phase별 소요 시간
>    - Step 성공률, 재시도 횟수
>    - 에이전트별 호출 통계
>    - 품질 지표 요약 (리뷰 Critical/Major/Minor 건수, QA 결과, 성능 수치, 보안 스캔 결과)
>    - 이전 3회 feature 파이프라인 대비 트렌드
>
> 2. 각 부서장에게 KPT 항목 제출 요청: Keep(유지), Problem(문제), Try(시도).
>    이 파이프라인에 참여한 부서장만 대상:
>    - 기획부장 (Phase 1 참여)
>    - 개발부장 (Phase 2 참여)
>    - QA부장 (Phase 3 참여)
>    - 평가부장 (Phase 3 참여, 해당 시)
>
> 3. 합의 도출:
>    - 수집된 KPT를 종합하여 Problem 우선순위 정렬
>    - 액션 아이템 확정
>    - 교차 검증
>
> 4. 피드백 반영:
>    - 에이전트 교훈 저장
>    - gotchas 승격 검사
>    - Pipeline Learnings 갱신
>    - 프로세스 개선 제안
>
> 5. 보드 및 히스토리 업데이트:
>    - 완료된 모든 태스크를 board.md의 `## Done`으로 이동
>    - **DB 상태 업데이트 (board.md Done 이동과 동시에 실행)**: `~/.claude/plugins/marketplaces/my-claude/bams.db`가 존재하면 각 태스크의 상태를 `done`으로 업데이트한다:
>      ```bash
>      if [ -f "$HOME/.claude/plugins/marketplaces/my-claude/bams.db" ]; then
>        bun -e "
>          import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
>          const db = new TaskDB();
>          // 완료된 각 태스크 ID에 대해 호출:
>          // db.updateTaskStatus('{task_id}', 'done', 'pipeline-orchestrator');
>          db.close();
>        "
>      fi
>      ```
>    - `.crew/history.md`에 타임스탬프와 함께 추가
>    - board.md의 `> Last updated:` 업데이트
>
> 6. 회고 결과를 tracking 파일에 기록
>
> **기대 산출물**: 회고 결과 (KPT 요약, 액션 아이템, 피드백 반영 내역), 업데이트된 board.md/history.md

orchestrator 반환 후, Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "pipeline-orchestrator-13-$(date -u +%Y%m%d)" "pipeline-orchestrator" "success" {duration_ms} "Step 13 완료: 회고 완료"
```

Step 13 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 13 "done" {duration_ms}
```

---

## Phase 5.5: CLAUDE.md 상태 업데이트

`CLAUDE.md`의 `## Bams 현재 상태` 섹션을 업데이트합니다 (없으면 파일 끝에 추가, 있으면 Edit으로 교체). `.crew/board.md`를 읽어 다음을 포함:
- 마지막 업데이트 타임스탬프
- 진행 중인 작업
- 활성 스프린트 정보
- 이번 실행에서 생성된 아티팩트 경로
- 다음에 실행 가능한 태스크/명령 제안

---

## 롤백 시스템

### 롤백 포인트 기록
각 Phase 완료 시 tracking 파일에 롤백 정보를 자동 기록합니다:
- **Phase 2 완료**: `commit_before` (구현 시작 전 커밋 해시), `branch`, `files_created`
- **Phase 4 완료**: `pr_number`, `version_bump` (있는 경우)

### 롤백 실행
AskUserQuestion에서 "롤백" 선택 시:
1. **Phase 4 롤백**: PR 닫기 → 버전 범프 리버트 → CHANGELOG 리버트
2. **Phase 2 롤백**: `git reset --soft {commit_before}` → 변경사항 스태시 저장
3. 트래킹 파일에 `status: rolled_back` 기록

---

## 마무리

### 최종 요약 제시

피처명, 생성/수정 파일 목록, 테스트 파일 목록, 리뷰 이슈 요약, QA 결과, 성능 수치, 보안 스캔 결과, 성과 지표, 회고 KPT 요약, 아티팩트 경로, 완료 태스크 수, PR 번호 (있는 경우).

### Viz 이벤트: pipeline_end

파이프라인 종료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "{status}" {total} {completed} {failed} {skipped}
```
(`{status}`는 `completed` / `paused` / `failed` 중 하나, `{total}`은 13)

**`references/completion-protocol.md` 참조.** 표준 프로토콜을 따릅니다.

이 파이프라인의 Learnings 카테고리:
1. `pattern:` — 새로 도입한 패턴/라이브러리
2. `convention:` — 리뷰(Step 4)에서 발견된 코드 컨벤션
3. `vulnerable:` — 보안 감사(Step 7)/리뷰에서 반복 지적된 영역
4. `perf-baseline:` — 벤치마크(Step 6) 수치
5. `deploy:` — Ship/Deploy 결과 요약
