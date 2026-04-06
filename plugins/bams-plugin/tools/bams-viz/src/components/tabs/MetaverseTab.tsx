'use client'

import { useState, useMemo } from 'react'
import { usePolling } from '@/hooks/usePolling'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { formatDuration, formatRelativeTime } from '@/lib/utils'
import { ALL_AGENTS, DEPT_INFO } from '@/lib/agents-config'
import type { AgentData, AgentCall } from '@/lib/types'

const DEPT_MAP = DEPT_INFO

/* ── Layout: management top-center, planning/engineering mid, design center, evaluation/qa bottom ── */
const DEPT_LAYOUT: Record<string, { x: number; y: number; w: number; h: number }> = {
  management:  { x: 250, y: 20,  w: 500, h: 200 },
  planning:    { x: 20,  y: 260, w: 470, h: 240 },
  engineering: { x: 510, y: 260, w: 470, h: 240 },
  design:      { x: 175, y: 520, w: 650, h: 240 },
  evaluation:  { x: 20,  y: 780, w: 470, h: 240 },
  qa:          { x: 510, y: 780, w: 470, h: 240 },
}

interface AgentNode {
  agentType: string
  department: string
  status: 'idle' | 'working' | 'error'
  callCount: number
  errorCount: number
  avgDurationMs: number
  errorRate: number
  lastCall: AgentCall | null
  recentCalls: AgentCall[]
  x: number
  y: number
}

interface MetaverseTabProps {
  pipelineSlug?: string | null
  wuSlug?: string | null
  onNavigateToTraces?: () => void
}

/**
 * Merge hardcoded ALL_AGENTS with live data.
 * Agents without activity appear as idle with zero counts.
 */
function buildAgentNodes(data: AgentData | null): AgentNode[] {
  const callsByType = new Map<string, AgentCall[]>()
  if (data) {
    for (const call of data.calls) {
      const arr = callsByType.get(call.agentType) || []
      arr.push(call)
      callsByType.set(call.agentType, arr)
    }
  }

  const statsByType = new Map<string, { callCount: number; errorCount: number; avgDurationMs: number; errorRate: number }>()
  if (data) {
    for (const s of data.stats) {
      statsByType.set(s.agentType, {
        callCount: s.callCount,
        errorCount: s.errorCount,
        avgDurationMs: s.avgDurationMs,
        errorRate: s.errorRate,
      })
    }
  }

  const deptAgents: Record<string, AgentNode[]> = {}

  for (const { agentType, department } of ALL_AGENTS) {
    const calls = callsByType.get(agentType) || []
    const sorted = [...calls].sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0
      return tb - ta
    })

    const lastCall = sorted[0] || null
    const isRunning = lastCall && lastCall.startedAt && !lastCall.endedAt
    const hasError = lastCall?.isError

    const status: 'idle' | 'working' | 'error' = hasError ? 'error' : isRunning ? 'working' : 'idle'
    const stats = statsByType.get(agentType)

    if (!deptAgents[department]) deptAgents[department] = []
    deptAgents[department].push({
      agentType,
      department,
      status: calls.length === 0 ? 'idle' : status,
      callCount: stats?.callCount ?? 0,
      errorCount: stats?.errorCount ?? 0,
      avgDurationMs: stats?.avgDurationMs ?? 0,
      errorRate: stats?.errorRate ?? 0,
      lastCall,
      recentCalls: sorted.slice(0, 5),
      x: 0,
      y: 0,
    })
  }

  const result: AgentNode[] = []
  for (const [dept, agents] of Object.entries(deptAgents)) {
    const layout = DEPT_LAYOUT[dept] || DEPT_LAYOUT.engineering
    const cols = 3
    const cellW = (layout.w - 40) / cols
    const cellH = dept === 'management' ? 70 : 80

    agents.forEach((agent, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      agent.x = layout.x + 20 + col * cellW + cellW / 2
      agent.y = layout.y + 55 + row * cellH + cellH / 2
      result.push(agent)
    })
  }

  return result
}

