'use client'

import { useEffect, useRef } from 'react'

type TaskStatus = 'backlog' | 'in_progress' | 'done' | 'blocked' | 'cancelled'

const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; pulse?: boolean }> = {
  backlog:     { label: 'backlog',     color: 'var(--text-muted)' },
  in_progress: { label: 'in progress', color: 'var(--status-running, #3b82f6)', pulse: true },
  done:        { label: 'done',        color: 'var(--status-done, #22c55e)' },
  blocked:     { label: 'blocked',     color: 'var(--status-fail, #ef4444)' },
  cancelled:   { label: 'cancelled',   color: 'var(--text-muted)' },
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.backlog
  const dotRef = useRef<HTMLSpanElement>(null)

  // pulse 애니메이션: in_progress 전용
  useEffect(() => {
    if (!cfg.pulse || !dotRef.current) return
    const el = dotRef.current
    let scale = 1
    let growing = true
    let raf: number

    const animate = () => {
      scale = growing ? scale + 0.04 : scale - 0.04
      if (scale >= 1.4) growing = false
      if (scale <= 0.8) growing = true
      el.style.transform = `scale(${scale})`
      raf = requestAnimationFrame(animate)
    }
    raf = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(raf)
  }, [cfg.pulse])

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 7px',
        borderRadius: '10px',
        fontSize: '10px',
        fontWeight: 600,
        lineHeight: '16px',
        background: `${cfg.color}18`,
        color: cfg.color,
        border: `1px solid ${cfg.color}33`,
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        ref={dotRef}
        style={{
          display: 'inline-block',
          width: '5px',
          height: '5px',
          borderRadius: '50%',
          background: cfg.color,
          flexShrink: 0,
        }}
      />
      {cfg.label}
    </span>
  )
}
