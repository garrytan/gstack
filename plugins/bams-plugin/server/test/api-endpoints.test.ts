/**
 * api-endpoints.test.ts
 *
 * bams-server API 엔드포인트 통합 테스트
 * 대상 엔드포인트:
 *   PATCH  /api/workunits/:slug               — 상태 업데이트 (completed/abandoned)
 *   DELETE /api/workunits/:slug               — soft delete (204)
 *   GET    /api/workunits/:slug/agents        — 에이전트 통계
 *   GET    /api/workunits/:slug/agents/active — 활성 에이전트
 *   PATCH  /api/workunits/:slug/pipelines/:p  — 파이프라인 강제 종료
 *   GET    /api/workunits/:slug/retro         — retro 자동 요약 (이벤트 기반)
 *   GET    /api/pipelines/:slug/tasks         — 파이프라인 하위 task 조회 (신규)
 *
 * Batch 2 변경사항:
 *   - CostDB 의존 엔드포인트 제거 (POST/GET /api/costs, /workunits/:slug/costs, /budget/status)
 *   - POST /api/workunits/:slug/retro 제거 (retro 연결 불필요)
 *   - GET /api/workunits/:slug/retro에서 retro_slug 필드 제거
 *   - DB FK 기반 조회로 전환 (pipelines.work_unit_id)
 *   - syncPipelinesFromEvents() 서버 시작 시 호출
 *   - GET /api/pipelines/:slug/tasks 신규 엔드포인트 추가
 *
 * 전략:
 *   - BAMS_ROOT를 임시 디렉토리로 주입하여 ~/.bams 오염 방지
 *   - app.ts를 Bun subprocess로 실행 (포트 3199) → fetch로 호출
 *   - afterAll에서 프로세스 종료
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ─────────────────────────────────────────────────────────────
// 테스트 환경 설정
// ─────────────────────────────────────────────────────────────

const TEST_PORT = 3199
const BASE_URL = `http://localhost:${TEST_PORT}`
const TEST_ROOT = join('/tmp', `bams-test-${randomUUID()}`)
const PIPELINE_DIR = join(TEST_ROOT, 'artifacts', 'pipeline')

let serverProcess: ReturnType<typeof Bun.spawn> | null = null

/** Work Unit JSONL 파일을 생성하여 "존재하는 WU"를 시뮬레이션 */
function createWorkUnitFile(slug: string, name = 'Test WU') {
  const file = join(PIPELINE_DIR, `${slug}-workunit.jsonl`)
  const event = JSON.stringify({
    type: 'work_unit_start',
    work_unit_slug: slug,
    name,
    ts: new Date().toISOString(),
  })
  writeFileSync(file, event + '\n', 'utf-8')
}

/** 파이프라인 이벤트 파일 생성 (활성 파이프라인 시뮬레이션) */
function createActivePipelineFile(pipelineSlug: string, workUnitSlug: string) {
  const file = join(PIPELINE_DIR, `${pipelineSlug}-events.jsonl`)
  writeFileSync(
    file,
    JSON.stringify({
      type: 'pipeline_start',
      pipeline_slug: pipelineSlug,
      work_unit_slug: workUnitSlug,
      ts: new Date().toISOString(),
    }) + '\n',
    'utf-8'
  )
}

/** 완료된 파이프라인 이벤트 파일 생성 */
function createCompletedPipelineFile(pipelineSlug: string, workUnitSlug: string) {
  const file = join(PIPELINE_DIR, `${pipelineSlug}-events.jsonl`)
  const lines = [
    JSON.stringify({ type: 'pipeline_start', pipeline_slug: pipelineSlug, work_unit_slug: workUnitSlug, ts: new Date().toISOString() }),
    JSON.stringify({ type: 'pipeline_end', pipeline_slug: pipelineSlug, status: 'completed', ts: new Date().toISOString() }),
  ]
  writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
}