function AgentNodeSVG({
  node,
  onClick,
}: {
  node: AgentNode
  onClick: () => void
}) {
  const deptInfo = DEPT_MAP[node.department] || { color: '#6c757d', label: 'Unknown' }
  const hasActivity = node.callCount > 0
  const fillColor = node.status === 'working' ? deptInfo.color
    : node.status === 'error' ? '#ef4444'
    : hasActivity ? deptInfo.color
    : '#6c757d'

  const fillOpacity = hasActivity ? 0.9 : 0.35

  return (
    <g
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      {/* Outer ring for working/error */}
      {node.status !== 'idle' && (
        <circle
          cx={node.x}
          cy={node.y}
          r={22}
          fill="none"
          stroke={fillColor}
          strokeWidth={2}
          opacity={0.3}
        />
      )}
      {/* Main circle */}
      <circle
        cx={node.x}
        cy={node.y}
        r={16}
        fill={fillColor}
        opacity={fillOpacity}
      />
      {/* Icon */}
      <text
        x={node.x}
        y={node.y + 1}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={12}
        fill="white"
      >
        {node.status === 'error' ? '!' : node.status === 'working' ? '>' : hasActivity ? '#' : '-'}
      </text>

      {/* Call count badge */}
      {node.callCount > 0 && (
        <>
          <circle
            cx={node.x + 12}
            cy={node.y - 12}
            r={8}
            fill="var(--bg-card, #1e1e1e)"
            stroke={fillColor}
            strokeWidth={1.5}
          />
          <text
            x={node.x + 12}
            y={node.y - 11}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={8}
            fontWeight={700}
            fill={fillColor}
          >
            {node.callCount > 99 ? '99+' : node.callCount}
          </text>
        </>
      )}

      {/* Label */}
      <text
        x={node.x}
        y={node.y + 30}
        textAnchor="middle"
        fontSize={10}
        fill="var(--text-secondary)"
      >
        {node.agentType.length > 20 ? node.agentType.slice(0, 18) + '..' : node.agentType}
      </text>
    </g>
  )
}

