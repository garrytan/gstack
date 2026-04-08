/**
 * views/SettingsView.tsx
 * TASK-014: 설정 UI
 *
 * - 글로벌 단축키 표시 (Cmd+Shift+B)
 * - 다크모드 토글 (system / dark / light)
 * - 자동시작 토글 (tauri-plugin-autostart)
 */

import { useState, useEffect } from 'react'
// invoke removed — not used in current implementation
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart'
import type { ThemeMode } from '@/hooks/useTheme'

interface SettingsViewProps {
  onBack: () => void
  themeMode: ThemeMode
  onSetTheme: (mode: ThemeMode) => void
}

export function SettingsView({ onBack, themeMode, onSetTheme }: SettingsViewProps) {
  const [autostartEnabled, setAutostartEnabled] = useState(false)
  const [autostartLoading, setAutostartLoading] = useState(true)

  // 자동시작 현재 상태 조회
  useEffect(() => {
    isEnabled()
      .then(enabled => {
        setAutostartEnabled(enabled)
      })
      .catch(err => {
        console.error('[SettingsView] autostart isEnabled error:', err)
      })
      .finally(() => {
        setAutostartLoading(false)
      })
  }, [])

  async function handleAutostartToggle() {
    const next = !autostartEnabled
    try {
      if (next) {
        await enable()
      } else {
        await disable()
      }
      setAutostartEnabled(next)
    } catch (err) {
      console.error('[SettingsView] autostart toggle error:', err)
    }
  }

  const themeCycle: ThemeMode[] = ['system', 'dark', 'light']
  const themeLabels: Record<ThemeMode, string> = {
    system: '시스템',
    dark: '다크',
    light: '라이트',
  }

  function handleThemeCycle() {
    const currentIdx = themeCycle.indexOf(themeMode)
    const nextIdx = (currentIdx + 1) % themeCycle.length
    onSetTheme(themeCycle[nextIdx])
  }

  return (
    <div
      style={{
        width: 'var(--widget-width-sm)',
        minHeight: 'var(--widget-height-sm)',
        background: 'var(--color-background)',
        display: 'flex',
        flexDirection: 'column',
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
        <button
          onClick={onBack}
          aria-label="뒤로"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-accent)',
            cursor: 'pointer',
            fontSize: 13,
            padding: '2px 4px',
            borderRadius: 4,
            lineHeight: 1,
          }}
        >
          ← 뒤로
        </button>
        <span
          style={{
            fontWeight: 600,
            fontSize: 13,
            color: 'var(--color-text)',
            flex: 1,
          }}
        >
          설정
        </span>
      </div>

      {/* Settings List */}
      <div style={{ padding: '8px 0', flex: 1 }}>

        {/* Section: 일반 */}
        <div
          style={{
            padding: '6px 16px 4px',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          일반
        </div>

        {/* 글로벌 단축키 */}
        <SettingsRow
          label="팝오버 토글"
          description="전역 단축키"
          action={
            <kbd
              style={{
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border)',
                borderRadius: 4,
                padding: '2px 6px',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-muted)',
                letterSpacing: '0.02em',
              }}
            >
              ⌘⇧B
            </kbd>
          }
        />

        {/* 자동시작 */}
        <SettingsRow
          label="로그인 시 자동 시작"
          description="macOS 시작 시 자동 실행"
          action={
            <Toggle
              enabled={autostartEnabled}
              disabled={autostartLoading}
              onToggle={handleAutostartToggle}
            />
          }
        />

        {/* Section: 외관 */}
        <div
          style={{
            padding: '12px 16px 4px',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          외관
        </div>

        {/* 다크모드 */}
        <SettingsRow
          label="테마"
          description={`현재: ${themeLabels[themeMode]}`}
          action={
            <button
              onClick={handleThemeCycle}
              style={{
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 12,
                color: 'var(--color-text)',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}
            >
              {themeLabels[themeMode]}
            </button>
          }
        />
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--color-border)',
          fontSize: 11,
          color: 'var(--color-text-dim)',
          textAlign: 'center',
        }}
      >
        BAMS Widget v1.0.0
      </div>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────

function SettingsRow({
  label,
  description,
  action,
}: {
  label: string
  description?: string
  action: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        gap: 8,
      }}
    >
      <div>
        <div style={{ fontSize: 13, color: 'var(--color-text)' }}>{label}</div>
        {description && (
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
            {description}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{action}</div>
    </div>
  )
}

function Toggle({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={disabled ? undefined : onToggle}
      aria-pressed={enabled}
      aria-disabled={disabled}
      style={{
        width: 38,
        height: 22,
        borderRadius: 11,
        border: 'none',
        background: enabled ? 'var(--color-accent)' : 'var(--color-surface-3)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.2s',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: enabled ? 18 : 2,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#ffffff',
          transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }}
      />
    </button>
  )
}
