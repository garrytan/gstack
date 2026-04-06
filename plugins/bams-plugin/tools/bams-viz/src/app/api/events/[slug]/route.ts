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


function headers(source: string) {
  return { 'Access-Control-Allow-Origin': '*', 'X-Data-Source': source }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug: rawSlug } = await params
  const slug = safeDecodeSlug(rawSlug)

  // Note: bamsApi.getPipeline() returns { slug, events, tasks, summary } which is NOT
  // the Pipeline type ({ steps, agents, status, ... }) expected by DagTab/GanttTab.
  // Always use EventStore which parses events into the correct Pipeline shape.
  try {
    const store = EventStore.getInstance()
    const pipeline = store.getPipeline(slug)
    if (!pipeline) {
      return NextResponse.json({ error: 'Not found' }, { status: 404, headers: headers('fallback') })
    }
    return NextResponse.json(pipeline, { headers: headers('fallback') })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500, headers: headers('error') })
  }
}
