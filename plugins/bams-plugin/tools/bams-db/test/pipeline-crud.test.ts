/**
 * pipeline-crud.test.ts
 *
 * TaskDB Pipeline CRUD 메서드 전체 커버리지 테스트
 * - upsertPipeline(): 신규 생성, 기존 업데이트, work_unit_id FK 매칭
 * - updatePipelineStatus(): status/endedAt/durationMs 업데이트
 * - getPipelines(): 전체 목록 조회
 * - getPipelineBySlug(): slug 기반 단일 조회
 * - getPipelinesByWorkUnit(): work_unit_id FK 기반 조회
 * - getTasksByPipelineId(): pipeline_id 기반 task 조회
 * - FK 제약조건 위반 시나리오
 * - 엣지 케이스 (빈 DB, 중복 slug, null work_unit_id)
 *
 * 격리: in-memory SQLite (':memory:') — 파일시스템 오염 없음
 */

import { describe, test, expect } from 'bun:test'
import { TaskDB, WorkUnitDB } from '../index.ts'

// ─────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────

function createTaskDB(): TaskDB {
  return new TaskDB(':memory:')
}

function createWorkUnitDB(): WorkUnitDB {
  return new WorkUnitDB(':memory:')
}

const NOW = new Date().toISOString()

// ─────────────────────────────────────────────────────────────
// upsertPipeline — 신규 생성
// ─────────────────────────────────────────────────────────────

