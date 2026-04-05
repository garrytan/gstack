# 기술 설계: Work Unit 매칭 로직 수정

**pipeline_slug**: dev_work매치로직수정  
**작성일**: 2026-04-05  
**작성자**: backend-engineering  
**참조 PRD**: `.crew/artifacts/prd/dev_work매치로직수정-prd.md`

---

## 1. 현재 아키텍처 분석

### 1.1 매칭 플로우 (현재)

```
/bams:dev 실행
    ↓
bams-viz-emit.sh pipeline_start 호출
    ↓
wu_latest_slug() — /tmp/bams-active-workunits.json에서 last 항목 자동 선택
    ↓
pipeline_start 이벤트에 work_unit_slug 포함하여 JSONL 파일에 기록
    ↓ (DB 연결 없음)
```

### 1.2 기존 데이터 흐름

- **활성 WU 저장소**: `/tmp/bams-active-workunits.json` (배열, 메모리/임시)
- **연결 기록**: `{slug}-events.jsonl`의 `pipeline_start.work_unit_slug` 필드
- **DB 테이블**: `work_units`, `pipeline_work_unit` 테이블이 schema.ts에 정의되어 있으나 `index.ts`에 메서드 없음 + bams-db 초기화 시 CREATE TABLE 미포함

### 1.3 서버 조회 방식 (현재)

`GET /api/workunits/:slug` → `parsePipelineEvents()` 순회하며 `pipeline_start.work_unit_slug === wuSlug` 필터링

---

## 2. 설계 결정

### 결정 1: 사용자 선택 위치

**문제**: `bams-viz-emit.sh`는 bash 스크립트이므로 AskUserQuestion 불가.  
**결정**: 파이프라인 커맨드 레벨(`_shared_common.md`)에서 `pipeline_start` emit 이전에 work unit 선택 로직을 삽입한다.

```
파이프라인 커맨드 (_shared_common.md 공통 규칙)
    ↓
활성 WU 목록 확인 (/tmp/bams-active-workunits.json)
    ↓
0개: work_unit_slug 없이 진행
1개: 자동 선택 (현재와 동일)
2개 이상: AskUserQuestion → 선택
    ↓
bams-viz-emit.sh pipeline_start <slug> <type> <cmd> <args> "" <selected_wu_slug>
    ↓
DB INSERT pipeline_work_unit (Bun 인라인 스크립트)
```

### 결정 2: DB 연결 방식

**문제**: bams-viz-emit.sh는 bash이므로 SQLite 직접 접근 불가.  
**결정**: pipeline_start emit 직후, Bun 인라인 스크립트로 DB에 기록한다.

```bash
# pipeline_start emit 후
if [ -n "$SELECTED_WU_SLUG" ]; then
  bun -e "
    import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
    const db = new TaskDB('.crew/db/bams.db');
    db.linkPipelineToWorkUnit('{pipeline_slug}', '${SELECTED_WU_SLUG}');
    db.close();
  " 2>/dev/null || true
fi
```

### 결정 3: DB JOIN 방식

기존 JSONL 파싱 방식 유지 + DB가 있으면 DB를 우선 사용 (기존 TaskDB 패턴과 동일).

---

## 3. 변경 상세 설계

### 3.1 DB 스키마 변경 (bams-db/schema.ts)

**변경 없음** — `work_units`, `pipeline_work_unit` 테이블이 이미 정의되어 있음.

단, `bams-db/index.ts`의 `initSchema()`에 DDL 포함이 누락되어 있으므로 추가 필요:

```typescript
// index.ts initSchema() 수정
private initSchema(): void {
  this.db.exec(TASKS_TABLE_DDL);
  this.db.exec(TASK_EVENTS_TABLE_DDL);
  this.db.exec(TASKS_INDEXES_DDL);
  // 추가:
  this.db.exec(WORK_UNITS_TABLE_DDL);        // ← 신규 추가
  this.db.exec(PIPELINE_WORK_UNIT_TABLE_DDL); // ← 신규 추가
}
```

### 3.2 bams-db/index.ts 신규 메서드

