/**
 * Section furniture.
 *
 * One eyebrow/heading/standfirst treatment for the whole page, so the
 * vertical rhythm and type scale are set once rather than re-guessed in
 * nineteen places.
 */

export const Section = ({
  id,
  tone = 'light',
  className,
  children,
}: {
  id?: string;
  tone?: 'light' | 'dark' | 'tint';
  className?: string;
  children: React.ReactNode;
}) => (
  <section
    id={id}
    className={[
      tone === 'dark' ? 'propiq-dark' : '',
      tone === 'tint' ? 'bg-[var(--surface-1)]' : '',
      'border-t border-[var(--border-subtle)]',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')}
  >
    <div className="mx-auto max-w-7xl px-4 py-16 sm:py-20">{children}</div>
  </section>
);

export const SectionHead = ({
  eyebrow,
  title,
  standfirst,
  action,
}: {
  eyebrow: string;
  title: string;
  standfirst?: string;
  action?: React.ReactNode;
}) => (
  <div className="flex flex-wrap items-end justify-between gap-6">
    <div className="max-w-2xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--text-accent)]">
        {eyebrow}
      </p>
      <h2 className="mt-3 text-[1.75rem] font-bold leading-tight tracking-tight sm:text-4xl">
        {title}
      </h2>
      {standfirst && (
        <p className="mt-3 text-base leading-relaxed text-[var(--text-secondary)]">{standfirst}</p>
      )}
    </div>
    {action}
  </div>
);

/**
 * The demo-data note.
 *
 * Shown wherever a section renders figures off the fixture dataset. Quieter
 * than the application's full banner because the page carries one prominent
 * banner already, but never absent from a section that shows numbers.
 */
export const DemoNote = ({ children }: { children?: React.ReactNode }) => (
  <p className="mt-4 text-[11px] leading-relaxed text-[var(--text-muted)]">
    {children ?? (
      <>
        Figures on this section are computed by the live scoring engine over a labelled
        development dataset. Locality names are real Bengaluru localities; every figure attached
        to them is synthetic.
      </>
    )}
  </p>
);
