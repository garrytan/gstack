/**
 * WorkCard.tsx — bams-viz에서 이식 (compact 변형)
 * - 'use client' 제거 (Next.js 의존성 제거)
 * - next/link, next/navigation 의존성 없음
 * - CSS custom properties: --color-* (위젯 globals.css 기준)
 * - compact: padding/font 축소 (320px 팝오버에 맞게)
 */

import { StatusBadge } from './StatusBadge'
import { formatRelativeTime } from '../lib/utils'
import type { WorkUnit } from '../lib/types'

interface WorkCardProps {
  workunit: WorkUnit & {
    pipelineCount?: number
    task_summary?: {
      total: number
      done: number
      in_progress: number
      backlog: number
    }
  }
  onClick: () => void
  /** compact: 팝오버용 소형 카드 (기본값 true) */
  compact?: boolean
}

export function WorkCard({ workunit, onClick, compact = true }: WorkCardProps) {
  const pipelineCount = workunit.pipelineCount ?? 0
  const taskSummary = workunit.task_summary
  const progressPct = taskSummary && taskSummary.total > 0
    ? Math.round((taskSummary.done / taskSummary.total) * 100)
    : null

  const p = compact ? '10px 12px' : '16px'
  const nameFontSize = compact ? '12px' : '13px'
  const metaFontSize = compact ? '10px' : '11px'
  const borderRadius = compact ? '8px' : '10px'

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius,
        padding: p,
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLDivElement
        el.style.borderColor = 'var(--color-accent)'
        el.style.boxShadow = '0 0 0 1px var(--color-accent)'
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLDivElement
        el.style.borderColor = 'var(--color-border)'
        el.style.boxShadow = 'none'
      }}
    >
      {/* Top: Name + Status */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: compact ? '6px' : '10px',
      }}>
        <span style={{
          fontWeight: 600,
          fontSize: nameFontSize,
          color: 'var(--color-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          marginRight: '8px',
        }}>
          {workunit.name}
        </span>
        <StatusBadge status={workunit.status} size={compact ? 'xs' : 'sm'} />
      </div>

      {/* Meta: pipeline count + start time */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        fontSize: metaFontSize,
        color: 'var(--color-text-muted)',
        marginBottom: progressPct !== null ? (compact ? '6px' : '10px') : '0',
      }}>
        <span>{pipelineCount} pipeline{pipelineCount !== 1 ? 's' : ''}</span>
        <span>{formatRelativeTime(workunit.created_at)}</span>
      </div>

      {/* Progress bar */}
      {progressPct !== null && taskSummary && (
        <div>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '9px',
            color: 'var(--color-text-muted)',
            marginBottom: '3px',
          }}>
            <span>Tasks</span>
            <span>{taskSummary.done}/{taskSummary.total} ({progressPct}%)</span>
          </div>
          <div style={{
            height: compact ? '3px' : '4px',
            borderRadius: '2px',
            background: 'var(--color-surface-3)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${progressPct}%`,
              borderRadius: '2px',
              background: progressPct === 100
                ? 'var(--color-status-completed)'
                : 'var(--color-accent)',
              transition: 'width 0.3s',
            }} />
          </div>
        </div>
      )}
    </div>
  )
}
