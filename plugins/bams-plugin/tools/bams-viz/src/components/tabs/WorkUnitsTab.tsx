'use client'

import { useState, useMemo } from 'react'
import { usePolling } from '@/hooks/usePolling'
import { formatRelativeTime } from '@/lib/utils'
import { TaskCard } from '@/components/ui/TaskCard'
import { CostBar } from '@/components/ui/CostBar'
import { BudgetProgressBar } from '@/components/ui/BudgetProgressBar'
import type {
  WorkUnit,
  Task,
  WorkUnitTasksResponse,
  WorkUnitCostsResponse,
  BudgetStatusResponse,
} from '@/lib/types'

interface WorkUnitsResponse {
  workunits: WorkUnit[]
}

// WU 상세 응답 — API는 { workunit: WUDetailData } wrapper로 반환
interface WUDetailResponse {
  workunit: WUDetailData
}

interface WUDetailData {
  slug: string
  name: string
  status: 'active' | 'completed' | 'abandoned' | 'unknown'
  startedAt: string | null
  endedAt: string | null
  pipelines: Array<{
    slug: string
    type: string
    linkedAt: string | null
  }>
  task_summary: {
    total: number
    backlog: number
    in_progress: number
    done: number
    blocked: number
    cancelled: number
  }
  total_billed_cents: number
}

// WUTasksData = WorkUnitTasksResponse (imported from types)

type StatusFilter = 'all' | 'active' | 'completed' | 'abandoned'
type DetailTab = 'pipelines' | 'costs' | 'budget'

// ─────────────────────────────────────────────────────────────
// Master panel — Work Unit card (좌측 목록)
// ─────────────────────────────────────────────────────────────

function WUCard({
  workunit,
  selected,
  onClick,
}: {
  workunit: WorkUnit
  selected: boolean
  onClick: () => void
}) {
  const isActive = workunit.status === 'active'
  const borderColor = selected
    ? 'var(--accent, #3b82f6)'
    : isActive
    ? 'var(--status-running, #3b82f6)'
    : 'var(--border-light)'

  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        width: '100%',
        padding: '12px 14px',
        background: selected
          ? 'var(--accent-subtle, rgba(59,130,246,0.12))'
          : 'var(--bg-card)',
        border: `1px solid ${borderColor}`,
        borderRadius: '8px',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'border-color 0.15s, background 0.15s',
        color: 'var(--text-primary)',
        fontSize: '12px',
      }}
    >
      {/* Row 1: name + status badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontWeight: 700, fontSize: '13px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {workunit.name}
        </span>
        <WUStatusBadge status={workunit.status} />
      </div>

      {/* Row 2: slug */}
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {workunit.slug}
      </div>

      {/* Row 3: pipeline count + timing */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '10px', color: 'var(--text-muted)' }}>
        <span>
          {workunit.pipelines.length} pipeline{workunit.pipelines.length !== 1 ? 's' : ''}
        </span>
        <span>{formatRelativeTime(workunit.startedAt)}</span>
      </div>
    </button>
  )
}

function WUStatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    active:    'var(--status-running, #3b82f6)',
    completed: 'var(--status-done, #22c55e)',
    abandoned: 'var(--status-fail, #ef4444)',
    unknown:   'var(--text-muted)',
  }
  const color = colorMap[status] ?? 'var(--text-muted)'
  return (
    <span style={{
      padding: '1px 7px',
      borderRadius: '10px',
      fontSize: '10px',
      fontWeight: 600,
      background: `${color}18`,
      color,
      border: `1px solid ${color}33`,
      whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// Pipeline accordion row
// ─────────────────────────────────────────────────────────────

function PipelineAccordion({
  pipeline,
  tasksBySlug,
}: {
  pipeline: WUDetailData['pipelines'][number]
  tasksBySlug: Record<string, Task[]>
}) {
  const [open, setOpen] = useState(false)
  const tasks = tasksBySlug[pipeline.slug] ?? []

  const statusColor: Record<string, string> = {
    active:    'var(--status-running, #3b82f6)',
    completed: 'var(--status-done, #22c55e)',
    failed:    'var(--status-fail, #ef4444)',
    unknown:   'var(--text-muted)',
  }
  const pStatus = (pipeline as unknown as Record<string, unknown>).status as string | undefined
  const dotColor = statusColor[pStatus ?? 'unknown'] ?? 'var(--text-muted)'

  return (
    <div style={{
      border: '1px solid var(--border-light)',
      borderRadius: '6px',
      overflow: 'hidden',
    }}>
      {/* Accordion header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          background: open ? 'var(--bg-secondary)' : 'var(--bg-card)',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'var(--text-primary)',
          fontSize: '12px',
          transition: 'background 0.15s',
        }}
      >
        {/* Expand indicator */}
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: '12px', flexShrink: 0 }}>
          {open ? '▼' : '▶'}
        </span>

        {/* Status dot */}
        <span style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
        }} />

        {/* Pipeline slug */}
        <span style={{ flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pipeline.slug}
        </span>

        {/* Type badge */}
        <span style={{
          fontSize: '10px',
          padding: '1px 6px',
          borderRadius: '8px',
          background: 'var(--bg-secondary)',
          color: 'var(--text-muted)',
          border: '1px solid var(--border-light)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}>
          {pipeline.type}
        </span>

        {/* Linked time */}
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {pipeline.linkedAt ? formatRelativeTime(pipeline.linkedAt) : '—'}
        </span>

        {/* Task count chip */}
        {tasks.length > 0 && (
          <span style={{
            fontSize: '10px',
            padding: '1px 6px',
            borderRadius: '8px',
            background: 'var(--accent-subtle, rgba(59,130,246,0.1))',
            color: 'var(--accent)',
            border: '1px solid var(--accent)33',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}>
            {tasks.length} task{tasks.length !== 1 ? 's' : ''}
          </span>
        )}
      </button>

      {/* Accordion body — tasks */}
      {open && (
        <div style={{
          padding: '8px 12px 10px',
          background: 'var(--bg-primary)',
          borderTop: '1px solid var(--border-light)',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}>
          {tasks.length === 0 ? (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>
              No tasks for this pipeline
            </div>
          ) : (
            tasks.map(t => <TaskCard key={t.id} task={t} />)
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Detail panel — Pipelines / Costs / Budget 탭
// ─────────────────────────────────────────────────────────────

function DetailPanel({
  wuSlug,
}: {
  wuSlug: string
}) {
  const [detailTab, setDetailTab] = useState<DetailTab>('pipelines')

  // WU 상세 데이터 (파이프라인 목록, 상태, 타입, 시작시간 포함)
  const { data: detailResponse, isLoading: detailLoading } = usePolling<WUDetailResponse>(
    `/api/workunits/${encodeURIComponent(wuSlug)}`,
    5000
  )

  // API wrapper unwrap — API가 { workunit: {...} } 형태로 반환하므로 unwrap
  const detail = detailResponse?.workunit ?? null

  // Tasks (pipelines 탭 활성 시 3초 폴링)
  const { data: tasksData, isLoading: tasksLoading } = usePolling<WorkUnitTasksResponse>(
    detailTab === 'pipelines' ? `/api/workunits/${encodeURIComponent(wuSlug)}/tasks` : null,
    3000
  )

  // Always-on costs polling for header total display (30s interval, lightweight)
  const { data: costsHeader } = usePolling<WorkUnitCostsResponse>(
    `/api/workunits/${encodeURIComponent(wuSlug)}/costs`,
    30000
  )
  const { data: costs, isLoading: costsLoading } = usePolling<WorkUnitCostsResponse>(
    detailTab === 'costs' ? `/api/workunits/${encodeURIComponent(wuSlug)}/costs` : null,
    5000
  )
  const { data: budget, isLoading: budgetLoading } = usePolling<BudgetStatusResponse>(
    detailTab === 'budget' ? '/api/budget/status' : null,
    10000
  )

  // tasks를 파이프라인 slug 기준 Map으로 변환
  const tasksBySlug = useMemo(() => {
    if (!tasksData) return {} as Record<string, Task[]>
    const map: Record<string, Task[]> = {}
    for (const p of tasksData.pipelines) {
      map[p.slug] = p.tasks
    }
    return map
  }, [tasksData])

  const DETAIL_TABS: { id: DetailTab; label: string }[] = [
    { id: 'pipelines', label: 'Pipelines & Tasks' },
    { id: 'costs',     label: 'Costs' },
    { id: 'budget',    label: 'Budget' },
  ]

  const pipelineCount = detail?.pipelines?.length ?? 0

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* WU detail header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
      }}>
        {/* Name + status */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
          <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {detail?.name ?? wuSlug}
          </span>
          {detail?.status && <WUStatusBadge status={detail.status} />}
        </div>

        {/* Pipeline count */}
        {pipelineCount > 0 && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{pipelineCount}</strong> pipeline{pipelineCount !== 1 ? 's' : ''}
          </span>
        )}

        {/* Start time */}
        {detail?.startedAt && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {formatRelativeTime(detail.startedAt)}
          </span>
        )}

        {/* Total cost */}
        {costsHeader && costsHeader.total_billed_cents > 0 && (
          <span style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            <strong style={{ color: 'var(--text-primary)' }}>${(costsHeader.total_billed_cents / 100).toFixed(4)}</strong>
          </span>
        )}
      </div>

      {/* Detail sub-tabs */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--border)',
        padding: '0 16px',
        background: 'var(--bg-primary)',
        flexShrink: 0,
      }}>
        {DETAIL_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setDetailTab(tab.id)}
            style={{
              padding: '8px 14px',
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${detailTab === tab.id ? 'var(--accent)' : 'transparent'}`,
              color: detailTab === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: '12px',
              fontWeight: detailTab === tab.id ? 600 : 400,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        {/* ── Pipelines & Tasks ── */}
        {detailTab === 'pipelines' && (
          detailLoading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Loading pipelines...</div>
          ) : !detail || detail.pipelines.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center', padding: '24px' }}>
              No pipelines linked to this work unit
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Task summary chips (from tasks API) */}
              {tasksData && tasksData.total_count > 0 && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {Object.entries(tasksData.summary).map(([key, val]) => (
                    <span key={key} style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-light)' }}>
                      {key.replace('_', ' ')}: <strong>{val}</strong>
                    </span>
                  ))}
                </div>
              )}

              {/* Pipeline accordion list */}
              {tasksLoading && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading tasks...</div>
              )}
              {detail.pipelines.map(p => (
                <PipelineAccordion
                  key={p.slug}
                  pipeline={p}
                  tasksBySlug={tasksBySlug}
                />
              ))}
            </div>
          )
        )}

        {/* ── Costs ── */}
        {detailTab === 'costs' && (
          costsLoading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Loading costs...</div>
          ) : !costs ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center', padding: '24px' }}>No cost data</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Total */}
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>
                ${(costs.total_billed_cents / 100).toFixed(4)}
                <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>total</span>
              </div>

              {/* By pipeline */}
              {costs.by_pipeline.length > 0 && (
                <div>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>By Pipeline</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {costs.by_pipeline.map(p => (
                      <CostBar
                        key={p.pipeline_slug}
                        label={p.pipeline_slug}
                        billedCents={p.billed_cents}
                        maxCents={costs.total_billed_cents}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* By agent */}
              {costs.by_agent.length > 0 && (
                <div>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>By Agent</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {costs.by_agent.map((a, i) => (
                      <CostBar
                        key={`${a.agent_slug}-${a.model}-${i}`}
                        label={a.agent_slug}
                        subLabel={a.model}
                        billedCents={a.billed_cents}
                        maxCents={costs.total_billed_cents}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        )}

        {/* ── Budget ── */}
        {detailTab === 'budget' && (
          budgetLoading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Loading budget...</div>
          ) : !budget || budget.statuses.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center', padding: '24px' }}>
              No budget policies configured
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {budget.statuses.map((s, i) => (
                <BudgetProgressBar key={`${s.policy.id}-${i}`} status={s} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}

function EmptyDetailState() {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      gap: '8px',
      color: 'var(--text-muted)',
      fontSize: '13px',
    }}>
      <span style={{ fontSize: '28px', opacity: 0.4 }}>📦</span>
      <span>Select a Work Unit to view details</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────

export function WorkUnitsTab({ pipelineSlug }: { pipelineSlug?: string | null }) {
  const [selectedWU, setSelectedWU] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const { data, error, isLoading } = usePolling<WorkUnitsResponse>('/api/workunits', 3000)

  // Sort: active first, then by startedAt descending
  const sorted = useMemo(() => {
    if (!data?.workunits) return []
    return [...data.workunits].sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1
      if (a.status !== 'active' && b.status === 'active') return 1
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    })
  }, [data])

  // pipeline 필터 (Dashboard에서 내려온 pipelineSlug)
  const byPipeline = useMemo(() => {
    if (!pipelineSlug) return sorted
    return sorted.filter(wu => wu.pipelines.some(p => p.slug === pipelineSlug))
  }, [sorted, pipelineSlug])

  // status 필터
  const filtered = useMemo(() => {
    if (statusFilter === 'all') return byPipeline
    return byPipeline.filter(wu => wu.status === statusFilter)
  }, [byPipeline, statusFilter])

  if (isLoading) {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading work units...</div>
  }
  if (error) {
    return <div style={{ padding: '20px', color: 'var(--status-fail)' }}>Error: {error.message}</div>
  }

  const allWUs = data?.workunits ?? []
  const activeCount = allWUs.filter(w => w.status === 'active').length
  const completedCount = allWUs.filter(w => w.status === 'completed').length

  const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
    { id: 'all',       label: `All (${allWUs.length})` },
    { id: 'active',    label: `Active (${activeCount})` },
    { id: 'completed', label: `Completed (${completedCount})` },
    { id: 'abandoned', label: 'Abandoned' },
  ]

  return (
    <div style={{ height: '100%', display: 'flex', overflow: 'hidden' }}>

      {/* ── Master panel: 280px 고정 좌측 ── */}
      <div style={{
        width: '280px',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-primary)',
        overflow: 'hidden',
      }}>
        {/* Status filter tabs */}
        <div style={{
          display: 'flex',
          borderBottom: '1px solid var(--border)',
          overflowX: 'auto',
          flexShrink: 0,
        }}>
          {STATUS_FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              style={{
                padding: '7px 10px',
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${statusFilter === f.id ? 'var(--accent)' : 'transparent'}`,
                color: statusFilter === f.id ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: '11px',
                fontWeight: statusFilter === f.id ? 600 : 400,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'color 0.15s, border-color 0.15s',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* WU card list */}
        <div style={{ flex: 1, overflow: 'auto', padding: '10px' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
              {pipelineSlug
                ? `No work units for "${pipelineSlug}"`
                : 'No work units found'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {filtered.map(wu => (
                <WUCard
                  key={wu.slug}
                  workunit={wu}
                  selected={selectedWU === wu.slug}
                  onClick={() => setSelectedWU(selectedWU === wu.slug ? null : wu.slug)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer stats */}
        <div style={{
          padding: '8px 12px',
          borderTop: '1px solid var(--border)',
          fontSize: '10px',
          color: 'var(--text-muted)',
          flexShrink: 0,
        }}>
          <span style={{ color: 'var(--status-running)' }}>{activeCount} active</span>
          {' · '}
          <span>{completedCount} completed</span>
          {pipelineSlug && <span> · filtered by pipeline</span>}
        </div>
      </div>

      {/* ── Detail panel: flex-1 우측 ── */}
      {selectedWU ? (
        <DetailPanel wuSlug={selectedWU} />
      ) : (
        <EmptyDetailState />
      )}
    </div>
  )
}
