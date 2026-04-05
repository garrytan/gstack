'use client'

type Priority = 'high' | 'medium' | 'low'

const PRIORITY_CONFIG: Record<Priority, { label: string; color: string }> = {
  high:   { label: 'H', color: 'var(--priority-high, #f97316)' },
  medium: { label: 'M', color: 'var(--priority-medium, #eab308)' },
  low:    { label: 'L', color: 'var(--priority-low, #22c55e)' },
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const cfg = PRIORITY_CONFIG[priority] ?? PRIORITY_CONFIG.medium
  return (
    <span
      title={`Priority: ${priority}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '18px',
        height: '18px',
        borderRadius: '4px',
        fontSize: '10px',
        fontWeight: 700,
        lineHeight: 1,
        background: `${cfg.color}22`,
        color: cfg.color,
        border: `1px solid ${cfg.color}44`,
        flexShrink: 0,
        letterSpacing: 0,
      }}
    >
      {cfg.label}
    </span>
  )
}
