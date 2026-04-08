/**
 * components/Header.tsx
 * TASK-011: BAMS Widget 팝오버 헤더
 * - 제목 "BAMS Widget" + 설정 아이콘(⚙)
 * - compact 팝오버(320px)에 최적화
 */

interface HeaderProps {
  title?: string
  onSettingsClick?: () => void
}

export function Header({ title = 'BAMS Widget', onSettingsClick }: HeaderProps) {
  return (
    <div
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      <span
        style={{
          fontWeight: 600,
          fontSize: 13,
          color: 'var(--color-text)',
          letterSpacing: '-0.01em',
        }}
      >
        {title}
      </span>
      <button
        onClick={onSettingsClick}
        aria-label="Settings"
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-text-muted)',
          cursor: onSettingsClick ? 'pointer' : 'default',
          fontSize: 14,
          padding: '2px 4px',
          borderRadius: 4,
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onMouseEnter={e => {
          if (onSettingsClick) {
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text)'
          }
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-muted)'
        }}
      >
        ⚙
      </button>
    </div>
  )
}
