'use client'

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { usePolling } from '@/hooks/usePolling'
import { AppHeader } from '@/components/shared/AppHeader'
import { WorkDetailHeader } from '@/components/work-detail/WorkDetailHeader'
import { WorkDetailTabs } from '@/components/work-detail/WorkDetailTabs'
import { PipelinesPanel } from '@/components/work-detail/PipelinesPanel'
import { TimelineTab } from '@/components/tabs/TimelineTab'
import { MetaverseTab } from '@/components/tabs/MetaverseTab'
import { bamsApi } from '@/lib/bams-api'
import { formatDuration } from '@/lib/utils'
import { AGENT_DEPT_MAP, DEPT_INFO } from '@/lib/agents-config'
import type { DetailTab, WorkUnit, WorkUnitDetailResponse, PipelineEvent } from '@/lib/types'

// ── Event type styles for Logs v2.0 ─────────────────────────────────────────
const EVENT_TYPE_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  pipeline_start: { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6', label: 'pipeline' },
  pipeline_end:   { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6', label: 'pipeline' },
  step_start:     { bg: 'rgba(34,197,94,0.1)',  color: '#22c55e', label: 'step' },
  step_end:       { bg: 'rgba(34,197,94,0.1)',  color: '#22c55e', label: 'step' },
  agent_start:    { bg: 'rgba(168,85,247,0.1)', color: '#a855f7', label: 'agent' },
  agent_end:      { bg: 'rgba(168,85,247,0.1)', color: '#a855f7', label: 'agent' },
  error:          { bg: 'rgba(239,68,68,0.1)',  color: '#ef4444', label: 'error' },
}

const DEFAULT_EVENT_STYLE = { bg: 'rgba(156,163,175,0.1)', color: '#9ca3af', label: 'event' }

function getEventStyle(type: string) {
  return EVENT_TYPE_STYLES[type] ?? DEFAULT_EVENT_STYLE
}

function getAgentColor(agentType: string): string | undefined {
  const dept = AGENT_DEPT_MAP[agentType]
  return dept ? DEPT_INFO[dept]?.color : undefined
}

// ── DAG helpers ──────────────────────────────────────────────────────────────
function sanitizeSvgId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_')
}

export default function WorkDetailPage() {
  const params = useParams()
  const router = useRouter()
  const slug = params.slug as string

  const [activeTab, setActiveTab] = useState<DetailTab>('pipelines')

  const { data, error, isLoading, mutate } = usePolling<WorkUnitDetailResponse & { pipelines?: unknown[] }>(
    slug ? `/api/workunits/${encodeURIComponent(slug)}` : null,
    3000
  )

  const workunit = data?.workunit as (WorkUnit & { pipelines?: WorkUnit['pipelines'] }) | undefined

  const handleBack = useCallback(() => {
    router.push('/')
  }, [router])

  const handleAction = useCallback(async (action: 'complete' | 'abandon' | 'delete') => {
    if (!slug) return
    try {
      if (action === 'delete') {
        if (!confirm('Are you sure you want to delete this work unit?')) return
        await bamsApi.deleteWorkUnit(slug)
        router.push('/')
        return
      }
      const status = action === 'complete' ? 'completed' : 'abandoned'
      await bamsApi.patchWorkUnit(slug, { status })
      mutate()
    } catch (err) {
      console.error('Action failed:', err)
    }
  }, [slug, router, mutate])

  if (isLoading && !data) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--bg-secondary)',
      }}>
        <AppHeader />
        <main style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading...
          </div>
        </main>
      </div>
    )
  }

  if (error || !workunit) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--bg-secondary)',
      }}>
        <AppHeader />
        <main style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
          <div style={{ padding: '40px', textAlign: 'center' }}>
            <div style={{ color: 'var(--status-fail)', marginBottom: '12px' }}>
              {error ? `Error: ${error.message}` : 'Work unit not found'}
            </div>
            <button
              onClick={handleBack}
              style={{
                padding: '6px 16px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                color: 'var(--text-primary)',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              Back to list
            </button>
          </div>
        </main>
      </div>
    )
  }

  const pipelines = workunit.pipelines ?? []

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      minHeight: '100vh',
      background: 'var(--bg-secondary)',
    }}>
      <AppHeader />
      <main style={{
        padding: '24px',
        maxWidth: '1200px',
        margin: '0 auto',
        width: '100%',
        flex: 1,
      }}>
        <WorkDetailHeader
          workunit={workunit}
          onBack={handleBack}
          onAction={handleAction}
        />
        <WorkDetailTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />

        {activeTab === 'pipelines' && (
          <PipelinesPanel pipelines={pipelines} wuSlug={slug} />
        )}
        {activeTab === 'agents' && (
          <AgentsPanel wuSlug={slug} />
        )}
        {activeTab === 'timeline' && (
          <TimelineTab
            pipelineSlug={pipelines.length > 0 ? (pipelines[0] as { slug?: string }).slug ?? null : null}
            onNavigateToLogs={() => {
              setActiveTab('logs')
            }}
          />
        )}
        {activeTab === 'dag' && (
          <DagPanel wuSlug={slug} />
        )}
        {activeTab === 'logs' && (
          <LogsPanel wuSlug={slug} pipelines={pipelines} />
        )}
        {activeTab === 'retro' && (
          <RetroPanel wuSlug={slug} />
        )}
        {activeTab === 'metaverse' && (
          <MetaverseTab wuSlug={slug} />
        )}
      </main>
    </div>
  )
}

