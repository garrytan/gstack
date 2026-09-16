import type { Metadata } from 'next';
import Link from 'next/link';
import { getPropertyRepository } from '@/data';
import { buildPropertyIntelligence } from '@/server/intelligence';
import type { PropertyIntelligence } from '@/server/intelligence';
import { DemoDataBanner } from '@/components/propiq/data-status';
import { InvestmentPanel } from '@/components/propiq/investment-panel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Investment analysis',
  description:
    'Yield, cash flow, IRR and scenario returns, computed by deterministic arithmetic with the assumptions on show.',
  alternates: { canonical: '/investment' },
};

export default async function InvestmentPage({
  searchParams,
}: {
  searchParams: Promise<{ property?: string }>;
}) {
  const { property } = await searchParams;
  const repo = getPropertyRepository();
  const id = property && /^[a-zA-Z0-9_-]+$/.test(property) ? property : undefined;

  let intel: PropertyIntelligence | undefined;
  if (id) {
    intel = await buildPropertyIntelligence(id as never);
  } else {
    const { items } = await repo.search({ pageSize: 1, sort: 'priceAsc' });
    if (items[0]) intel = await buildPropertyIntelligence(items[0].id);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      {repo.servesDemoData && <DemoDataBanner className="mb-6" />}

      <h1 className="text-3xl font-semibold tracking-tight">Investment analysis</h1>
      <p className="mt-3 text-base text-[var(--text-secondary)]">
        Every figure here is arithmetic, not a forecast, and no language model is anywhere near it.
        The loan amortises month by month on a reducing balance, tax follows a simplified Section 24
        model, and IRR is solved by bisection over the levered cash-flow series — returning nothing
        rather than a number when the series has no root.
      </p>

      {intel ? (
        <>
          <p className="mt-6 text-sm text-[var(--text-secondary)]">
            Worked example —{' '}
            <Link
              href={`/property/${intel.property.id}`}
              className="text-[var(--text-accent)] hover:underline"
            >
              {intel.property.title}
            </Link>
          </p>
          <div className="mt-3">
            <InvestmentPanel analysis={intel.investment} />
          </div>
        </>
      ) : (
        <p className="mt-6 text-sm text-[var(--text-muted)]">
          No property is available to analyse in this environment.
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">What the model does not know</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-[var(--text-secondary)]">
          <li>
            Your actual loan offer. Rate and tenure are assumptions until you have a sanction
            letter.
          </li>
          <li>
            What the unit will really rent for. Rent is an estimate for the unit type, not a signed
            lease.
          </li>
          <li>
            Your tax position. The Section 24 treatment here is simplified and is not tax advice.
          </li>
          <li>
            Future appreciation. That is why the scenario table varies it rather than asserting it.
          </li>
        </ul>
      </section>
    </div>
  );
}
