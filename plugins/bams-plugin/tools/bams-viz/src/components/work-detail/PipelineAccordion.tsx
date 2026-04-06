'use client'

import { useState, useRef, useEffect } from 'react'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { TaskTable } from './TaskTable'
import { formatDuration } from '@/lib/utils'
import { bamsApi } from '@/lib/bams-api'
import type { WorkUnitPipeline } from '@/lib/types'

interface PipelineAccordionProps {
  pipeline: WorkUnitPipeline
  wuSlug: string
}

export function PipelineAccordion({ pipeline, wuSlug }: PipelineAccordionProps) {
  const [open, setOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [menuOpen])

  const totalSteps = pipeline.totalSteps || 0
  const completedSteps = pipeline.completedSteps || 0
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0

  async function handleStatusChange(status: 'completed' | 'failed' | 'paused') {
    try {
      await bamsApi.patchWorkUnitPipeline(wuSlug, pipeline.slug, { status })
    } catch (err) {
      console.error('Failed to update pipeline status:', err)
    }
    setMenuOpen(false)
  }

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: '8px',
      overflow: 'hidden',
    }}>
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '10px 14px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setOpen(prev => !prev)}
      >
        {/* Chevron */}
        <span style={{
          fontSize: '10px',
          color: 'var(--text-muted)',
          width: '14px',
          textAlign: 'center',
          flexShrink: 0,
          transition: 'transform 0.15s',
          transform: open ? 'rotate(90deg)' : 'none',
        }}>
          &#9654;
        </span>

        {/* Slug */}
        <span style={{
          fontWeight: 600,
          fontSize: '12px',
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}>
          {pipeline.slug}
        </span>

        {/* Type badge */}
        <span style={{
          fontSize: '10px',
          padding: '1px 6px',
          borderRadius: '4px',
          background: 'var(--bg-secondary)',
          color: 'var(--text-secondary)',
          fontWeight: 500,
          flexShrink: 0,
        }}>
          {pipeline.type}
        </span>

        {/* Status */}
        <StatusBadge status={pipeline.status ?? 'unknown'} size="sm" />

        {/* Progress bar (inline) */}
        {totalSteps > 0 && (
          <div style={{
            width: '60px',
            height: '4px',
            borderRadius: '2px',
            background: 'var(--bg-secondary)',
            overflow: 'hidden',
            flexShrink: 0,
          }}>
            <div style={{
              height: '100%',
              width: `${progressPct}%`,
              background: pipeline.failedSteps > 0 ? 'var(--status-fail)' : 'var(--accent)',
              borderRadius: '2px',
              transition: 'width 0.3s',
            }} />
          </div>
        )}

        {/* Duration */}
        {pipeline.durationMs != null && (
          <span style={{
            fontSize: '10px',
            color: 'var(--text-muted)',
            flexShrink: 0,
          }}>
            {formatDuration(pipeline.durationMs)}
          </span>
        )}

        {/* Actions menu */}
        <div
          ref={menuRef}
          style={{ position: 'relative', flexShrink: 0 }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => setMenuOpen(prev => !prev)}
            aria-label="Pipeline actions"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '14px',
              color: 'var(--text-muted)',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            ...
          </button>
          {menuOpen && (
            <div style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: '4px',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '4px 0',
              minWidth: '120px',
              zIndex: 100,
              boxShadow: '0 4px 12px var(--shadow)',
            }}>
              <PipelineMenuBtn label="Complete" onClick={() => handleStatusChange('completed')} />
              <PipelineMenuBtn label="Failed" onClick={() => handleStatusChange('failed')} />
              <PipelineMenuBtn label="Pause" onClick={() => handleStatusChange('paused')} />
            </div>
          )}
        </div>
      </div>

      {/* Expanded: Task table */}
      {open && (
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '0',
        }}>
          <TaskTable pipelineSlug={pipeline.slug} />
        </div>
      )}
    </div>
  )
}

function PipelineMenuBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        padding: '6px 14px',
        background: 'none',
        border: 'none',
        textAlign: 'left',
        fontSize: '12px',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-hover, var(--bg-secondary))'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background = 'none'
      }}
    >
      {label}
    </button>
  )
}