// ── Agents Panel ─────────────────────────────────────────────────────────────
function AgentsPanel({ wuSlug }: { wuSlug: string }) {
  const { data, isLoading, error } = usePolling<{
    work_unit_slug: string
    stats: Array<{
      agent_type: string
      call_count: number
      error_count: number
      avg_duration_ms: number | null
    }>
    active_agents: Array<{
      call_id: string
      agent_type: string
      pipeline_slug: string
      started_at: string
    }>
  }>(
    `/api/workunits/${encodeURIComponent(wuSlug)}/agents`,
    5000
  )

  if (isLoading && !data) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>Loading agents...</div>
  }
  if (error) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--status-fail)', fontSize: '12px' }}>Failed to load agents</div>
  }

  const stats = data?.stats ?? []
  const activeAgents = data?.active_agents ?? []

  return (
    <div>
      {activeAgents.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
            Active ({activeAgents.length})
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {activeAgents.map(a => (
              <div key={a.call_id} style={{
                padding: '6px 12px',
                borderRadius: '6px',
                background: 'rgba(59,130,246,0.08)',
                border: '1px solid rgba(59,130,246,0.2)',
                fontSize: '11px',
                color: 'var(--text-primary)',
              }}>
                <span style={{ fontWeight: 600 }}>{a.agent_type}</span>
                <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>{a.pipeline_slug}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
          <thead>
            <tr style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px', fontWeight: 500 }}>Agent</th>
              <th style={{ padding: '8px 12px', fontWeight: 500 }}>Calls</th>
              <th style={{ padding: '8px 12px', fontWeight: 500 }}>Errors</th>
              <th style={{ padding: '8px 12px', fontWeight: 500 }}>Avg Duration</th>
            </tr>
          </thead>
          <tbody>
            {stats.map(s => (
              <tr key={s.agent_type} style={{ borderTop: '1px solid var(--border-light)' }}>
                <td style={{ padding: '6px 12px', color: 'var(--text-primary)', fontWeight: 500 }}>{s.agent_type}</td>
                <td style={{ padding: '6px 12px', color: 'var(--text-secondary)' }}>{s.call_count}</td>
                <td style={{ padding: '6px 12px', color: s.error_count > 0 ? 'var(--status-fail)' : 'var(--text-muted)' }}>{s.error_count}</td>
                <td style={{ padding: '6px 12px', color: 'var(--text-muted)' }}>
                  {s.avg_duration_ms != null ? `${Math.round(s.avg_duration_ms / 1000)}s` : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
          No agent data available
        </div>
      )}
    </div>
  )
}

// ── Retro Panel ───────────────────────────────────────────────────────────────
function RetroPanel({ wuSlug }: { wuSlug: string }) {
  const { data, isLoading, error } = usePolling<{
    work_unit_slug: string
    auto_summary: {
      total_pipelines: number
      completed_pipelines: number
      failed_pipelines: number
      active_pipelines: number
      total_agents: number
      total_agent_calls: number
      agent_errors: number
      total_duration_ms: number
      pipelines: Array<{
        slug: string
        type: string
        status: string
        duration_ms: number | null
        agent_calls: number
        agent_errors: number
      }>
      top_agents: Array<{
        agent_type: string
        call_count: number
        error_count: number
      }>
    } | null
  }>(
    `/api/workunits/${encodeURIComponent(wuSlug)}/retro`,
    10000
  )

  if (isLoading && !data) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>Loading timeline...</div>
  }
  if (error) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--status-fail)', fontSize: '12px' }}>Failed to load timeline</div>
  }

  const summary = data?.auto_summary
  if (!summary) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>No summary data available</div>
  }

  return (
    <div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: '12px',
        marginBottom: '20px',
      }}>
        <SummaryCard label="Pipelines" value={summary.total_pipelines.toString()} />
        <SummaryCard label="Completed" value={summary.completed_pipelines.toString()} color="var(--status-done)" />
        <SummaryCard label="Failed" value={summary.failed_pipelines.toString()} color={summary.failed_pipelines > 0 ? 'var(--status-fail)' : undefined} />
        <SummaryCard label="Agent Calls" value={summary.total_agent_calls.toString()} />
        <SummaryCard label="Errors" value={summary.agent_errors.toString()} color={summary.agent_errors > 0 ? 'var(--status-fail)' : undefined} />
        <SummaryCard label="Total Time" value={formatDuration(summary.total_duration_ms)} />
      </div>

      {summary.pipelines.length > 0 && (
        <div>
          <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>Pipeline Breakdown</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
            <thead>
              <tr style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', textAlign: 'left' }}>
                <th style={{ padding: '6px 12px', fontWeight: 500 }}>Pipeline</th>
                <th style={{ padding: '6px 12px', fontWeight: 500 }}>Type</th>
                <th style={{ padding: '6px 12px', fontWeight: 500 }}>Status</th>
                <th style={{ padding: '6px 12px', fontWeight: 500 }}>Duration</th>
                <th style={{ padding: '6px 12px', fontWeight: 500 }}>Agents</th>
              </tr>
            </thead>
            <tbody>
              {summary.pipelines.map(p => (
                <tr key={p.slug} style={{ borderTop: '1px solid var(--border-light)' }}>
                  <td style={{ padding: '6px 12px', fontWeight: 500, color: 'var(--text-primary)' }}>{p.slug}</td>
                  <td style={{ padding: '6px 12px', color: 'var(--text-secondary)' }}>{p.type}</td>
                  <td style={{ padding: '6px 12px', color: 'var(--text-secondary)' }}>{p.status}</td>
                  <td style={{ padding: '6px 12px', color: 'var(--text-muted)' }}>{p.duration_ms != null ? formatDuration(p.duration_ms) : '-'}</td>
                  <td style={{ padding: '6px 12px', color: 'var(--text-muted)' }}>{p.agent_calls}{p.agent_errors > 0 ? ` (${p.agent_errors} err)` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: '8px',
      padding: '12px',
    }}>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '18px', fontWeight: 700, color: color ?? 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}

// ── DAG Panel — SVG-based interactive graph ──────────────────────────────────
function DagPanel({ wuSlug }: { wuSlug: string }) {
  const { data, isLoading, error } = usePolling<PipelineEvent[]>(
    `/api/events/raw/all`,
    5000
  )

  // Build graph data
  const graphData = useMemo(() => {
    if (!data || !Array.isArray(data)) return null

    const starts = data.filter(e => e.type === 'agent_start') as Array<PipelineEvent & { agent_type?: string; call_id?: string; pipeline_slug?: string }>
    const ends = data.filter(e => e.type === 'agent_end') as Array<PipelineEvent & { agent_type?: string; call_id?: string; is_error?: boolean; pipeline_slug?: string }>

    if (starts.length === 0) return null

    // Build: pipeline -> agents (ordered)
    const pipelines = new Map<string, string[]>()
    for (const s of starts) {
      const pSlug = s.pipeline_slug ?? 'unknown'
      const agent = s.agent_type ?? 'unknown'
      if (!pipelines.has(pSlug)) pipelines.set(pSlug, [])
      const agents = pipelines.get(pSlug)!
      if (!agents.includes(agent)) agents.push(agent)
    }

    // Error agents
    const errorAgents = new Set<string>()
    for (const e of ends) {
      if (e.is_error && e.agent_type) errorAgents.add(e.agent_type)
    }

    // Mermaid code (for copy button)
    const lines: string[] = ['graph TD']
    for (const [pSlug, agents] of pipelines) {
      const pId = sanitizeSvgId(pSlug)
      lines.push(`  ${pId}["${pSlug}"]`)
      lines.push(`  style ${pId} fill:#1e3a5f,stroke:#3b82f6,color:#fff`)
      for (let i = 0; i < agents.length; i++) {
        const aId = sanitizeSvgId(`${pSlug}_${agents[i]}`)
        lines.push(`  ${pId} --> ${aId}["${agents[i]}"]`)
        if (errorAgents.has(agents[i])) {
          lines.push(`  style ${aId} fill:#5f1e1e,stroke:#ef4444,color:#fff`)
        }
        if (i > 0) {
          const prevId = sanitizeSvgId(`${pSlug}_${agents[i - 1]}`)
          lines.push(`  ${prevId} -.-> ${aId}`)
        }
      }
    }
    const mermaidCode = lines.join('\n')

    return { pipelines, errorAgents, mermaidCode }
  }, [data])

  if (isLoading && !data) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>Loading DAG...</div>
  }
  if (error) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--status-fail)', fontSize: '12px' }}>Failed to load DAG data</div>
  }
  if (!graphData) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>No agent call data available for DAG</div>
  }

  const { pipelines, errorAgents, mermaidCode } = graphData

  // ── SVG layout constants ──
  const PIPELINE_NODE_W = 160
  const PIPELINE_NODE_H = 36
  const AGENT_NODE_W = 140
  const AGENT_NODE_H = 30
  const H_GAP = 24       // horizontal gap between pipeline nodes
  const PIPELINE_Y = 20
  const AGENT_Y_START = 100
  const AGENT_ROW_H = 50

  // Collect all unique agents globally (for agent row positions)
  const allAgents: string[] = []
  for (const agents of pipelines.values()) {
    for (const a of agents) {
      if (!allAgents.includes(a)) allAgents.push(a)
    }
  }

  const pipelineList = Array.from(pipelines.keys())
  const numPipelines = pipelineList.length
  const numAgents = allAgents.length

  const svgWidth = Math.max(
    numPipelines * (PIPELINE_NODE_W + H_GAP) + H_GAP,
    numAgents * (AGENT_NODE_W + H_GAP) + H_GAP,
    400
  )
  const svgHeight = AGENT_Y_START + numAgents * AGENT_ROW_H + 40

  // Pipeline node centers (X)
  const pipelineXMap: Record<string, number> = {}
  pipelineList.forEach((pSlug, i) => {
    pipelineXMap[pSlug] = H_GAP + i * (PIPELINE_NODE_W + H_GAP) + PIPELINE_NODE_W / 2
  })

  // Agent node centers (Y) — stacked vertically
  const agentYMap: Record<string, number> = {}
  allAgents.forEach((a, i) => {
    agentYMap[a] = AGENT_Y_START + i * AGENT_ROW_H + AGENT_NODE_H / 2
  })

  // Agent X — center all agents column
  const agentsColumnX = svgWidth / 2

  return (
    <div>
      <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>Agent Call DAG</h3>
        <button
          onClick={() => { navigator.clipboard.writeText(mermaidCode) }}
          style={{
            padding: '4px 10px',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            background: 'var(--bg-card)',
            color: 'var(--text-secondary)',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          Copy Mermaid
        </button>
      </div>

      {/* SVG DAG */}
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '16px',
        overflow: 'auto',
        marginBottom: '16px',
      }}>
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          style={{ width: '100%', minWidth: `${Math.min(svgWidth, 800)}px`, height: 'auto', display: 'block' }}
        >
          <defs>
            <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#3b82f6" />
            </marker>
            <marker id="arrowhead-dash" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#6b7280" />
            </marker>
          </defs>

          {/* Pipeline nodes */}
          {pipelineList.map(pSlug => {
            const cx = pipelineXMap[pSlug]
            const x = cx - PIPELINE_NODE_W / 2
            const agents = pipelines.get(pSlug) ?? []

            return (
              <g key={pSlug}>
                <rect
                  x={x}
                  y={PIPELINE_Y}
                  width={PIPELINE_NODE_W}
                  height={PIPELINE_NODE_H}
                  rx={6}
                  fill="#1e3a5f"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                />
                <text
                  x={cx}
                  y={PIPELINE_Y + PIPELINE_NODE_H / 2 + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={11}
                  fontWeight={600}
                  fill="#93c5fd"
                >
                  {pSlug.length > 22 ? pSlug.slice(0, 20) + '..' : pSlug}
                </text>

                {/* Edges: pipeline → each agent */}
                {agents.map(agent => {
                  const ay = agentYMap[agent]
                  return (
                    <line
                      key={`${pSlug}-${agent}`}
                      x1={cx}
                      y1={PIPELINE_Y + PIPELINE_NODE_H}
                      x2={agentsColumnX}
                      y2={ay - AGENT_NODE_H / 2}
                      stroke="#3b82f6"
                      strokeWidth={1}
                      strokeOpacity={0.5}
                      markerEnd="url(#arrowhead)"
                    />
                  )
                })}

                {/* Sequence edges: agent[i-1] -> agent[i] (dashed) */}
                {agents.map((agent, i) => {
                  if (i === 0) return null
                  const prevAgent = agents[i - 1]
                  const y1 = agentYMap[prevAgent] + AGENT_NODE_H / 2
                  const y2 = agentYMap[agent] - AGENT_NODE_H / 2
                  return (
                    <line
                      key={`seq-${pSlug}-${i}`}
                      x1={agentsColumnX + AGENT_NODE_W / 2 + 8}
                      y1={y1}
                      x2={agentsColumnX + AGENT_NODE_W / 2 + 8}
                      y2={y2}
                      stroke="#6b7280"
                      strokeWidth={1}
                      strokeDasharray="4 3"
                      strokeOpacity={0.6}
                      markerEnd="url(#arrowhead-dash)"
                    />
                  )
                })}
              </g>
            )
          })}

          {/* Agent nodes */}
          {allAgents.map(agent => {
            const cy = agentYMap[agent]
            const isError = errorAgents.has(agent)
            const agentColor = getAgentColor(agent)
            const fillColor = isError ? 'rgba(239,68,68,0.15)' : agentColor ? `${agentColor}22` : 'rgba(59,130,246,0.12)'
            const borderColor = isError ? '#ef4444' : agentColor ?? '#3b82f6'
            const textColor = isError ? '#fca5a5' : agentColor ?? '#93c5fd'
            const ax = agentsColumnX - AGENT_NODE_W / 2

            return (
              <g key={agent}>
                <rect
                  x={ax}
                  y={cy - AGENT_NODE_H / 2}
                  width={AGENT_NODE_W}
                  height={AGENT_NODE_H}
                  rx={5}
                  fill={fillColor}
                  stroke={borderColor}
                  strokeWidth={1}
                  strokeOpacity={0.6}
                />
                <text
                  x={agentsColumnX}
                  y={cy + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={10}
                  fill={textColor}
                >
                  {agent.length > 20 ? agent.slice(0, 18) + '..' : agent}
                </text>
                {isError && (
                  <circle cx={ax + AGENT_NODE_W - 8} cy={cy} r={5} fill="#ef4444" opacity={0.8} />
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {/* Mermaid code (reference) */}
      <details style={{ marginTop: '8px' }}>
        <summary style={{ fontSize: '11px', color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>
          Mermaid source
        </summary>
        <pre style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '12px',
          fontSize: '11px',
          fontFamily: 'monospace',
          color: 'var(--text-primary)',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
          marginTop: '8px',
        }}>
          {mermaidCode}
        </pre>
      </details>
    </div>
  )
}

// ── Logs Panel v2.0 ───────────────────────────────────────────────────────────
function LogRow({
  event,
  index,
}: {
  event: PipelineEvent
  index: number
}) {
  const [expanded, setExpanded] = useState(false)
  const ev = event as Record<string, unknown>
  const style = getEventStyle(event.type)
  const isError = event.type === 'error' || ev.is_error === true
  const agentType = ev.agent_type as string | undefined
  const agentColor = agentType ? getAgentColor(agentType) : undefined
  const inputText = ev.input as string | undefined
  const outputText = ev.output as string | undefined

  const time = new Date(event.ts).toLocaleTimeString('ko-KR', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const details = getEventDetails(event)

  // Build raw JSON (excluding ts for brevity in collapsed view)
  const rawJson = JSON.stringify(event, null, 2)

  return (
    <div
      style={{
        borderBottom: '1px solid var(--border-light)',
        background: isError ? 'rgba(239,68,68,0.04)' : index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
      }}
    >
      {/* Main row */}
      <div
        onClick={() => setExpanded(p => !p)}
        style={{
          display: 'grid',
          gridTemplateColumns: '70px 90px 1fr 1fr auto',
          gap: '8px',
          alignItems: 'center',
          padding: '6px 10px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {/* Time */}
        <span style={{ fontFamily: 'monospace', fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {time}
        </span>

        {/* Event type badge */}
        <span style={{
          display: 'inline-block',
          padding: '2px 7px',
          borderRadius: '10px',
          fontSize: '10px',
          fontWeight: 600,
          background: style.bg,
          color: style.color,
          whiteSpace: 'nowrap',
          textAlign: 'center',
        }}>
          {style.label}
        </span>

        {/* Pipeline slug */}
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {event.pipeline_slug ?? '-'}
        </span>

        {/* Agent type with dept color */}
        <span style={{
          fontSize: '11px',
          color: agentColor ?? 'var(--text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontWeight: agentType ? 500 : 400,
        }}>
          {agentType ?? details.slice(0, 40)}
        </span>

        {/* Expand chevron */}
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', transition: 'transform 0.15s', transform: expanded ? 'rotate(180deg)' : 'none' }}>
          ▼
        </span>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ padding: '0 10px 10px 10px' }}>
          {/* Agent type full name if truncated */}
          {agentType && (
            <div style={{ fontSize: '11px', color: agentColor ?? 'var(--text-secondary)', marginBottom: '6px', fontWeight: 600 }}>
              {event.type} — {agentType}
            </div>
          )}

          {/* Input/Output sections */}
          {inputText && (
            <div style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Input</div>
              <pre style={{
                fontSize: '11px',
                color: 'var(--text-secondary)',
                background: 'var(--bg-secondary)',
                borderRadius: '4px',
                padding: '8px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                maxHeight: '120px',
                margin: 0,
              }}>
                {inputText.length > 800 ? inputText.slice(0, 800) + '\n...[truncated]' : inputText}
              </pre>
            </div>
          )}
          {outputText && (
            <div style={{ marginBottom: '8px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Output</div>
              <pre style={{
                fontSize: '11px',
                color: 'var(--text-secondary)',
                background: 'var(--bg-secondary)',
                borderRadius: '4px',
                padding: '8px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                maxHeight: '120px',
                margin: 0,
              }}>
                {outputText.length > 800 ? outputText.slice(0, 800) + '\n...[truncated]' : outputText}
              </pre>
            </div>
          )}

          {/* Raw JSON */}
          <div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Raw JSON</div>
            <pre style={{
              fontSize: '10px',
              fontFamily: 'monospace',
              color: 'var(--text-muted)',
              background: 'var(--bg-secondary)',
              borderRadius: '4px',
              padding: '8px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              maxHeight: '200px',
              margin: 0,
            }}>
              {rawJson}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function LogsPanel({ wuSlug, pipelines }: { wuSlug: string; pipelines: unknown[] }) {
  const [filter, setFilter] = useState('')
  const [autoScroll, setAutoScroll] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data, isLoading, error } = usePolling<PipelineEvent[]>(
    `/api/events/raw/all`,
    3000
  )

  const events = useMemo(() => {
    if (!data || !Array.isArray(data)) return []
    if (!filter) return data
    const lower = filter.toLowerCase()
    return data.filter(e =>
      e.type.toLowerCase().includes(lower) ||
      (e.pipeline_slug && String(e.pipeline_slug).toLowerCase().includes(lower)) ||
      JSON.stringify(e).toLowerCase().includes(lower)
    )
  }, [data, filter])

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events, autoScroll])

  if (isLoading && !data) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>Loading logs...</div>
  }
  if (error) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--status-fail)', fontSize: '12px' }}>Failed to load logs</div>
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ marginBottom: '10px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter events (type, pipeline, agent...)"
          style={{
            flex: 1,
            padding: '7px 12px',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            fontSize: '12px',
            outline: 'none',
          }}
        />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {events.length} event{events.length !== 1 ? 's' : ''}
        </span>
        <button
          onClick={() => setAutoScroll(p => !p)}
          style={{
            padding: '6px 12px',
            borderRadius: '6px',
            border: `1px solid ${autoScroll ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
            background: autoScroll ? 'rgba(59,130,246,0.1)' : 'var(--bg-card)',
            color: autoScroll ? '#3b82f6' : 'var(--text-secondary)',
            fontSize: '11px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Auto-scroll {autoScroll ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Events list */}
      {events.length > 0 ? (
        <div
          ref={scrollRef}
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            overflow: 'auto',
            maxHeight: '600px',
          }}
        >
          {events.map((event, i) => (
            <LogRow key={`${event.ts}-${i}`} event={event} index={i} />
          ))}
        </div>
      ) : (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
          No events found
        </div>
      )}
    </div>
  )
}

function getEventDetails(event: PipelineEvent): string {
  const ev = event as Record<string, unknown>
  switch (event.type) {
    case 'pipeline_start':
      return `command: ${ev.command ?? '-'}`
    case 'pipeline_end':
      return `status: ${ev.status}${ev.duration_ms ? `, ${formatDuration(ev.duration_ms as number)}` : ''}`
    case 'step_start':
      return `step ${ev.step_number}: ${ev.step_name} (phase: ${ev.phase})`
    case 'step_end':
      return `step ${ev.step_number} ${ev.status}${ev.duration_ms ? `, ${formatDuration(ev.duration_ms as number)}` : ''}`
    case 'agent_start':
      return `${ev.agent_type}${ev.description ? ` — ${ev.description}` : ''}`
    case 'agent_end':
      return `${ev.agent_type} ${ev.is_error ? 'FAILED' : 'OK'}${ev.duration_ms ? `, ${formatDuration(ev.duration_ms as number)}` : ''}`
    case 'error':
      return (ev.message as string) ?? ''
    default:
      return JSON.stringify(Object.fromEntries(Object.entries(ev).filter(([k]) => !['type', 'ts', 'pipeline_slug'].includes(k))))
  }
}
