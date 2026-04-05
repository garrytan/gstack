import { NextResponse } from 'next/server'
import { getDbPath } from '@/lib/global-root'
import type { BudgetStatusResponse } from '@/lib/types'

const corsHeaders = { 'Access-Control-Allow-Origin': '*' }
const BAMS_SERVER = process.env.BAMS_SERVER_URL ?? 'http://localhost:3099'

// ── bams-server 우선 호출 ────────────────────────────────────────────────────

async function fetchFromServer(): Promise<BudgetStatusResponse | null> {
  try {
    const res = await fetch(`${BAMS_SERVER}/api/budget/status`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    return res.json() as Promise<BudgetStatusResponse>
  } catch {
    return null
  }
}

// ── DB fallback ──────────────────────────────────────────────────────────────

function fetchFromFallback(): BudgetStatusResponse | null {
  const dbPath = getDbPath()
  if (!dbPath) return { statuses: [] }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(dbPath, { readonly: true })

    // budget_policies 테이블이 없을 수도 있으므로 try-catch
    interface PolicyRow {
      id: string
      scope_type: 'agent' | 'pipeline' | 'global'
      scope_id: string | null
      metric: string
      window_kind: string
      amount: number
      warn_percent: number
      hard_stop_enabled: number
      is_active: number
    }

    const policies = db
      .prepare<PolicyRow, []>(
        `SELECT id, scope_type, scope_id, metric, window_kind, amount, warn_percent, hard_stop_enabled, is_active
         FROM budget_policies
         WHERE is_active = 1
         ORDER BY scope_type`
      )
      .all()

    db.close()

    // 각 policy에 대해 현재 사용량 계산 (간단한 fallback — 전체 합산)
    const statuses = policies.map(policy => {
      const current = 0 // fallback에서는 현재 사용량 계산 생략
      const percent = policy.amount > 0 ? (current / policy.amount) * 100 : 0
      return {
        policy,
        current,
        percent,
        warn: percent >= policy.warn_percent,
        hard_stop: policy.hard_stop_enabled === 1 && percent >= 100,
      }
    })

    return { statuses }
  } catch (err) {
    console.warn('[budget/status] DB fallback 실패:', err)
    return { statuses: [] }
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  // 1. bams-server 우선
  const serverResult = await fetchFromServer()
  if (serverResult !== null) {
    return NextResponse.json(serverResult, { headers: corsHeaders })
  }

  // 2. DB fallback
  const fallback = fetchFromFallback()
  return NextResponse.json(fallback ?? { statuses: [] }, {
    headers: { ...corsHeaders, 'X-Data-Source': 'fallback' },
  })
}
