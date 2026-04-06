'use client'

import type { CSSProperties } from 'react'

const COLOR_MAP: Record<string, string> = {
  active: '#3b82f6',
  running: '#3b82f6',
  in_progress: '#3b82f6',
  completed: '#22c55e',
  done: '#22c55e',
  success: '#22c55e',
  failed: '#ef4444',
  error: '#ef4444',
  abandoned: '#ef4444',
  cancelled: '#ef4444',
  paused: '#eab308',
  warning: '#eab308',
  blocked: '#eab308',
  backlog: '#585870',
}

interface StatusBadgeProps {
  status: string
  size?: 'sm' | 'md'
}

export function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const color = COLOR_MAP[status.toLowerCase()] ?? '#585870'
  const isSm = size === 'sm'

  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: isSm ? '10px' : '11px',
    padding: isSm ? '1px 6px' : '2px 8px',
    borderRadius: '10px',
    fontWeight: 600,
    color,
    background: `${color}15`,
    border: `1px solid ${color}30`,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  }

  return (
    <span style={style}>
      <span style={{
        width: isSm ? '5px' : '6px',
        height: isSm ? '5px' : '6px',
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
      {status}
    </span>
  )
}
