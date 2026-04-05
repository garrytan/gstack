'use client'

interface CostBarProps {
  /** 이 항목이 청구된 금액 (USD cents) */
  billedCents: number
  /** 최대값 (전체 bar 기준, 백분율 계산용) */
  maxCents: number
  /** bar 레이블 (에이전트 슬러그, 파이프라인 슬러그 등) */
  label: string
  /** 서브레이블 (모델명 등) */
  subLabel?: string
}

function formatCents(cents: number): string {
  if (cents < 1) return `$0.00`
  const dollars = cents / 100
  return dollars < 0.01 ? `$0.00` : `$${dollars.toFixed(2)}`
}

export function CostBar({ billedCents, maxCents, label, subLabel }: CostBarProps) {
  const pct = maxCents > 0 ? Math.min((billedCents / maxCents) * 100, 100) : 0
  const barColor = pct > 80
    ? 'var(--status-fail, #ef4444)'
    : pct > 50
    ? 'var(--priority-high, #f97316)'
    : 'var(--accent, #3b82f6)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
          <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {label}
          </span>
          {subLabel && (
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              ({subLabel})
            </span>
          )}
        </div>
        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
          {formatCents(billedCents)}
        </span>
      </div>
      <div style={{
        height: '6px',
        borderRadius: '3px',
        background: 'var(--border-light, rgba(148, 163, 184, 0.15))',
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${pct}%`,
          borderRadius: '3px',
          background: barColor,
          transition: 'width 0.3s ease',
        }} />
      </div>
    </div>
  )
}
