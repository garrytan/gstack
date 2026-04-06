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


const corsHeaders = { 'Access-Control-Allow-Origin': '*' }

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug: rawSlug } = await params
  const slug = safeDecodeSlug(rawSlug)
    const store = EventStore.getInstance()
    const events = store.getRawEvents(slug)
    return NextResponse.json(events, { headers: corsHeaders })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500, headers: corsHeaders })
  }
}