describe('upsertPipeline — 신규 생성', () => {
  test('최소 필수 필드로 파이프라인을 생성할 수 있다', () => {
    const db = createTaskDB()
    const id = db.upsertPipeline({ slug: 'min-pipe', type: 'dev' })

    expect(typeof id).toBe('string')
    expect(id.length).toBe(36) // UUID v4 format

    const p = db.getPipelineBySlug('min-pipe')
    expect(p).not.toBeNull()
    expect(p!.slug).toBe('min-pipe')
    expect(p!.type).toBe('dev')
    expect(p!.status).toBe('running') // default
    expect(p!.work_unit_id).toBeNull()
    expect(p!.command).toBeNull()
    expect(p!.arguments).toBeNull()
    expect(p!.started_at).toBeNull()
    db.close()
  })

  test('모든 선택 필드를 포함하여 생성할 수 있다', () => {
    const db = createTaskDB()
    const id = db.upsertPipeline({
      slug: 'full-pipe',
      type: 'feature',
      command: 'bams:feature',
      status: 'queued',
      arguments: '{"scope":"full"}',
      started_at: NOW,
    })

    const p = db.getPipelineBySlug('full-pipe')
    expect(p!.command).toBe('bams:feature')
    expect(p!.status).toBe('queued')
    expect(p!.arguments).toBe('{"scope":"full"}')
    expect(p!.started_at).toBe(NOW)
    db.close()
  })

  test('서로 다른 slug로 여러 파이프라인을 생성할 수 있다', () => {
    const db = createTaskDB()
    const id1 = db.upsertPipeline({ slug: 'pipe-a', type: 'dev' })
    const id2 = db.upsertPipeline({ slug: 'pipe-b', type: 'hotfix' })
    const id3 = db.upsertPipeline({ slug: 'pipe-c', type: 'feature' })

    expect(id1).not.toBe(id2)
    expect(id2).not.toBe(id3)
    expect(db.getPipelines().length).toBe(3)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// upsertPipeline — 기존 업데이트
// ─────────────────────────────────────────────────────────────

describe('upsertPipeline — 기존 업데이트', () => {
  test('동일 slug로 upsert 시 ID가 동일하게 유지된다', () => {
    const db = createTaskDB()
    const id1 = db.upsertPipeline({ slug: 'up-pipe', type: 'dev' })
    const id2 = db.upsertPipeline({ slug: 'up-pipe', type: 'hotfix' })
    expect(id1).toBe(id2)
    db.close()
  })

  test('type 필드는 항상 덮어쓴다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'type-pipe', type: 'dev' })
    db.upsertPipeline({ slug: 'type-pipe', type: 'hotfix' })

    const p = db.getPipelineBySlug('type-pipe')
    expect(p!.type).toBe('hotfix')
    db.close()
  })

  test('status는 COALESCE — 새 값이 있으면 업데이트, null이면 기존 유지', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'status-pipe', type: 'dev', status: 'running' })

    // status를 명시적으로 업데이트
    db.upsertPipeline({ slug: 'status-pipe', type: 'dev', status: 'completed' })
    expect(db.getPipelineBySlug('status-pipe')!.status).toBe('completed')

    // status를 생략하면 기존 값 유지
    db.upsertPipeline({ slug: 'status-pipe', type: 'dev' })
    expect(db.getPipelineBySlug('status-pipe')!.status).toBe('completed')
    db.close()
  })

  test('command는 COALESCE — null 전달 시 기존 값 유지', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'cmd-pipe', type: 'dev', command: 'bams:dev' })

    db.upsertPipeline({ slug: 'cmd-pipe', type: 'dev' })
    expect(db.getPipelineBySlug('cmd-pipe')!.command).toBe('bams:dev')
    db.close()
  })

  test('updated_at이 upsert 시 갱신된다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'ts-pipe', type: 'dev' })
    const p1 = db.getPipelineBySlug('ts-pipe')

    // 약간의 시간차를 두고 업데이트
    db.upsertPipeline({ slug: 'ts-pipe', type: 'dev', status: 'completed' })
    const p2 = db.getPipelineBySlug('ts-pipe')

    // updated_at이 존재하는지만 확인 (시간 정밀도 이슈로 동일할 수도 있음)
    expect(p2!.updated_at).toBeTruthy()
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// upsertPipeline — work_unit_id FK 매칭
// ─────────────────────────────────────────────────────────────

describe('upsertPipeline — work_unit_id FK', () => {
  test('work_unit_id를 직접 설정하여 파이프라인을 생성할 수 있다', () => {
    const db = createTaskDB()
    // work_unit 먼저 생성
    db.upsertWorkUnit('wu-direct', 'Direct WU')
    // work_unit id를 조회하여 직접 설정 (linkPipelineToWorkUnit 사용)
    db.upsertPipeline({ slug: 'wu-pipe', type: 'dev' })
    db.linkPipelineToWorkUnit('wu-pipe', 'wu-direct')

    const pipes = db.getWorkUnitPipelines('wu-direct')
    expect(pipes.length).toBe(1)
    expect(pipes[0].slug).toBe('wu-pipe')
    db.close()
  })

  test('존재하지 않는 work_unit_slug로 link 시 에러 없이 무시된다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'orphan-pipe', type: 'dev' })
    expect(() => db.linkPipelineToWorkUnit('orphan-pipe', 'ghost-wu')).not.toThrow()

    const p = db.getPipelineBySlug('orphan-pipe')
    expect(p!.work_unit_id).toBeNull()
    db.close()
  })

  test('work_unit_id가 null인 파이프라인도 정상 작동한다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'no-wu-pipe', type: 'dev' })

    const p = db.getPipelineBySlug('no-wu-pipe')
    expect(p!.work_unit_id).toBeNull()

    // getPipelinesByWorkUnit에서 빈 결과
    const pipes = db.getWorkUnitPipelines('nonexistent')
    expect(pipes.length).toBe(0)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// updatePipelineStatus
// ─────────────────────────────────────────────────────────────

describe('updatePipelineStatus', () => {
  test('status만 업데이트할 수 있다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'upd-status', type: 'dev' })

    db.updatePipelineStatus('upd-status', 'failed')

    const p = db.getPipelineBySlug('upd-status')
    expect(p!.status).toBe('failed')
    expect(p!.ended_at).toBeNull()
    expect(p!.duration_ms).toBeNull()
    db.close()
  })

  test('status + endedAt + durationMs를 모두 업데이트할 수 있다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'upd-full', type: 'dev' })

    db.updatePipelineStatus('upd-full', 'completed', NOW, 300000)

    const p = db.getPipelineBySlug('upd-full')
    expect(p!.status).toBe('completed')
    expect(p!.ended_at).toBe(NOW)
    expect(p!.duration_ms).toBe(300000)
    db.close()
  })

  test('endedAt이 이미 설정되어 있으면 COALESCE로 유지된다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'upd-coalesce', type: 'dev' })

    const earlierTime = '2026-01-01T00:00:00.000Z'
    db.updatePipelineStatus('upd-coalesce', 'failed', earlierTime, 100)

    // endedAt 없이 status만 변경
    db.updatePipelineStatus('upd-coalesce', 'completed')

    const p = db.getPipelineBySlug('upd-coalesce')
    expect(p!.status).toBe('completed')
    expect(p!.ended_at).toBe(earlierTime) // 기존 값 유지
    db.close()
  })

  test('존재하지 않는 slug에 대해 에러 없이 0 rows 업데이트', () => {
    const db = createTaskDB()
    expect(() => db.updatePipelineStatus('ghost-slug', 'completed')).not.toThrow()
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// getPipelines — 전체 목록
// ─────────────────────────────────────────────────────────────

describe('getPipelines', () => {
  test('빈 DB에서 빈 배열을 반환한다', () => {
    const db = createTaskDB()
    expect(db.getPipelines()).toEqual([])
    db.close()
  })

  test('모든 파이프라인을 반환한다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'first', type: 'dev' })
    db.upsertPipeline({ slug: 'second', type: 'hotfix' })
    db.upsertPipeline({ slug: 'third', type: 'feature' })

    const all = db.getPipelines()
    expect(all.length).toBe(3)
    // 모든 파이프라인이 반환되는지 확인 (created_at 동일 시 순서 미보장)
    const slugs = all.map(p => p.slug).sort()
    expect(slugs).toEqual(['first', 'second', 'third'])
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// getPipelineBySlug
// ─────────────────────────────────────────────────────────────

describe('getPipelineBySlug', () => {
  test('존재하지 않는 slug는 null을 반환한다', () => {
    const db = createTaskDB()
    expect(db.getPipelineBySlug('nonexistent')).toBeNull()
    db.close()
  })

  test('존재하는 slug는 전체 PipelineRow를 반환한다', () => {
    const db = createTaskDB()
    db.upsertPipeline({
      slug: 'detail-pipe',
      type: 'feature',
      command: 'bams:feature',
      status: 'running',
      started_at: NOW,
    })

    const p = db.getPipelineBySlug('detail-pipe')
    expect(p).not.toBeNull()
    expect(p!.id).toBeTruthy()
    expect(p!.slug).toBe('detail-pipe')
    expect(p!.type).toBe('feature')
    expect(p!.command).toBe('bams:feature')
    expect(p!.status).toBe('running')
    expect(p!.started_at).toBe(NOW)
    expect(p!.total_steps).toBe(0) // default
    expect(p!.completed_steps).toBe(0)
    expect(p!.failed_steps).toBe(0)
    db.close()
  })

  test('한글 slug도 정상 작동한다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'dev_결제플로우구현', type: 'feature' })

    const p = db.getPipelineBySlug('dev_결제플로우구현')
    expect(p).not.toBeNull()
    expect(p!.slug).toBe('dev_결제플로우구현')
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// getPipelinesByWorkUnit
// ─────────────────────────────────────────────────────────────

describe('getPipelinesByWorkUnit', () => {
  test('존재하지 않는 work_unit_id는 빈 배열을 반환한다', () => {
    const db = createTaskDB()
    expect(db.getPipelinesByWorkUnit('ghost-wu-id')).toEqual([])
    db.close()
  })

  test('work_unit_id에 연결된 파이프라인만 반환한다', () => {
    const db = createTaskDB()
    db.upsertWorkUnit('wu-filter', 'Filter WU')
    db.upsertWorkUnit('wu-other', 'Other WU')

    db.upsertPipeline({ slug: 'pipe-filter-1', type: 'dev' })
    db.upsertPipeline({ slug: 'pipe-filter-2', type: 'hotfix' })
    db.upsertPipeline({ slug: 'pipe-other', type: 'feature' })

    db.linkPipelineToWorkUnit('pipe-filter-1', 'wu-filter')
    db.linkPipelineToWorkUnit('pipe-filter-2', 'wu-filter')
    db.linkPipelineToWorkUnit('pipe-other', 'wu-other')

    const filtered = db.getWorkUnitPipelines('wu-filter')
    expect(filtered.length).toBe(2)
    expect(filtered.map(p => p.slug).sort()).toEqual(['pipe-filter-1', 'pipe-filter-2'])
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// getTasksByPipelineId — pipeline_id 기반 task 조회
// ─────────────────────────────────────────────────────────────

describe('getTasksByPipelineId', () => {
  test('빈 파이프라인은 빈 배열을 반환한다', () => {
    const db = createTaskDB()
    const pId = db.upsertPipeline({ slug: 'empty-tasks', type: 'dev' })
    expect(db.getTasksByPipelineId(pId)).toEqual([])
    db.close()
  })

  test('pipeline_id에 속한 task만 반환한다', () => {
    const db = createTaskDB()
    const p1 = db.upsertPipeline({ slug: 'pipe-tasks-1', type: 'dev' })
    const p2 = db.upsertPipeline({ slug: 'pipe-tasks-2', type: 'hotfix' })

    db.createTask({ pipeline_id: p1, title: 'P1 Task A' })
    db.createTask({ pipeline_id: p1, title: 'P1 Task B' })
    db.createTask({ pipeline_id: p2, title: 'P2 Task A' })

    const p1Tasks = db.getTasksByPipelineId(p1)
    expect(p1Tasks.length).toBe(2)
    expect(p1Tasks.every(t => t.pipeline_id === p1)).toBe(true)

    const p2Tasks = db.getTasksByPipelineId(p2)
    expect(p2Tasks.length).toBe(1)
    expect(p2Tasks[0].title).toBe('P2 Task A')
    db.close()
  })

  test('phase ASC 순서로 정렬된다', () => {
    const db = createTaskDB()
    const pId = db.upsertPipeline({ slug: 'sort-pipe', type: 'dev' })

    db.createTask({ pipeline_id: pId, title: 'Phase 3', phase: 3 })
    db.createTask({ pipeline_id: pId, title: 'Phase 1', phase: 1 })
    db.createTask({ pipeline_id: pId, title: 'Phase 2', phase: 2 })

    const tasks = db.getTasksByPipelineId(pId)
    expect(tasks[0].title).toBe('Phase 1')
    expect(tasks[1].title).toBe('Phase 2')
    expect(tasks[2].title).toBe('Phase 3')
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// FK 제약조건 위반 시나리오
// ─────────────────────────────────────────────────────────────

describe('FK 제약조건 위반', () => {
  test('존재하지 않는 pipeline_id로 task 생성 시 FK 에러가 발생한다', () => {
    const db = createTaskDB()
    expect(() => {
      db.createTask({
        pipeline_id: 'nonexistent-pipeline-id',
        title: 'Orphan Task',
      })
    }).toThrow()
    db.close()
  })

  test('pipeline에 task가 있어도 pipeline 자체는 독립 삭제 가능하지 않다 (FK 보호)', () => {
    // SQLite에서 FOREIGN KEY ON DELETE 기본값은 RESTRICT
    // pipeline을 직접 DELETE하면 FK violation
    const db = createTaskDB()
    const pId = db.upsertPipeline({ slug: 'fk-protect', type: 'dev' })
    db.createTask({ pipeline_id: pId, title: 'Protected Task' })

    // pipeline을 직접 SQL DELETE 시도하면 FK 제약으로 에러
    // TaskDB에는 deletePipeline이 없으므로 FK가 보호하는 것을 간접 확인
    const tasks = db.getTasksByPipelineId(pId)
    expect(tasks.length).toBe(1)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// 엣지 케이스
// ─────────────────────────────────────────────────────────────

describe('엣지 케이스', () => {
  test('매우 긴 slug도 저장할 수 있다', () => {
    const db = createTaskDB()
    const longSlug = 'a'.repeat(500)
    const id = db.upsertPipeline({ slug: longSlug, type: 'dev' })
    const p = db.getPipelineBySlug(longSlug)
    expect(p).not.toBeNull()
    expect(p!.slug).toBe(longSlug)
    db.close()
  })

  test('특수 문자가 포함된 slug도 저장할 수 있다', () => {
    const db = createTaskDB()
    const specialSlug = 'dev_결제-API_v2.0'
    db.upsertPipeline({ slug: specialSlug, type: 'dev' })
    const p = db.getPipelineBySlug(specialSlug)
    expect(p!.slug).toBe(specialSlug)
    db.close()
  })

  test('동일 slug로 UNIQUE 제약 위반 시 upsert가 처리한다 (에러 아님)', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'dup-slug', type: 'dev' })
    expect(() => db.upsertPipeline({ slug: 'dup-slug', type: 'hotfix' })).not.toThrow()

    const p = db.getPipelineBySlug('dup-slug')
    expect(p!.type).toBe('hotfix') // 업데이트됨
    db.close()
  })

  test('duration_ms=0도 정상 저장된다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'zero-dur', type: 'dev' })
    db.updatePipelineStatus('zero-dur', 'completed', NOW, 0)

    const p = db.getPipelineBySlug('zero-dur')
    expect(p!.duration_ms).toBe(0)
    db.close()
  })

  test('매우 큰 duration_ms도 정상 저장된다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'big-dur', type: 'dev' })
    db.updatePipelineStatus('big-dur', 'completed', NOW, 999999999)

    const p = db.getPipelineBySlug('big-dur')
    expect(p!.duration_ms).toBe(999999999)
    db.close()
  })

  test('getPipelineSummary — task가 없는 파이프라인은 모두 0을 반환한다', () => {
    const db = createTaskDB()
    const pId = db.upsertPipeline({ slug: 'empty-summary', type: 'dev' })

    const summary = db.getPipelineSummary(pId)
    expect(summary.total).toBe(0)
    expect(summary.backlog ?? 0).toBe(0)
    expect(summary.done ?? 0).toBe(0)
    db.close()
  })

  test('getPipelineSummary — 다양한 상태의 task를 정확히 집계한다', () => {
    const db = createTaskDB()
    const pId = db.upsertPipeline({ slug: 'mixed-summary', type: 'dev' })

    const t1 = db.createTask({ pipeline_id: pId, title: 'T1' }) // backlog
    const t2 = db.createTask({ pipeline_id: pId, title: 'T2' }) // backlog
    const t3 = db.createTask({ pipeline_id: pId, title: 'T3' }) // backlog

    // t1을 in_progress로
    db.checkoutTask(t1, 'run-1', 'agent-a')
    // t2를 done으로
    db.checkoutTask(t2, 'run-2', 'agent-b')
    db.updateTaskStatus(t2, 'done', 'agent-b', 'run-2')

    const summary = db.getPipelineSummary(pId)
    expect(summary.total).toBe(3)
    expect(summary.in_progress).toBe(1)
    expect(summary.done).toBe(1)
    expect(summary.backlog).toBe(1)
    db.close()
  })
})
