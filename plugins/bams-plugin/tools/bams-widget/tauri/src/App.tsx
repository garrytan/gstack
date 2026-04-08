/**
 * src/App.tsx
 * BAMS Widget — 팝오버 루트 컴포넌트
 *
 * 뷰 상태:
 * - { type: 'small' } — SmallView (기본, WU 목록)
 * - { type: 'medium', wu } — MediumView (WU 상세)
 * - { type: 'settings' } — SettingsView (설정, TASK-014)
 *
 * TASK-011: SmallView 분리 완료
 * TASK-012: MediumView 분리 완료 — 창 크기 전환 포함
 * TASK-014: SettingsView + useTheme 추가
 */

import { useState, useCallback } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { SmallView } from '@/views/SmallView'
import { MediumView } from '@/views/MediumView'
import { SettingsView } from '@/views/SettingsView'
import { useTheme } from '@/hooks/useTheme'
import type { WorkUnit } from '@/lib/types'

// ── 뷰 상태 타입 ─────────────────────────────────────────────────

type ViewState =
  | { type: 'small' }
  | { type: 'medium'; wu: WorkUnit }
  | { type: 'settings' }

// ── 창 크기 상수 ─────────────────────────────────────────────────

const SMALL_SIZE = { width: 320, height: 400 }
const MEDIUM_SIZE = { width: 480, height: 600 }

// ── Root App ────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<ViewState>({ type: 'small' })
  const { mode, setMode } = useTheme()

  const handleSelectWU = useCallback((wu: WorkUnit) => {
    setView({ type: 'medium', wu })
    void getCurrentWindow().setSize(
      new LogicalSize(MEDIUM_SIZE.width, MEDIUM_SIZE.height)
    )
  }, [])

  const handleBack = useCallback(() => {
    setView({ type: 'small' })
    void getCurrentWindow().setSize(
      new LogicalSize(SMALL_SIZE.width, SMALL_SIZE.height)
    )
  }, [])

  if (view.type === 'settings') {
    return (
      <SettingsView
        onBack={handleBack}
        themeMode={mode}
        onSetTheme={setMode}
      />
    )
  }

  if (view.type === 'medium') {
    return (
      <MediumView
        wu={view.wu}
        onBack={handleBack}
      />
    )
  }

  return (
    <SmallView
      onSelectWU={handleSelectWU}
      onSettings={() => setView({ type: 'settings' })}
    />
  )
}