export function MetaverseTab({ pipelineSlug, wuSlug, onNavigateToTraces }: MetaverseTabProps) {
  const [selectedAgent, setSelectedAgent] = useState<AgentNode | null>(null)

  // wuSlug가 있으면 해당 work unit 기준으로 필터링, pipelineSlug가 있으면 파이프라인 기준
  const apiUrl = wuSlug
    ? `/api/agents?date=all&pipeline_slug=${wuSlug}`
    : pipelineSlug
    ? `/api/agents?date=all&pipeline=${pipelineSlug}`
    : '/api/agents?date=all'

  const { data, error, isLoading } = usePolling<AgentData>(apiUrl, 2000)

  const nodes = useMemo(() => {
    return buildAgentNodes(data ?? null)
  }, [data])

  if (isLoading && !data) {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading metaverse...</div>
  }
  if (error) {
    return <div style={{ padding: '20px', color: 'var(--status-fail)' }}>Error: {error.message}</div>
  }

  const svgWidth = 1000
  const svgHeight = 1040

  const hasAnyActivity = nodes.some(n => n.callCount > 0)
  if (!hasAnyActivity && !isLoading) {
    return (
      <EmptyState
        title="No agent activity"
        description="No agents have been called in this work unit yet."
      />
    )
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '20px' }}>
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        style={{
          width: '100%',
          maxWidth: `${svgWidth}px`,
          height: 'auto',
          margin: '0 auto',
          display: 'block',
        }}
      >
        {/* Department areas */}
        {Object.entries(DEPT_LAYOUT).map(([dept, layout]) => {
          const deptInfo = DEPT_MAP[dept] || { color: '#6c757d', label: dept }
          const deptNodes = nodes.filter(n => n.department === dept)
          const totalCalls = deptNodes.reduce((sum, n) => sum + n.callCount, 0)
          return (
            <g key={dept}>
              <rect
                x={layout.x}
                y={layout.y}
                width={layout.w}
                height={layout.h}
                rx={8}
                fill={deptInfo.color}
                opacity={0.06}
                stroke={deptInfo.color}
                strokeWidth={1}
                strokeOpacity={0.2}
              />
              <text
                x={layout.x + 12}
                y={layout.y + 24}
                fontSize={13}
                fontWeight={600}
                fill={deptInfo.color}
                opacity={0.7}
              >
                {deptInfo.label}
              </text>
              <text
                x={layout.x + layout.w - 12}
                y={layout.y + 24}
                fontSize={11}
                fill={deptInfo.color}
                opacity={0.5}
                textAnchor="end"
              >
                {totalCalls} calls
              </text>
            </g>
          )
        })}

        {/* Agent nodes */}
        {nodes.map(node => (
          <AgentNodeSVG
            key={node.agentType}
            node={node}
            onClick={() => setSelectedAgent(node)}
          />
        ))}
      </svg>

      {/* Agent detail modal */}
      <Modal
        open={selectedAgent !== null}
        onClose={() => setSelectedAgent(null)}
        title={selectedAgent?.agentType || ''}
        width="520px"
      >
        {selectedAgent && (
          <div>
            {/* Status + department */}
            <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Badge
                variant={selectedAgent.status === 'error' ? 'error' : selectedAgent.status === 'working' ? 'running' : 'pending'}
                pulse={selectedAgent.status === 'working'}
              >
                {selectedAgent.status.toUpperCase()}
              </Badge>
              <span style={{ fontSize: '12px', color: DEPT_MAP[selectedAgent.department]?.color || 'var(--text-muted)' }}>
                {DEPT_MAP[selectedAgent.department]?.label || selectedAgent.department}
              </span>
            </div>

            {/* Performance stats */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: '8px',
              marginBottom: '16px',
            }}>
              <div style={{
                padding: '10px',
                background: 'var(--bg-secondary)',
                borderRadius: '6px',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {selectedAgent.callCount}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Total Calls</div>
              </div>
              <div style={{
                padding: '10px',
                background: 'var(--bg-secondary)',
                borderRadius: '6px',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {selectedAgent.avgDurationMs > 0 ? formatDuration(selectedAgent.avgDurationMs) : '-'}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Avg Duration</div>
              </div>
              <div style={{
                padding: '10px',
                background: 'var(--bg-secondary)',
                borderRadius: '6px',
                textAlign: 'center',
              }}>
                <div style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: selectedAgent.errorRate > 0 ? 'var(--status-fail)' : 'var(--text-primary)',
                }}>
                  {selectedAgent.errorRate > 0 ? `${selectedAgent.errorRate.toFixed(1)}%` : '0%'}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Error Rate</div>
              </div>
            </div>

            {/* Current task */}
            {selectedAgent.lastCall && selectedAgent.status === 'working' && (
              <div style={{
                padding: '12px',
                background: 'var(--bg-secondary)',
                borderRadius: '6px',
                marginBottom: '16px',
                fontSize: '12px',
              }}>
                <div style={{ fontWeight: 600, marginBottom: '4px', color: 'var(--text-secondary)' }}>Current Task</div>
                <div>{selectedAgent.lastCall.promptSummary || selectedAgent.lastCall.description || '-'}</div>
              </div>
            )}

            {/* Recent history */}
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Recent History
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {selectedAgent.recentCalls.map((call, i) => {
                const summary = call.description || call.promptSummary || ''
                const inputText = call.input || call.promptSummary || ''
                const outputText = call.output || call.resultSummary || ''
                const hasContent = summary || inputText || outputText
                return (
                  <div
                    key={call.callId || i}
                    style={{
                      padding: '10px 12px',
                      background: 'var(--bg-secondary)',
                      borderRadius: '6px',
                      fontSize: '12px',
                      borderLeft: `3px solid ${call.isError ? 'var(--status-fail)' : !call.endedAt ? 'var(--status-running)' : 'var(--status-done)'}`,
                    }}
                  >
                    {/* Header row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: hasContent ? '6px' : 0 }}>
                      <Badge variant={call.isError ? 'error' : !call.endedAt ? 'running' : 'success'}>
                        {call.isError ? 'ERR' : !call.endedAt ? 'RUN' : 'OK'}
                      </Badge>
                      {call.model && (
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: '3px' }}>
                          {call.model}
                        </span>
                      )}
                      {call.parentSpanId && (
                        <span style={{ fontSize: '10px', color: 'var(--dept-planning)', background: 'rgba(59,130,246,0.1)', padding: '1px 6px', borderRadius: '3px' }}>
                          from parent
                        </span>
                      )}
                      <span style={{ flex: 1 }} />
                      <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                        {call.durationMs != null ? formatDuration(call.durationMs) : '...'}
                      </span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                        {call.startedAt ? formatRelativeTime(call.startedAt) : ''}
                      </span>
                    </div>
                    {/* Description */}
                    {summary && (
                      <div style={{ color: 'var(--text-primary)', marginBottom: '4px', lineHeight: '1.4' }}>
                        {summary}
                      </div>
                    )}
                    {/* Input preview */}
                    {inputText && inputText !== summary && (
                      <div style={{ color: 'var(--text-secondary)', fontSize: '11px', lineHeight: '1.4', marginBottom: '4px' }}>
                        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Input: </span>
                        {inputText.length > 200 ? inputText.slice(0, 200) + '...' : inputText}
                      </div>
                    )}
                    {/* Output preview */}
                    {outputText && (
                      <div style={{ color: 'var(--text-secondary)', fontSize: '11px', lineHeight: '1.4' }}>
                        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Output: </span>
                        {outputText.length > 200 ? outputText.slice(0, 200) + '...' : outputText}
                      </div>
                    )}
                    {/* Error message */}
                    {call.isError && call.errorMessage && (
                      <div style={{ color: 'var(--status-fail)', fontSize: '11px', marginTop: '4px' }}>
                        {call.errorMessage}
                      </div>
                    )}
                  </div>
                )
              })}
              {selectedAgent.recentCalls.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: '12px', padding: '8px' }}>No recent calls</div>
              )}
            </div>

            {/* Link to traces */}
            {onNavigateToTraces && (
              <button
                onClick={() => {
                  setSelectedAgent(null)
                  onNavigateToTraces()
                }}
                style={{
                  marginTop: '16px',
                  background: 'none',
                  border: '1px solid var(--accent)',
                  borderRadius: '6px',
                  padding: '8px 16px',
                  color: 'var(--accent)',
                  fontSize: '12px',
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                View in Traces tab
              </button>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
