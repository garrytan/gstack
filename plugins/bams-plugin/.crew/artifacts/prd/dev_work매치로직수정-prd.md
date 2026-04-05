# PRD: Work Unit 매칭 로직 수정

**pipeline_slug**: dev_work매치로직수정  
**작성일**: 2026-04-05  
**작성자**: product-strategy  
**상태**: Draft

---

## 1. 배경 및 문제

### 현황

파이프라인 시작 시 (`pipeline_start` 이벤트 emit), `bams-viz-emit.sh`의 `wu_latest_slug()` 함수가 `/tmp/bams-active-workunits.json`에서 **가장 마지막에 시작된** work unit을 자동으로 선택한다.

```
# bams-viz-emit.sh line 89
ACTIVE_WU=$(wu_latest_slug)
```

### 문제

1. **여러 work unit이 동시에 활성 상태일 때 오매칭**: A, B 두 개의 work unit이 활성이면, 어떤 파이프라인을 시작해도 항상 가장 최근(B)에 연결됨
2. **사용자 의도 무시**: 사용자가 A의 작업으로 파이프라인을 시작했어도 B에 연결됨
3. **DB 미활용**: `pipeline_work_unit` 연결 테이블이 스키마에 정의되어 있으나 실제로 활용되지 않음 — 이벤트 파일(JSONL)의 `pipeline_start.work_unit_slug`가 유일한 연결 기록

---

## 2. 목표

1. 파이프라인 시작 시 활성 work unit이 **2개 이상**이면 사용자에게 선택하게 함 (1개이면 자동 선택 유지)
2. work unit ↔ pipeline 매칭을 **DB(`pipeline_work_unit` 테이블)에 기록**
3. viz 조회 시 DB join으로 매칭 정보를 보여줌

---

## 3. 사용자 시나리오

### 시나리오 A: 활성 work unit 1개 (변경 없음)
1. 사용자가 `/bams:dev` 실행
2. 활성 work unit 1개 → 자동 연결 (현재와 동일)

### 시나리오 B: 활성 work unit 2개 이상 (신규)
1. 사용자가 `/bams:dev` 실행
2. 파이프라인 시작 전, **AskUserQuestion**으로 선택:  
   "어떤 작업에 이 파이프라인을 연결할까요?"  
   옵션: [work-unit-A의 slug/이름, work-unit-B의 slug/이름, "연결 안 함"]
3. 사용자가 선택 → 선택한 work unit slug로 `pipeline_start` emit
4. DB `pipeline_work_unit` 테이블에 `(pipeline_slug, work_unit_slug, linked_at)` INSERT
5. viz에서 work unit 상세 조회 시 DB join으로 pipeline 목록 표시

### 시나리오 C: 활성 work unit 0개
1. 사용자가 `/bams:dev` 실행
2. 활성 work unit 없음 → `work_unit_slug` 없이 `pipeline_start` emit (현재와 동일)

---

## 4. 요구사항

### 필수 요구사항 (Must Have)

| ID | 요구사항 |
|----|---------|
| REQ-1 | 활성 WU 2개 이상일 때 파이프라인 시작 전 AskUserQuestion으로 선택 |
| REQ-2 | 선택 결과를 `pipeline_start` 이벤트의 `work_unit_slug` 필드에 반영 |
| REQ-3 | `pipeline_work_unit` 테이블에 매칭 기록 INSERT |
| REQ-4 | bams-server `/api/workunits/:slug` 응답에 DB join 결과 반영 |

### 선택 요구사항 (Nice to Have)

| ID | 요구사항 |
|----|---------|
| REQ-5 | 기존 JSONL 기반 연결 데이터를 DB로 마이그레이션하는 one-time 스크립트 |
| REQ-6 | bams-db `index.ts`에 `linkPipelineToWorkUnit()`, `getWorkUnitPipelines()` 메서드 추가 |

### 비요구사항 (Out of Scope)

- work unit 자체 생성/삭제 로직 변경 없음
- `/bams:start`, `/bams:end` 커맨드 UI 변경 없음
- JSONL 이벤트 파일 포맷 변경 없음 (하위 호환 유지)

---

## 5. 제약 조건

- `bams-viz-emit.sh`는 순수 bash 스크립트이므로 SQLite 직접 접근 불가 → DB INSERT는 별도 Bun 스크립트 또는 bams-server API를 통해 처리
- `work_unit_slug` 필드는 선택 사항 — "연결 안 함" 선택 시 필드 없이 emit 유지
- `/tmp/bams-active-workunits.json` 포맷 변경 없음

---

## 6. 성공 지표

- 활성 work unit 2개 이상인 상태에서 파이프라인 시작 시 100% AskUserQuestion 표시
- DB `pipeline_work_unit` 테이블에 매칭 레코드가 정확히 기록됨
- viz에서 work unit 상세 조회 시 올바른 pipeline 목록 표시

---

## 7. 관련 파일

| 파일 | 역할 |
|------|------|
| `plugins/bams-plugin/hooks/bams-viz-emit.sh` | pipeline_start 이벤트 처리, work unit 자동 선택 로직 |
| `plugins/bams-plugin/tools/bams-db/schema.ts` | work_units, pipeline_work_unit 테이블 정의 |
| `plugins/bams-plugin/tools/bams-db/index.ts` | DB 메서드 (linkPipelineToWorkUnit 추가 필요) |
| `plugins/bams-plugin/server/src/app.ts` | /api/workunits/:slug 엔드포인트 |
| `plugins/bams-plugin/tools/bams-viz/src/lib/event-store.ts` | WorkUnit 파싱 로직 |
| `plugins/bams-plugin/commands/bams/_shared_common.md` | 파이프라인 공통 규칙 |
| `plugins/bams-plugin/commands/bams/dev/phase-0-init.md` | dev 파이프라인 시작 지점 |
| `plugins/bams-plugin/commands/bams/feature/_common.md` | feature 파이프라인 공통 규칙 |
| `plugins/bams-plugin/commands/bams/hotfix/_common.md` | hotfix 파이프라인 공통 규칙 |

