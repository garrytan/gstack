'use client'

import { useMemo, useState } from 'react'
import { usePolling } from '@/hooks/usePolling'
import type { RetroJournalEntry } from '@/lib/types'

/* ------------------------------------------------------------------ */
/*  Types matching the JSON schema from PRD section 3.4               */
/* ------------------------------------------------------------------ */

interface HRReportSummary {
  total_pipelines: number
  total_invocations: number
  overall_success_rate: number | null
}

interface HRDepartment {
  department_id: string
  agent_count: number
  avg_success_rate: number | null
  total_invocations: number
}

interface HRAgent {
  agent_id: string
  department: string
  grade: string
  invocation_count: number
  success_rate: number | null
  avg_duration_ms: number
  retry_count: number
  escalation_count: number
  trend: 'improving' | 'declining' | 'stable'
}

interface HRReport {
  report_date: string | null
  source?: 'weekly' | 'retro'
  retro_slug?: string
  period: { start: string | null; end: string | null }
  summary: HRReportSummary
  departments: HRDepartment[]
  agents: HRAgent[]
  alerts: string[]
  recommendations: string[]
}

interface HRReportListItem {
  date: string
  filename: string
  report_date: string
  period: { start: string; end: string } | null
  agent_count: number
  alert_count: number
  source?: 'weekly' | 'retro'
  retro_slug?: string
}

/* ------------------------------------------------------------------ */
/*  Null-safe helpers                                                   */
/* ------------------------------------------------------------------ */

/** Formats a success rate (0–1) as percentage string, returns '-' for null */
function fmtRate(rate: number | null, digits = 1): string {
  if (rate === null || rate === undefined) return '-'
  return `${(rate * 100).toFixed(digits)}%`
}

/** Returns accent color for a success rate, or muted for null */
function rateAccent(rate: number | null): string {
  if (rate === null || rate === undefined) return 'var(--text-muted)'
  if (rate >= 0.85) return '#22c55e'
  if (rate >= 0.7) return '#eab308'
  return '#ef4444'
}

/* ------------------------------------------------------------------ */
/*  Grade color mapping                                                */
/* ------------------------------------------------------------------ */

const GRADE_COLORS: Record<string, string> = {
  A: '#22c55e',
  B: '#3b82f6',
  C: '#eab308',
  D: '#f97316',
  F: '#ef4444',
}

function gradeColor(grade: string): string {
  return GRADE_COLORS[grade.toUpperCase()] ?? 'var(--text-muted)'
}

/* ------------------------------------------------------------------ */
/*  Trend display                                                      */
/* ------------------------------------------------------------------ */

function trendSymbol(trend: string): { symbol: string; color: string } {
  switch (trend) {
    case 'improving': return { symbol: '\u2191', color: '#22c55e' }
    case 'declining': return { symbol: '\u2193', color: '#ef4444' }
    default: return { symbol: '=', color: 'var(--text-muted)' }
  }
}

/* ------------------------------------------------------------------ */
/*  Department label mapping                                           */
/* ------------------------------------------------------------------ */

const DEPT_LABELS: Record<string, { label: string; color: string }> = {
  executive: { label: 'Executive', color: '#ec4899' },
  management: { label: 'Executive', color: '#ec4899' },
  planning: { label: 'Planning', color: '#3b82f6' },
  engineering: { label: 'Engineering', color: '#22c55e' },
  evaluation: { label: 'Evaluation', color: '#f97316' },
  qa: { label: 'QA', color: '#a855f7' },
}

function deptLabel(deptId: string): { label: string; color: string } {
  return DEPT_LABELS[deptId] ?? { label: deptId, color: '#6c757d' }
}

/* ------------------------------------------------------------------ */
/*  SourceBadge                                                        */
/* ------------------------------------------------------------------ */

