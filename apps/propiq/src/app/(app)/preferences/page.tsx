import type { Metadata } from 'next';
import Link from 'next/link';
import { getPropertyRepository } from '@/data';
import { loadBuyerProfile } from '@/server/actions';
import { PreferencesForm } from '@/components/propiq/preferences-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your preferences',
  description:
    'Tell PropIQ how you buy, and every score is weighted for you rather than for an average.',
  robots: { index: false, follow: true },
};

export default async function PreferencesPage() {
  const [profile, localities] = await Promise.all([
    loadBuyerProfile(),
    getPropertyRepository().listLocalities(),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Your preferences</h1>
      <p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">
        A score weighted for an average buyer is a score for nobody. Tell PropIQ how you are
        actually buying and the pillar weights, the buyer-fit signals and the verdict all change
        with it. Nothing here filters properties out — it changes how they are judged.
      </p>

      <div className="mt-8">
        <PreferencesForm profile={profile} localities={localities} />
      </div>

      <p className="mt-8 text-xs text-[var(--text-muted)]">
        Curious what these weights do?{' '}
        <Link href="/methodology" className="text-[var(--text-accent)] hover:underline">
          The methodology page
        </Link>{' '}
        publishes the exact weight each pillar carries for each buyer type.
      </p>
    </div>
  );
}
