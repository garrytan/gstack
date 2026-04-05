'use client'

import type { BudgetStatusItem } from '@/lib/types'

interface BudgetProgressBarProps {
  status: BudgetStatusItem
}

function formatMetric(value: number, metric: string): string {
  if (metric === 'billed_cents') {
    return value < 100 ? `$${(value / 100).toFixed(3)}` : `$${(value / 100).toFixed(2)}`
  }
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M tok`
    : value >= 1_000
    ? `${(value / 1_000).toFixed(1)}K tok`
    : `${value} tok`
}

export function BudgetProgressBar({ status }: BudgetProgressBarProps) {
  const { policy, current, percent, warn, hard_stop } = status

  const barColor = hard_stop
    ? 'var(--status-fail, #ef4444)'
    : warn
    ? 'var(--priority-high, #f97316)'
    : 'var(--status-done, #22c55e)'

  const scopeLabel = policy.scope_id
    ? `${policy.scope_type}/${policy.scope_id}`
    : policy.scope_type

  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: '6px',
      background: hard_stop
        ? 'rgba(239, 68, 68, 0.08)'
        : warn
        ? 'rgba(249, 115, 22, 0.08)'
        : 'var(--bg-card, rgba(255,255,255,0.04))',
      border: `1px solid ${hard_stop ? 'rgba(239,68,68,0.3)' : warn ? 'rgba(249,115,22,0.3)' : 'var(--border-light)'}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', gap: '8px' }}>
        <div>
          <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)' }}>
            {scopeLabel}
          </span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: '6px' }}>
            {policy.window_kind}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {hard_stop && (
            <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--status-fail, #ef4444)', background: 'rgba(239,68,68,0.15)', padding: '1px 6px', borderRadius: '4px' }}>
              HARD STOP
            </span>
          )}
          {!hard_stop && warn && (
            <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--priority-high, #f97316)' }}>
              WARN
            </span>
          )}
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            {formatMetric(current, policy.metric)} / {formatMetric(policy.amount, policy.metric)}
          </span>
          <span style={{ fontSize: '11px', fontWeight: 700, color: barColor }}>
            {percent.toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Progress track */}
      <div style={{
        height: '8px',
        borderRadius: '4px',
        background: 'var(--border-light, rgba(148, 163, 184, 0.15))',
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${Math.min(percent, 100)}%`,
          borderRadius: '4px',
          background: barColor,
          transition: 'width 0.3s ease',
        }} />
      </div>

      {/* Warn threshold marker */}
      <div style={{ position: 'relative', height: '4px', marginTop: '2px' }}>
        <div
          title={`Warn threshold: ${policy.warn_percent}%`}
          style={{
            position: 'absolute',
            left: `${policy.warn_percent}%`,
            top: 0,
            width: '1px',
            height: '4px',
            background: 'var(--priority-high, #f97316)',
            opacity: 0.6,
          }}
        />
      </div>
    </div>
  )
}
