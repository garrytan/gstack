import { NextResponse } from 'next/server'
import { EventStore } from '@/lib/event-store'

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


function headers(source: string = 'bams-server') {
  return { 'Access-Control-Allow-Origin': '*', 'X-Data-Source': source }
}

const BAMS_SERVER = process.env.BAMS_SERVER_URL ?? 'http://localhost:3099'

// ── bams-server 우선 호출 (task_summary, total_billed_cents 포함) ────────────
async function fetchFromServer(slug: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${BAMS_SERVER}/api/workunits/${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    const data = await res.json()
    // bams-server returns flat object; wrap in { workunit: ... } for consistency
    return { workunit: data }
  } catch {
    return null
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug: rawSlug } = await params
  const slug = safeDecodeSlug(rawSlug)

  // 1. bams-server 우선 (task_summary + total_billed_cents 포함)
  const serverResult = await fetchFromServer(slug)
  if (serverResult !== null) {
    return NextResponse.json(serverResult, { headers: { ...headers(), 'X-Data-Source': 'bams-server' } })
  }

  // 2. EventStore fallback
  try {
    const store = EventStore.getInstance()
    const events = store.getWorkUnitEvents(slug)

    if (events.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: headers('fallback') })
    }

    const workunits = store.getWorkUnits()
    const workunit = workunits.find((wu) => wu.slug === slug) ?? null

    if (!workunit) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: headers('fallback') })
    }

    // Enrich with full pipeline data
    const pipelinesDetail = (workunit.pipelines ?? []).map((p) => {
      const pipeline = store.getPipeline(p.slug)
      return {
        ...p,
        status: pipeline?.status ?? p.status ?? 'unknown',
        startedAt: pipeline?.startedAt ?? null,
        endedAt: pipeline?.endedAt ?? null,
        type: pipeline?.type ?? p.type,
      }
    })

    return NextResponse.json({
      workunit: {
        ...workunit,
        pipelines: pipelinesDetail,
        events,
        task_summary: { total: 0, backlog: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0 },
        total_billed_cents: 0,
      },
    }, { headers: { ...headers('fallback') } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500, headers: headers('error') })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug: rawSlug } = await params
  const slug = safeDecodeSlug(rawSlug)
  try {
    const body = await request.text()
    const res = await fetch(`${BAMS_SERVER}/api/workunits/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5000),
    })
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json', ...headers() },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy error'
    return NextResponse.json({ error: message }, { status: 502, headers: headers('error') })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug: rawSlug } = await params
  const slug = safeDecodeSlug(rawSlug)
  try {
    const res = await fetch(`${BAMS_SERVER}/api/workunits/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    })
    return new Response(res.status === 204 ? null : await res.text(), {
      status: res.status,
      headers: headers(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy error'
    return NextResponse.json({ error: message }, { status: 502, headers: headers('error') })
  }
}
