/**
 * Section furniture.
 *
 * One eyebrow/heading/standfirst treatment for the whole page, so the
 * vertical rhythm and type scale are set once rather than re-guessed in
 * nineteen places.
 */

/**
 * Four grounds, not one.
 *
 * `base` is the page's own teal; `deep` drops below it and `raise` lifts above
 * it. Alternating them down the page is what stops nineteen sections reading
 * as a single undifferentiated column — the previous `tint` differed from its
 * neighbour by about two percent of lightness, which is to say not at all.
 */
const TONE_CLASS: Readonly<Record<'base' | 'deep' | 'raise' | 'dark', string>> = {
  base: '',
  deep: 'propiq-band-deep',
  raise: 'propiq-band-raise',
  dark: 'propiq-dark',
};

export const Section = ({
  id,
  tone = 'base',
  className,
  children,
}: {
  id?: string;
  tone?: 'base' | 'deep' | 'raise' | 'dark';
  className?: string;
  children: React.ReactNode;
}) => (
  <section
    id={id}
    /* The header is sticky, so an anchor jump would otherwise drop the section
       heading underneath it. */
    style={id === undefined ? undefined : { scrollMarginTop: '4.5rem' }}
    className={['propiq-seam', TONE_CLASS[tone], className ?? ''].filter(Boolean).join(' ')}
  >
    <div className="mx-auto max-w-7xl px-4 py-20 sm:py-24">{children}</div>
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
      <p className="propiq-eyebrow-pill text-[11px] font-semibold uppercase tracking-[0.16em]">
        {eyebrow}
      </p>
      <h2 className="propiq-display mt-4 text-[2.15rem] font-bold leading-[1.06] sm:text-[2.9rem]">
        {title}
      </h2>
      {standfirst && (
        <p className="mt-4 text-[17px] leading-relaxed text-[var(--text-secondary)]">
          {standfirst}
        </p>
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
        Figures on this section are computed by the live scoring engine over a labelled development
        dataset. Locality names are real Bengaluru localities; every figure attached to them is
        synthetic.
      </>
    )}
  </p>
);
