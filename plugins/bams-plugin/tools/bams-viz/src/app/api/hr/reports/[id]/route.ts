import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { getDbPath } from '@/lib/global-root'
import { EventStore } from '@/lib/event-store'
import type { HRReportDetailResponse } from '@/lib/types'

const corsHeaders = { 'Access-Control-Allow-Origin': '*' }
const BAMS_SERVER = process.env.BAMS_SERVER_URL ?? 'http://localhost:3099'

// ── bams-server 우선 호출 ────────────────────────────────────────────────────

async function fetchFromServer(id: string): Promise<HRReportDetailResponse | null> {
  try {
    const res = await fetch(`${BAMS_SERVER}/api/hr/reports/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    return res.json() as Promise<HRReportDetailResponse>
  } catch {
    return null
  }
}

// ── DB fallback ──────────────────────────────────────────────────────────────

function fetchFromDb(id: string): HRReportDetailResponse | null {
  const dbPath = getDbPath()
  if (!dbPath) return null

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(dbPath, { readonly: true })

    const row = db
      .prepare<{
        id: string
        retro_slug: string
        report_date: string
        source: string
        period_start: string | null
        period_end: string | null
        data: string
      }, [string]>('SELECT * FROM hr_reports WHERE id = ?')
      .get(id)

    db.close()

    if (!row) return null

    let data: Record<string, unknown> = {}
    try { data = JSON.parse(row.data) } catch { /* ignore */ }

    return {
      id: row.id,
      retro_slug: row.retro_slug,
      report_date: row.report_date,
      source: row.source,
      period_start: row.period_start,
      period_end: row.period_end,
      data,
    }
  } catch (err) {
    console.warn('[hr/reports/[id]] DB 조회 실패:', err)
    return null
  }
}

// ── JSON fallback ─────────────────────────────────────────────────────────────

function fetchFromJson(id: string): HRReportDetailResponse | null {
  const crewRoot = EventStore.findCrewRoot()
  const hrDir = join(crewRoot, 'artifacts', 'hr')

  // id가 파일명 형식인지 확인: retro-report-{slug}-{date}.json or weekly-report-{date}.json
  const possibleFiles = [
    `${id}.json`,
    `retro-report-${id}.json`,
    `weekly-report-${id}.json`,
  ]

  for (const filename of possibleFiles) {
    const filepath = join(hrDir, filename)
    if (existsSync(filepath)) {
      try {
        const raw = JSON.parse(readFileSync(filepath, 'utf-8')) as Record<string, unknown>
        const dateMatch = filename.match(/-(\d{4}-\d{2}-\d{2})\.json$/)
        const reportDate = (raw.report_date as string) ?? dateMatch?.[1] ?? id
        const isRetro = filename.startsWith('retro-report-')
        const slugMatch = filename.match(/^retro-report-(.+)-\d{4}-\d{2}-\d{2}\.json$/)
        return {
          id,
          retro_slug: (raw.retro_slug as string) ?? (isRetro ? (slugMatch?.[1] ?? id) : id),
          report_date: reportDate,
          source: (raw.source as string) ?? (isRetro ? 'retro' : 'weekly'),
          period_start: (raw.period as { start?: string })?.start ?? null,
          period_end: (raw.period as { end?: string })?.end ?? null,
          data: raw,
        }
      } catch {
        continue
      }
    }
  }

  return null
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const decodedId = decodeURIComponent(id)

  // 1. bams-server 우선
  const serverResult = await fetchFromServer(decodedId)
  if (serverResult !== null) {
    return NextResponse.json(serverResult, { headers: corsHeaders })
  }

  // 2. DB fallback
  const dbResult = fetchFromDb(decodedId)
  if (dbResult !== null) {
    return NextResponse.json(dbResult, { headers: { ...corsHeaders, 'X-Data-Source': 'fallback-db' } })
  }

  // 3. JSON fallback
  const jsonResult = fetchFromJson(decodedId)
  if (jsonResult !== null) {
    return NextResponse.json(jsonResult, { headers: { ...corsHeaders, 'X-Data-Source': 'fallback-json' } })
  }

  return NextResponse.json({ error: `HR report not found: ${decodedId}` }, { status: 404, headers: corsHeaders })
}
