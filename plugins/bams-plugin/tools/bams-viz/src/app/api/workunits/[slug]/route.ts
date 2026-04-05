import { NextResponse } from 'next/server'
import { EventStore } from '@/lib/event-store'

function headers() {
  return { 'Access-Control-Allow-Origin': '*', 'X-Data-Source': 'direct' }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params
    const store = EventStore.getInstance()
    const events = store.getWorkUnitEvents(slug)

    if (events.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: headers() })
    }

    // Build full work unit with pipeline details
    const workunits = store.getWorkUnits()
    const workunit = workunits.find((wu) => wu.slug === slug) ?? null

    if (!workunit) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: headers() })
    }

    // Enrich with full pipeline data for each linked pipeline
    const pipelinesDetail = workunit.pipelines.map((p) => {
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
      },
    }, { headers: headers() })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500, headers: headers() })
  }
}
