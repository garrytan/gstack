'use client'

import { StatusBadge } from '@/components/shared/StatusBadge'
import { formatRelativeTime } from '@/lib/utils'
import type { WorkUnit } from '@/lib/types'

interface WorkCardProps {
  workunit: WorkUnit & {
    task_summary?: {
      total: number
      done: number
      in_progress: number
      backlog: number
    }
  }
  onClick: () => void
}

export function WorkCard({ workunit, onClick }: WorkCardProps) {
  const pipelineCount = workunit.pipelineCount ?? workunit.pipelines?.length ?? 0
  const taskSummary = workunit.task_summary
  const progressPct = taskSummary && taskSummary.total > 0
    ? Math.round((taskSummary.done / taskSummary.total) * 100)
    : null

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '16px',
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)'
        ;(e.currentTarget as HTMLDivElement).style.boxShadow = '0 0 0 1px var(--accent)'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'
        ;(e.currentTarget as HTMLDivElement).style.boxShadow = 'none'
      }}
    >
      {/* Top: Name + Status */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '10px',
      }}>
        <span style={{
          fontWeight: 600,
          fontSize: '13px',
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          marginRight: '8px',
        }}>
          {workunit.name}
        </span>
        <StatusBadge status={workunit.status} size="sm" />
      </div>

      {/* Meta: pipeline count + start time */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        fontSize: '11px',
        color: 'var(--text-muted)',
        marginBottom: progressPct !== null ? '10px' : '0',
      }}>
        <span>{pipelineCount} pipeline{pipelineCount !== 1 ? 's' : ''}</span>
        <span>{formatRelativeTime(workunit.startedAt)}</span>
      </div>

      {/* Progress bar */}
      {progressPct !== null && taskSummary && (
        <div>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '10px',
            color: 'var(--text-muted)',
            marginBottom: '4px',
          }}>
            <span>Tasks</span>
            <span>{taskSummary.done}/{taskSummary.total} ({progressPct}%)</span>
          </div>
          <div style={{
            height: '4px',
            borderRadius: '2px',
            background: 'var(--bg-secondary)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${progressPct}%`,
              borderRadius: '2px',
              background: progressPct === 100 ? 'var(--status-done)' : 'var(--accent)',
              transition: 'width 0.3s',
            }} />
          </div>
        </div>
      )}
    </div>
  )
}
