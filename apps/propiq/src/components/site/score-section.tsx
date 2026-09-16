/**
 * The PropIQ Score section.
 *
 * The breakdown is the property's real pillar set with its real published
 * weights, so the bars sum to the score above them. A pillar with no evidence
 * shows "withheld" rather than a zero bar — the engine drops it and rescales
 * the rest, and hiding that would misrepresent how the number was reached.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { ScoreDial } from '@/components/propiq/score-dial';
import { Section, SectionHead, DemoNote } from '@/components/site/section';
import { formatPercent } from '@/lib/utils';
import type { SiteProperty } from '@/site/types';

const barColour = (score: number): string =>
  score >= 72
    ? 'var(--color-buy)'
    : score >= 55
      ? 'var(--color-watch)'
      : score >= 40
        ? 'var(--color-negotiate)'
        : 'var(--color-avoid)';

export const ScoreSection = ({ property }: { property: SiteProperty }) => {
  const withheld = property.breakdown.filter((p) => p.score === undefined).length;

  return (
    <Section tone="deep">
      <SectionHead
        eyebrow="PropIQ Score"
        title="One score. The full property picture."
        standfirst="Twelve pillars, weighted for who is buying, each one expanding into the signals behind it. The formula and the weights are published, so the number can be argued with."
      />

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] lg:gap-14">
        <div className="flex flex-col items-center lg:items-start">
          <ScoreDial
            score={property.propiqScore}
            band={property.scoreBand}
            confidence={property.scoreConfidence}
            size={188}
          />
          <p className="mt-4 text-center text-sm text-[var(--text-secondary)] lg:text-left">
            <span className="font-semibold text-[var(--text-primary)]">{property.name}</span>
            <br />
            {property.locality}, {property.city}
          </p>
          <dl className="mt-5 grid w-full grid-cols-2 gap-4">
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Evidence coverage
              </dt>
              <dd data-figure className="mt-1 text-lg font-semibold">
                {formatPercent(property.coverage * 100, 0)}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Pillars withheld
              </dt>
              <dd data-figure className="mt-1 text-lg font-semibold">
                {withheld}
              </dd>
            </div>
          </dl>
        </div>

        <div>
          <ul className="space-y-3.5">
            {property.breakdown.map((pillar) => (
              <li key={pillar.key}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-[var(--text-secondary)]">{pillar.label}</span>
                  <span className="flex items-baseline gap-2.5">
                    {pillar.weight !== undefined && (
                      <span
                        data-figure
                        className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]"
                      >
                        {(pillar.weight * 100).toFixed(0)}% weight
                      </span>
                    )}
                    <span data-figure className="w-9 text-right font-semibold">
                      {pillar.score === undefined ? '—' : pillar.score.toFixed(0)}
                    </span>
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  {pillar.score !== undefined && (
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${pillar.score}%`,
                        background: barColour(pillar.score),
                      }}
                    />
                  )}
                </div>
                {pillar.score === undefined && (
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Withheld — no evidence. Its weight is redistributed across the rest rather than
                    scored as zero.
                  </p>
                )}
              </li>
            ))}
          </ul>

          <Link
            href="/methodology"
            className="mt-7 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-brand-cyan-400)] hover:underline"
          >
            How PropIQ Score works <ArrowRight aria-hidden className="size-4" />
          </Link>
          <DemoNote>
            This is a live computation over a labelled development dataset, not an illustrative
            mock-up: the bars are the property&rsquo;s actual pillar scores under the published
            v0.1.0 weights, and they reconcile to the score on the left.
          </DemoNote>
        </div>
      </div>
    </Section>
  );
};
