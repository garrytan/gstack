/**
 * StatusBadge.tsx — bams-viz에서 이식 (compact 변형 적용)
 * - 'use client' 제거 (Next.js 의존성 제거)
 * - CSS custom properties: --color-* (위젯 globals.css 기준)
 */

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
  pending: '#8e8ea0',
  unknown: '#585870',
}

interface StatusBadgeProps {
  status: string
  /** sm: 기본, xs: compact (메뉴바 팝오버용) */
  size?: 'xs' | 'sm' | 'md'
}

export function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const color = COLOR_MAP[status.toLowerCase()] ?? '#585870'
  const isXs = size === 'xs'
  const isSm = size === 'sm'

  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: isXs ? '3px' : '4px',
    fontSize: isXs ? '9px' : isSm ? '10px' : '11px',
    padding: isXs ? '1px 4px' : isSm ? '1px 6px' : '2px 8px',
    borderRadius: '10px',
    fontWeight: 600,
    color,
    background: `${color}15`,
    border: `1px solid ${color}30`,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
    letterSpacing: isXs ? '0' : undefined,
  }

  const dotSize = isXs ? '4px' : isSm ? '5px' : '6px'

  return (
    <span style={style}>
      <span style={{
        width: dotSize,
        height: dotSize,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
      {status}
    </span>
  )
}
