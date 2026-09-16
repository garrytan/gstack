import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  CURRENT_SCORING_VERSION,
  SCORING_VERSIONS,
  getScoringVersion,
} from '@/domain/scoring/weights';
import { PILLAR_LABELS, SCORE_PILLARS } from '@/domain/scoring/types';
import { BUYER_PERSONAS } from '@/domain/buyer/types';
import { JsonLd, definedTerm } from '@/lib/structured-data';

/**
 * A frozen, citable permalink per scoring version.
 *
 * /methodology always shows the current formula, which is what a buyer wants.
 * A citation wants the opposite: a URL whose content does not change, so that
 * a score published under v0.1.0 stays explainable after v0.2.0 ships. Since
 * a scoring version is never mutated once released, every one of these is
 * permanently stable by construction.
 */

// The whole segment is dynamic — Next does not support a partial one like
// `v[version]`, which it reads as a literal folder name. So the "v" prefix
// travels inside the param and is stripped here: /methodology/v0.1.0.
export const generateStaticParams = () =>
  SCORING_VERSIONS.map((v) => ({ version: `v${v.version}` }));

const parse = (raw: string): string => (raw.startsWith('v') ? raw.slice(1) : raw);

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ version: string }>;
}): Promise<Metadata> => {
  const { version } = await params;
  const scoring = getScoringVersion(parse(version));
  if (!scoring) return {};
  return {
    title: `PropIQ Score v${scoring.version} — frozen methodology`,
    description:
      `The pillar weights and reporting floors for PropIQ scoring version ${scoring.version}, ` +
      'frozen for citation. Scoring versions are never mutated once released.',
    alternates: { canonical: `/methodology/v${scoring.version}` },
  };
};

export default async function FrozenMethodologyPage({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  const v = getScoringVersion(parse(version));
  if (!v) notFound();

  const superseded = v.version !== CURRENT_SCORING_VERSION.version;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <JsonLd
        data={definedTerm({
          name: 'PropIQ Score',
          description:
            'A 0 to 100 composite property score over twelve pillars, weighted by buyer persona, ' +
            'with missing signals dropped and remaining weights rescaled, reported with a 95% ' +
            'confidence band. Produced by deterministic arithmetic, never by a language model.',
          path: `/methodology/v${v.version}`,
          version: v.version,
        })}
      />

      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-accent)]">
        Frozen for citation
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        PropIQ Score, version {v.version}
      </h1>
      <p className="mt-3 max-w-2xl text-[var(--text-secondary)]">{v.summary}</p>

      <dl className="mt-6 grid gap-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-5 sm:grid-cols-3">
        <Fact label="Effective from" value={v.effectiveFrom} />
        <Fact
          label="Reporting floor — coverage"
          value={`${(v.minimumCoverage * 100).toFixed(0)}%`}
        />
        <Fact
          label="Reporting floor — confidence"
          value={`${(v.minimumConfidence * 100).toFixed(0)}%`}
        />
      </dl>

      <p className="mt-5 rounded-lg border-l-4 border-[var(--border-strong)] bg-[var(--surface-1)] px-4 py-3 text-sm text-[var(--text-secondary)]">
        {superseded ? (
          <>
            This version has been superseded by v{CURRENT_SCORING_VERSION.version}. It is kept
            unchanged so that scores published under it stay explainable.{' '}
            <Link href="/methodology" className="text-[var(--text-accent)] hover:underline">
              The current methodology
            </Link>{' '}
            is what new scores use.
          </>
        ) : (
          <>
            This is the current version. It is reproduced here at a stable URL so a citation does
            not break when the next version ships.{' '}
            <Link href="/methodology" className="text-[var(--text-accent)] hover:underline">
              The full methodology
            </Link>{' '}
            covers normalisation, evidence decay, valuation and decision rules.
          </>
        )}
      </p>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">Pillar weights</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Weights sum to 1 within each persona. Signals with no evidence are dropped and the
          remaining weights rescaled, so a missing input never scores as a zero.
        </p>
        <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <caption className="sr-only">
              PropIQ pillar weights by buyer persona, version {v.version}
            </caption>
            <thead>
              <tr className="bg-[var(--surface-1)]">
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium">
                  Pillar
                </th>
                {BUYER_PERSONAS.map((p) => (
                  <th key={p} scope="col" className="px-4 py-2 text-right text-xs font-medium">
                    {p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SCORE_PILLARS.map((pillar) => (
                <tr key={pillar} className="border-t border-[var(--border-subtle)]">
                  <th scope="row" className="px-4 py-2 text-left text-sm font-medium">
                    {PILLAR_LABELS[pillar]}
                  </th>
                  {BUYER_PERSONAS.map((persona) => (
                    <td
                      key={persona}
                      data-figure
                      className="px-4 py-2 text-right text-sm text-[var(--text-secondary)]"
                    >
                      {(v.weights[persona][pillar] * 100).toFixed(0)}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      {label}
    </dt>
    <dd data-figure className="mt-1 text-lg font-semibold">
      {value}
    </dd>
  </div>
);