function SourceBadge({ source }: { source?: 'weekly' | 'retro' }) {
  const isRetro = source === 'retro'
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 7px',
      borderRadius: '4px',
      fontSize: '10px',
      fontWeight: 600,
      color: '#fff',
      background: isRetro ? '#6366f1' : '#3b82f6',
      letterSpacing: '0.3px',
    }}>
      {isRetro ? '회고' : '주간'}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function SummaryCards({ report }: { report: HRReport }) {
  const activeAgents = report.agents.filter(a => a.invocation_count > 0).length
  const alertAgents = report.agents.filter(a => a.grade === 'D' || a.grade === 'F').length

  return (
    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
      <SummaryCard
        title="Agents"
        value={`${activeAgents} / ${report.agents.length}`}
        subtitle="active / total"
        accent="var(--text-primary)"
      />
      <SummaryCard
        title="Success Rate"
        value={fmtRate(report.summary.overall_success_rate)}
        subtitle="overall average"
        accent={rateAccent(report.summary.overall_success_rate)}
      />
      <SummaryCard
        title="Invocations"
        value={String(report.summary.total_invocations)}
        subtitle="this period"
        accent="var(--text-primary)"
      />
      <SummaryCard
        title="Attention Needed"
        value={String(alertAgents)}
        subtitle="D/F grade agents"
        accent={alertAgents > 0 ? '#ef4444' : '#22c55e'}
      />
    </div>
  )
}

function SummaryCard({ title, value, subtitle, accent }: {
  title: string
  value: string
  subtitle: string
  accent: string
}) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-light)',
      borderRadius: '8px',
      padding: '14px 16px',
      minWidth: '170px',
      flex: '1 1 170px',
    }}>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
        {title}
      </div>
      <div style={{ fontSize: '22px', fontWeight: 700, color: accent, marginBottom: '2px' }}>
        {value}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
        {subtitle}
      </div>
    </div>
  )
}

function DeptTable({ departments }: { departments: HRDepartment[] }) {
  if (departments.length === 0) return null
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-light)',
      borderRadius: '8px',
      overflow: 'hidden',
      marginBottom: '20px',
    }}>
      <div style={{
        padding: '12px 16px',
        fontSize: '13px',
        fontWeight: 600,
        borderBottom: '1px solid var(--border-light)',
        background: 'var(--bg-secondary)',
      }}>
        Department Summary
      </div>
      {/* Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '2fr 80px 100px 100px',
        gap: '8px',
        padding: '10px 16px',
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        borderBottom: '1px solid var(--border-light)',
      }}>
        <div>Department</div>
        <div style={{ textAlign: 'right' }}>Agents</div>
        <div style={{ textAlign: 'right' }}>Avg Success</div>
        <div style={{ textAlign: 'right' }}>Invocations</div>
      </div>
      {/* Rows */}
      {departments.map(dept => {
        const info = deptLabel(dept.department_id)
        return (
          <div
            key={dept.department_id}
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 80px 100px 100px',
              gap: '8px',
              padding: '10px 16px',
              fontSize: '13px',
              borderBottom: '1px solid var(--border-light)',
            }}
          >
            <div style={{ fontWeight: 600, color: info.color, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: info.color, flexShrink: 0 }} />
              {info.label}
            </div>
            <div style={{ textAlign: 'right' }}>{dept.agent_count}</div>
            <div style={{
              textAlign: 'right',
              color: rateAccent(dept.avg_success_rate),
              fontWeight: 600,
            }}>
              {fmtRate(dept.avg_success_rate)}
            </div>
            <div style={{ textAlign: 'right' }}>{dept.total_invocations}</div>
          </div>
        )
      })}
    </div>
  )
}

