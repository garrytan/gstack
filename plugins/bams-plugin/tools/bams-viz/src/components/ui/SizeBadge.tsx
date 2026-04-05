'use client'

type Size = 'XS' | 'S' | 'M' | 'L' | 'XL'

const SIZE_COLOR: Record<Size, string> = {
  XS: 'var(--text-muted)',
  S:  'var(--size-s, #60a5fa)',
  M:  'var(--size-m, #a78bfa)',
  L:  'var(--size-l, #f472b6)',
  XL: 'var(--size-xl, #fb7185)',
}

export function SizeBadge({ size }: { size: Size }) {
  const color = SIZE_COLOR[size] ?? 'var(--text-muted)'
  return (
    <span
      title={`Size: ${size}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 5px',
        borderRadius: '4px',
        fontSize: '10px',
        fontWeight: 600,
        lineHeight: '16px',
        background: `${color}18`,
        color,
        border: `1px solid ${color}33`,
        flexShrink: 0,
      }}
    >
      {size}
    </span>
  )
}
