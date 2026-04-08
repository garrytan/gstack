/**
 * PipelineAccordion.tsx — bams-viz에서 이식 (compact 변형)
 * - 'use client' 제거
 * - bamsApi.patchWorkUnitPipeline 의존성 제거 (위젯은 read-only)
 * - next/* 의존성 없음
 * - CSS custom properties: --color-* (위젯 globals.css 기준)
 */

import { useState } from 'react'
import { StatusBadge } from './StatusBadge'
import { formatDuration } from '../lib/utils'
import type { Pipeline } from '../lib/types'

interface PipelineAccordionProps {
  pipeline: Pipeline
  selected?: boolean
  onSelect?: (slug: string) => void
  compact?: boolean
}

export function PipelineAccordion({
  pipeline,
  selected,
  onSelect,
  compact = true,
}: PipelineAccordionProps) {
  const [open, setOpen] = useState(false)

  const totalSteps = pipeline.steps?.length ?? 0
  const completedSteps = pipeline.steps?.filter(s => s.status === 'done').length ?? 0
  const failedSteps = pipeline.steps?.filter(s => s.status === 'fail').length ?? 0
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0

  const rowPad = compact ? '8px 10px' : '10px 14px'
  const nameFontSize = compact ? '11px' : '12px'

  return (
    <div style={{
      background: 'var(--color-surface)',
      border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
      borderRadius: '6px',
      overflow: 'hidden',
      boxShadow: selected ? '0 0 0 1px var(--color-accent)' : undefined,
    }}>
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: rowPad,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => {
          setOpen(prev => !prev)
          onSelect?.(pipeline.slug)
        }}
      >
        {/* Chevron */}
        <span style={{
          fontSize: '9px',
          color: 'var(--color-text-muted)',
          width: '12px',
          textAlign: 'center',
          flexShrink: 0,
          transition: 'transform 0.15s',
          transform: open ? 'rotate(90deg)' : 'none',
          display: 'inline-block',
        }}>
          &#9654;
        </span>

        {/* Slug */}
        <span style={{
          fontWeight: 600,
          fontSize: nameFontSize,
          color: selected ? 'var(--color-accent)' : 'var(--color-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}>
          {pipeline.slug}
        </span>

        {/* Type badge */}
        <span style={{
          fontSize: '9px',
          padding: '1px 5px',
          borderRadius: '4px',
          background: 'var(--color-surface-3)',
          color: 'var(--color-text-muted)',
          fontWeight: 500,
          flexShrink: 0,
        }}>
          {pipeline.type}
        </span>

        {/* Status */}
        <StatusBadge status={pipeline.status ?? 'unknown'} size="xs" />

        {/* Progress bar (inline) */}
        {totalSteps > 0 && (
          <div style={{
            width: compact ? '40px' : '60px',
            height: '3px',
            borderRadius: '2px',
            background: 'var(--color-surface-3)',
            overflow: 'hidden',
            flexShrink: 0,
          }}>
            <div style={{
              height: '100%',
              width: `${progressPct}%`,
              background: failedSteps > 0
                ? 'var(--color-status-failed)'
                : 'var(--color-accent)',
              borderRadius: '2px',
              transition: 'width 0.3s',
            }} />
          </div>
        )}

        {/* Duration */}
        {pipeline.durationMs != null && (
          <span style={{
            fontSize: '9px',
            color: 'var(--color-text-muted)',
            flexShrink: 0,
          }}>
            {formatDuration(pipeline.durationMs)}
          </span>
        )}
      </div>

      {/* Expanded: Steps list */}
      {open && pipeline.steps && pipeline.steps.length > 0 && (
        <div style={{
          borderTop: '1px solid var(--color-border)',
          padding: '4px 0',
        }}>
          {pipeline.steps.map(step => (
            <StepRow key={step.number} step={step} compact={compact} />
          ))}
        </div>
      )}

      {/* Expanded: empty */}
      {open && (!pipeline.steps || pipeline.steps.length === 0) && (
        <div style={{
          borderTop: '1px solid var(--color-border)',
          padding: '8px 10px',
          fontSize: '10px',
          color: 'var(--color-text-muted)',
          textAlign: 'center',
        }}>
          스텝 정보 없음
        </div>
      )}
    </div>
  )
}

interface StepRowProps {
  step: {
    number: number
    name: string
    status: string
    durationMs: number | null
  }
  compact?: boolean
}

function StepRow({ step, compact }: StepRowProps) {
  const statusColor: Record<string, string> = {
    done: '#22c55e',
    fail: '#ef4444',
    skipped: '#8e8ea0',
  }
  const color = statusColor[step.status] ?? '#585870'

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: compact ? '3px 10px 3px 28px' : '4px 14px 4px 32px',
      fontSize: '10px',
    }}>
      <span style={{
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
      <span style={{
        flex: 1,
        color: 'var(--color-text)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {step.number}. {step.name}
      </span>
      {step.durationMs != null && (
        <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
          {formatDuration(step.durationMs)}
        </span>
      )}
    </div>
  )
}
