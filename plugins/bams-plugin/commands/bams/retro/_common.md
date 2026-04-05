# Retro: 공통 규칙

> 이 파일은 `/bams:retro` 파이프라인의 공통 규칙을 정의합니다.
> 엔트리포인트(`retro.md`)에서 모든 Phase 실행 전 Read하여 로드합니다.

---

## 공통 규칙 로드

**반드시 `plugins/bams-plugin/commands/bams/_shared_common.md`를 Read하여 공통 규칙을 로드합니다.**

---

## 산출물 경로 상수

모든 Phase에서 다음 경로 상수를 사용합니다:

| 상수 | 경로 | 설명 |
|------|------|------|
| `RETRO_ARTIFACTS_DIR` | `.crew/artifacts/retro/` | retro 산출물 기본 경로 |
| `PIPELINE_EVENTS_DIR` | `~/.bams/artifacts/pipeline/` | 파이프라인 이벤트 JSONL |
| `AGENT_LOGS_DIR` | `~/.bams/artifacts/agents/` | 에이전트 실행 로그 |
| `AGENT_DEFS_DIR` | `plugins/bams-plugin/agents/` | 에이전트 정의 파일 |
| `RETRO_PROTOCOL` | `plugins/bams-plugin/references/retro-protocol.md` | KPT 프레임워크 참조 |

---

## ★ 자기 참조 방지 규칙

retro 파이프라인(retro_* 또는 retro-* slug)의 이벤트 JSONL은 분석 대상에서 제외한다.
Phase 1에서 `~/.bams/artifacts/pipeline/*.jsonl`을 파싱할 때 `retro`로 시작하는 파일명은 건너뛴다.

이유: retro 파이프라인 자체의 에이전트 호출이 다음 회고의 분석 데이터에 포함되면
pipeline-orchestrator의 등급이 회고 반복 시 계속 하락하는 자기 참조 문제 발생.

---

## Phase 게이트 공통 절차

각 Phase 완료 후 pipeline-orchestrator가 다음 순서로 게이트를 확인합니다:

1. 필수 산출물이 `RETRO_ARTIFACTS_DIR/{slug}/` 에 모두 생성되었는가
2. Critical 이슈(에러 상태)가 0건인가
3. viz `step_end` 이벤트가 해당 Phase의 모든 Step에 emit되었는가

결과:
- **GO**: 모든 항목 통과 → 다음 Phase 진행
- **CONDITIONAL-GO**: 필수 통과, 권장 미충족 → 이슈 기록 후 진행
- **NO-GO**: 필수 미충족 → 재작업 지시 또는 에스컬레이션

---

## 아티팩트 보존 정책

- retro 아티팩트(`.crew/artifacts/retro/{slug}/`)는 **7일** 동안 보존됩니다
- Phase 5 완료 시 7일 이상 경과한 retro 디렉터리를 자동 삭제합니다
- 에이전트 정의 파일(`agents/*.md`)에 적용된 개선 사항은 영구 보존됩니다
- `.crew/gotchas.md`에 승격된 항목도 영구 보존됩니다
- **retro 이벤트 JSONL(`~/.bams/artifacts/pipeline/{slug}-events.jsonl`)은 `pipeline_end` emit 직후 즉시 삭제합니다** — retro 파이프라인은 viz DAG/Gantt/Timeline에 표시하지 않습니다
- **분석 대상 파이프라인 이벤트(`~/.bams/artifacts/pipeline/{analyzed-slug}-events.jsonl`)는 HR DB 변환 완료 직후 삭제합니다** — retro 결과가 HR DB에 영속화된 후 소스 이벤트는 불필요합니다
- 보존 기간 변경이 필요하면 이 파일의 정책을 수정하세요