function AgentTable({ agents }: { agents: HRAgent[] }) {
  if (agents.length === 0) return null

  const formatDuration = (ms: number): string => {
    if (ms === 0) return '-'
    if (ms < 1000) return `${ms}ms`
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    const rem = s % 60
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`
  }

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-light)',
      borderRadius: '8px',
      overflow: 'hidden',
      marginBottom: '20px',
    }}>
      <div style={{
        padding: '12px 16px',
        fontSize: '13px',
        fontWeight: 600,
        borderBottom: '1px solid var(--border-light)',
        background: 'var(--bg-secondary)',
      }}>
        Agent Performance
      </div>
      {/* Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 60px 80px 90px 80px 70px 60px',
        gap: '8px',
        padding: '10px 16px',
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        borderBottom: '1px solid var(--border-light)',
      }}>
        <div>Agent</div>
        <div>Department</div>
        <div style={{ textAlign: 'center' }}>Grade</div>
        <div style={{ textAlign: 'right' }}>Calls</div>
        <div style={{ textAlign: 'right' }}>Success</div>
        <div style={{ textAlign: 'right' }}>Avg Time</div>
        <div style={{ textAlign: 'right' }}>Retries</div>
        <div style={{ textAlign: 'center' }}>Trend</div>
      </div>
      {/* Rows */}
      {agents.map(agent => {
        const info = deptLabel(agent.department)
        const gc = gradeColor(agent.grade)
        const t = trendSymbol(agent.trend)
        const hasActivity = agent.invocation_count > 0
        return (
          <div
            key={agent.agent_id}
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr 60px 80px 90px 80px 70px 60px',
              gap: '8px',
              padding: '10px 16px',
              fontSize: '13px',
              borderBottom: '1px solid var(--border-light)',
              opacity: hasActivity ? 1 : 0.5,
            }}
          >
            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: hasActivity ? info.color : '#6c757d', flexShrink: 0,
              }} />
              {agent.agent_id}
            </div>
            <div style={{ color: info.color, fontSize: '12px', display: 'flex', alignItems: 'center' }}>
              {info.label}
            </div>
            <div style={{ textAlign: 'center' }}>
              <span style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 700,
                color: '#fff',
                background: gc,
                minWidth: '24px',
              }}>
                {agent.grade}
              </span>
            </div>
            <div style={{ textAlign: 'right' }}>
              {agent.invocation_count > 0 ? agent.invocation_count : '-'}
            </div>
            <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px' }}>
              <div style={{
                width: '40px', height: '6px', borderRadius: '3px',
                background: 'var(--border-light)', overflow: 'hidden',
              }}>
                <div style={{
                  width: `${agent.success_rate !== null ? Math.min(agent.success_rate * 100, 100) : 0}%`,
                  height: '100%',
                  borderRadius: '3px',
                  background: rateAccent(agent.success_rate),
                }} />
              </div>
              <span style={{ fontSize: '12px' }}>
                {hasActivity ? fmtRate(agent.success_rate, 0) : '-'}
              </span>
            </div>
            <div style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
              {formatDuration(agent.avg_duration_ms)}
            </div>
            <div style={{ textAlign: 'right', color: agent.retry_count > 0 ? '#f97316' : 'var(--text-secondary)' }}>
              {hasActivity ? agent.retry_count : '-'}
            </div>
            <div style={{ textAlign: 'center', fontWeight: 600, color: t.color, fontSize: '14px' }}>
              {hasActivity ? t.symbol : '-'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AlertSection({ agents }: { agents: HRAgent[] }) {
  const alertAgents = agents.filter(a => a.grade === 'D' || a.grade === 'F')
  if (alertAgents.length === 0) return null

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-light)',
      borderRadius: '8px',
      overflow: 'hidden',
      borderLeft: '3px solid #ef4444',
    }}>
      <div style={{
        padding: '12px 16px',
        fontSize: '13px',
        fontWeight: 600,
        borderBottom: '1px solid var(--border-light)',
        background: 'var(--bg-secondary)',
        color: '#ef4444',
      }}>
        Attention Needed (D/F Grade)
      </div>
      {alertAgents.map(agent => {
        const gc = gradeColor(agent.grade)
        const issues: string[] = []
        if (agent.success_rate !== null && agent.success_rate < 0.5) issues.push(`Very low success rate (${fmtRate(agent.success_rate, 0)})`)
        else if (agent.success_rate !== null && agent.success_rate < 0.7) issues.push(`Low success rate (${fmtRate(agent.success_rate, 0)})`)
        if (agent.retry_count > 3) issues.push(`High retry count (${agent.retry_count})`)
        if (agent.escalation_count > 0) issues.push(`${agent.escalation_count} escalation(s)`)
        if (issues.length === 0) issues.push('Performance below threshold')

        return (
          <div
            key={agent.agent_id}
            style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--border-light)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <span style={{
                display: 'inline-block', padding: '2px 8px', borderRadius: '4px',
                fontSize: '11px', fontWeight: 700, color: '#fff', background: gc,
              }}>
                {agent.grade}
              </span>
              <span style={{ fontWeight: 600, fontSize: '13px' }}>{agent.agent_id}</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                ({deptLabel(agent.department).label})
              </span>
            </div>
            <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              {issues.map((issue, i) => (
                <li key={i} style={{ marginBottom: '2px' }}>{issue}</li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  RetroJournalCard                                                   */
/* ------------------------------------------------------------------ */

function RetroJournalCard({ entry, isExpanded, onToggle }: {
  entry: RetroJournalEntry
  isExpanded: boolean
  onToggle: () => void
}) {
  const meta = entry.retro_metadata

  // Compute grade distribution from agents array if not in meta
  const gradeDist: Record<string, number> = meta.grade_distribution ?? {}
  if (Object.keys(gradeDist).length === 0 && entry.agents && entry.agents.length > 0) {
    for (const agent of entry.agents) {
      const g = (agent.grade ?? 'Unknown').toUpperCase()
      gradeDist[g] = (gradeDist[g] ?? 0) + 1
    }
  }
  const gradeEntries = Object.entries(gradeDist).sort(([a], [b]) => a.localeCompare(b))

  const displayActions = meta.action_items ?? []

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-light)',
      borderRadius: '8px',
      overflow: 'hidden',
      marginBottom: '10px',
      borderLeft: '3px solid #6366f1',
    }}>
      {/* Header — always visible, clickable */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 16px',
          cursor: 'pointer',
          background: isExpanded ? 'var(--bg-secondary)' : 'transparent',
          borderBottom: isExpanded ? '1px solid var(--border-light)' : 'none',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', minWidth: '90px' }}>
          {meta.retro_date}
        </span>
        <span style={{
          fontSize: '11px',
          color: '#6366f1',
          fontWeight: 600,
          background: 'rgba(99,102,241,0.08)',
          padding: '2px 7px',
          borderRadius: '4px',
          maxWidth: '200px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {entry.retro_slug}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          파이프라인 {meta.analyzed_pipelines}개 분석
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '12px', color: 'var(--text-muted)', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
          ▼
        </span>
      </div>

      {/* Body — expanded only */}
      {isExpanded && (
        <div style={{ padding: '12px 16px' }}>
          {/* Grade distribution mini badges */}
          {gradeEntries.length > 0 && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginRight: '2px' }}>에이전트 등급:</span>
              {gradeEntries.map(([grade, count]) => (
                <span
                  key={grade}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px',
                    padding: '2px 7px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: '#fff',
                    background: gradeColor(grade),
                  }}
                >
                  {grade}
                  <span style={{ fontWeight: 400, opacity: 0.85 }}>{count}</span>
                </span>
              ))}
            </div>
          )}

          {/* Action items summary */}
          <div style={{ marginBottom: '10px' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              개선 사항 {meta.action_items?.length ?? 0}건
            </span>
            {displayActions.length > 0 && (
              <ul style={{ margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                {displayActions.map((item, i) => (
                  <li key={i} style={{ marginBottom: '2px' }}>{item}</li>
                ))}
              </ul>
            )}
          </div>

          {/* Agent improvements */}
          {(() => {
            const improvements = meta.improvements
            if (!improvements || improvements.length === 0) return null
            return (
            <div style={{ marginBottom: '10px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>에이전트 개선 이력</span>
              {improvements.map((imp) => (
                <div key={imp.agent_id} style={{
                  marginTop: '6px',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  background: 'rgba(99,102,241,0.06)',
                  border: '1px solid rgba(99,102,241,0.15)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{imp.agent_id}</span>
                    <span style={{
                      fontSize: '11px', fontWeight: 600,
                      padding: '1px 6px', borderRadius: '3px',
                      background: 'rgba(239,68,68,0.12)', color: '#ef4444',
                    }}>{imp.grade_before}</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>→</span>
                    <span style={{
                      fontSize: '11px', fontWeight: 600,
                      padding: '1px 6px', borderRadius: '3px',
                      background: 'rgba(34,197,94,0.12)', color: '#22c55e',
                    }}>{imp.grade_target}</span>
                  </div>
                  <ul style={{ margin: '0', paddingLeft: '16px', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                    {imp.changes.map((c: string, i: number) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            )
          })()}

          {/* KPT summary */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{
              padding: '3px 9px', borderRadius: '4px', fontSize: '11px', fontWeight: 600,
              background: 'rgba(34,197,94,0.12)', color: '#22c55e',
            }}>
              Keep {meta.keep_count}
            </span>
            <span style={{
              padding: '3px 9px', borderRadius: '4px', fontSize: '11px', fontWeight: 600,
              background: 'rgba(239,68,68,0.12)', color: '#ef4444',
            }}>
              Problem {meta.problem_count}
            </span>
            <span style={{
              padding: '3px 9px', borderRadius: '4px', fontSize: '11px', fontWeight: 600,
              background: 'rgba(59,130,246,0.12)', color: '#3b82f6',
            }}>
              Try {meta.try_count}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  RetroJournalSection                                                */
/* ------------------------------------------------------------------ */

function RetroJournalSection({ selectedRetroSlug }: { selectedRetroSlug?: string | null }) {
  const url = selectedRetroSlug
    ? `/api/hr/retro-journal?slug=${encodeURIComponent(selectedRetroSlug)}`
    : '/api/hr/retro-journal'
  const { data: entries, isLoading } = usePolling<RetroJournalEntry[]>(url, 10000)
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null)

  const toggle = (slug: string) => {
    setExpandedSlug(prev => (prev === slug ? null : slug))
  }

  // Sort by report_date descending (already sorted by API, but ensure it)
  const sorted = useMemo(() => {
    if (!entries) return []
    return [...entries].sort((a, b) => b.report_date.localeCompare(a.report_date))
  }, [entries])

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border-light)',
      borderRadius: '8px',
      overflow: 'hidden',
    }}>
      {/* Section header */}
      <div style={{
        padding: '12px 16px',
        fontSize: '13px',
        fontWeight: 600,
        borderBottom: '1px solid var(--border-light)',
        background: 'var(--bg-secondary)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <span style={{ width: '3px', height: '14px', background: '#6366f1', borderRadius: '2px', display: 'inline-block' }} />
        회고 일지
        {sorted.length > 0 && (
          <span style={{
            fontSize: '11px',
            fontWeight: 400,
            color: 'var(--text-muted)',
            background: 'var(--border-light)',
            padding: '1px 6px',
            borderRadius: '10px',
          }}>
            {sorted.length}건
          </span>
        )}
      </div>

      {/* Content */}
      <div style={{ padding: '12px 16px' }}>
        {isLoading ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>
            로딩 중...
          </div>
        ) : sorted.length === 0 ? (
          <div style={{
            fontSize: '13px',
            color: 'var(--text-muted)',
            textAlign: 'center',
            padding: '24px 0',
          }}>
            회고 이력이 없습니다
          </div>
        ) : (
          sorted.map(entry => (
            <RetroJournalCard
              key={entry.retro_slug}
              entry={entry}
              isExpanded={expandedSlug === entry.retro_slug}
              onToggle={() => toggle(entry.retro_slug)}
            />
          ))
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main HRTab component                                               */
/* ------------------------------------------------------------------ */

export function HRTab() {
  // API Contract: /api/hr/reports returns { reports: HRReportListItem[] }
  const { data: reportListData, isLoading: isListLoading } = usePolling<{ reports: HRReportListItem[] }>('/api/hr/reports', 10000)
  const reportList = reportListData?.reports ?? []
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null)

  // Determine which report URL to poll
  const reportUrl = selectedFilename
    ? `/api/hr/reports/latest?filename=${encodeURIComponent(selectedFilename)}`
    : '/api/hr/reports/latest'

  const { data: report, error, isLoading: isReportLoading } = usePolling<HRReport>(reportUrl, 10000)

  const isLoading = isListLoading || isReportLoading

  // Sort agents: D/F first, then by invocation count descending
  const sortedAgents = useMemo(() => {
    if (!report?.agents) return []
    return [...report.agents].sort((a, b) => {
      const gradeOrder: Record<string, number> = { F: 0, D: 1, C: 2, B: 3, A: 4 }
      const ga = gradeOrder[a.grade] ?? 5
      const gb = gradeOrder[b.grade] ?? 5
      if (ga !== gb) return ga - gb
      return b.invocation_count - a.invocation_count
    })
  }, [report])

  if (isLoading && !report) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading HR reports...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: '20px', color: 'var(--status-fail)' }}>
        Error loading HR data: {error.message}
      </div>
    )
  }

  const hasData = report && report.report_date !== null

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '12px 20px',
        borderBottom: '1px solid var(--border)',
        fontSize: '13px',
        color: 'var(--text-secondary)',
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600 }}>HR Performance Report</span>
        {report?.period?.start && report?.period?.end && (
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {report.period.start} ~ {report.period.end}
          </span>
        )}
        {/* Source badge for current report */}
        {report?.report_date && (
          <SourceBadge source={report.source} />
        )}
        <div style={{ flex: 1 }} />
        {/* Report date selector */}
        {reportList && reportList.length > 0 && (
          <select
            value={selectedFilename ?? ''}
            onChange={e => setSelectedFilename(e.target.value || null)}
            style={{
              padding: '4px 8px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              fontSize: '12px',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="">Latest Report</option>
            {reportList.map(r => (
              <option key={r.filename} value={r.filename}>
                {r.report_date} ({r.agent_count} agents){r.source === 'retro' && r.retro_slug ? ` — ${r.retro_slug}` : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        {!hasData ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '300px',
            color: 'var(--text-muted)',
            gap: '12px',
          }}>
            <div style={{ fontSize: '32px' }}>&#128203;</div>
            <div style={{ fontSize: '14px', fontWeight: 600 }}>No HR Reports Available</div>
            <div style={{ fontSize: '12px', textAlign: 'center', maxWidth: '400px', lineHeight: '1.5' }}>
              HR Agent has not generated any weekly performance reports yet.
              Reports appear here after the hr-agent runs its weekly performance check pipeline.
            </div>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div style={{ marginBottom: '20px' }}>
              <SummaryCards report={report} />
            </div>

            {/* Department summary */}
            <DeptTable departments={report.departments} />

            {/* Agent performance table */}
            <AgentTable agents={sortedAgents} />

            {/* Attention needed section */}
            <AlertSection agents={report.agents} />

          </>
        )}

        {/* Retro Journal — always visible regardless of hasData */}
        <div style={{ marginTop: '20px' }}>
          <RetroJournalSection selectedRetroSlug={report?.retro_slug ?? null} />
        </div>
      </div>
    </div>
  )
}
