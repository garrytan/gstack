/**
 * EmptyState.tsx — bams-viz에서 이식 (compact 변형)
 * - 'use client' 제거
 * - next/* 의존성 없음
 * - CSS custom properties: --color-* (위젯 globals.css 기준)
 * - compact: padding/font 축소 (팝오버 공간 절약)
 */

interface EmptyStateProps {
  icon?: string
  title: string
  description?: string
  /** compact: 팝오버용 소형 (기본값 true) */
  compact?: boolean
}

export function EmptyState({
  icon = '📭',
  title,
  description,
  compact = true,
}: EmptyStateProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: compact ? '24px 16px' : '60px 20px',
      color: 'var(--color-text-muted)',
      textAlign: 'center',
      gap: compact ? '6px' : '8px',
    }}>
      <div style={{
        fontSize: compact ? '28px' : '48px',
        lineHeight: 1,
        marginBottom: compact ? '4px' : '8px',
      }}>
        {icon}
      </div>
      <div style={{
        fontSize: compact ? '12px' : '16px',
        fontWeight: 600,
        color: 'var(--color-text)',
      }}>
        {title}
      </div>
      {description && (
        <div style={{
          fontSize: compact ? '10px' : '13px',
          maxWidth: compact ? '240px' : '400px',
          color: 'var(--color-text-muted)',
          lineHeight: 1.5,
        }}>
          {description}
        </div>
      )}
    </div>
  )
}
