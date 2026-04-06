'use client'

import { PipelineAccordion } from './PipelineAccordion'
import type { WorkUnitPipeline } from '@/lib/types'

interface PipelinesPanelProps {
  pipelines: WorkUnitPipeline[]
  wuSlug: string
}

export function PipelinesPanel({ pipelines, wuSlug }: PipelinesPanelProps) {
  if (pipelines.length === 0) {
    return (
      <div style={{
        padding: '40px 20px',
        textAlign: 'center',
        color: 'var(--text-muted)',
        fontSize: '13px',
      }}>
        No pipelines linked to this work unit
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {pipelines.map(p => (
        <PipelineAccordion key={p.id ?? p.slug} pipeline={p} wuSlug={wuSlug} />
      ))}
    </div>
  )
}
