'use client'

import { memo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { formatRelativeTime } from '@/lib/utils'
import { PriorityBadge } from '@/components/ui/PriorityBadge'
import { SizeBadge } from '@/components/ui/SizeBadge'
import { TaskStatusBadge } from '@/components/ui/TaskStatusBadge'
import { DepsPills } from '@/components/ui/DepsPills'
import { TagChips } from '@/components/ui/TagChips'
import { CheckoutLock } from '@/components/ui/CheckoutLock'
import type { Task } from '@/lib/types'

// ── marked 설정 ──────────────────────────────────────────────────────────────
marked.setOptions({ async: false })

function renderMarkdown(md: string): string {
  try {
    const result = marked.parse(md, { async: false })
    return typeof result === 'string' ? result : md
  } catch {
    return md
  }
}

interface TaskCardProps {
  task: Task
}

export const TaskCard = memo(function TaskCard({ task }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false)

  const deps: string[] = task.deps
    ? (() => { try { return JSON.parse(task.deps) } catch { return [] } })()
    : []
  const tags: string[] = task.tags
    ? (() => { try { return JSON.parse(task.tags) } catch { return [] } })()
    : []

  const hasPhaseStep = task.phase !== null || task.step !== null

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: '6px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-light)',
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
      }}
    >
      {/* Row 1: badges + title + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
        <PriorityBadge priority={task.priority} />
        {task.size && <SizeBadge size={task.size} />}
        <span
          style={{
            flex: 1,
            fontWeight: 600,
            fontSize: '12px',
            minWidth: '80px',
            color: 'var(--text-primary)',
          }}
        >
          {task.title}
        </span>
        {task.assignee_agent && (
          <span
            style={{
              fontSize: '10px',
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            {task.assignee_agent}
          </span>
        )}
        <TaskStatusBadge status={task.status} />
      </div>

      {/* Row 2: phase/step meta */}
      {hasPhaseStep && (
        <div style={{ display: 'flex', gap: '8px', fontSize: '10px', color: 'var(--text-muted)' }}>
          {task.phase !== null && (
            <span
              style={{
                padding: '1px 6px',
                borderRadius: '4px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-light)',
              }}
            >
              Phase {task.phase}
            </span>
          )}
          {task.step && (
            <span
              style={{
                padding: '1px 6px',
                borderRadius: '4px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-light)',
                fontFamily: 'monospace',
              }}
            >
              {task.step}
            </span>
          )}
        </div>
      )}

      {/* Row 3: deps + tags */}
      {(deps.length > 0 || tags.length > 0) && (
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          <DepsPills deps={deps} />
          <TagChips tags={tags} />
        </div>
      )}

      {/* Row 4: timing + lock */}
      <div
        style={{
          display: 'flex',
          gap: '10px',
          flexWrap: 'wrap',
          fontSize: '10px',
          color: 'var(--text-muted)',
        }}
      >
        {task.started_at && (
          <span>Started: {formatRelativeTime(task.started_at)}</span>
        )}
        {task.completed_at && (
          <span>Done: {formatRelativeTime(task.completed_at)}</span>
        )}
        {task.checkout_locked_at && (
          <CheckoutLock
            lockedAt={task.checkout_locked_at}
            agent={task.assignee_agent}
          />
        )}
      </div>

      {/* Row 5: description toggle (Markdown 렌더링 + XSS 방어) */}
      {task.description && (
        <>
          <button
            onClick={() => setExpanded(v => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '10px',
              color: 'var(--text-muted)',
              padding: 0,
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: '8px' }}>{expanded ? '▼' : '▶'}</span>
            description
          </button>
          {expanded && (
            <div
              className="task-description-markdown"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderMarkdown(task.description)) }}
              style={{
                fontSize: '11px',
                color: 'var(--text-secondary)',
                lineHeight: 1.6,
                padding: '6px 8px',
                borderRadius: '4px',
                background: 'var(--bg-secondary)',
                wordBreak: 'break-word',
                // inline reset for markdown elements rendered inside
                '--task-md-p-margin': '0.25em 0',
                '--task-md-code-bg': 'var(--bg-card)',
              } as React.CSSProperties}
            />
          )}
        </>
      )}
    </div>
  )
})
