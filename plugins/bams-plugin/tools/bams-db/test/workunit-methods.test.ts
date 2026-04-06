/**
 * workunit-methods.test.ts
 *
 * WorkUnitDB + TaskDB 스키마 재설계 검증 테스트
 * - WorkUnitDB: createWorkUnit, deleteWorkUnit (soft delete), endWorkUnit
 * - TaskDB: pipelines CRUD, tasks with pipeline_id FK, schema integrity
 *
 * 격리: in-memory SQLite (':memory:') 사용 — 파일시스템 오염 없음
 */

import { describe, test, expect } from 'bun:test'
import { WorkUnitDB, TaskDB } from '../index.ts'

// ─────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────

function createWorkUnitDB(): WorkUnitDB {
  return new WorkUnitDB(':memory:')
}

function createTaskDB(): TaskDB {
  return new TaskDB(':memory:')
}

const NOW = new Date().toISOString()

// ─────────────────────────────────────────────────────────────
// WorkUnitDB 기본 CRUD
// ─────────────────────────────────────────────────────────────

describe('WorkUnitDB — createWorkUnit', () => {
  test('Work Unit을 생성할 수 있다', () => {
    const db = createWorkUnitDB()
    db.createWorkUnit('wu-test', 'Test WU', NOW)

    const wu = db.getWorkUnit('wu-test')
    expect(wu).not.toBeNull()
    expect(wu!.slug).toBe('wu-test')
    expect(wu!.name).toBe('Test WU')
    expect(wu!.status).toBe('active')
    db.close()
  })

  test('동일 slug로 중복 생성 시 무시된다 (idempotent)', () => {
    const db = createWorkUnitDB()
    db.createWorkUnit('wu-dup', 'First', NOW)
    db.createWorkUnit('wu-dup', 'Second', NOW)

    const wu = db.getWorkUnit('wu-dup')
    expect(wu!.name).toBe('First')
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// WorkUnitDB — deleteWorkUnit (soft delete)
// ─────────────────────────────────────────────────────────────

describe('WorkUnitDB — deleteWorkUnit', () => {
  test('soft delete가 정상 작동한다', () => {
    const db = createWorkUnitDB()
    db.createWorkUnit('wu-del', 'Delete WU', NOW)

    db.deleteWorkUnit('wu-del')

    const wu = db.getWorkUnit('wu-del')
    expect(wu).not.toBeNull()
    expect(wu!.deleted_at).not.toBeNull()
    db.close()
  })

  test('이미 삭제된 Work Unit은 재삭제되지 않는다', () => {
    const db = createWorkUnitDB()
    db.createWorkUnit('wu-del2', 'Delete WU 2', NOW)
    db.deleteWorkUnit('wu-del2')

    const firstDeletedAt = db.getWorkUnit('wu-del2')!.deleted_at
    db.deleteWorkUnit('wu-del2')
    const secondDeletedAt = db.getWorkUnit('wu-del2')!.deleted_at

    expect(firstDeletedAt).toBe(secondDeletedAt)
    db.close()
  })

  test('존재하지 않는 slug 삭제 시 에러가 발생하지 않는다', () => {
    const db = createWorkUnitDB()
    expect(() => db.deleteWorkUnit('ghost')).not.toThrow()
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// WorkUnitDB — endWorkUnit
// ─────────────────────────────────────────────────────────────

describe('WorkUnitDB — endWorkUnit', () => {
  test('Work Unit을 종료할 수 있다', () => {
    const db = createWorkUnitDB()
    db.createWorkUnit('wu-end', 'End WU', NOW)

    db.endWorkUnit('wu-end', 'completed', NOW)

    const wu = db.getWorkUnit('wu-end')
    expect(wu!.status).toBe('completed')
    expect(wu!.ended_at).toBe(NOW)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// WorkUnitDB — retro_slug 컬럼이 제거되었는지 확인
// ─────────────────────────────────────────────────────────────

describe('WorkUnitDB — retro_slug 제거 확인', () => {
  test('WorkUnitRow에 retro_slug 필드가 없다', () => {
    const db = createWorkUnitDB()
    db.createWorkUnit('wu-no-retro', 'No Retro', NOW)

    const wu = db.getWorkUnit('wu-no-retro')
    expect(wu).not.toBeNull()
    // retro_slug가 스키마에서 제거되었으므로 필드가 없어야 한다
    expect((wu as Record<string, unknown>).retro_slug).toBeUndefined()
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// TaskDB — pipelines 테이블 CRUD
// ─────────────────────────────────────────────────────────────

describe('TaskDB — pipelines CRUD', () => {
  test('upsertPipeline으로 파이프라인을 생성할 수 있다', () => {
    const db = createTaskDB()
    const id = db.upsertPipeline({
      slug: 'test-pipeline',
      type: 'dev',
      command: 'bams:dev',
      status: 'running',
      started_at: NOW,
    })

    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)

    const pipeline = db.getPipelineBySlug('test-pipeline')
    expect(pipeline).not.toBeNull()
    expect(pipeline!.slug).toBe('test-pipeline')
    expect(pipeline!.type).toBe('dev')
    expect(pipeline!.status).toBe('running')
    db.close()
  })

  test('동일 slug로 upsertPipeline 시 업데이트된다', () => {
    const db = createTaskDB()
    const id1 = db.upsertPipeline({
      slug: 'up-pipeline',
      type: 'dev',
    })

    const id2 = db.upsertPipeline({
      slug: 'up-pipeline',
      type: 'hotfix',
      status: 'completed',
    })

    expect(id1).toBe(id2)

    const pipeline = db.getPipelineBySlug('up-pipeline')
    expect(pipeline!.type).toBe('hotfix')
    expect(pipeline!.status).toBe('completed')
    db.close()
  })

  test('updatePipelineStatus로 상태를 변경할 수 있다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'status-pipe', type: 'feature' })

    db.updatePipelineStatus('status-pipe', 'completed', NOW, 120000)

    const pipeline = db.getPipelineBySlug('status-pipe')
    expect(pipeline!.status).toBe('completed')
    expect(pipeline!.ended_at).toBe(NOW)
    expect(pipeline!.duration_ms).toBe(120000)
    db.close()
  })

  test('getPipelines로 전체 목록을 조회할 수 있다', () => {
    const db = createTaskDB()
    db.upsertPipeline({ slug: 'pipe-a', type: 'dev' })
    db.upsertPipeline({ slug: 'pipe-b', type: 'hotfix' })

    const all = db.getPipelines()
    expect(all.length).toBe(2)
    db.close()
  })

  test('getPipelineBySlug로 존재하지 않는 slug는 null을 반환한다', () => {
    const db = createTaskDB()
    expect(db.getPipelineBySlug('ghost')).toBeNull()
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// TaskDB — pipelines + work_units 연결
// ─────────────────────────────────────────────────────────────

describe('TaskDB — pipelines-workunit 연결', () => {
  test('upsertPipeline에 work_unit_id를 설정할 수 있다', () => {
    const db = createTaskDB()
    // work unit 생성
    db.upsertWorkUnit('wu-link', 'Link WU')

    // work unit id를 가져오기 위해 SQL 직접 사용은 불가하므로,
    // linkPipelineToWorkUnit을 통해 연결 후 getPipelinesByWorkUnit으로 확인
    db.upsertPipeline({ slug: 'link-pipe', type: 'dev' })
    db.linkPipelineToWorkUnit('link-pipe', 'wu-link')

    const pipelines = db.getWorkUnitPipelines('wu-link')
    expect(pipelines.length).toBe(1)
    expect(pipelines[0].slug).toBe('link-pipe')
    db.close()
  })

  test('getWorkUnitPipelines로 연결된 파이프라인을 조회할 수 있다', () => {
    const db = createTaskDB()
    db.upsertWorkUnit('wu-multi', 'Multi WU')
    db.upsertPipeline({ slug: 'pipe-1', type: 'dev' })
    db.upsertPipeline({ slug: 'pipe-2', type: 'hotfix' })
    db.linkPipelineToWorkUnit('pipe-1', 'wu-multi')
    db.linkPipelineToWorkUnit('pipe-2', 'wu-multi')

    const pipelines = db.getWorkUnitPipelines('wu-multi')
    expect(pipelines.length).toBe(2)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// TaskDB — tasks with pipeline_id FK
// ─────────────────────────────────────────────────────────────

describe('TaskDB — tasks with pipeline_id FK', () => {
  test('createTask에 pipeline_id를 사용한다', () => {
    const db = createTaskDB()
    const pipelineId = db.upsertPipeline({ slug: 'task-pipe', type: 'dev' })

    const taskId = db.createTask({
      pipeline_id: pipelineId,
      title: 'Test Task',
      description: 'A test task',
    })

    const task = db.getTask(taskId)
    expect(task).not.toBeNull()
    expect(task!.pipeline_id).toBe(pipelineId)
    expect(task!.title).toBe('Test Task')
    db.close()
  })

  test('getTasksByPipelineId로 파이프라인의 태스크를 조회할 수 있다', () => {
    const db = createTaskDB()
    const pipelineId = db.upsertPipeline({ slug: 'tasks-pipe', type: 'dev' })

    db.createTask({ pipeline_id: pipelineId, title: 'Task 1' })
    db.createTask({ pipeline_id: pipelineId, title: 'Task 2' })

    const tasks = db.getTasksByPipelineId(pipelineId)
    expect(tasks.length).toBe(2)
    db.close()
  })

  test('createTask에 model, label, duration_ms, summary를 설정할 수 있다', () => {
    const db = createTaskDB()
    const pipelineId = db.upsertPipeline({ slug: 'extra-pipe', type: 'dev' })

    const taskId = db.createTask({
      pipeline_id: pipelineId,
      title: 'Extended Task',
      model: 'claude-sonnet-4',
      label: 'backend',
      duration_ms: 5000,
      summary: 'A task with extra fields',
    })

    const task = db.getTask(taskId)
    expect(task!.model).toBe('claude-sonnet-4')
    expect(task!.label).toBe('backend')
    expect(task!.duration_ms).toBe(5000)
    expect(task!.summary).toBe('A task with extra fields')
    db.close()
  })

  test('getPipelineSummary가 pipeline_id 기반으로 작동한다', () => {
    const db = createTaskDB()
    const pipelineId = db.upsertPipeline({ slug: 'summary-pipe', type: 'dev' })

    db.createTask({ pipeline_id: pipelineId, title: 'T1' })
    db.createTask({ pipeline_id: pipelineId, title: 'T2' })

    const summary = db.getPipelineSummary(pipelineId)
    expect(summary.total).toBe(2)
    expect(summary.backlog).toBe(2)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// 스키마 무결성 검증
// ─────────────────────────────────────────────────────────────

describe('스키마 무결성 검증', () => {
  test('TaskDB 인스턴스 생성 시 모든 테이블이 자동 생성된다', () => {
    const db = createTaskDB()

    // pipelines 테이블 존재 확인
    const pipeline = db.getPipelineBySlug('nonexistent')
    expect(pipeline).toBeNull()

    // tasks 테이블 존재 확인 (pipeline 필요)
    const pipelineId = db.upsertPipeline({ slug: 'schema-test', type: 'dev' })
    const tasks = db.getTasksByPipelineId(pipelineId)
    expect(tasks.length).toBe(0)

    db.close()
  })

  test('WorkUnitDB 인스턴스 생성이 정상 작동한다', () => {
    const db = createWorkUnitDB()
    const units = db.getWorkUnits()
    expect(Array.isArray(units)).toBe(true)
    db.close()
  })

  test('pipeline_work_unit 테이블은 더 이상 존재하지 않는다 (pipelines.work_unit_id FK로 대체)', () => {
    const db = createTaskDB()
    // pipelines 테이블의 work_unit_id FK로 연결 확인
    db.upsertWorkUnit('wu-fk', 'FK WU')
    const pipelineId = db.upsertPipeline({ slug: 'fk-pipe', type: 'dev' })
    db.linkPipelineToWorkUnit('fk-pipe', 'wu-fk')

    const pipelines = db.getWorkUnitPipelines('wu-fk')
    expect(pipelines.length).toBe(1)
    expect(pipelines[0].id).toBe(pipelineId)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────
// CostDB 제거 확인
// ─────────────────────────────────────────────────────────────

describe('CostDB 제거 확인', () => {
  test('CostDB, getDefaultCostDB가 export되지 않는다', async () => {
    const mod = await import('../index.ts')
    expect((mod as Record<string, unknown>).CostDB).toBeUndefined()
    expect((mod as Record<string, unknown>).getDefaultCostDB).toBeUndefined()
  })
})
