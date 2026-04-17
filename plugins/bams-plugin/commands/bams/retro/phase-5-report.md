# Retro: Phase 5 — 보고

> 이 파일은 `/bams:retro`의 Phase 5를 실행합니다.
> 공통 규칙은 `_common.md`를 참조합니다.

## 입력 컨텍스트
- slug: {엔트리포인트에서 결정된 retro slug}
- TARGET_SCOPE: {recent5 / all / slug:{값} / since_{N}d}
- 전체 Phase 산출물:
  - `.crew/artifacts/retro/{slug}/phase1-pipeline-metrics.md`
  - `.crew/artifacts/retro/{slug}/phase1-agent-metrics.md`
  - `.crew/artifacts/retro/{slug}/phase2-kpt-consolidated.md`
  - `.crew/artifacts/retro/{slug}/phase3-quantitative-eval.md`
  - `.crew/artifacts/retro/{slug}/phase3-performance-eval.md`
  - `.crew/artifacts/retro/{slug}/phase3-cost-eval.md`
  - `.crew/artifacts/retro/{slug}/phase3-qualitative-{부서명}.md` (참여 부서장별)
  - `.crew/artifacts/retro/{slug}/phase4-improvements-summary.md`
  - `.crew/artifacts/retro/{slug}/phase4-improvement-{에이전트명}.md` (개선 대상별)

---

## Phase 5: 보고

Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" 10 "종합 보고서 생성" "Phase 5: 보고"
```

---

## Step 10: 종합 보고서

**2단 위임 — 루프 A**: orchestrator 조언 → 메인이 executive-reporter 직접 spawn.

**Step 10a: Advisor 호출** — Task tool, subagent_type: **"bams-plugin:pipeline-orchestrator"**, 조언자 모드. 컨텍스트: `.crew/artifacts/retro/{slug}/` 전체 Phase 1-4 산출물, retro-protocol.md. Advisor Response: 보고서 6개 섹션 검증, 신호등 임계값, 1페이지 요약 포맷, tracking.yml 스키마 재확인. spawn 지시 금지. (agent_start/end: `orchestrator-advisor-step10-{date}`)

**Step 10b: 메인이 executive-reporter 직접 spawn**

Bash로 agent_start를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "executive-reporter-10-$(date -u +%Y%m%d)" "executive-reporter" "claude-opus-4-7" "Step 10: 종합 보고서 생성"
```

서브에이전트 실행 (Task tool, subagent_type: **"bams-plugin:executive-reporter"**):

> **Phase 5 Step 10 — 종합 보고서 생성**
>
> **위임 메시지:**
> ```
> task_description: "회고/평가/개선 전체 결과를 종합 보고서로 작성하라"
> input_artifacts: [Phase 1-4 전체 산출물 목록]
> expected_output:
>   - path: .crew/artifacts/retro/{slug}/phase5-retro-report.md  (종합 보고서)
>   - path: .crew/artifacts/retro/{slug}/phase5-retro-summary.md  (1페이지 요약)
> quality_criteria:
>   - 보고서 구성 6개 섹션 모두 포함 (아래 명시)
>   - 신호등 체계 (Green/Yellow/Red) 사용
>   - 에이전트별 등급표 포함
>   - KPT 건수 명시 (Keep N, Problem N, Try N)
>   - 개선 실행 결과 명시 (승인 N건 / 적용 N건 / 보류 N건)
> ```
>
> **보고서 구성 (`phase5-retro-report.md`):**
> 1. **요약 대시보드** — 신호등 체계 (Green: 이상 없음 / Yellow: 권장 조치 / Red: 즉시 조치)
>    - 분석 파이프라인 수
>    - 전체 Step 성공률
>    - 에이전트 등급 분포 (A/B/C/D 건수)
>    - 개선 적용 현황 (승인/적용/보류)
> 2. **분석 대상 파이프라인 목록** — slug, 실행 일시, 총 소요 시간
> 3. **에이전트별 평가 결과** — 정량 등급표 + 정성 핵심 코멘트
> 4. **KPT 종합** — Keep N건 핵심 항목 / Problem N건 우선순위 순 / Try N건 실행 계획
> 5. **개선 실행 결과** — 적용된 변경 사항 목록 + diff 요약 / 보류된 개선안 경로
> 6. **다음 retro 권장 사항** — 다음 실행 권장 시점, 우선 점검 에이전트, 미해결 액션 아이템
>
> **1페이지 요약 (`phase5-retro-summary.md`):**
> - 회고 요약 (KPT 핵심 3줄 — Keep 1줄, Problem 1줄, Try 1줄)
> - 에이전트 평가 결과 (등급표 축약)
> - 개선 실행 결과 (승인/적용/보류 건수)
> - 다음 파이프라인 권장 사항 (2줄 이내)
>
> **tracking 파일 기록 (retro-protocol.md §6-2 형식):**
> `.crew/artifacts/retro/{slug}/` 내 tracking.yml 또는 해당 파이프라인의 tracking 파일에
> 아래 형식으로 기록합니다:
> ```yaml
> retro:
>   conducted_at: {ISO timestamp}
>   scope: {TARGET_SCOPE}
>   pipelines_analyzed: {N}
>   keep_count: {N}
>   problem_count: {N}
>   try_count: {N}
>   action_items:
>     - description: "..."
>       assignee: "{에이전트명}"
>       target: "다음 파이프라인"
>       status: pending
>   lessons_saved: [{에이전트 목록}]
>   gotchas_promoted: {N}
>   learnings_updated: {N}
> ```
>
> **기대 산출물**:
> - `.crew/artifacts/retro/{slug}/phase5-retro-report.md`
> - `.crew/artifacts/retro/{slug}/phase5-retro-summary.md`
> - tracking 파일 retro 섹션 기록

