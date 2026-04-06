import { NextResponse } from 'next/server'

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


const BAMS_SERVER = process.env.BAMS_SERVER_URL ?? 'http://localhost:3099'

function headers(source: string = 'bams-server') {
  return { 'Access-Control-Allow-Origin': '*', 'X-Data-Source': source }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug: rawSlug } = await params
  const slug = safeDecodeSlug(rawSlug)
  try {
    const res = await fetch(
      `${BAMS_SERVER}/api/workunits/${encodeURIComponent(slug)}/agents`,
      { signal: AbortSignal.timeout(3000) }
    )
    if (res.ok) {
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Content-Type': 'application/json', ...headers() },
      })
    }
    return NextResponse.json({ error: 'Not found' }, { status: res.status, headers: headers() })
  } catch {
    // bams-server 다운 시 빈 응답으로 graceful degradation
    return NextResponse.json(
      { work_unit_slug: slug, stats: [], active_agents: [] },
      { headers: headers('fallback') }
    )
  }
}
