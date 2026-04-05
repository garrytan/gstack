'use client'

interface TagChipsProps {
  tags: string[]
}

// 태그 문자열에서 결정론적 색상 계산
function tagColor(tag: string): string {
  const COLORS = [
    'var(--tag-1, #60a5fa)',
    'var(--tag-2, #a78bfa)',
    'var(--tag-3, #34d399)',
    'var(--tag-4, #f472b6)',
    'var(--tag-5, #fb923c)',
    'var(--tag-6, #facc15)',
  ]
  let hash = 0
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) & 0xffff
  }
  return COLORS[hash % COLORS.length]
}

export function TagChips({ tags }: TagChipsProps) {
  if (tags.length === 0) return null

  return (
    <span style={{ display: 'inline-flex', gap: '3px', flexWrap: 'wrap' }}>
      {tags.map((tag) => {
        const color = tagColor(tag)
        return (
          <span
            key={tag}
            title={`Tag: ${tag}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '1px 6px',
              borderRadius: '10px',
              fontSize: '10px',
              fontWeight: 500,
              lineHeight: '16px',
              background: `${color}18`,
              color,
              border: `1px solid ${color}33`,
            }}
          >
            #{tag}
          </span>
        )
      })}
    </span>
  )
}
