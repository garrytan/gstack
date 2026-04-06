'use client'

const FILTERS = ['all', 'active', 'completed', 'abandoned'] as const

interface StatusFilterProps {
  value: string
  onChange: (v: string) => void
}

export function StatusFilter({ value, onChange }: StatusFilterProps) {
  return (
    <div style={{
      display: 'flex',
      gap: '6px',
      marginBottom: '16px',
    }}>
      {FILTERS.map(f => {
        const isActive = value === f
        return (
          <button
            key={f}
            onClick={() => onChange(f)}
            style={{
              padding: '5px 14px',
              borderRadius: '6px',
              border: '1px solid',
              borderColor: isActive ? 'var(--accent)' : 'var(--border)',
              background: isActive ? 'var(--accent)' : 'var(--bg-secondary)',
              color: isActive ? '#fff' : 'var(--text-secondary)',
              fontSize: '12px',
              fontWeight: isActive ? 600 : 400,
              cursor: 'pointer',
              textTransform: 'capitalize',
              transition: 'all 0.15s',
            }}
          >
            {f === 'all' ? 'All' : f}
          </button>
        )
      })}
    </div>
  )
}
