import { NextRequest, NextResponse } from 'next/server'
import { EventStore } from '@/lib/event-store'
import { bamsApi } from '@/lib/bams-api'

function headers(source: string) {
  return { 'Access-Control-Allow-Origin': '*', 'X-Data-Source': source }
}

export async function GET() {
  // API 우선: Control Plane에서 파이프라인 목록 조회
  try {
    const data = await bamsApi.getPipelines()
    // Unwrap: consumers expect a raw array, not { pipelines: [...] }
    const list = data.pipelines ?? data
    return NextResponse.json(list, { headers: headers('api') })
  } catch {
    // Fallback: EventStore (파일 기반)
    try {
      const store = EventStore.getInstance()
      const pipelines = store.getPipelines().map((p) => {
        // Extract work_unit_slug from pipeline_start event
        const events = store.getRawEvents(p.slug)
        const startEvent = events.find((e) => e.type === 'pipeline_start')
        const workUnitSlug = (startEvent as Record<string, unknown>)?.work_unit_slug as string | undefined
        return { ...p, work_unit_slug: workUnitSlug ?? null }
      })
      return NextResponse.json(pipelines, { headers: headers('fallback') })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error'
      return NextResponse.json({ error: message }, { status: 500, headers: headers('error') })
    }
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const slug = request.nextUrl.searchParams.get('slug')
    const store = EventStore.getInstance()

    if (slug) {
      const deleted = store.deletePipeline(slug)
      if (!deleted) {
        return NextResponse.json({ error: 'Not found' }, { status: 404, headers: headers('direct') })
      }
      return NextResponse.json({ deleted: slug }, { headers: headers('direct') })
    } else {
      const count = store.deleteAllPipelines()
      return NextResponse.json({ deleted: 'all', count }, { headers: headers('direct') })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500, headers: headers('direct') })
  }
}
