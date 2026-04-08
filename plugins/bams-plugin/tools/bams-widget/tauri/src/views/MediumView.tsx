/**
 * src/views/MediumView.tsx
 * TASK-012: 팝오버 Medium View — 480x600px
 *
 * 구조:
 *   Header  (← Back / WU 슬러그 / Open in Dashboard 링크)
 *   ──────
 *   Pipelines 섹션 (PipelineAccordion compact, max-height 300px 스크롤)
 *   ──────
 *   Active Agents 섹션 (에이전트명 + 경과 시간)
 *   ──────
 *   Footer  (Open in Dashboard 버튼)
 */

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { fetcher, SWR_KEYS } from '@/lib/api'
import { PipelineAccordion } from '@/components/PipelineAccordion'
import { StatusBadge } from '@/components/StatusBadge'
import type {
  WorkUnit,
  WorkUnitDetailResponse,
  ActiveAgentsResponse,
  PipelineDetail,
  ActiveAgent,
} from '@/lib/types'

// ── 경과 시간 포매터 ─────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s elapsed`
  const mins = Math.floor(secs / 60)
  const s = secs % 60
  return `${mins}m ${s}s elapsed`
}

// ── openUrl 헬퍼 ─────────────────────────────────────────────────

async function openUrl(url: string): Promise<void> {
  const m = await import('@tauri-apps/plugin-opener')
  await m.openUrl(url)
}

// ── Active Agents 섹션 ───────────────────────────────────────────

interface ActiveAgentsSectionProps {
  agents: ActiveAgent[]
}

function ActiveAgentsSection({ agents }: ActiveAgentsSectionProps) {
  // 경과 시간을 1초마다 갱신
  const [, tick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--color-border)',
        flexShrink: 0,
      }}
    >
      <p
        style={{
          fontSize: 10,
          color: 'var(--color-text-muted)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 600,
        }}
      >
        Active Agents
      </p>

      {agents.length === 0 ? (
        <p style={{ fontSize: 11, color: 'var(--color-text-dim)', fontStyle: 'italic' }}>
          No active agents
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {agents.map((agent) => {
            const elapsedMs = Date.now() - new Date(agent.started_at).getTime()

            return (
              <div
                key={agent.call_id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 11,
                }}
              >
                {/* 애니메이션 점 */}
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--color-status-running)',
                    flexShrink: 0,
                    animation: 'pulse 1.5s ease-in-out infinite',
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    color: 'var(--color-text)',
                    fontFamily: 'var(--font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {agent.agent_type}
                </span>
                <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
                  {formatElapsed(elapsedMs)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Pipeline 목록 섹션 ────────────────────────────────────────────

interface PipelinesSectionProps {
  wuSlug: string
}

function PipelinesSection({ wuSlug }: PipelinesSectionProps) {
  const { data, isLoading } = useSWR<WorkUnitDetailResponse & { pipelines?: PipelineDetail[] }>(
    SWR_KEYS.workUnitDetail(wuSlug),
    fetcher,
    { refreshInterval: 15_000 }
  )

  const pipelines = (data as { pipelines?: unknown[] } | undefined)?.pipelines ?? []

  if (isLoading) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-text-muted)',
          fontSize: 12,
        }}
      >
        Loading...
      </div>
    )
  }

  if (pipelines.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-text-dim)',
          fontSize: 12,
          fontStyle: 'italic',
        }}
      >
        No pipelines
      </div>
    )
  }

  return (
    <div
      style={{
        flex: 1,
        overflow: 'auto',
        padding: '12px 16px',
        maxHeight: 300,
      }}
    >
      <p
        style={{
          fontSize: 10,
          color: 'var(--color-text-muted)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 600,
        }}
      >
        Pipelines
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(pipelines as PipelineDetail[]).map((pl) => (
          <PipelineAccordion
            key={pl.slug}
            pipeline={{
              slug: pl.slug,
              type: pl.type,
              status: pl.status,
              command: pl.type,
              startedAt: pl.started_at,
              endedAt: null,
              durationMs: null,
              steps: [],
              agents: [],
              errors: [],
            }}
            compact
          />
        ))}
      </div>
    </div>
  )
}

// ── MediumView 루트 ───────────────────────────────────────────────

interface MediumViewProps {
  wu: WorkUnit
  onBack: () => void
}

export function MediumView({ wu, onBack }: MediumViewProps) {
  const { data: agentsData } = useSWR<ActiveAgentsResponse>(
    SWR_KEYS.workUnitAgentsActive(wu.slug),
    fetcher,
    { refreshInterval: 10_000 }
  )

  const agents: ActiveAgent[] = agentsData?.active_agents ?? []

  const handleOpenDashboard = () => {
    void openUrl(`http://localhost:3333/work/${wu.slug}`)
  }

  return (
    <div
      style={{
        width: 'var(--widget-width-md)',
        height: 'var(--widget-height-md)',
        background: 'var(--color-background)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: 'expandIn 0.2s ease-out',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        {/* Back 버튼 */}
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-accent)',
            cursor: 'pointer',
            fontSize: 12,
            padding: 0,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 3,
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.opacity = '0.7'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.opacity = '1'
          }}
        >
          ← Back
        </button>

        {/* WU 슬러그 */}
        <span
          style={{
            fontWeight: 600,
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--color-text)',
          }}
        >
          {wu.slug}
        </span>

        {/* Status */}
        <StatusBadge status={wu.status} size="xs" />

        {/* Open in Dashboard 아이콘 링크 */}
        <button
          onClick={handleOpenDashboard}
          title="Open in Dashboard"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
            fontSize: 13,
            padding: 0,
            flexShrink: 0,
            lineHeight: 1,
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--color-accent)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)'
          }}
        >
          &#128279;
        </button>
      </div>

      {/* Pipelines 섹션 — flex: 1, max-height 300px 스크롤 */}
      <PipelinesSection wuSlug={wu.slug} />

      {/* Active Agents 섹션 */}
      <ActiveAgentsSection agents={agents} />

      {/* Footer — Open in Dashboard */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--color-border)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={handleOpenDashboard}
          style={{
            width: '100%',
            padding: '7px 0',
            background: 'var(--color-accent)',
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background =
              'var(--color-accent-hover)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent)'
          }}
        >
          Open in Dashboard
        </button>
      </div>
    </div>
  )
}
