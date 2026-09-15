import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'About',
  description: 'What PropIQ is for, and what it refuses to do.',
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">About PropIQ</h1>
      <p className="mt-4 text-base leading-relaxed text-[var(--text-secondary)]">
        PropIQ is a property decision intelligence platform, built by CiteRank AI. It is not a
        listings portal. The question it answers is not &ldquo;what is available&rdquo; but
        &ldquo;should I buy this one, at this price, and what should I argue about&rdquo;.
      </p>

      <h2 className="mt-8 text-lg font-semibold tracking-tight">The position</h2>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
        Indian residential buying runs on asymmetry. The developer knows the carpet ratio, the delay
        record, the unsold inventory and the real clearing price. The buyer gets a brochure. PropIQ
        exists to close that gap with evidence rather than opinion: every number carries a source, a
        date and a confidence, and when the evidence runs out the product says so instead of filling
        the space.
      </p>

      <h2 className="mt-8 text-lg font-semibold tracking-tight">Three commitments</h2>
      <ul className="mt-3 space-y-3 text-sm leading-relaxed text-[var(--text-secondary)]">
        <li>
          <strong className="text-[var(--text-primary)]">No invented facts.</strong> A missing field
          reads as unknown. The scoring engine excludes it and rescales the remaining weights, so a
          gap in the record never masquerades as a bad measurement.
        </li>
        <li>
          <strong className="text-[var(--text-primary)]">No black-box scoring.</strong> The weights,
          the normalisation functions and the decision thresholds are{' '}
          <Link href="/methodology" className="text-accent-500 hover:underline">
            published
          </Link>
          , and read directly from the running code so they cannot drift from what produced your
          score.
        </li>
        <li>
          <strong className="text-[var(--text-primary)]">No paid verdicts.</strong> Commercial
          relationships are disclosed on every property and computed in a system the scoring engine
          cannot read.
        </li>
      </ul>

      <h2 className="mt-8 text-lg font-semibold tracking-tight">Coverage</h2>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
        The architecture scales nationally. The data deliberately does not, yet. Dense, trustworthy
        coverage of one market beats thin coverage of a hundred, and a measurement product that
        overclaims its coverage has already lost the argument it exists to win.
      </p>

      <h2 className="mt-8 text-lg font-semibold tracking-tight">What this is not</h2>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
        PropIQ produces decision support. It is not investment advice, not legal advice, and not a
        title certification. Document analysis, when it ships, will flag what looks wrong in a deed
        — it will not replace a lawyer reading it.
      </p>
    </div>
  );
}
