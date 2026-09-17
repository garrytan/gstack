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
import { ChevronRight } from 'lucide-react';
import { ConstellationTable, ScoreConstellation } from '@/components/site/score-constellation';
import { Section, SectionHead, DemoNote } from '@/components/site/section';
import type { SiteProperty } from '@/site/types';

export const ScoreSection = ({ property }: { property: SiteProperty }) => {
  const withheld = property.breakdown.filter((p) => p.score === undefined).length;

  return (
    <Section tone="deep">
      <SectionHead
        eyebrow="PropIQ Score"
        title="One score. The full property picture."
        standfirst="Twelve pillars, weighted for who is buying, each one expanding into the signals behind it. The formula and the weights are published, so the number can be argued with."
      />

      <div className="mt-12">
        <ScoreConstellation
          score={property.propiqScore}
          band={property.scoreBand}
          confidence={property.scoreConfidence}
          coverage={property.coverage}
          breakdown={property.breakdown}
          propertyName={property.name}
          locality={`${property.locality}, ${property.city}`}
        />

        {/* Always rendered, never a fallback. The diagram is the argument; the
            table is what a keyboard, a screen reader, a printout and anyone
            who just wants the numbers all get. */}
        <details className="group mt-10">
          <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            <ChevronRight
              aria-hidden
              className="size-4 transition-transform group-open:rotate-90"
            />
            All {property.breakdown.length} pillars as a table
          </summary>
          <ConstellationTable breakdown={property.breakdown} className="mt-4" />
        </details>

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link
            href="/methodology"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-accent)] hover:underline"
          >
            How PropIQ Score works <ArrowRight aria-hidden className="size-4" />
          </Link>
          <p className="text-[13px] text-[var(--text-muted)]">
            Withheld pillars: {withheld}. Their weight is redistributed, never scored as zero.
          </p>
        </div>

        <DemoNote>
          This is a live computation over a labelled development dataset, not an illustrative
          mock-up: the pillar scores are the property&rsquo;s actual values under the published
          v0.1.0 weights, and they reconcile to the composite at the centre.
        </DemoNote>
      </div>
    </Section>
  );
};
