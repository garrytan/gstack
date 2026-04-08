/**
 * components/RecentItem.tsx
 * TASK-011: Recent 섹션 한 줄 요약 아이템
 * - 완료된 WU를 한 줄로 표시 (slug + 경과 시간)
 * - compact 팝오버(320px)에 최적화
 */

import { StatusBadge } from './StatusBadge'
import { formatRelativeTime } from '../lib/utils'
import type { WorkUnit } from '../lib/types'

interface RecentItemProps {
  workunit: WorkUnit
}

export function RecentItem({ workunit }: RecentItemProps) {
  const timeStr = workunit.completed_at
    ? formatRelativeTime(workunit.completed_at)
    : formatRelativeTime(workunit.updated_at)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 4,
      }}
    >
      <StatusBadge status={workunit.status} size="xs" />
      <span
        style={{
          flex: 1,
          fontSize: 11,
          color: 'var(--color-text-muted)',
          fontFamily: 'var(--font-mono)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {workunit.slug}
      </span>
      <span
        style={{
          fontSize: 10,
          color: 'var(--color-text-dim)',
          flexShrink: 0,
        }}
      >
        {timeStr}
      </span>
    </div>
  )
}
