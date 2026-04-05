'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import React from 'react'
import { usePolling } from '@/hooks/usePolling'
import { GanttTab } from '@/components/tabs/GanttTab'
import { DagTab } from '@/components/tabs/DagTab'
import { OrgTab } from '@/components/tabs/OrgTab'
import { AgentsTab } from '@/components/tabs/AgentsTab'
import { TimelineTab } from '@/components/tabs/TimelineTab'
import { LogsTab } from '@/components/tabs/LogsTab'
import { MetaverseTab } from '@/components/tabs/MetaverseTab'
import { HRTab } from '@/components/tabs/HRTab'
import { WorkUnitsTab } from '@/components/tabs/WorkUnitsTab'
import type { WorkUnit } from '@/lib/types'

const TABS = [
  { id: 'workunits', label: 'Work Units', icon: '📦' },
  { id: 'agents', label: 'Agents', icon: '🤖' },
  { id: 'metaverse', label: 'Metaverse', icon: '🌐' },
  { id: 'dag', label: 'DAG', icon: '🔀' },
  { id: 'gantt', label: 'Gantt', icon: '📊' },
  { id: 'org', label: 'Org', icon: '🏢' },
  { id: 'timeline', label: 'Timeline', icon: '📅' },
  { id: 'logs', label: 'Logs', icon: '📋' },
  { id: 'hr', label: 'HR', icon: '👤' },
] as const

type TabId = (typeof TABS)[number]['id']

