import type { Metadata } from 'next';
import Link from 'next/link';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { evaluateAlerts } from '@/domain/alerts/engine';
import { ALERT_THRESHOLDS } from '@/domain/alerts/types';
import type { Alert } from '@/domain/alerts/types';
import { buildPropertyIntelligence } from '@/server/intelligence';
import type { PropertyIntelligence } from '@/server/intelligence';
import { currentUserId } from '@/server/actions';
import { getWatchlistRepository } from '@/server/watchlist';
import { getSnapshotStore, toSnapshot } from '@/server/snapshots';
import { buildDigest } from '@/domain/alerts/digest';
import { getNotificationRepository } from '@/server/notifications';
import { getPropertyRepository } from '@/data';
import { DemoDataBanner } from '@/components/propiq/data-status';
import { AlertList } from '@/components/propiq/alert-list';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Alerts',
  description: 'Material changes on the properties you track.',
  robots: { index: false, follow: false },
};

export default async function AlertsPage() {
  const repo = getPropertyRepository();
  const userId = await currentUserId();

  if (!userId) {
    return (
      <Shell>
        <SignedOut />
      </Shell>
    );
  }

  const entries = await getWatchlistRepository().list(userId);
  const now = new Date().toISOString();
  const store = getSnapshotStore();

  // Each watched property is re-scored, diffed against its last snapshot, and
  // the new snapshot stored. On first sight there is no baseline, so there is
  // nothing to report — which is correct, not a gap.
  const alerts: Alert[] = [];
  let baselinesCreated = 0;

  for (const entry of entries) {
    const intel: PropertyIntelligence | undefined = await buildPropertyIntelligence(
      asId<PropertyId>(entry.propertyId),
      { now, includeAlternatives: false },
    );
    if (!intel) continue;

    const current = toSnapshot(intel);
    const previous = await store.latest(userId, entry.propertyId);
    if (previous) {
      alerts.push(...evaluateAlerts(previous, current, now));
    } else {
      baselinesCreated += 1;
    }
    await store.put(userId, current);
  }

  // Record what fired to the inbox. Opening this page is the only evaluation
  // that happens without a scheduler, so without this write the product would
  // forget a change the moment you navigated away. The store's idempotency key
  // makes a refresh harmless.
  if (alerts.length > 0) {
    const digest = buildDigest(alerts, now);
    await getNotificationRepository().add(
      userId,
      digest.alerts.map((a) => ({
        propertyId: asId<PropertyId>(a.propertyId),
        kind: a.kind,
        severity: a.severity,
        headline: `${a.label}: ${a.headline}`,
        detail: `${a.detail} (${a.before} → ${a.after})`,
        rule: a.rule,
      })),
    );
  }

  return (
    <Shell>
      {repo.servesDemoData && <DemoDataBanner className="mb-6" />}

      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
          <p className="text-sm font-medium">Nothing to watch yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
            Alerts fire on properties you save. Add one to your watchlist and PropIQ will tell you
            when its price, possession date, RERA status, risk band or verdict actually moves.
          </p>
          <Link
            href="/search"
            className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-ink-950 hover:bg-accent-400"
          >
            Find properties
          </Link>
        </div>
      ) : (
        <>
          <AlertList
            alerts={alerts}
            watchedCount={entries.length}
            baselinesCreated={baselinesCreated}
          />
          <Thresholds />
          <p className="mt-6 text-xs text-[var(--text-secondary)]">
            Everything that fires here is also written to your{' '}
            <Link
              href="/dashboard/notifications"
              className="underline underline-offset-2 hover:text-[var(--text-primary)]"
            >
              notifications inbox
            </Link>
            , which is where you can see which delivery channels this deployment has configured.
          </p>
        </>
      )}
    </Shell>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="mx-auto max-w-4xl px-4 py-8">
    <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
    <p className="mb-6 mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
      Every watched property is re-scored when you open this page and compared against what we last
      saw. Only changes that clear a published threshold are shown — an alert that fires on noise
      teaches you to ignore alerts.
    </p>
    {children}
  </div>
);

const SignedOut = () => (
  <div className="rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
    <p className="text-sm font-medium">Sign in to get alerts</p>
    <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
      Alerts are tied to your watchlist, which is private to your account.
    </p>
    <Link
      href="/login"
      className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-ink-950 hover:bg-accent-400"
    >
      Sign in
    </Link>
  </div>
);

const Thresholds = () => (
  <section className="mt-10">
    <h2 className="text-sm font-semibold">What counts as material</h2>
    <p className="mt-1 text-xs text-[var(--text-muted)]">
      These are the published thresholds. Anything smaller is inside the noise and is not sent.
    </p>
    <table className="mt-3 w-full border-collapse text-sm">
      <caption className="sr-only">Published alert thresholds</caption>
      <tbody>
        <Row label="Asking price change" value={`${ALERT_THRESHOLDS.priceChangePercent}%`} />
        <Row label="Fair value move" value={`${ALERT_THRESHOLDS.fairValueChangePercent}%`} />
        <Row label="PropIQ Score move" value={`${ALERT_THRESHOLDS.scorePoints} points`} />
        <Row label="Possession slip" value={`${ALERT_THRESHOLDS.possessionSlipDays} days`} />
        <Row
          label="Evidence gone stale"
          value={`${ALERT_THRESHOLDS.stalePercentage}% of records`}
        />
        <Row label="Verdict, RERA status, risk band" value="any change" />
      </tbody>
    </table>
  </section>
);

const Row = ({ label, value }: { label: string; value: string }) => (
  <tr className="border-b border-[var(--border-subtle)]">
    <th scope="row" className="py-1.5 pr-4 text-left text-xs font-medium">
      {label}
    </th>
    <td data-figure className="py-1.5 text-right text-xs font-semibold">
      {value}
    </td>
  </tr>
);
