/**
 * hooks/useTheme.ts
 * TASK-014: 다크모드 hook
 *
 * - prefers-color-scheme 시스템 감지
 * - 수동 토글(dark/light/system) 지원
 * - localStorage에 사용자 선택 영속
 * - data-theme 속성을 document.documentElement에 반영
 */

import { useState, useEffect } from 'react'

export type ThemeMode = 'dark' | 'light' | 'system'

const STORAGE_KEY = 'bams-widget-theme'

function getSystemTheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(resolved: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', resolved)
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light' || stored === 'system') {
      return stored
    }
    return 'system'
  })

  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark') return 'dark'
    if (stored === 'light') return 'light'
    return getSystemTheme()
  })

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')

    function update() {
      const resolved = mode === 'system' ? getSystemTheme() : mode
      setResolvedTheme(resolved)
      applyTheme(resolved)
    }

    update()

    // system 모드일 때만 OS 변경 감지
    if (mode === 'system') {
      mq.addEventListener('change', update)
      return () => mq.removeEventListener('change', update)
    }
  }, [mode])

  function setMode(newMode: ThemeMode) {
    localStorage.setItem(STORAGE_KEY, newMode)
    setModeState(newMode)
  }

  function toggleTheme() {
    // dark ↔ light 토글 (system 모드 해제)
    const next = resolvedTheme === 'dark' ? 'light' : 'dark'
    setMode(next)
  }

  return { mode, resolvedTheme, setMode, toggleTheme }
}
