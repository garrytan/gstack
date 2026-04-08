/**
 * TaskRow.tsx — bams-viz에서 이식 (compact 변형)
 * - 'use client' 제거
 * - next/* 의존성 없음
 * - CSS custom properties: --color-* (위젯 globals.css 기준)
 * - compact: tr 대신 div 기반 (테이블 없이 독립 사용 가능하도록 변경)
 */

import { StatusBadge } from './StatusBadge'
import { formatDuration } from '../lib/utils'

const LABEL_COLORS: Record<string, string> = {
  success: '#22c55e',
  error: '#ef4444',
  warning: '#eab308',
}

interface TaskRowItem {
  id?: number
  title: string
  assignee_agent?: string | null
  model?: string | null
  label?: string | null
  duration_ms?: number | null
  status: string
}

interface TaskRowProps {
  task: TaskRowItem
  compact?: boolean
  showAgent?: boolean
}

export function TaskRow({ task, compact = true, showAgent = false }: TaskRowProps) {
  const labelColor = task.label
    ? LABEL_COLORS[task.label.toLowerCase()] ?? null
    : null

  const padV = compact ? '4px' : '6px'

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: `${padV} 10px`,
      borderTop: '1px solid var(--color-border)',
      fontSize: compact ? '10px' : '11px',
      minHeight: compact ? '28px' : '34px',
    }}>
      {/* Task title */}
      <span style={{
        flex: 1,
        color: 'var(--color-text)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      }}>
        {task.title}
      </span>

      {/* Assignee (옵션) */}
      {showAgent && task.assignee_agent && (
        <span style={{
          color: 'var(--color-text-muted)',
          flexShrink: 0,
          fontSize: compact ? '9px' : '10px',
          maxWidth: '80px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {task.assignee_agent}
        </span>
      )}

      {/* Label */}
      {task.label && (
        <span style={{
          fontSize: '9px',
          padding: '1px 5px',
          borderRadius: '4px',
          fontWeight: 600,
          color: labelColor ?? 'var(--color-text-muted)',
          background: labelColor ? `${labelColor}15` : 'var(--color-surface-3)',
          border: labelColor ? `1px solid ${labelColor}30` : '1px solid var(--color-border)',
          flexShrink: 0,
        }}>
          {task.label}
        </span>
      )}

      {/* Duration */}
      {task.duration_ms != null && (
        <span style={{
          color: 'var(--color-text-muted)',
          flexShrink: 0,
          fontSize: compact ? '9px' : '10px',
        }}>
          {formatDuration(task.duration_ms)}
        </span>
      )}

      {/* Status */}
      <StatusBadge status={task.status} size="xs" />
    </div>
  )
}
