'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { usePolling } from '@/hooks/usePolling'
import { StatusFilter } from './StatusFilter'
import { WorkCard } from './WorkCard'
import type { WorkUnit } from '@/lib/types'

interface WorkUnitsResponse {
  workunits: Array<WorkUnit & {
    task_summary?: {
      total: number
      done: number
      in_progress: number
      backlog: number
    }
  }>
}

export function WorkCardGrid() {
  const router = useRouter()
  const [filter, setFilter] = useState('all')
  const { data, error, isLoading } = usePolling<WorkUnitsResponse>('/api/workunits', 5000)

  const filtered = useMemo(() => {
    if (!data?.workunits) return []
    if (filter === 'all') return data.workunits
    return data.workunits.filter(wu => wu.status === filter)
  }, [data, filter])

  if (isLoading && !data) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--status-fail)' }}>
        Failed to load work units: {error.message}
      </div>
    )
  }

  return (
    <div>
      <StatusFilter value={filter} onChange={setFilter} />

      {filtered.length === 0 ? (
        <div style={{
          padding: '60px 20px',
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: '13px',
        }}>
          <div style={{ fontSize: '28px', marginBottom: '12px', opacity: 0.5 }}>--</div>
          <div>No work units found</div>
          {filter !== 'all' && (
            <div style={{ marginTop: '4px', fontSize: '11px' }}>
              Try changing the filter
            </div>
          )}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '16px',
        }}>
          {filtered.map(wu => (
            <WorkCard
              key={wu.slug}
              workunit={wu}
              onClick={() => router.push(`/work/${encodeURIComponent(wu.slug)}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
