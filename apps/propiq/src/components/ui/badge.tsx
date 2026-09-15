import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
  {
    variants: {
      tone: {
        neutral: 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-secondary)]',
        accent: 'border-accent-600 bg-accent-600/15 text-accent-400',
        buy: 'border-[var(--color-buy)] bg-[var(--color-buy)]/15 text-[var(--color-buy)]',
        negotiate:
          'border-[var(--color-negotiate)] bg-[var(--color-negotiate)]/15 text-[var(--color-negotiate)]',
        watch: 'border-[var(--color-watch)] bg-[var(--color-watch)]/15 text-[var(--color-watch)]',
        avoid: 'border-[var(--color-avoid)] bg-[var(--color-avoid)]/15 text-[var(--color-avoid)]',
        warn: 'border-[var(--color-negotiate)] bg-[var(--color-negotiate)]/20 text-[var(--color-negotiate)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export const Badge = ({ className, tone, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ tone }), className)} {...props} />
);