Bash로 agent_end를 emit합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "executive-reporter-10-$(date -u +%Y%m%d)" "executive-reporter" "success" {duration_ms} "Step 10 완료: 종합 보고서 생성"
```

Phase 5 완료 시, Bash로 다음을 실행합니다:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" 10 "done" {duration_ms}
```

---

## 최종 요약 제시

phase5-retro-summary.md 내용을 Read하여 대화창에 직접 출력합니다.

출력 형식:

```
## /bams:retro 완료 — {slug}

### 분석 결과
- 분석 파이프라인: {N}개
- 에이전트 등급 분포: A {N}건 / B {N}건 / C {N}건 / D {N}건

### KPT 핵심
- Keep: {핵심 항목 1줄}
- Problem: {핵심 항목 1줄}
- Try: {핵심 항목 1줄}

### 개선 실행
- 승인: {N}건 / 적용 완료: {N}건 / 보류: {N}건

### 산출물 경로
- 종합 보고서: .crew/artifacts/retro/{slug}/phase5-retro-report.md
- 1페이지 요약: .crew/artifacts/retro/{slug}/phase5-retro-summary.md
```

---

## Step 11: 오래된 retro 아티팩트 정리

7일 이상 경과한 retro 아티팩트를 자동 삭제합니다.

Bash로 다음을 실행합니다:
```bash
echo "[retro] 7일 이상 된 retro 아티팩트 정리 시작..."
RETRO_DIR=".crew/artifacts/retro"
if [ -d "$RETRO_DIR" ]; then
  CLEANED=0
  for d in "$RETRO_DIR"/*/; do
    [ ! -d "$d" ] && continue
    # 디렉터리 내 가장 최근 파일의 수정 시간 확인
    LATEST=$(find "$d" -type f -newer "$d" -o -type f 2>/dev/null | head -1)
    if [ -z "$LATEST" ]; then
      LATEST=$(find "$d" -type f 2>/dev/null | head -1)
    fi
    if [ -n "$LATEST" ]; then
      # 7일(604800초) 이상 경과했는지 확인
      FILE_AGE=$(( $(date +%s) - $(stat -f %m "$LATEST" 2>/dev/null || stat -c %Y "$LATEST" 2>/dev/null || echo 0) ))
      if [ "$FILE_AGE" -gt 604800 ]; then
        echo "[retro] 삭제: $(basename "$d") ($(( FILE_AGE / 86400 ))일 경과)"
        rm -rf "$d"
        CLEANED=$((CLEANED + 1))
      fi
    fi
  done
  echo "[retro] 정리 완료: ${CLEANED}개 디렉터리 삭제"
else
  echo "[retro] retro 아티팩트 디렉터리 없음 — 스킵"
fi
```

---

