import { NextResponse } from 'next/server'

const BAMS_SERVER = process.env.BAMS_SERVER_URL ?? 'http://localhost:3099'
const corsHeaders = { 'Access-Control-Allow-Origin': '*' }

/**
 * GET /api/hr/retro-journal
 *
 * N+1 해소: bams-server의 /api/hr/reports가 이미 각 보고서의 `data` JSON 컬럼을
 * 포함하여 반환하므로, 개별 /api/hr/reports/:id fetch 없이 목록 응답만으로
 * retro_metadata, agents, alerts 등 상세 데이터를 추출한다.
 *
 * Before: 1 (list) + N (detail per report) = N+1 requests
 * After:  1 (list) request only
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const slug = url.searchParams.get('slug') || undefined

    // Single fetch: list API already includes full `data` JSON column
    const res = await fetch(`${BAMS_SERVER}/api/hr/reports`, {
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      return NextResponse.json([], { headers: corsHeaders })
    }

    const json = await res.json()
    const reports: Array<Record<string, unknown>> = json.reports ?? json

    if (!Array.isArray(reports)) {
      return NextResponse.json([], { headers: corsHeaders })
    }

    // Filter retro reports and extract detail from inline `data` column
    const entries = []

    for (const r of reports) {
      if (r.source !== 'retro') continue
      if (slug && r.retro_slug !== slug) continue

      // Parse the `data` JSON column (serialized HRReport)
      let parsed: Record<string, unknown> = {}
      if (typeof r.data === 'string') {
        try {
          parsed = JSON.parse(r.data)
        } catch {
          continue
        }
      } else if (typeof r.data === 'object' && r.data !== null) {
        parsed = r.data as Record<string, unknown>
      }

      if (!parsed.retro_metadata) continue

      const reportId = (r.id ?? r.retro_slug) as string
      entries.push({
        retro_slug: (r.retro_slug ?? reportId) as string,
        report_date: r.report_date as string,
        period: parsed.period ?? {
          start: (r.period_start ?? null) as string | null,
          end: (r.period_end ?? null) as string | null,
        },
        agent_count: Array.isArray(parsed.agents) ? parsed.agents.length : 0,
        alert_count: Array.isArray(parsed.alerts) ? parsed.alerts.length : 0,
        retro_metadata: parsed.retro_metadata,
        agents: parsed.agents ?? [],
      })
    }

    return NextResponse.json(entries, { headers: corsHeaders })
  } catch (error) {
    console.error('[retro-journal] Unexpected error:', error)
    return NextResponse.json([], { headers: corsHeaders, status: 200 })
  }
}
