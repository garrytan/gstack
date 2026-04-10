'use client'

import { useMemo } from 'react'
import { usePolling } from '@/hooks/usePolling'
import { Badge } from '@/components/ui/Badge'
import { formatDuration, formatRelativeTime } from '@/lib/utils'
import { ALL_AGENTS, DEPT_INFO } from '@/lib/agents-config'
import type { AgentData, AgentTypeStat } from '@/lib/types'

interface AgentRow {
  agentType: string
  department: string
  callCount: number
  errorCount: number
  avgDurationMs: number
  errorRate: number
  lastActive: string | null
}

interface DeptSummary {
  department: string
  label: string
  color: string
  totalCalls: number
  totalErrors: number
  avgDuration: number
  agentCount: number
}

function buildAgentRows(data: AgentData | null): AgentRow[] {
  const statMap = new Map<string, AgentTypeStat>()
  if (data) {
    for (const s of data.stats) statMap.set(s.agentType, s)
  }

  // Find last active time per agent type
  const lastActiveMap = new Map<string, string>()
  if (data) {
    for (const call of data.calls) {
      const t = call.startedAt || call.endedAt
      if (!t) continue
      const prev = lastActiveMap.get(call.agentType)
      if (!prev || new Date(t).getTime() > new Date(prev).getTime()) {
        lastActiveMap.set(call.agentType, t)
      }
    }
  }

  return ALL_AGENTS.map(({ agentType, department }) => {
    const stat = statMap.get(agentType)
    return {
      agentType,
      department,
      callCount: stat?.callCount ?? 0,
      errorCount: stat?.errorCount ?? 0,
      avgDurationMs: stat?.avgDurationMs ?? 0,
      errorRate: stat?.errorRate ?? 0,
      lastActive: lastActiveMap.get(agentType) ?? null,
    }
  })
}

function buildDeptSummaries(rows: AgentRow[]): DeptSummary[] {
  const deptOrder = ['management', 'planning', 'engineering-frontend', 'engineering-backend', 'engineering-platform', 'design', 'evaluation', 'qa']
  return deptOrder.map(dept => {
    const deptRows = rows.filter(r => r.department === dept)
    const info = DEPT_INFO[dept] || { color: '#6c757d', label: dept }
    const totalCalls = deptRows.reduce((s, r) => s + r.callCount, 0)
    const totalErrors = deptRows.reduce((s, r) => s + r.errorCount, 0)
    const activeDurations = deptRows.filter(r => r.avgDurationMs > 0)
    const avgDuration = activeDurations.length > 0
      ? activeDurations.reduce((s, r) => s + r.avgDurationMs, 0) / activeDurations.length
      : 0
    return {
      department: dept,
      label: info.label,
      color: info.color,
      totalCalls,
      totalErrors,
      avgDuration,
      agentCount: deptRows.length,
    }
  })
}

function DeptSummaryCard({ summary }: { summary: DeptSummary }) {
  const errorRate = summary.totalCalls > 0
    ? ((summary.totalErrors / summary.totalCalls) * 100).toFixed(1)
    : '0.0'
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-light)',
      borderRadius: '8px',
      padding: '14px 16px',
      borderLeft: `3px solid ${summary.color}`,
      minWidth: '170px',
      flex: '1 1 170px',
    }}>
      <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', color: summary.color }}>
        {summary.label}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '12px', color: 'var(--text-secondary)' }}>
        <div>Calls: <strong style={{ color: 'var(--text-primary)' }}>{summary.totalCalls}</strong></div>
        <div>Errors: <strong style={{ color: summary.totalErrors > 0 ? 'var(--status-fail)' : 'var(--text-primary)' }}>{summary.totalErrors}</strong></div>
        <div>Avg: <strong style={{ color: 'var(--text-primary)' }}>{summary.avgDuration > 0 ? formatDuration(summary.avgDuration) : '-'}</strong></div>
        <div>Err%: <strong style={{ color: parseFloat(errorRate) > 0 ? 'var(--status-fail)' : 'var(--text-primary)' }}>{errorRate}%</strong></div>
      </div>
    </div>
  )
}

