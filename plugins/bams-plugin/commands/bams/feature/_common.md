# Feature: 공통 규칙

> 이 파일은 `/bams:feature` 파이프라인의 공통 규칙을 정의합니다.
> 엔트리포인트(`feature.md`)에서 모든 Phase 실행 전 Read하여 로드합니다.

---

## TaskDB 연동 (DB가 존재하면 board.md 대신 DB 사용)

`.crew/db/bams.db`가 존재하면 DB를 우선 사용합니다:

```bash
# DB 존재 확인
if [ -f ".crew/db/bams.db" ]; then
  echo "[bams-db] DB 모드 활성화"
fi
```

**태스크 등록 시 (DB가 존재하면):** Bash로 bun 스크립트를 실행하여 TaskDB에 태스크를 등록합니다.

```bash
if [ -f ".crew/db/bams.db" ]; then
  bun -e "
    import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
    const db = new TaskDB('.crew/db/bams.db');
    db.createTask({ pipeline_slug: '{slug}', title: '{task_title}', status: 'in_progress', assignee_agent: '{agent}', phase: {phase} });
    db.close();
  "
fi
```

**파이프라인 완료 시 (DB가 존재하면):** board.md를 DB 스냅샷으로 갱신합니다.

```bash
if [ -f ".crew/db/bams.db" ]; then
  bun run plugins/bams-plugin/tools/bams-db/sync-board.ts {slug} --write
fi
```

DB가 없으면 기존 board.md 방식을 유지합니다.

---

## 스킬 로딩

```bash
_BROWSE_SKILL=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/skills/browse/SKILL.md" 2>/dev/null | head -1)
_QA_SKILL=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/skills/qa-only/SKILL.md" 2>/dev/null | head -1)
_BENCHMARK_SKILL=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/skills/benchmark/SKILL.md" 2>/dev/null | head -1)
_CSO_SKILL=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/skills/cso/SKILL.md" 2>/dev/null | head -1)
_SHIP_SKILL=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/skills/ship/SKILL.md" 2>/dev/null | head -1)
_DEPLOY_SKILL=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/skills/land-and-deploy/SKILL.md" 2>/dev/null | head -1)
_DOCRELEASE_SKILL=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/skills/document-release/SKILL.md" 2>/dev/null | head -1)
_RETRO_SKILL=$(find ~/.claude/plugins/cache -path "*/bams-plugin/*/skills/retro/SKILL.md" 2>/dev/null | head -1)
```

`_BROWSE_SKILL`이 비어있으면 bams-plugin 스킬 미설치로 판단. 해당 단계를 대체 행동으로 처리합니다.

---

## ★ Viz Agent 이벤트 규칙

**`references/viz-agent-protocol.md` 참조.** 모든 서브에이전트 호출 전후에 반드시 agent_start/agent_end 이벤트를 emit한다. orchestrator 내부에서 부서장/에이전트를 호출할 때도 동일하게 적용한다.

**호출 직전:**
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_start "{slug}" "{call_id}" "{agent_type}" "{model}" "{description}"
```

**호출 직후:**
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1); [ -n "$_EMIT" ] && bash "$_EMIT" agent_end "{slug}" "{call_id}" "{agent_type}" "{status}" {duration_ms} "{result_summary}"
```

- `{call_id}` 형식: `{agent_type}-{step_number}-{timestamp}` (예: `pipeline-orchestrator-1-20260403`)
- `{status}`: `success` / `error` / `timeout`

### ★ Step 이벤트 필수 규칙 (DAG/Gantt 표시용)

DAG와 Gantt 차트는 `step_start`/`step_end` 이벤트에 의존합니다. 에이전트 호출만으로는 표시되지 않습니다.

**모든 Phase는 반드시 step_start로 시작하고 step_end로 끝나야 합니다:**
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
# Phase 시작
[ -n "$_EMIT" ] && bash "$_EMIT" step_start "{slug}" {step_number} "{step_name}" "{phase_name}"
# ... 에이전트 호출 ...
# Phase 종료
[ -n "$_EMIT" ] && bash "$_EMIT" step_end "{slug}" {step_number} "done" {duration_ms}
```

step 이벤트 없이 agent 이벤트만 emit하면 DAG/Gantt에 표시되지 않습니다.


---

## ★ 위임 원칙 — 커맨드 레벨 직접 수정 금지

**이 커맨드에서 직접 Read/Edit/Write로 코드를 수정하지 않는다.**
모든 코드 수정은 `pipeline-orchestrator → 부서장 → 에이전트` 위임 체계를 통해 수행한다.

- 허용: Bash, Glob으로 상태 확인, viz 이벤트 emit, 사용자 질문
- 금지: Edit/Write로 소스 코드 직접 변경
- **위반 시**: 즉시 중단하고 pipeline-orchestrator에게 해당 작업을 위임할 것

---

## bams-server 자동 기동 (C1 Control Plane)

파이프라인 시작 전 bams-server가 실행 중인지 확인하고 필요시 백그라운드로 기동한다.

```bash
# bams-server 포트(3099) 확인
if ! curl -sf http://localhost:3099/health > /dev/null 2>&1; then
  echo "[bams] Control Plane 서버 기동 중..."
  nohup bun run plugins/bams-plugin/server/src/app.ts > /tmp/bams-server.log 2>&1 &
  echo "[bams] PID: $! — 로그: /tmp/bams-server.log"
  sleep 1
  if curl -sf http://localhost:3099/health > /dev/null 2>&1; then
    echo "[bams] Control Plane 서버 기동 완료 (http://localhost:3099)"
  else
    echo "[bams] WARNING: 서버 기동 실패 — 파일 fallback 모드로 진행"
  fi
else
  echo "[bams] Control Plane 서버 이미 실행 중 (http://localhost:3099)"
fi
```

---

## ★ Pipeline 종료 보장 규칙

파이프라인이 어떤 Phase에서 완료되든, 마지막 Phase를 실행하는 pipeline-orchestrator는 반드시 `pipeline_end` 이벤트를 emit해야 합니다.

- Phase 5까지 완주 시: Phase 5에서 pipeline_end emit (기존 동작)
- 중간 Phase에서 완료 시 (사용자가 "여기까지만" 선택): 해당 Phase의 orchestrator가 pipeline_end emit
- 에러/중단 시: pipeline_end status="failed" 또는 "paused" emit

```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" pipeline_end "{slug}" "{status}"
```

**이 규칙을 위반하면 viz에서 파이프라인이 영원히 "진행 중"으로 표시됩니다.**
