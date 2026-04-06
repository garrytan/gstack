'use client'

import { useState, useRef, useEffect } from 'react'
import { StatusBadge } from '@/components/shared/StatusBadge'
import type { WorkUnit } from '@/lib/types'

interface WorkDetailHeaderProps {
  workunit: WorkUnit
  onBack: () => void
  onAction: (action: 'complete' | 'abandon' | 'delete') => void
}

export function WorkDetailHeader({ workunit, onBack, onAction }: WorkDetailHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [menuOpen])

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      marginBottom: '20px',
    }}>
      <button
        onClick={onBack}
        aria-label="Go back"
        style={{
          background: 'none',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '4px 10px',
          cursor: 'pointer',
          fontSize: '14px',
          color: 'var(--text-secondary)',
          lineHeight: 1,
        }}
      >
        &larr;
      </button>

      <h1 style={{
        fontSize: '18px',
        fontWeight: 700,
        color: 'var(--text-primary)',
        margin: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1,
      }}>
        {workunit.name}
      </h1>

      <StatusBadge status={workunit.status} size="md" />

      {/* Action dropdown */}
      <div ref={menuRef} style={{ position: 'relative' }}>
        <button
          onClick={() => setMenuOpen(prev => !prev)}
          aria-label="Actions"
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            padding: '4px 10px',
            cursor: 'pointer',
            fontSize: '16px',
            color: 'var(--text-secondary)',
            lineHeight: 1,
          }}
        >
          ...
        </button>
        {menuOpen && (
          <div style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: '4px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '4px 0',
            minWidth: '140px',
            zIndex: 100,
            boxShadow: '0 4px 12px var(--shadow)',
          }}>
            {workunit.status === 'active' && (
              <MenuButton
                label="Complete"
                color="var(--status-done)"
                onClick={() => { onAction('complete'); setMenuOpen(false) }}
              />
            )}
            {workunit.status === 'active' && (
              <MenuButton
                label="Abandon"
                color="var(--status-fail)"
                onClick={() => { onAction('abandon'); setMenuOpen(false) }}
              />
            )}
            <MenuButton
              label="Delete"
              color="var(--status-fail)"
              onClick={() => { onAction('delete'); setMenuOpen(false) }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function MenuButton({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        padding: '6px 14px',
        background: 'none',
        border: 'none',
        textAlign: 'left',
        fontSize: '12px',
        color,
        cursor: 'pointer',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-hover, var(--bg-secondary))'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background = 'none'
      }}
    >
      {label}
    </button>
  )
}