export function AgentsTab({ pipelineSlug }: { pipelineSlug?: string | null }) {
  const apiUrl = pipelineSlug ? `/api/agents?date=all&pipeline=${pipelineSlug}` : '/api/agents?date=all'
  const { data, error, isLoading } = usePolling<AgentData>(apiUrl, 2000)

  const rows = useMemo(() => buildAgentRows(data ?? null), [data])
  const deptSummaries = useMemo(() => buildDeptSummaries(rows), [rows])

  if (isLoading && !data) {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading agents...</div>
  }
  if (error) {
    return <div style={{ padding: '20px', color: 'var(--status-fail)' }}>Error loading agents: {error.message}</div>
  }

  const totalCalls = data?.totalCalls ?? 0
  const totalErrors = data?.totalErrors ?? 0
  const runningCount = data?.runningCount ?? 0

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Summary bar */}
      <div style={{
        display: 'flex',
        gap: '20px',
        padding: '12px 20px',
        borderBottom: '1px solid var(--border)',
        fontSize: '13px',
        color: 'var(--text-secondary)',
        flexShrink: 0,
      }}>
        <span>Agents: <strong style={{ color: 'var(--text-primary)' }}>{ALL_AGENTS.length}</strong></span>
        <span>Total Calls: <strong style={{ color: 'var(--text-primary)' }}>{totalCalls}</strong></span>
        <span>Running: <strong style={{ color: 'var(--status-running)' }}>{runningCount}</strong></span>
        <span>Errors: <strong style={{ color: totalErrors > 0 ? 'var(--status-fail)' : 'var(--text-primary)' }}>{totalErrors}</strong></span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        {/* Department summary cards */}
        <div style={{
          display: 'flex',
          gap: '12px',
          marginBottom: '20px',
          flexWrap: 'wrap',
        }}>
          {deptSummaries.map(s => (
            <DeptSummaryCard key={s.department} summary={s} />
          ))}
        </div>

        {/* Agent table */}
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-light)',
          borderRadius: '8px',
          overflow: 'hidden',
        }}>
          {/* Table header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 80px 90px 80px 100px',
            gap: '8px',
            padding: '10px 16px',
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            borderBottom: '1px solid var(--border-light)',
            background: 'var(--bg-secondary)',
          }}>
            <div>Agent</div>
            <div>Department</div>
            <div style={{ textAlign: 'right' }}>Calls</div>
            <div style={{ textAlign: 'right' }}>Avg Time</div>
            <div style={{ textAlign: 'right' }}>Err %</div>
            <div style={{ textAlign: 'right' }}>Last Active</div>
          </div>

          {/* Table rows */}
          {rows.map(row => {
            const deptInfo = DEPT_INFO[row.department] || { color: '#6c757d', label: row.department }
            const hasActivity = row.callCount > 0
            return (
              <div
                key={row.agentType}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 80px 90px 80px 100px',
                  gap: '8px',
                  padding: '10px 16px',
                  fontSize: '13px',
                  borderBottom: '1px solid var(--border-light)',
                  opacity: hasActivity ? 1 : 0.5,
                }}
              >
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: hasActivity ? deptInfo.color : '#6c757d',
                    flexShrink: 0,
                  }} />
                  {row.agentType}
                </div>
                <div style={{ color: deptInfo.color, fontSize: '12px', display: 'flex', alignItems: 'center' }}>
                  {deptInfo.label}
                </div>
                <div style={{ textAlign: 'right', color: 'var(--text-primary)' }}>
                  {row.callCount > 0 ? row.callCount : '-'}
                </div>
                <div style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                  {row.avgDurationMs > 0 ? formatDuration(row.avgDurationMs) : '-'}
                </div>
                <div style={{
                  textAlign: 'right',
                  color: row.errorRate > 0 ? 'var(--status-fail)' : 'var(--text-secondary)',
                }}>
                  {row.callCount > 0 ? `${row.errorRate.toFixed(1)}%` : '-'}
                </div>
                <div style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: '12px' }}>
                  {row.lastActive ? formatRelativeTime(row.lastActive) : '-'}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
