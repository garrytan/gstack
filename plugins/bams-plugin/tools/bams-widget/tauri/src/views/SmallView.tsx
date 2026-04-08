/**
 * src/views/SmallView.tsx
 * TASK-011: 팝오버 Small View — 320x400px
 * TASK-014: onSettings 콜백 추가 (Header ⚙ 클릭 → SettingsView 전환)
 *
 * 구조:
 *   Header  (BAMS Widget + 설정 아이콘)
 *   ──────
 *   Content (스크롤 가능)
 *     Active Work Units — WorkCard compact 목록
 *     Recent           — 최근 완료 WU 3개 (RecentItem 한줄 요약)
 *   ──────
 *   Footer  (Open Dashboard 버튼 + 포트 표시)
 *
 * 서버 Offline → EmptyState 표시
 * WU 카드 클릭 → onSelectWU(wu) 콜백으로 MediumView 전환
 */

import useSWR from 'swr'
import { fetcher, SWR_KEYS } from '@/lib/api'
import { WorkCard } from '@/components/WorkCard'
import { EmptyState } from '@/components/EmptyState'
import { Header } from '@/components/Header'
import { RecentItem } from '@/components/RecentItem'
import type { WorkUnit, WorkUnitsResponse } from '@/lib/types'

interface SmallViewProps {
  /** WU 카드 클릭 시 MediumView로 전환하는 콜백 */
  onSelectWU: (wu: WorkUnit) => void
  /** Header ⚙ 클릭 시 SettingsView로 전환하는 콜백 (TASK-014) */
  onSettings?: () => void
}

export function SmallView({ onSelectWU, onSettings }: SmallViewProps) {
  const { data, error, isLoading } = useSWR<WorkUnitsResponse>(
    SWR_KEYS.workUnits,
    fetcher,
    { refreshInterval: 10_000 }
  )

  const activeWUs = data?.workunits.filter((wu) => wu.status === 'active') ?? []
  const recentWUs = data?.workunits
    .filter((wu) => wu.status === 'completed' || wu.status === 'paused')
    .slice(0, 3) ?? []

  const handleOpenDashboard = () => {
    void import('@tauri-apps/plugin-opener').then((m) =>
      m.openUrl('http://localhost:3333')
    )
  }

  return (
    <div
      style={{
        width: 'var(--widget-width-sm)',
        height: 'var(--widget-height-sm)',
        background: 'var(--color-background)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header — ⚙ 클릭 시 onSettings 호출 */}
      <Header onSettingsClick={onSettings} />

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '12px 16px',
        }}
      >
        {/* 서버 Offline */}
        {error && (
          <EmptyState
            icon="⚡"
            title="Server Offline"
            description="bams-server :3099 에 연결할 수 없습니다"
          />
        )}

        {/* 로딩 */}
        {isLoading && !error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--color-text-muted)',
              fontSize: 12,
            }}
          >
            Loading...
          </div>
        )}

        {/* 데이터 로드 완료 */}
        {!isLoading && !error && (
          <>
            {/* Active Work Units 섹션 */}
            <div style={{ marginBottom: 16 }}>
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
                Active ({activeWUs.length})
              </p>

              {activeWUs.length === 0 ? (
                <p
                  style={{
                    fontSize: 11,
                    color: 'var(--color-text-dim)',
                    fontStyle: 'italic',
                    padding: '4px 0',
                  }}
                >
                  No active work units
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {activeWUs.map((wu) => (
                    <WorkCard
                      key={wu.id}
                      workunit={wu}
                      onClick={() => onSelectWU(wu)}
                      compact
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Recent 섹션 — 최근 완료 WU 3개 */}
            {recentWUs.length > 0 && (
              <div>
                <p
                  style={{
                    fontSize: 10,
                    color: 'var(--color-text-muted)',
                    marginBottom: 4,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    fontWeight: 600,
                  }}
                >
                  Recent
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {recentWUs.map((wu) => (
                    <RecentItem key={wu.id} workunit={wu} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <button
          onClick={handleOpenDashboard}
          style={{
            fontSize: 11,
            color: 'var(--color-accent)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            fontWeight: 500,
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.textDecoration = 'underline'
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.textDecoration = 'none'
          }}
        >
          Open Dashboard
        </button>
        <span style={{ fontSize: 10, color: 'var(--color-text-dim)' }}>
          :3099
        </span>
      </div>
    </div>
  )
}
