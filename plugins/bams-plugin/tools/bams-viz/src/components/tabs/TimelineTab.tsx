'use client'

import { useState, useMemo } from 'react'
import { usePolling } from '@/hooks/usePolling'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { formatDuration } from '@/lib/utils'
import type { PipelineEvent } from '@/lib/types'

const EVENT_ICONS: Record<string, string> = {
  pipeline_start: '🚀',
  pipeline_end: '🏁',
  step_start: '▶',
  step_end: '⏹',
  agent_start: '🤖',
  agent_end: '✅',
  error: '❌',
}

const EVENT_TYPES = ['all', 'pipeline_start', 'pipeline_end', 'step_start', 'step_end', 'agent_start', 'agent_end', 'error'] as const

interface TimelineTabProps {
  pipelineSlug: string | null
  onNavigateToLogs?: (timestamp?: string) => void
}

function EventCard({ event, onNavigateToLogs }: { event: PipelineEvent; onNavigateToLogs?: (ts: string) => void }) {
  const icon = EVENT_ICONS[event.type] || '📌'
  const time = new Date(event.ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

  let title = event.type
  let detail = ''
  const ev = event as Record<string, unknown>

  switch (event.type) {
    case 'pipeline_start':
      title = `Pipeline started`
      detail = (ev.command as string) || ''
      break
    case 'pipeline_end':
      title = `Pipeline ${ev.status}`
      detail = ev.duration_ms ? formatDuration(ev.duration_ms as number) : ''
      break
    case 'step_start':
      title = `Step ${ev.step_number}: ${ev.step_name}`
      detail = `Phase: ${ev.phase}`
      break
    case 'step_end':
      title = `Step ${ev.step_number} ${ev.status}`
      detail = ev.duration_ms ? formatDuration(ev.duration_ms as number) : ''
      break
    case 'agent_start':
      title = `${ev.agent_type} started`
      detail = (ev.description as string) || (ev.prompt_summary as string) || ''
      break
    case 'agent_end':
      title = `${ev.agent_type} ${ev.is_error ? 'failed' : 'completed'}`
      detail = ev.duration_ms ? formatDuration(ev.duration_ms as number) : ''
      break
    case 'error':
      title = `Error`
      detail = (ev.message as string) || ''
      break
  }

  const isError = event.type === 'error' || (ev.is_error as boolean)
  const isRunning = event.type === 'agent_start' || event.type === 'step_start'

  return (
    <div style={{
      display: 'flex',
      gap: '12px',
      padding: '12px 20px',
      borderBottom: '1px solid var(--border-light)',
      background: isError ? 'var(--error-bg)' : 'transparent',
    }}>
      {/* Timeline line + dot */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '20px', flexShrink: 0 }}>
        <span style={{ fontSize: '14px' }}>{icon}</span>
        <div style={{ flex: 1, width: '1px', background: 'var(--border-light)', marginTop: '4px' }} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>{title}</span>
          {isError && <Badge variant="error">ERROR</Badge>}
          {isRunning && <Badge variant="running" pulse>ACTIVE</Badge>}
        </div>
        {detail && (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {detail}
          </div>
        )}
      </div>

      {/* Time + link */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{time}</span>
        {onNavigateToLogs && (
          <button
            onClick={() => onNavigateToLogs(event.ts)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '11px',
              color: 'var(--accent)',
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            Logs
          </button>
        )}
      </div>
    </div>
  )
}

export function TimelineTab({ pipelineSlug, onNavigateToLogs }: TimelineTabProps) {
  const [filter, setFilter] = useState<string>('all')
  const apiUrl = pipelineSlug ? `/api/events/raw/${pipelineSlug}` : '/api/events/raw/all'
  const { data, error, isLoading } = usePolling<PipelineEvent[]>(apiUrl, 1000)

  const filtered = useMemo(() => {
    if (!data || !Array.isArray(data)) return []
    if (filter === 'all') return data
    return data.filter(e => e.type === filter)
  }, [data, filter])
  if (isLoading && !data) {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading timeline...</div>
  }
  if (error) {
    return <div style={{ padding: '20px', color: 'var(--status-fail)' }}>Error: {error.message}</div>
  }
  if (!data || data.length === 0) {
    return <EmptyState icon="📅" title="No events" description="No events recorded for this pipeline" />
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Filter bar */}
      <div style={{
        display: 'flex',
        gap: '6px',
        padding: '10px 20px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        flexWrap: 'wrap',
      }}>
        {EVENT_TYPES.map(type => (
          <button
            key={type}
            onClick={() => setFilter(type)}
            style={{
              padding: '4px 10px',
              borderRadius: '12px',
              border: '1px solid',
              borderColor: filter === type ? 'var(--accent)' : 'var(--border-light)',
              background: filter === type ? 'rgba(59,130,246,0.1)' : 'transparent',
              color: filter === type ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: '11px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {type === 'all' ? `All (${data.length})` : type.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.map((event, i) => (
          <EventCard key={`${event.ts}-${i}`} event={event} onNavigateToLogs={onNavigateToLogs} />
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
            No events match this filter
          </div>
        )}
      </div>
    </div>
  )
}
