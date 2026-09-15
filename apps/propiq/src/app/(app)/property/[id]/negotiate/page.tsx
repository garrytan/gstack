import { notFound } from 'next/navigation';
import { cache } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { buildPropertyIntelligence } from '@/server/intelligence';
import { currentUserId, loadNegotiation } from '@/server/actions';
import { NegotiationTracker } from '@/components/propiq/negotiation-tracker';
import { StartNegotiationForm } from '@/components/propiq/start-negotiation-form';
import { TrackView } from '@/components/propiq/track-view';
import { formatINR } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const loadProperty = cache(async (id: string) =>
  buildPropertyIntelligence(asId<PropertyId>(id), { includeAlternatives: false }),
);

export const generateMetadata = async ({ params }: Params): Promise<Metadata> => {
  const { id } = await params;
  const intel = await loadProperty(id);
  if (!intel) notFound();
  return {
    title: `Negotiation — ${intel.property.title}`,
    robots: { index: false, follow: false },
  };
};

export default async function NegotiatePage({ params }: Params) {
  const { id } = await params;
  const intel = await loadProperty(id);
  if (!intel) notFound();

  const userId = await currentUserId();
  const negotiation = userId ? await loadNegotiation(id) : undefined;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <TrackView
        event="offer_created"
        properties={{ propertyId: id, started: Boolean(negotiation) }}
      />

      <nav aria-label="Breadcrumb" className="mb-4 text-xs text-[var(--text-muted)]">
        <Link href={`/property/${id}`} className="hover:underline">
          ← {intel.property.title}
        </Link>
      </nav>

      <h1 className="text-2xl font-semibold tracking-tight">Negotiation</h1>
      <p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">
        The sequence is what people lose track of: what was asked, what was offered, what came back,
        and what the walk-away number was before the room talked them out of it. Write both numbers
        down now, while you are calm.
      </p>

      {!userId ? (
        <SignedOut />
      ) : negotiation ? (
        <div className="mt-6">
          <NegotiationTracker negotiation={negotiation} />
        </div>
      ) : (
        <div className="mt-6">
          <StartNegotiationForm
            propertyId={id}
            askingPrice={intel.property.askingPrice}
            fairValueMid={intel.valuation.insufficientEvidence ? undefined : intel.valuation.mid}
            suggestedTarget={intel.negotiation?.targetPrice}
            suggestedWalkAway={intel.negotiation?.walkAwayPrice}
          />
          {intel.negotiation && (
            <p className="mt-4 text-xs text-[var(--text-muted)]">
              PropIQ suggests opening at {formatINR(intel.negotiation.openingOffer)}, targeting{' '}
              {formatINR(intel.negotiation.targetPrice)} and walking away above{' '}
              {formatINR(intel.negotiation.walkAwayPrice)} — derived from the comparable set, not
              from the asking price. Override any of them; they are your numbers.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const SignedOut = () => (
  <div className="mt-6 rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
    <p className="text-sm font-medium">Sign in to track a negotiation</p>
    <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
      What you offered and what they said is private to your account.
    </p>
    <Link
      href="/login"
      className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-ink-950 hover:bg-accent-400"
    >
      Sign in
    </Link>
  </div>
);
