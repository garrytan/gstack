'use client'

interface DepsPillsProps {
  deps: string[]
}

export function DepsPills({ deps }: DepsPillsProps) {
  if (deps.length === 0) return null

  return (
    <span style={{ display: 'inline-flex', gap: '3px', flexWrap: 'wrap' }}>
      {deps.map((dep) => (
        <span
          key={dep}
          title={`Depends on: ${dep}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '3px',
            padding: '1px 6px',
            borderRadius: '4px',
            fontSize: '10px',
            fontWeight: 500,
            lineHeight: '16px',
            background: 'var(--deps-bg, rgba(148, 163, 184, 0.12))',
            color: 'var(--text-muted)',
            border: '1px solid var(--border-light, rgba(148, 163, 184, 0.2))',
          }}
        >
          <span style={{ fontSize: '9px', opacity: 0.7 }}>↑</span>
          {dep}
        </span>
      ))}
    </span>
  )
}
