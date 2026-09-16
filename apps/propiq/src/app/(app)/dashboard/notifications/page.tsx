import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, Bell, CircleAlert, Info } from 'lucide-react';
import { currentUserId } from '@/server/actions';
import { getNotificationRepository } from '@/server/notifications';
import { deliveryStatus } from '@/server/alert-delivery';
import { DELIVERY_CHANNEL_LABELS } from '@/data/ports';
import type { DeliveryChannel, NotificationRecord } from '@/data/ports';
import { MarkReadButton } from '@/components/propiq/mark-read-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Notifications',
  description: 'Every alert that crossed a published threshold on a property you track.',
  robots: { index: false, follow: false },
};

/**
 * What each channel means when it is not configured. Shown verbatim so the
 * deployment's capability is legible rather than implied by silence.
 */
const CHANNEL_REQUIREMENT: Readonly<Record<DeliveryChannel, string>> = {
  inApp: 'Always on. Needs nothing beyond the database.',
  webhook: 'Set ALERT_WEBHOOK_URL (and ALERT_WEBHOOK_SECRET to sign payloads).',
  email: 'Needs a transactional email provider. Not integrated in this build.',
};

const SEVERITY_STYLE = {
  urgent: { icon: CircleAlert, className: 'text-red-400', label: 'Urgent' },
  attention: { icon: AlertTriangle, className: 'text-amber-400', label: 'Attention' },
  info: { icon: Info, className: 'text-[var(--text-muted)]', label: 'Info' },
} as const;

export default async function NotificationsPage() {
  const userId = await currentUserId();
  if (!userId)
    return (
      <Shell>
        <SignedOut />
      </Shell>
    );

  const repo = getNotificationRepository();
  const [items, unread] = await Promise.all([repo.list(userId), repo.unreadCount(userId)]);
  const channels = deliveryStatus();

  return (
    <Shell action={<MarkReadButton unreadCount={unread} />}>
      <DeliveryChannels channels={channels} />

      {items.length === 0 ? (
        <Empty />
      ) : (
        <ol className="mt-8 space-y-3">
          {items.map((n) => (
            <NotificationRow key={n.id} notification={n} />
          ))}
        </ol>
      )}
    </Shell>
  );
}

const DeliveryChannels = ({
  channels,
}: {
  channels: ReadonlyArray<{ channel: DeliveryChannel; configured: boolean }>;
}) => (
  <section aria-labelledby="channels-heading" className="mt-6">
    <h2 id="channels-heading" className="text-sm font-semibold">
      Where alerts go
    </h2>
    <ul className="mt-3 grid gap-2 sm:grid-cols-3">
      {channels.map(({ channel, configured }) => (
        <li
          key={channel}
          className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">{DELIVERY_CHANNEL_LABELS[channel]}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                configured
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-[var(--surface-2)] text-[var(--text-muted)]'
              }`}
            >
              {configured ? 'Active' : 'Not configured'}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-secondary)]">
            {CHANNEL_REQUIREMENT[channel]}
          </p>
        </li>
      ))}
    </ul>
  </section>
);

const NotificationRow = ({ notification }: { notification: NotificationRecord }) => {
  const style = SEVERITY_STYLE[notification.severity];
  const Icon = style.icon;
  return (
    <li
      className={`rounded-lg border p-4 ${
        notification.readAt
          ? 'border-[var(--border-subtle)] bg-transparent'
          : 'border-[var(--border-strong)] bg-[var(--surface-1)]'
      }`}
    >
      <div className="flex items-start gap-3">
        <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${style.className}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{notification.headline}</p>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">{notification.detail}</p>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
            <span className="sr-only">Severity: </span>
            <span>{style.label}</span>
            <span aria-hidden>·</span>
            <span>
              rule <code className="font-mono">{notification.rule}</code>
            </span>
            {notification.propertyId && (
              <>
                <span aria-hidden>·</span>
                <Link
                  href={`/property/${notification.propertyId}`}
                  className="underline underline-offset-2 hover:text-[var(--text-primary)]"
                >
                  Open property
                </Link>
              </>
            )}
            <span aria-hidden>·</span>
            <time dateTime={notification.createdAt}>
              {new Date(notification.createdAt).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </time>
          </p>
        </div>
        {!notification.readAt && (
          <span className="mt-1 size-2 shrink-0 rounded-full bg-accent-500" aria-label="Unread" />
        )}
      </div>
    </li>
  );
};

const Empty = () => (
  <div className="mt-8 rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
    <Bell aria-hidden className="mx-auto size-5 text-[var(--text-muted)]" />
    <p className="mt-2 text-sm font-medium">No notifications yet</p>
    <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
      A notification is written when a property you watch crosses a published threshold. Nothing has
      crossed one yet, which is a real answer, not an empty screen waiting for data.
    </p>
    <Link
      href="/dashboard/alerts"
      className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-white hover:bg-accent-400"
    >
      Check alerts now
    </Link>
  </div>
);

const SignedOut = () => (
  <div className="mt-6 rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
    <p className="text-sm font-medium">Sign in to see your notifications</p>
    <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
      Notifications are tied to your watchlist, which is private to your account.
    </p>
    <Link
      href="/login"
      className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-white hover:bg-accent-400"
    >
      Sign in
    </Link>
  </div>
);

const Shell = ({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) => (
  <div className="mx-auto max-w-4xl px-4 py-8">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
          The record of every alert that cleared a published threshold. Each one names the rule that
          fired, so you can check the arithmetic rather than take our word for it.
        </p>
      </div>
      {action}
    </div>
    {children}
  </div>
);
