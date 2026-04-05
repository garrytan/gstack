'use client'

import { formatRelativeTime } from '@/lib/utils'

interface CheckoutLockProps {
  lockedAt: string
  agent?: string | null
}

export function CheckoutLock({ lockedAt, agent }: CheckoutLockProps) {
  const title = agent
    ? `Checked out by ${agent} at ${lockedAt}`
    : `Checked out at ${lockedAt}`

  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        padding: '1px 6px',
        borderRadius: '4px',
        fontSize: '10px',
        fontWeight: 500,
        background: 'var(--lock-bg, rgba(234, 179, 8, 0.12))',
        color: 'var(--lock-color, #eab308)',
        border: '1px solid rgba(234, 179, 8, 0.25)',
      }}
    >
      <span style={{ fontSize: '9px' }}>⊘</span>
      locked {formatRelativeTime(lockedAt)}
      {agent && <span style={{ opacity: 0.7 }}>· {agent}</span>}
    </span>
  )
}
