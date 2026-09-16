import { CircleSlash, HandCoins, ShieldAlert, ThumbsUp, Eye } from 'lucide-react';
import type { Decision } from '@/domain/decision/engine';
import { DECISION_LABELS } from '@/domain/decision/engine';
import { cn } from '@/lib/utils';

const META: Readonly<Record<Decision, { color: string; icon: typeof ThumbsUp }>> = {
  BUY: { color: 'var(--color-buy)', icon: ThumbsUp },
  NEGOTIATE: { color: 'var(--color-negotiate)', icon: HandCoins },
  WATCH: { color: 'var(--color-watch)', icon: Eye },
  AVOID: { color: 'var(--color-avoid)', icon: ShieldAlert },
  INSUFFICIENT_EVIDENCE: { color: 'var(--color-unknown)', icon: CircleSlash },
};

export const DecisionBadge = ({
  decision,
  confidence,
  size = 'md',
  className,
}: {
  decision: Decision;
  confidence?: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) => {
  const meta = META[decision];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-md border font-semibold uppercase tracking-wide',
        size === 'sm' && 'px-2 py-1 text-[10px]',
        size === 'md' && 'px-3 py-1.5 text-xs',
        size === 'lg' && 'px-4 py-2 text-sm',
        className,
      )}
      style={{
        color: meta.color,
        borderColor: meta.color,
        background: `color-mix(in srgb, ${meta.color} 7%, transparent)`,
      }}
    >
      <Icon aria-hidden className={size === 'lg' ? 'size-4' : 'size-3'} />
      {DECISION_LABELS[decision]}
      {/* `opacity-80` dragged this figure to 3.22:1 against the badge tint. The
          secondary token is already a tested value on this surface. */}
      {confidence !== undefined && (
        <span data-figure className="font-normal text-[var(--text-secondary)]">
          {Math.round(confidence * 100)}%
        </span>
      )}
    </span>
  );
};
