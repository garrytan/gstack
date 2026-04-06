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

function headers() {
  return { 'Access-Control-Allow-Origin': '*', 'X-Data-Source': 'bams-server' }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string; pipelineSlug: string }> }
) {
  const { slug: rawSlug, pipelineSlug: rawPipelineSlug } = await params
  const slug = safeDecodeSlug(rawSlug)
  const pipelineSlug = safeDecodeSlug(rawPipelineSlug)
  try {
    const body = await request.text()
    const res = await fetch(
      `${BAMS_SERVER}/api/workunits/${encodeURIComponent(slug)}/pipelines/${encodeURIComponent(pipelineSlug)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      }
    )
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json', ...headers() },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy error'
    return NextResponse.json({ error: message }, { status: 502, headers: headers() })
  }
}
