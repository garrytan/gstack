import { NextRequest, NextResponse } from 'next/server'

const BAMS_SERVER = process.env.BAMS_SERVER_URL ?? 'http://localhost:3099'

function headers(source: string) {
  return { 'Access-Control-Allow-Origin': '*', 'X-Data-Source': source }
}

export async function GET() {
  try {
    const res = await fetch(`${BAMS_SERVER}/api/pipelines`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const data = await res.json()
      // API Contract: passthrough bams-server response as { pipelines: [...] }
      // Consumers (bams-api.ts getPipelines) expect { pipelines: PipelineSummary[] }
      const pipelines = data.pipelines ?? data
      return NextResponse.json({ pipelines }, { headers: headers('api') })
    }
    return NextResponse.json({ pipelines: [] }, { headers: headers('error') })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500, headers: headers('error') })
  }
}

export async function DELETE(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get('slug')

  // Note: Pipeline deletion is not yet supported via bams-server API.
  // For now, return 501 Not Implemented. Pipeline 5 will handle cleanup.
  return NextResponse.json(
    { error: 'Pipeline deletion via API not yet implemented. Use bams-server directly.' },
    { status: 501, headers: headers('api') }
  )
}