beforeAll(async () => {
  mkdirSync(PIPELINE_DIR, { recursive: true })
  mkdirSync(join(TEST_ROOT, 'db'), { recursive: true })

  const appPath = join(import.meta.dir, '../../server/src/app.ts')

  serverProcess = Bun.spawn(
    ['bun', 'run', appPath],
    {
      env: {
        ...process.env,
        BAMS_ROOT: TEST_ROOT,
        BAMS_SERVER_PORT: String(TEST_PORT),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )

  // 서버 시작 대기 (최대 3초)
  for (let i = 0; i < 15; i++) {
    await Bun.sleep(200)
    try {
      const res = await fetch(`${BASE_URL}/api/workunits`)
      if (res.status < 500) break
    } catch {
      // 아직 시작 중
    }
  }
})

afterAll(() => {
  serverProcess?.kill()
  try { rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
})

// ─────────────────────────────────────────────────────────────
// PATCH /api/workunits/:slug — 입력 검증 (DB 불필요 경로)
// ─────────────────────────────────────────────────────────────

describe('PATCH /api/workunits/:slug — 입력 검증', () => {
  test('유효하지 않은 status 값 → 400 Bad Request', async () => {
    createWorkUnitFile('wu-invalid-status')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-invalid-status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'invalid-status' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/status must be/)
  })

  test('Invalid JSON body → 400 Bad Request', async () => {
    createWorkUnitFile('wu-bad-json')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-bad-json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  test('status=completed, 활성 파이프라인 있을 때 → 400 (active_pipelines_exist)', async () => {
    createWorkUnitFile('wu-active-pipe-check')
    createActivePipelineFile('pipe-active-99', 'wu-active-pipe-check')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-active-pipe-check`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('active_pipelines_exist')
  })
})

// ─────────────────────────────────────────────────────────────
// PATCH/DELETE /api/workunits/:slug — DB 경로
// ─────────────────────────────────────────────────────────────

describe('PATCH /api/workunits/:slug — DB 경로', () => {
  test('status=abandoned → 200 OK', async () => {
    createWorkUnitFile('wu-abandon-ok')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-abandon-ok`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'abandoned' }),
    })
    expect(res.status).toBe(200)
  })

  test('status=completed (완료된 파이프라인만) → 200 OK', async () => {
    createWorkUnitFile('wu-complete-ok')
    createCompletedPipelineFile('pipe-complete-ok', 'wu-complete-ok')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-complete-ok`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    })
    expect(res.status).toBe(200)
  })
})

describe('DELETE /api/workunits/:slug', () => {
  test('존재하는 Work Unit 삭제 → 204 No Content', async () => {
    createWorkUnitFile('wu-del-ok')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-del-ok`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(204)
  })

  test('존재하지 않는 slug 삭제 → 404 Not Found', async () => {
    const res = await fetch(`${BASE_URL}/api/workunits/wu-ghost-delete-99`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────
// GET /api/workunits/:slug/agents
// ─────────────────────────────────────────────────────────────

describe('GET /api/workunits/:slug/agents', () => {
  test('존재하지 않는 slug → 404 Not Found', async () => {
    const res = await fetch(`${BASE_URL}/api/workunits/wu-agents-ghost/agents`)
    expect(res.status).toBe(404)
  })

  test('존재하는 Work Unit → 200, stats + active_agents', async () => {
    createWorkUnitFile('wu-agents-ok')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-agents-ok/agents`)
    expect(res.status).toBe(200)
    const body = await res.json() as { stats: unknown[]; active_agents: unknown[] }
    expect(Array.isArray(body.stats)).toBe(true)
    expect(Array.isArray(body.active_agents)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// GET /api/workunits/:slug/agents/active
// ─────────────────────────────────────────────────────────────

describe('GET /api/workunits/:slug/agents/active', () => {
  test('존재하지 않는 slug → 404 Not Found', async () => {
    const res = await fetch(`${BASE_URL}/api/workunits/wu-active-ghost/agents/active`)
    expect(res.status).toBe(404)
  })

  test('존재하는 Work Unit (파이프라인 없음) → 200, active_agents 빈 배열', async () => {
    createWorkUnitFile('wu-active-empty')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-active-empty/agents/active`)
    expect(res.status).toBe(200)
    const body = await res.json() as { work_unit_slug: string; active_agents: unknown[] }
    expect(body.work_unit_slug).toBe('wu-active-empty')
    expect(Array.isArray(body.active_agents)).toBe(true)
    expect(body.active_agents.length).toBe(0)
  })

  test('/agents/active가 /agents보다 먼저 매칭된다 (라우팅 우선순위)', async () => {
    createWorkUnitFile('wu-route-test')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-route-test/agents/active`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('active_agents')
    expect(body).not.toHaveProperty('stats')
  })
})

// ─────────────────────────────────────────────────────────────
// PATCH /api/workunits/:slug/pipelines/:pipelineSlug
// ─────────────────────────────────────────────────────────────

describe('PATCH /api/workunits/:slug/pipelines/:pipelineSlug', () => {
  test('존재하지 않는 파이프라인 → 404 Not Found', async () => {
    const res = await fetch(
      `${BASE_URL}/api/workunits/wu-any/pipelines/pipe-ghost-404`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      }
    )
    expect(res.status).toBe(404)
  })

  test('유효하지 않은 status → 400 Bad Request', async () => {
    createActivePipelineFile('pipe-bad-st', 'wu-pipe-bad-st')
    const res = await fetch(
      `${BASE_URL}/api/workunits/wu-pipe-bad-st/pipelines/pipe-bad-st`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'invalid' }),
      }
    )
    expect(res.status).toBe(400)
  })

  test('활성 파이프라인을 completed로 강제 종료 → 200 OK', async () => {
    createWorkUnitFile('wu-force-close')
    createActivePipelineFile('pipe-force-close', 'wu-force-close')
    const res = await fetch(
      `${BASE_URL}/api/workunits/wu-force-close/pipelines/pipe-force-close`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      }
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  test('활성 파이프라인을 failed로 강제 종료 → 200 OK', async () => {
    createWorkUnitFile('wu-force-fail')
    createActivePipelineFile('pipe-force-fail', 'wu-force-fail')
    const res = await fetch(
      `${BASE_URL}/api/workunits/wu-force-fail/pipelines/pipe-force-fail`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'failed' }),
      }
    )
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────
// GET /api/workunits/:slug/retro — 자동 요약만 (retro_slug/POST 제거됨)
// ─────────────────────────────────────────────────────────────

describe('GET /api/workunits/:slug/retro', () => {
  test('존재하지 않는 slug → 404 Not Found', async () => {
    const res = await fetch(`${BASE_URL}/api/workunits/wu-retro-ghost/retro`)
    expect(res.status).toBe(404)
  })

  test('존재하는 Work Unit → 200, auto_summary 포함', async () => {
    createWorkUnitFile('wu-retro-auto')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-retro-auto/retro`)
    expect(res.status).toBe(200)
    const body = await res.json() as { work_unit_slug: string; auto_summary: unknown }
    expect(body.work_unit_slug).toBe('wu-retro-auto')
    // retro_slug 필드가 제거되었는지 확인
    expect(body).not.toHaveProperty('retro_slug')
  })

  test('파이프라인이 있는 Work Unit → auto_summary에 파이프라인 데이터 포함', async () => {
    createWorkUnitFile('wu-retro-with-pipes')
    createCompletedPipelineFile('pipe-retro-1', 'wu-retro-with-pipes')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-retro-with-pipes/retro`)
    expect(res.status).toBe(200)
    const body = await res.json() as { auto_summary: { total_pipelines: number; pipelines: unknown[] } }
    expect(body.auto_summary).not.toBeNull()
    expect(body.auto_summary.total_pipelines).toBe(1)
    expect(Array.isArray(body.auto_summary.pipelines)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// POST /api/workunits/:slug/retro — 제거 확인
// ─────────────────────────────────────────────────────────────

describe('POST /api/workunits/:slug/retro — 제거됨', () => {
  test('POST retro → 404 (엔드포인트 제거됨)', async () => {
    createWorkUnitFile('wu-retro-post-removed')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-retro-post-removed/retro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retro_slug: 'retro_x' }),
    })
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────
// 제거된 엔드포인트 확인 (CostDB 관련)
// ─────────────────────────────────────────────────────────────

describe('제거된 CostDB 엔드포인트', () => {
  test('POST /api/costs → 404', async () => {
    const res = await fetch(`${BASE_URL}/api/costs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline_slug: 'test', model: 'sonnet' }),
    })
    expect(res.status).toBe(404)
  })

  test('GET /api/costs → 404', async () => {
    const res = await fetch(`${BASE_URL}/api/costs`)
    expect(res.status).toBe(404)
  })

  test('GET /api/workunits/:slug/costs → 404', async () => {
    createWorkUnitFile('wu-costs-removed')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-costs-removed/costs`)
    expect(res.status).toBe(404)
  })

  test('GET /api/budget/status → 404', async () => {
    const res = await fetch(`${BASE_URL}/api/budget/status`)
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────
// GET /api/pipelines/:slug/tasks — 신규 엔드포인트
// ─────────────────────────────────────────────────────────────

describe('GET /api/pipelines/:slug/tasks', () => {
  test('존재하지 않는 pipeline → 404', async () => {
    const res = await fetch(`${BASE_URL}/api/pipelines/pipe-ghost-tasks/tasks`)
    expect(res.status).toBe(404)
  })

  test('JSONL만 있는 pipeline → 200, 빈 tasks', async () => {
    createActivePipelineFile('pipe-tasks-jsonl', 'wu-any')
    const res = await fetch(`${BASE_URL}/api/pipelines/pipe-tasks-jsonl/tasks`)
    expect(res.status).toBe(200)
    const body = await res.json() as { pipeline_slug: string; tasks: unknown[]; count: number }
    expect(body.pipeline_slug).toBe('pipe-tasks-jsonl')
    expect(body.count).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────
// Health + 기본 엔드포인트
// ─────────────────────────────────────────────────────────────

describe('기본 엔드포인트', () => {
  test('GET /health → 200 OK', async () => {
    const res = await fetch(`${BASE_URL}/health`)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  test('GET /api/pipelines → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/pipelines`)
    expect(res.status).toBe(200)
  })

  test('GET /api/workunits → 200', async () => {
    const res = await fetch(`${BASE_URL}/api/workunits`)
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────
// GET /api/workunits/:slug — pipelines 배열 포함 확인
// ─────────────────────────────────────────────────────────────

describe('GET /api/workunits/:slug — 상세 응답 구조', () => {
  test('존재하지 않는 slug → 404', async () => {
    const res = await fetch(`${BASE_URL}/api/workunits/wu-detail-ghost-99`)
    expect(res.status).toBe(404)
  })

  test('존재하는 Work Unit → 200, slug/name/status/pipelines/task_summary 포함', async () => {
    createWorkUnitFile('wu-detail-ok')
    const res = await fetch(`${BASE_URL}/api/workunits/wu-detail-ok`)
    expect(res.status).toBe(200)

    const body = await res.json() as {
      slug: string
      name: string
      status: string
      pipelines: unknown[]
      task_summary: { total: number }
    }
    expect(body.slug).toBe('wu-detail-ok')
    expect(body).toHaveProperty('name')
    expect(body).toHaveProperty('status')
    expect(Array.isArray(body.pipelines)).toBe(true)
    expect(body).toHaveProperty('task_summary')
    expect(typeof body.task_summary.total).toBe('number')
  })

  test('파이프라인이 연결된 Work Unit → pipelines 배열에 포함', async () => {
    createWorkUnitFile('wu-detail-pipes')
    createActivePipelineFile('pipe-detail-1', 'wu-detail-pipes')
    createCompletedPipelineFile('pipe-detail-2', 'wu-detail-pipes')

    const res = await fetch(`${BASE_URL}/api/workunits/wu-detail-pipes`)
    expect(res.status).toBe(200)

    const body = await res.json() as {
      pipelines: Array<{ slug: string; type: string; status: string }>
    }
    expect(body.pipelines.length).toBeGreaterThanOrEqual(1)
    // 각 파이프라인에 slug, type, status 필드가 있는지 확인
    for (const p of body.pipelines) {
      expect(p).toHaveProperty('slug')
      expect(p).toHaveProperty('type')
      expect(p).toHaveProperty('status')
    }
  })
})

// ─────────────────────────────────────────────────────────────
// GET /api/pipelines/:slug/tasks — 추가 시나리오
// ─────────────────────────────────────────────────────────────

describe('GET /api/pipelines/:slug/tasks — 추가 시나리오', () => {
  test('응답에 pipeline_slug, tasks, count 필드가 포함된다', async () => {
    createActivePipelineFile('pipe-tasks-struct', 'wu-any')
    const res = await fetch(`${BASE_URL}/api/pipelines/pipe-tasks-struct/tasks`)
    expect(res.status).toBe(200)

    const body = await res.json() as {
      pipeline_slug: string
      tasks: unknown[]
      count: number
    }
    expect(body.pipeline_slug).toBe('pipe-tasks-struct')
    expect(Array.isArray(body.tasks)).toBe(true)
    expect(typeof body.count).toBe('number')
    expect(body.count).toBe(body.tasks.length)
  })
})

// ─────────────────────────────────────────────────────────────
// syncPipelinesFromEvents — DB 동기화 후 상태 확인
// ─────────────────────────────────────────────────────────────

describe('syncPipelinesFromEvents 통합', () => {
  test('서버 시작 후 GET /api/pipelines가 { pipelines: [] } 구조를 반환한다', async () => {
    const res = await fetch(`${BASE_URL}/api/pipelines`)
    expect(res.status).toBe(200)
    const body = await res.json() as { pipelines: unknown[] }
    expect(Array.isArray(body.pipelines)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// 제거된 CostDB 엔드포인트 — 추가 확인
// ─────────────────────────────────────────────────────────────

describe('제거된 엔드포인트 — 추가 확인', () => {
  test('PUT /api/costs → 404 (메서드 불문 제거)', async () => {
    const res = await fetch(`${BASE_URL}/api/costs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  test('GET /api/budget → 404', async () => {
    const res = await fetch(`${BASE_URL}/api/budget`)
    expect(res.status).toBe(404)
  })
})
