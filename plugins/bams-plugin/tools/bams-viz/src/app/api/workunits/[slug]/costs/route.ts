import { NextResponse } from 'next/server'
import { EventStore } from '@/lib/event-store'
import { getDbPath } from '@/lib/global-root'
import type { WorkUnitCostsResponse } from '@/lib/types'

const corsHeaders = { 'Access-Control-Allow-Origin': '*' }
const BAMS_SERVER = process.env.BAMS_SERVER_URL ?? 'http://localhost:3099'

// ── bams-server 우선 호출 ────────────────────────────────────────────────────

async function fetchFromServer(slug: string): Promise<WorkUnitCostsResponse | null> {
  try {
    const res = await fetch(`${BAMS_SERVER}/api/workunits/${encodeURIComponent(slug)}/costs`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    return res.json() as Promise<WorkUnitCostsResponse>
  } catch {
    return null
  }
}

// ── DB fallback ──────────────────────────────────────────────────────────────

interface CostRow {
  agent_slug: string
  model: string
  billed_cents: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  pipeline_slug: string
}

function fetchFromFallback(slug: string): WorkUnitCostsResponse | null {
  const store = EventStore.getInstance()
  const wuEvents = store.getWorkUnitEvents(slug)
  if (wuEvents.length === 0) return null

  const linkedSlugs: string[] = wuEvents
    .filter(e => e.type === 'pipeline_linked')
    .map(e => (e as { pipeline_slug?: string }).pipeline_slug ?? '')
    .filter(Boolean)

  const dbPath = getDbPath()
  if (!dbPath) {
    return {
      work_unit_slug: slug,
      total_billed_cents: 0,
      by_pipeline: linkedSlugs.map(ps => ({
        pipeline_slug: ps,
        billed_cents: 0,
        input_tokens: 0,
        output_tokens: 0,
      })),
      by_agent: [],
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(dbPath, { readonly: true })

    // pipeline별 집계
    const placeholders = linkedSlugs.map(() => '?').join(',')
    if (!placeholders) {
      db.close()
      return { work_unit_slug: slug, total_billed_cents: 0, by_pipeline: [], by_agent: [] }
    }

    const byPipeline = db
      .prepare<
        { pipeline_slug: string; billed_cents: number; input_tokens: number; output_tokens: number },
        string[]
      >(
        `SELECT pipeline_slug,
                SUM(billed_cents) as billed_cents,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens
         FROM cost_records
         WHERE pipeline_slug IN (${placeholders})
         GROUP BY pipeline_slug`
      )
      .all(...linkedSlugs)

    const byAgent = db
      .prepare<CostRow, string[]>(
        `SELECT agent_slug, model,
                SUM(billed_cents) as billed_cents,
                SUM(input_tokens) as input_tokens,
                SUM(output_tokens) as output_tokens,
                SUM(cache_read_tokens) as cache_read_tokens,
                SUM(cache_write_tokens) as cache_write_tokens
         FROM cost_records
         WHERE pipeline_slug IN (${placeholders})
         GROUP BY agent_slug, model
         ORDER BY billed_cents DESC`
      )
      .all(...linkedSlugs)

    db.close()

    const total = byPipeline.reduce((sum, p) => sum + (p.billed_cents ?? 0), 0)

    return {
      work_unit_slug: slug,
      total_billed_cents: total,
      by_pipeline: byPipeline,
      by_agent: byAgent,
    }
  } catch (err) {
    console.warn('[workunits/costs] DB fallback 실패:', err)
    return null
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params

  // 1. bams-server 우선
  const serverResult = await fetchFromServer(slug)
  if (serverResult !== null) {
    return NextResponse.json(serverResult, { headers: corsHeaders })
  }

  // 2. DB fallback
  const fallback = fetchFromFallback(slug)
  if (fallback === null) {
    return NextResponse.json({ error: 'Work unit not found' }, { status: 404, headers: corsHeaders })
  }

  return NextResponse.json(fallback, { headers: { ...corsHeaders, 'X-Data-Source': 'fallback' } })
}
