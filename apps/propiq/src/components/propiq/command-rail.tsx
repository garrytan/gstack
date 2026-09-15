/**
 * The command rail.
 *
 * A status board for the covered market: how the verdicts fall, how complete
 * the evidence is, and what moved. Every figure is computed from the same
 * scoring pass that produced the cards below it, so the rail can never
 * disagree with the rest of the page.
 *
 * Nothing here is a vanity metric. Coverage and the insufficient-evidence
 * count are the two numbers a measurement product should be judged on, so
 * they are shown as prominently as the good news.
 */

import Link from 'next/link';
import type { PropertyIntelligence } from '@/server/intelligence';
import type { Decision } from '@/domain/decision/engine';
import { DECISION_LABELS } from '@/domain/decision/engine';
import { formatINR, formatPercent } from '@/lib/utils';

const ORDER: readonly Decision[] = ['BUY', 'NEGOTIATE', 'WATCH', 'AVOID', 'INSUFFICIENT_EVIDENCE'];

const COLOR: Readonly<Record<Decision, string>> = {
  BUY: 'var(--color-buy)',
  NEGOTIATE: 'var(--color-negotiate)',
  WATCH: 'var(--color-watch)',
  AVOID: 'var(--color-avoid)',
  INSUFFICIENT_EVIDENCE: 'var(--color-unknown)',
};

export const CommandRail = ({
  intelligence,
}: {
  intelligence: readonly PropertyIntelligence[];
}) => {
  const total = intelligence.length;

  const counts = ORDER.map((decision) => ({
    decision,
    count: intelligence.filter((i) => i.decision.decision === decision).length,
  }));

  const scored = intelligence.filter((i) => i.score.score !== undefined);
  const meanScore =
    scored.length === 0
      ? undefined
      : scored.reduce((a, i) => a + (i.score.score ?? 0), 0) / scored.length;
  const meanCoverage =
    total === 0 ? 0 : intelligence.reduce((a, i) => a + i.score.coverage, 0) / total;

  // The most underpriced property we can actually value — the one thing on this
  // panel a buyer would act on today.
  const bestValue = intelligence
    .filter((i) => !i.valuation.insufficientEvidence)
    .reduce<PropertyIntelligence | undefined>(
      (best, i) =>
        i.valuation.askingDeviationPercent < (best?.valuation.askingDeviationPercent ?? Infinity)
          ? i
          : best,
      undefined,
    );

  const materialRisks = intelligence.reduce((a, i) => a + i.risk.materialRisks.length, 0);

  return (
    <aside
      aria-label="Market status"
      className="flex flex-col gap-5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-5"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="propiq-live-dot size-1.5 rounded-full bg-accent-400" />
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
          Covered market
        </h2>
      </div>

      {/* Verdict distribution — the shape of the market in one read. */}
      <div>
        <div className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
          {counts
            .filter((c) => c.count > 0)
            .map((c) => (
              <span
                key={c.decision}
                className="block h-full"
                style={{ width: `${(c.count / total) * 100}%`, background: COLOR[c.decision] }}
              />
            ))}
        </div>
        <ul className="mt-3 flex flex-col gap-1.5">
          {counts
            .filter((c) => c.count > 0)
            .map((c) => (
              <li key={c.decision} className="flex items-center gap-2 text-xs">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: COLOR[c.decision] }}
                />
                <span className="text-[var(--text-secondary)]">{DECISION_LABELS[c.decision]}</span>
                <span data-figure className="ml-auto font-semibold">
                  {c.count}
                </span>
              </li>
            ))}
        </ul>
      </div>

      <dl className="grid grid-cols-2 gap-4 border-t border-[var(--border-subtle)] pt-4">
        <Stat label="Properties scored" value={String(total)} />
        <Stat
          label="Mean score"
          value={meanScore === undefined ? '—' : String(Math.round(meanScore))}
        />
        <Stat label="Mean coverage" value={formatPercent(meanCoverage * 100, 0)} />
        <Stat label="Material risks" value={String(materialRisks)} />
      </dl>

      {bestValue && (
        <div className="border-t border-[var(--border-subtle)] pt-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
            Widest gap to fair value
          </p>
          <Link
            href={`/property/${bestValue.property.id}`}
            className="mt-1.5 block text-sm font-medium hover:underline"
          >
            {bestValue.property.title}
          </Link>
          <p data-figure className="mt-1 text-xs text-[var(--text-secondary)]">
            {formatINR(bestValue.property.askingPrice)} ·{' '}
            <span
              style={{
                color:
                  bestValue.valuation.askingDeviationPercent < 0
                    ? 'var(--color-buy)'
                    : 'var(--color-avoid)',
              }}
            >
              {formatPercent(Math.abs(bestValue.valuation.askingDeviationPercent), 1)}{' '}
              {bestValue.valuation.askingDeviationPercent < 0 ? 'under' : 'over'}
            </span>{' '}
            our estimate
          </p>
        </div>
      )}

      <p className="border-t border-[var(--border-subtle)] pt-4 text-[11px] leading-relaxed text-[var(--text-muted)]">
        Every figure here is computed live from the same scoring pass behind the properties below.
        Coverage is shown because a measurement product should be judged on what it could not
        measure, not only on what it could.
      </p>
    </aside>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
    <dd data-figure className="mt-0.5 text-xl font-semibold leading-none">
      {value}
    </dd>
  </div>
);
