# 태스크 분해: Work Unit 매칭 로직 수정

**pipeline_slug**: dev_work매치로직수정  
**작성일**: 2026-04-05  
**작성자**: product-strategy  
**참조 설계**: `.crew/artifacts/design/dev_work매치로직수정-tech-design.md`

---

## 전체 요약

| 구분 | 수 |
|------|---|
| 총 태스크 | 7 |
| backend 태스크 | 5 |
| 공통/규칙 태스크 | 1 |
| 테스트 태스크 | 1 |

---

## Phase 2: 구현

### TASK-WM-1: bams-db initSchema에 Work Unit DDL 추가

| 항목 | 내용 |
|------|------|
| 담당 | backend-engineering |
| 우선순위 | high |
| 크기 | XS |
| 태그 | `["backend", "db"]` |
| 파일 | `plugins/bams-plugin/tools/bams-db/index.ts` |

**구현 내용:**
- `initSchema()` 메서드에 `WORK_UNITS_TABLE_DDL`, `PIPELINE_WORK_UNIT_TABLE_DDL` import 및 `this.db.exec()` 추가
- `schema.ts`에서 두 DDL 심볼을 import

**완료 조건:**
- [ ] `bams.db` 새로 생성 시 `work_units`, `pipeline_work_unit` 테이블이 자동 생성됨
- [ ] 기존 DB에 대해 `CREATE TABLE IF NOT EXISTS`로 idempotent 동작

---

### TASK-WM-2: bams-db에 Work Unit 연결 메서드 추가

| 항목 | 내용 |
|------|------|
| 담당 | backend-engineering |
| 우선순위 | high |
| 크기 | S |
| 태그 | `["backend", "db"]` |
| 선행 태스크 | TASK-WM-1 |
| 파일 | `plugins/bams-plugin/tools/bams-db/index.ts` |

**구현 내용:**
```typescript
linkPipelineToWorkUnit(pipelineSlug: string, workUnitSlug: string): void
getWorkUnitPipelines(workUnitSlug: string): PipelineWorkUnitRow[]
upsertWorkUnit(slug: string, name?: string): void
close(): void
```

**완료 조건:**
- [ ] `linkPipelineToWorkUnit()`: `INSERT OR IGNORE`로 중복 방지
- [ ] `getWorkUnitPipelines()`: `pipeline_work_unit` 테이블에서 `work_unit_slug` 필터링
- [ ] `upsertWorkUnit()`: `INSERT OR IGNORE`로 중복 방지
- [ ] `close()`: `this.db.close()` 명시적 호출

---

### TASK-WM-3: _shared_common.md Work Unit 선택 블록 추가

| 항목 | 내용 |
|------|------|
| 담당 | backend-engineering |
| 우선순위 | high |
| 크기 | S |
| 태그 | `["backend", "workflow"]` |
| 선행 태스크 | TASK-WM-2 |
| 파일 | `plugins/bams-plugin/commands/bams/_shared_common.md` |

**구현 내용:**
- `## ★ Work Unit 선택 (파이프라인 시작 전 필수)` 섹션 추가
- 활성 WU 0/1/2개 이상 분기 로직 (bash + AskUserQuestion)
- `pipeline_start` emit 시 `SELECTED_WU_SLUG` 인자 전달
- DB 연결 기록 Bun 인라인 스크립트

**완료 조건:**
- [ ] 활성 WU 0개: `work_unit_slug` 없이 진행
- [ ] 활성 WU 1개: 자동 선택, 질문 없음
- [ ] 활성 WU 2개 이상: AskUserQuestion으로 선택 후 진행
- [ ] "연결 안 함" 옵션 제공
- [ ] DB INSERT 실패 시 `|| true`로 파이프라인 계속 진행

---

### TASK-WM-4: bams-server /api/workunits/:slug DB join 추가

| 항목 | 내용 |
|------|------|
| 담당 | backend-engineering |
| 우선순위 | medium |
| 크기 | S |
| 태그 | `["backend", "api"]` |
| 선행 태스크 | TASK-WM-2 |
| 파일 | `plugins/bams-plugin/server/src/app.ts` |

**구현 내용:**
- `/api/workunits/:slug` 핸들러에 `db.getWorkUnitPipelines(wuSlug)` 호출
- DB 결과 있으면 우선 사용, 없으면 JSONL fallback 유지
- 각 파이프라인 항목에 `type` 필드 추가 (parsePipelineEvents로 조회)
- `getDefaultDB()` import에 WU 메서드 타입 추가

**완료 조건:**
- [ ] DB에 `pipeline_work_unit` 레코드 있으면 DB 기반 반환
- [ ] DB 레코드 없으면 기존 JSONL 기반 동작 유지
- [ ] 응답 포맷 `{ slug, name, status, startedAt, endedAt, events, pipelines, task_summary, total_billed_cents }` 유지

---

### TASK-WM-5: event-store.ts getActiveWorkUnits() 추가

| 항목 | 내용 |
|------|------|
| 담당 | backend-engineering |
| 우선순위 | low |
| 크기 | XS |
| 태그 | `["backend", "viz"]` |
| 파일 | `plugins/bams-plugin/tools/bams-viz/src/lib/event-store.ts` |

**구현 내용:**
```typescript
getActiveWorkUnits(): WorkUnit[] {
  const workunits = this.getWorkUnits()
  return workunits.filter((wu) => wu.status === 'active')
}
```

**완료 조건:**
- [ ] `getActiveWorkUnit()`(단수, 기존)는 유지
- [ ] `getActiveWorkUnits()`(복수)가 추가됨

---

## Phase 3: 검증

### TASK-WM-6: 통합 테스트 시나리오 작성 및 검증

| 항목 | 내용 |
|------|------|
| 담당 | qa-strategy |
| 우선순위 | medium |
| 크기 | M |
| 태그 | `["qa", "test"]` |
| 선행 태스크 | TASK-WM-1 ~ TASK-WM-5 |

**검증 시나리오:**

1. **시나리오 A — 활성 WU 0개**: 파이프라인 시작 → `work_unit_slug` 필드 없이 `pipeline_start` emit 확인
2. **시나리오 B — 활성 WU 1개**: 파이프라인 시작 → 질문 없이 자동 연결 → DB `pipeline_work_unit` 레코드 확인
3. **시나리오 C — 활성 WU 2개**: 파이프라인 시작 → AskUserQuestion 표시 → 선택 후 올바른 WU에 연결 → DB 레코드 확인
4. **시나리오 D — "연결 안 함"**: WU 없이 파이프라인 진행 → DB 레코드 없음 확인
5. **시나리오 E — DB join 조회**: `/api/workunits/:slug` 호출 → DB 기반 파이프라인 목록 반환 확인
6. **시나리오 F — DB 없는 환경**: `.crew/db/bams.db` 없을 때 파이프라인 정상 시작 확인

---

## 의존성 그래프

```
TASK-WM-1 (initSchema)
    ↓
TASK-WM-2 (WU 메서드)
    ├── TASK-WM-3 (_shared_common.md)
    ├── TASK-WM-4 (server DB join)
    └── TASK-WM-5 (event-store 복수)
            ↓
        TASK-WM-6 (통합 테스트)
```

---

## 구현 예상 소요

| 태스크 | 예상 소요 |
|--------|---------|
| TASK-WM-1 | 10분 |
| TASK-WM-2 | 20분 |
| TASK-WM-3 | 30분 |
| TASK-WM-4 | 20분 |
| TASK-WM-5 | 5분 |
| TASK-WM-6 | 30분 |
| **합계** | **~115분** |

