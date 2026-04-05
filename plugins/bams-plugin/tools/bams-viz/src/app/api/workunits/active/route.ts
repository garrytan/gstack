import { NextResponse } from 'next/server'
import { EventStore } from '@/lib/event-store'

function headers() {
  return { 'Access-Control-Allow-Origin': '*', 'X-Data-Source': 'direct' }
}

export async function GET() {
  try {
    const store = EventStore.getInstance()
    const workunit = store.getActiveWorkUnit()
    return NextResponse.json({ workunit }, { headers: headers() })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500, headers: headers() })
  }
}
