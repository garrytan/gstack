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

function headers(source: string = 'bams-server') {
  return { 'Access-Control-Allow-Origin': '*', 'X-Data-Source': source }
}

const BAMS_SERVER = process.env.BAMS_SERVER_URL ?? 'http://localhost:3099'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug: rawSlug } = await params
  const slug = safeDecodeSlug(rawSlug)

  try {
    const res = await fetch(`${BAMS_SERVER}/api/workunits/${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const data = await res.json()
      // API Contract: passthrough as { workunit: ... }
      // Consumers (bams-api.ts getWorkUnit/getWorkUnitDetail, work/[slug]/page.tsx) expect { workunit: WorkUnit }
      const workunit = data.workunit ?? data
      return NextResponse.json({ workunit }, { headers: headers('bams-server') })
    }
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: headers('error') })
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
