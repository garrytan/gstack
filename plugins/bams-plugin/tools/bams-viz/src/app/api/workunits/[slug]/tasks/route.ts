import { NextResponse } from 'next/server'
import { EventStore } from '@/lib/event-store'
import { getDbPath } from '@/lib/global-root'
import type { WorkUnitTasksResponse } from '@/lib/types'

/** Defensively decode percent-encoded slug. Handles double-encoding. */
function safeDecodeSlug(raw: string): string {
  try {
    let decoded = raw
    for (let i = 0; i < 2; i++) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    }
    return decoded
  } catch {
    return raw
  }
}


const corsHeaders = { 'Access-Control-Allow-Origin': '*' }
const BAMS_SERVER = process.env.BAMS_SERVER_URL ?? 'http://localhost:3099'

// ── bams-server 우선 호출 ────────────────────────────────────────────────────

async function fetchFromServer(slug: string): Promise<WorkUnitTasksResponse | null> {
  try {
    const res = await fetch(`${BAMS_SERVER}/api/workunits/${encodeURIComponent(slug)}/tasks`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    return res.json() as Promise<WorkUnitTasksResponse>
  } catch {
    return null
  }
}

// ── EventStore + DB fallback ─────────────────────────────────────────────────

function fetchFromFallback(slug: string): WorkUnitTasksResponse | null {
  const store = EventStore.getInstance()
  const wuEvents = store.getWorkUnitEvents(slug)
  if (wuEvents.length === 0) return null

  // 연결된 파이프라인 slug 수집
  const linkedSlugs: string[] = wuEvents
    .filter(e => e.type === 'pipeline_linked')
    .map(e => (e as { pipeline_slug?: string }).pipeline_slug ?? '')
    .filter(Boolean)

  // DB에서 태스크 조회
  const dbPath = getDbPath()
  if (!dbPath) {
    return {
      work_unit_slug: slug,
      pipelines: linkedSlugs.map(ps => ({ slug: ps, tasks: [] })),
      total_count: 0,
      summary: { backlog: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0 },
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(dbPath, { readonly: true })

    // N+1 해결: IN절 단일 쿼리로 모든 파이프라인의 태스크를 한 번에 조회
    const placeholders = linkedSlugs.map(() => '?').join(', ')
    const allTaskRows = linkedSlugs.length > 0
      ? db
          .prepare<Record<string, unknown>, string[]>(
            `SELECT * FROM tasks WHERE pipeline_slug IN (${placeholders}) ORDER BY pipeline_slug, created_at ASC`
          )
          .all(...linkedSlugs)
      : []

    db.close()

    // pipeline_slug 기준으로 그룹핑
    const tasksByPipeline = new Map<string, Record<string, unknown>[]>()
    for (const ps of linkedSlugs) {
      tasksByPipeline.set(ps, [])
    }
    for (const row of allTaskRows) {
      const ps = row['pipeline_slug'] as string
      if (tasksByPipeline.has(ps)) {
        tasksByPipeline.get(ps)!.push(row)
      }
    }

    const pipelinesWithTasks = linkedSlugs.map(ps => ({
      slug: ps,
      tasks: tasksByPipeline.get(ps) ?? [],
    }))

    const summary = {
      backlog:     allTaskRows.filter(t => t['status'] === 'backlog').length,
      in_progress: allTaskRows.filter(t => t['status'] === 'in_progress').length,
      in_review:   allTaskRows.filter(t => t['status'] === 'in_review').length,
      done:        allTaskRows.filter(t => t['status'] === 'done').length,
      blocked:     allTaskRows.filter(t => t['status'] === 'blocked').length,
      cancelled:   allTaskRows.filter(t => t['status'] === 'cancelled').length,
    }

    return {
      work_unit_slug: slug,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pipelines: pipelinesWithTasks as any as WorkUnitTasksResponse['pipelines'],
      total_count: allTaskRows.length,
      summary,
    }
  } catch (err) {
    console.warn('[workunits/tasks] DB fallback 실패:', err)
    return null
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug: rawSlug } = await params
  const slug = safeDecodeSlug(rawSlug)

  // 1. bams-server 우선
  const serverResult = await fetchFromServer(slug)
  if (serverResult !== null) {
    return NextResponse.json(serverResult, { headers: corsHeaders })
  }

  // 2. EventStore + DB fallback
  const fallback = fetchFromFallback(slug)
  if (fallback === null) {
    return NextResponse.json({ error: 'Work unit not found' }, { status: 404, headers: corsHeaders })
  }

  return NextResponse.json(fallback, { headers: { ...corsHeaders, 'X-Data-Source': 'fallback' } })
}