```typescript
// ─────────────────────────────────────────────────────────────
// Work Unit 연결
// ─────────────────────────────────────────────────────────────

/**
 * pipeline_work_unit 연결 테이블에 레코드를 삽입한다.
 * 이미 연결된 경우 무시 (idempotent).
 */
linkPipelineToWorkUnit(pipelineSlug: string, workUnitSlug: string): void {
  this.db.prepare(`
    INSERT OR IGNORE INTO pipeline_work_unit (pipeline_slug, work_unit_slug, linked_at)
    VALUES (?, ?, datetime('now'))
  `).run(pipelineSlug, workUnitSlug);
}

/**
 * work unit에 연결된 파이프라인 목록을 DB에서 조회한다.
 * @returns [{pipeline_slug, work_unit_slug, linked_at}]
 */
getWorkUnitPipelines(workUnitSlug: string): PipelineWorkUnitRow[] {
  return this.db
    .prepare<PipelineWorkUnitRow>(`
      SELECT pipeline_slug, work_unit_slug, linked_at
      FROM pipeline_work_unit
      WHERE work_unit_slug = ?
      ORDER BY linked_at ASC
    `)
    .all(workUnitSlug);
}

/**
 * work unit 레코드가 없으면 생성한다.
 * bams:start와 독립적으로 pipeline 연결 시 보장용.
 */
upsertWorkUnit(slug: string, name?: string): void {
  this.db.prepare(`
    INSERT OR IGNORE INTO work_units (id, slug, name, status, started_at)
    VALUES (?, ?, ?, 'active', datetime('now'))
  `).run(randomUUID(), slug, name ?? slug);
}

/**
 * DB close — 명시적 리소스 해제
 */
close(): void {
  this.db.close();
}
```

### 3.3 _shared_common.md 공통 규칙 추가

**파이프라인 시작 전** Work Unit 선택 블록을 추가합니다:

```markdown
## ★ Work Unit 선택 (파이프라인 시작 전 필수)

파이프라인 시작 전 활성 work unit 선택을 확인합니다.

```bash
# 활성 WU 목록 확인
if [ -f /tmp/bams-active-workunits.json ]; then
  WU_COUNT=$(jq 'length' /tmp/bams-active-workunits.json 2>/dev/null || echo 0)
  WU_LIST=$(jq -r '.[] | "\(.slug): \(.name)"' /tmp/bams-active-workunits.json 2>/dev/null)
else
  WU_COUNT=0
  WU_LIST=""
fi
echo "활성 WU 수: $WU_COUNT"
echo "$WU_LIST"
```

결과에 따라:
- 0개: `SELECTED_WU_SLUG=""` (빈 값으로 진행)
- 1개: `SELECTED_WU_SLUG` = 해당 slug (자동 선택, 사용자 확인 불필요)
- 2개 이상: **AskUserQuestion**으로 사용자 선택
  - Question: "어떤 작업에 이 파이프라인을 연결할까요?"
  - Options: 각 work unit의 slug/name + "연결 안 함"
  - 사용자가 선택한 slug를 `SELECTED_WU_SLUG`로 설정
  - "연결 안 함" 선택 시 `SELECTED_WU_SLUG=""`

pipeline_start emit 시 `SELECTED_WU_SLUG`를 6번째 인자로 전달:
```bash
_EMIT=$(find ~/.claude/plugins/cache -name "bams-viz-emit.sh" -path "*/bams-plugin/*" 2>/dev/null | head -1)
[ -n "$_EMIT" ] && bash "$_EMIT" pipeline_start "{slug}" "{type}" "{command}" "{arguments}" "" "${SELECTED_WU_SLUG}"
```

DB 연결 기록 (DB가 존재하면):
```bash
if [ -n "$SELECTED_WU_SLUG" ] && [ -f ".crew/db/bams.db" ]; then
  bun -e "
    import { TaskDB } from './plugins/bams-plugin/tools/bams-db/index.ts';
    const db = new TaskDB('.crew/db/bams.db');
    db.upsertWorkUnit('${SELECTED_WU_SLUG}');
    db.linkPipelineToWorkUnit('{slug}', '${SELECTED_WU_SLUG}');
    db.close();
  " 2>/dev/null || true
fi
```
```

### 3.4 bams-server/src/app.ts 변경

`GET /api/workunits/:slug` 핸들러에서 DB join을 우선 사용하도록 수정:

