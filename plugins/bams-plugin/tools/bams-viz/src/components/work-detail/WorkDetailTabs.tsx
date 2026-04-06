'use client'

import type { DetailTab } from '@/lib/types'

const TABS: { id: DetailTab; label: string }[] = [
  { id: 'pipelines', label: 'Pipelines' },
  { id: 'agents', label: 'Agents' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'dag', label: 'DAG' },
  { id: 'logs', label: 'Logs' },
  { id: 'retro', label: 'Retro' },
  { id: 'metaverse', label: 'Metaverse' },
]

interface WorkDetailTabsProps {
  activeTab: DetailTab
  onTabChange: (tab: DetailTab) => void
}

export function WorkDetailTabs({ activeTab, onTabChange }: WorkDetailTabsProps) {
  return (
    <nav style={{
      display: 'flex',
      gap: 0,
      borderBottom: '1px solid var(--border)',
      marginBottom: '16px',
    }}>
      {TABS.map(tab => {
        const isActive = activeTab === tab.id
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
              color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: '12px',
              fontWeight: isActive ? 600 : 400,
              cursor: 'pointer',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {tab.label}
          </button>
        )
      })}
    </nav>
  )
}
