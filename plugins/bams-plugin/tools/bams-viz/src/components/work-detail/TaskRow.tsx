'use client'

import { StatusBadge } from '@/components/shared/StatusBadge'
import { formatDuration } from '@/lib/utils'
import type { Task } from '@/lib/types'

const LABEL_COLORS: Record<string, string> = {
  success: '#22c55e',
  error: '#ef4444',
  warning: '#eab308',
}

interface TaskRowProps {
  task: Task
}

export function TaskRow({ task }: TaskRowProps) {
  const labelColor = task.label ? LABEL_COLORS[task.label.toLowerCase()] ?? 'var(--text-muted)' : null

  return (
    <tr style={{
      borderTop: '1px solid var(--border-light)',
    }}>
      <td style={{
        padding: '6px 12px',
        color: 'var(--text-primary)',
        maxWidth: '200px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {task.title}
      </td>
      <td style={{
        padding: '6px 12px',
        color: 'var(--text-secondary)',
      }}>
        {task.assignee_agent ?? '-'}
      </td>
      <td style={{
        padding: '6px 12px',
        color: 'var(--text-muted)',
      }}>
        {task.model ?? '-'}
      </td>
      <td style={{ padding: '6px 12px' }}>
        {task.label ? (
          <span style={{
            fontSize: '10px',
            padding: '1px 6px',
            borderRadius: '4px',
            fontWeight: 600,
            color: labelColor ?? 'var(--text-muted)',
            background: labelColor ? `${labelColor}15` : 'var(--bg-secondary)',
            border: labelColor ? `1px solid ${labelColor}30` : '1px solid var(--border)',
          }}>
            {task.label}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>-</span>
        )}
      </td>
      <td style={{
        padding: '6px 12px',
        color: 'var(--text-muted)',
      }}>
        {task.duration_ms != null ? formatDuration(task.duration_ms) : '-'}
      </td>
      <td style={{ padding: '6px 12px' }}>
        <StatusBadge status={task.status} size="sm" />
      </td>
    </tr>
  )
}
