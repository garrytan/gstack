/**
 * The verdict.
 *
 * Three columns because the engine produces three lists: what supports the
 * call, what works against it, and what it could not establish. The third
 * column is the one most products drop, and it is the one that makes the
 * other two trustworthy.
 */

import Link from 'next/link';
import { ArrowRight, CircleHelp, TriangleAlert, Check } from 'lucide-react';
import { DECISION_LABELS } from '@/domain/decision/engine';
import { Section, SectionHead, DemoNote } from '@/components/site/section';
import { formatINR, formatPercent } from '@/lib/utils';
import type { SiteProperty } from '@/site/types';

export const VerdictSection = ({ property }: { property: SiteProperty }) => (
  <Section tone="tint">
    <SectionHead
      eyebrow="Explainable verdict"
      title="Every call, with its reasons attached."
      standfirst="The engine reaches one of five verdicts and names the rule that produced it. Nothing here is a language model's opinion — a model is only ever used to put the arithmetic into a sentence."
    />

    <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
          Verdict
        </p>
        <p className="propiq-brand-text mt-2 text-3xl font-bold tracking-tight">
          {DECISION_LABELS[property.decision]}
        </p>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">
          {property.verdictHeadline}
        </p>

        <dl className="mt-6 grid grid-cols-2 gap-5">
          <Fact label="Confidence" value={formatPercent(property.verdictConfidence * 100, 0)} />
          <Fact label="Risk band" value={property.riskBand} />
          <Fact
            label="Asking"
            value={formatINR(property.price)}
          />
          <Fact
            label="Fair value"
            value={
              property.fairValueMid === undefined ? 'Not valued' : formatINR(property.fairValueMid)
            }
          />
        </dl>

        <Link
          href={`/property/${property.slug}`}
          className="mt-7 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-brand-blue-500)] hover:underline"
        >
          Open the full workup <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Column
          icon={Check}
          tone="var(--color-buy)"
          title="Why it ranks where it does"
          items={property.strengths}
          empty="Nothing cleared the reporting bar."
        />
        <Column
          icon={TriangleAlert}
          tone="var(--color-negotiate)"
          title="What could go wrong"
          items={property.watchItems}
          empty="No material concerns in the evidence."
        />
        <Column
          icon={CircleHelp}
          tone="var(--text-muted)"
          title="What we could not establish"
          items={property.unknowns}
          empty="No material gaps in the evidence."
        />
      </div>
    </div>

    <DemoNote />
  </Section>
);

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      {label}
    </dt>
    <dd data-figure className="mt-1 text-base font-semibold capitalize">
      {value}
    </dd>
  </div>
);

const Column = ({
  icon: Icon,
  tone,
  title,
  items,
  empty,
}: {
  icon: typeof Check;
  tone: string;
  title: string;
  items: readonly string[];
  empty: string;
}) => (
  <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-4">
    <div className="flex items-center gap-2">
      <Icon aria-hidden className="size-4" style={{ color: tone }} />
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </h3>
    </div>
    {items.length === 0 ? (
      <p className="mt-3 text-xs text-[var(--text-muted)]">{empty}</p>
    ) : (
      <ul className="mt-3 space-y-2.5">
        {items.slice(0, 5).map((item) => (
          <li key={item} className="text-xs leading-relaxed text-[var(--text-secondary)]">
            {item}
          </li>
        ))}
      </ul>
    )}
  </div>
);