interface PipelineListItem {
  slug: string
  type: string
  status: string
}

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<TabId>('workunits')
  const [selectedPipeline, setSelectedPipeline] = useState<string | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [logHighlightTs, setLogHighlightTs] = useState<string | null>(null)

  // Poll pipeline list + connection status (unified)
  const { data: pipelines, isValidating, error: connError } = usePolling<PipelineListItem[]>('/api/pipelines', 3000)

  // Track if user has interacted with selector
  const [userSelected, setUserSelected] = useState(false)

  // Work Unit selector
  const [selectedWorkUnit, setSelectedWorkUnit] = useState<string | null>(null)
  const [workUnitUserSelected, setWorkUnitUserSelected] = useState(false)

  // Poll Work Unit list
  const { data: workUnitsData } = usePolling<{ workunits: WorkUnit[] }>('/api/workunits', 5000)

  // Auto-select first pipeline only on initial load
  useEffect(() => {
    if (pipelines && pipelines.length > 0 && !selectedPipeline && !userSelected) {
      setSelectedPipeline(pipelines[0].slug)
    }
  }, [pipelines, selectedPipeline, userSelected])

  // Theme persistence
  useEffect(() => {
    const saved = localStorage.getItem('bams-viz-theme')
    if (saved === 'light' || saved === 'dark') setTheme(saved)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('bams-viz-theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }, [])

  // Work Unit 선택 시 pipeline selector 필터링
  const filteredPipelines = useMemo(() => {
    if (!selectedWorkUnit || !workUnitsData) return pipelines ?? []
    const wu = workUnitsData.workunits.find(w => w.slug === selectedWorkUnit)
    if (!wu) return pipelines ?? []
    const wuPipelineSlugs = new Set(wu.pipelines.map(p => p.slug))
    return (pipelines ?? []).filter(p => wuPipelineSlugs.has(p.slug))
  }, [selectedWorkUnit, workUnitsData, pipelines])

  // Cross-tab navigation: Timeline -> Logs
  const handleNavigateToLogs = useCallback((timestamp?: string) => {
    setActiveTab('logs')
    if (timestamp) setLogHighlightTs(timestamp)
  }, [])

  const connectionStatus = connError ? 'disconnected' : isValidating ? 'connecting' : 'connected'

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--bg-secondary)',
      color: 'var(--text-primary)',
    }}>
      {/* Header */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '0 20px',
        height: '50px',
        background: 'var(--bg-primary)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px' }}>📡</span>
          <span style={{ fontWeight: 700, fontSize: '15px' }}>bams-viz</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 500 }}>v2.0</span>
        </div>

        {/* Work Unit selector */}
        <select
          value={selectedWorkUnit || ''}
          onChange={e => {
            setWorkUnitUserSelected(true)
            setSelectedWorkUnit(e.target.value || null)
            // WU 변경 시 pipeline 선택 초기화
            setSelectedPipeline(null)
            setUserSelected(false)
          }}
          style={{
            padding: '5px 10px',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            fontSize: '12px',
            minWidth: '160px',
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          <option value="">All Work Units</option>
          {workUnitsData?.workunits.map(wu => (
            <option key={wu.slug} value={wu.slug}>
              {wu.name} ({wu.status})
            </option>
          ))}
        </select>

        {/* Separator */}
        <span style={{ color: 'var(--border)', fontSize: '16px', lineHeight: 1, userSelect: 'none' }}>|</span>

        {/* Pipeline selector — filtered by WU if selected */}
        <select
          value={selectedPipeline || ''}
          onChange={e => { setUserSelected(true); setSelectedPipeline(e.target.value || null) }}
          style={{
            padding: '5px 10px',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            fontSize: '12px',
            minWidth: '200px',
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          <option value="">
            {selectedWorkUnit ? 'All in WU' : 'All pipelines (전체)'}
          </option>
          {filteredPipelines.map(p => (
            <option key={p.slug} value={p.slug}>
              {p.slug} ({p.status})
            </option>
          ))}
        </select>

        {/* Summary chips (WU 선택 시) */}
        {selectedWorkUnit && workUnitsData && (() => {
          const wu = workUnitsData.workunits.find(w => w.slug === selectedWorkUnit)
          if (!wu) return null
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
              <span style={{
                padding: '2px 8px',
                borderRadius: '10px',
                fontSize: '10px',
                fontWeight: 600,
                background: wu.status === 'active' ? 'rgba(59,130,246,0.15)' : 'rgba(34,197,94,0.12)',
                color: wu.status === 'active' ? 'var(--status-running, #3b82f6)' : 'var(--status-done, #22c55e)',
                border: `1px solid ${wu.status === 'active' ? 'rgba(59,130,246,0.3)' : 'rgba(34,197,94,0.25)'}`,
              }}>
                {wu.pipelines.length} pipelines
              </span>
            </div>
          )
        })()}

        <div style={{ flex: 1 }} />

        {/* Connection status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
          <span style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: connectionStatus === 'connected' ? 'var(--status-done)'
              : connectionStatus === 'connecting' ? 'var(--status-running)'
              : 'var(--status-fail)',
          }} />
          <span style={{ color: 'var(--text-muted)' }}>
            {connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
          </span>
        </div>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            padding: '4px 8px',
            cursor: 'pointer',
            fontSize: '14px',
            lineHeight: 1,
          }}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      {/* Tab bar */}
      <nav style={{
        display: 'flex',
        gap: '0',
        padding: '0 20px',
        background: 'var(--bg-primary)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        overflowX: 'auto',
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '10px 16px',
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${activeTab === tab.id ? 'var(--accent)' : 'transparent'}`,
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: '12px',
              fontWeight: activeTab === tab.id ? 600 : 400,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            <span style={{ fontSize: '13px' }}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Main content */}
      <main style={{ flex: 1, overflow: 'hidden' }}>
        <TabErrorBoundary key={activeTab}>
          {activeTab === 'workunits' && <WorkUnitsTab pipelineSlug={selectedPipeline} />}
          {activeTab === 'dag' && <DagTab pipelineSlug={selectedPipeline} />}
          {activeTab === 'gantt' && <GanttTab pipelineSlug={selectedPipeline} />}
          {activeTab === 'org' && <OrgTab />}
          {activeTab === 'agents' && <AgentsTab pipelineSlug={selectedPipeline} />}
          {activeTab === 'timeline' && <TimelineTab pipelineSlug={selectedPipeline} onNavigateToLogs={handleNavigateToLogs} />}
          {activeTab === 'logs' && <LogsTab pipelineSlug={selectedPipeline} highlightTimestamp={logHighlightTs} />}
          {activeTab === 'metaverse' && <MetaverseTab pipelineSlug={selectedPipeline} />}
          {activeTab === 'hr' && <HRTab />}
        </TabErrorBoundary>
      </main>

      {/* Footer */}
      <footer style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        height: '35px',
        background: 'var(--bg-primary)',
        borderTop: '1px solid var(--border)',
        fontSize: '11px',
        color: 'var(--text-muted)',
        flexShrink: 0,
      }}>
        <span>
          {selectedWorkUnit && `WU: ${selectedWorkUnit} | `}
          Pipeline: {selectedPipeline || 'none'}
          {filteredPipelines && ` | ${filteredPipelines.length} pipeline(s)`}
        </span>
        <LastUpdateTime />
      </footer>
    </div>
  )
}

function LastUpdateTime() {
  const [time, setTime] = useState('')
  useEffect(() => {
    const update = () => setTime(new Date().toLocaleTimeString('ko-KR', { hour12: false }))
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])
  return <span>Last update: {time || '--:--:--'}</span>
}

// Error boundary for individual tabs

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class TabErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Tab error:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
        }}>
          <div style={{ fontSize: '24px', marginBottom: '12px' }}>⚠</div>
          <div style={{ fontWeight: 600, marginBottom: '8px' }}>Something went wrong</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
            {this.state.error?.message || 'Unknown error'}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '6px 16px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