## HR 보고서 자동 변환

Phase 5 보고서 생성이 완료되면, retro 결과를 HR JSON + DB로 자동 변환합니다:

```bash
echo "[retro] HR 보고서 자동 변환 시작..."
bun -e "
  import { convertRetroToHR } from './plugins/bams-plugin/tools/bams-viz/src/lib/retro-to-hr.ts';
  try {
    convertRetroToHR('{slug}', '.crew');
    console.log('[retro] HR 보고서 변환 완료 (JSON + DB)');
  } catch (e) {
    console.warn('[retro] HR 변환 실패 (비치명적):', e.message);
  }
"
```

---

## 분석 완료 마커 기록

HR DB 변환 완료 후, 이번 retro에서 분석한 파이프라인 slug를 `.retro-analyzed` 마커 파일에 기록합니다.
이벤트 JSONL 파일은 **삭제하지 않고 보존**합니다 (viz DAG/Gantt/Traces 데이터 보존).

Bash로 다음을 실행합니다:
```bash
echo "[retro] 분석 완료 마커 기록 시작..."
METRICS_FILE=".crew/artifacts/retro/{slug}/phase1-pipeline-metrics.md"
PIPELINE_DIR=~/.bams/artifacts/pipeline
MARKER_FILE="${PIPELINE_DIR}/.retro-analyzed"
MARKED=0
SKIPPED=0

if [ -f "$METRICS_FILE" ]; then
  # 마크다운 테이블에서 slug 추출 (헤더/구분선 제외, 첫 번째 데이터 컬럼)
  SLUGS=$(awk -F'|' '
    NR > 1 && !/^[[:space:]]*\|[[:space:]]*[-]+/ && NF > 2 {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      if ($2 != "" && $2 != "slug" && $2 != "항목" && $2 != "type" && $2 != "순서") print $2
    }
  ' "$METRICS_FILE" | grep -E '^(debug|dev|feature|hotfix|plan|ship|retro)_' | sort -u)

  if [ -z "$SLUGS" ]; then
    echo "[retro] WARNING: phase1-pipeline-metrics.md에서 slug를 추출할 수 없음 — 스킵"
  else
    # 마커 파일이 없으면 생성
    [ ! -f "$MARKER_FILE" ] && touch "$MARKER_FILE"

    SLUG_COUNT=$(echo "$SLUGS" | wc -l | tr -d ' ')
    echo "[retro] 분석된 파이프라인: ${SLUG_COUNT}개"
    while IFS= read -r PIPELINE_SLUG; do
      # 중복 방지: 이미 마커에 기록된 slug는 스킵
      if grep -qxF "$PIPELINE_SLUG" "$MARKER_FILE" 2>/dev/null; then
        echo "[retro]   스킵 (이미 마커 기록됨): ${PIPELINE_SLUG}"
        SKIPPED=$((SKIPPED + 1))
      else
        echo "$PIPELINE_SLUG" >> "$MARKER_FILE"
        echo "[retro]   마커 기록: ${PIPELINE_SLUG}"
        MARKED=$((MARKED + 1))
      fi
    done <<< "$SLUGS"
    echo "[retro] 마커 기록 완료: 기록 ${MARKED}건, 스킵 ${SKIPPED}건"
  fi
else
  echo "[retro] WARNING: ${METRICS_FILE} 없음 — 마커 기록 스킵"
fi
```

---

## pipeline_end emit

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "completed"
```

---

## retro 이벤트 파일 정리

retro 파이프라인은 viz DAG/Gantt/Timeline에 표시할 필요가 없으므로 pipeline_end emit 직후 이벤트 파일을 삭제합니다.

Bash로 다음을 실행합니다:
```bash
# retro 파이프라인은 viz에 표시할 필요 없으므로 이벤트 파일 삭제
_RETRO_EVENTS_FILE=~/.bams/artifacts/pipeline/{slug}-events.jsonl
if [ -f "$_RETRO_EVENTS_FILE" ]; then
  rm -f "$_RETRO_EVENTS_FILE"
  echo "[retro] viz 이벤트 파일 정리 완료: ${_RETRO_EVENTS_FILE}"
else
  echo "[retro] viz 이벤트 파일 없음 — 스킵: ${_RETRO_EVENTS_FILE}"
fi
```