```typescript
// GET /api/workunits/:slug — DB join 우선
if (method === "GET" && workunitDetailMatch) {
  const wuSlug = workunitDetailMatch[1];
  
  // 1. DB에서 연결된 파이프라인 조회 (primary)
  const db = getDefaultDB();
  const dbPipelines = db.getWorkUnitPipelines(wuSlug);  // 신규 메서드
  
  // 2. JSONL fallback (DB 레코드 없으면)
  let pipelines;
  if (dbPipelines.length > 0) {
    pipelines = dbPipelines.map(row => ({
      slug: row.pipeline_slug,
      type: getPipelineType(row.pipeline_slug), // parsePipelineEvents로 type 조회
      linkedAt: row.linked_at,
    }));
  } else {
    // 기존 JSONL 기반 조회 (하위 호환)
    pipelines = pipelineSlugs
      .map(ps => { ... })  // 현재 로직 유지
      .filter(Boolean);
  }
  
  // ... 나머지 로직 동일
}
```

### 3.5 bams-viz/src/lib/event-store.ts 변경

`buildWorkUnit()` 메서드는 변경 없음. JSONL 기반 파싱 유지.

단, `getActiveWorkUnit()` → `getActiveWorkUnits()` (복수) 메서드 추가:

```typescript
/**
 * 현재 활성 상태인 모든 work unit 반환
 */
getActiveWorkUnits(): WorkUnit[] {
  const workunits = this.getWorkUnits()
  return workunits.filter((wu) => wu.status === 'active')
}
```

---

## 4. 변경 파일 목록

| 파일 | 변경 유형 | 변경 내용 |
|------|---------|---------|
| `plugins/bams-plugin/tools/bams-db/index.ts` | 수정 | `initSchema()`에 WU DDL 추가, `linkPipelineToWorkUnit()`, `getWorkUnitPipelines()`, `upsertWorkUnit()`, `close()` 메서드 추가 |
| `plugins/bams-plugin/commands/bams/_shared_common.md` | 수정 | Work Unit 선택 블록 추가 |
| `plugins/bams-plugin/server/src/app.ts` | 수정 | `/api/workunits/:slug` 핸들러에 DB join 추가 |
| `plugins/bams-plugin/tools/bams-viz/src/lib/event-store.ts` | 수정 | `getActiveWorkUnits()` 메서드 추가 |
| `plugins/bams-plugin/tools/bams-db/schema.ts` | 변경 없음 | 이미 WU 테이블 정의됨 |
| `plugins/bams-plugin/hooks/bams-viz-emit.sh` | 변경 없음 | pipeline_start는 이미 6번째 인자로 WU slug 처리 가능 |

---

## 5. 하위 호환성

- JSONL 이벤트 파일 포맷 변경 없음 → 기존 파이프라인 이벤트 파일 재파싱 필요 없음
- `/tmp/bams-active-workunits.json` 포맷 변경 없음
- 기존 `pipeline_start` 이벤트에 `work_unit_slug`가 이미 있으므로 JSONL fallback으로 동작
- DB가 없는 환경에서도 파이프라인 시작 가능 (Bun 스크립트 실패 시 `|| true`로 무시)

---

## 6. 테스트 계획

| 시나리오 | 검증 항목 |
|---------|---------|
| 활성 WU 0개 | pipeline_start에 work_unit_slug 없이 emit |
| 활성 WU 1개 | 자동 선택, AskUserQuestion 없음 |
| 활성 WU 2개 | AskUserQuestion 표시, 선택 후 DB INSERT |
| "연결 안 함" 선택 | work_unit_slug 없이 진행, DB INSERT 없음 |
| DB 없는 환경 | Bun 스크립트 실패 시 파이프라인 정상 진행 |
| DB join 조회 | /api/workunits/:slug에서 DB 연결 파이프라인 반환 |

---

## 7. 구현 순서

1. `bams-db/index.ts` — `initSchema()` 수정 + WU 메서드 추가
2. `_shared_common.md` — Work Unit 선택 블록 추가
3. `bams-server/src/app.ts` — DB join 추가
4. `event-store.ts` — `getActiveWorkUnits()` 추가
5. 통합 테스트

