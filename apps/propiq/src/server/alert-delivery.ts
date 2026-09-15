/**
 * Alert delivery.
 *
 * Evaluation says what changed. This says where that goes. Three channels,
 * each of which reports its own configuration state rather than failing
 * silently or pretending to have sent something:
 *
 *  - `inApp`   always available; writes to the notification inbox.
 *  - `webhook` available when `ALERT_WEBHOOK_URL` is set; signed when
 *              `ALERT_WEBHOOK_SECRET` is also set.
 *  - `email`   has no provider in this build. It returns `notConfigured` with
 *              the integration requirement, which is the honest answer, not a
 *              stub that logs to the console and claims success.
 *
 * Delivery never mutates an alert and never produces one. It moves what the
 * deterministic engines already decided.
 */

import 'server-only';
import { createHmac } from 'node:crypto';
import type { UserId } from '@/domain/shared/types';
import type { AlertDigest } from '@/domain/alerts/digest';
import type { AlertNotifier, DeliveryReceipt, NewNotification } from '@/data/ports';
import { getServerEnv } from '@/lib/env';
import { getNotificationRepository } from '@/server/notifications';

/** A webhook that has not answered in this long is not going to. */
const WEBHOOK_TIMEOUT_MS = 5_000;

const receipt = (
  channel: DeliveryReceipt['channel'],
  outcome: DeliveryReceipt['outcome'],
  detail: string,
): DeliveryReceipt => ({ channel, outcome, detail, attemptedAt: new Date().toISOString() });

const toNotification = (alert: AlertDigest['alerts'][number]): NewNotification => ({
  propertyId: alert.propertyId as NewNotification['propertyId'],
  kind: alert.kind,
  severity: alert.severity,
  headline: `${alert.label}: ${alert.headline}`,
  detail: `${alert.detail} (${alert.before} → ${alert.after})`,
  rule: alert.rule,
});

const inAppNotifier: AlertNotifier = {
  channel: 'inApp',
  isConfigured: () => true,
  send: async (userId, digest) => {
    const written = await getNotificationRepository().add(
      userId,
      digest.alerts.map(toNotification),
    );
    // Fewer rows written than alerts means the idempotency key absorbed a
    // repeat, which is the store working, not a partial failure.
    const suppressed = digest.alerts.length - written.length;
    return receipt(
      'inApp',
      'delivered',
      suppressed > 0
        ? `${written.length} added to the inbox, ${suppressed} already recorded today`
        : `${written.length} added to the inbox`,
    );
  },
};

const webhookNotifier: AlertNotifier = {
  channel: 'webhook',
  isConfigured: () => Boolean(getServerEnv().ALERT_WEBHOOK_URL),
  send: async (userId, digest) => {
    const env = getServerEnv();
    const url = env.ALERT_WEBHOOK_URL;
    if (!url) {
      return receipt(
        'webhook',
        'notConfigured',
        'Set ALERT_WEBHOOK_URL to a POST endpoint to receive digests as JSON.',
      );
    }

    // The user id is included so the receiver can route, but nothing about the
    // user beyond it: a webhook is an external sink.
    const payload = JSON.stringify({
      generatedAt: digest.generatedAt,
      subject: digest.subject,
      userId,
      counts: digest.counts,
      alerts: digest.alerts,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'PropIQ-Alerts/1',
    };
    if (env.ALERT_WEBHOOK_SECRET) {
      headers['x-propiq-signature'] = `sha256=${createHmac('sha256', env.ALERT_WEBHOOK_SECRET)
        .update(payload)
        .digest('hex')}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!response.ok) {
        return receipt('webhook', 'failed', `Endpoint returned ${response.status}.`);
      }
      return receipt('webhook', 'delivered', `Endpoint accepted ${digest.alerts.length}.`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      return receipt('webhook', 'failed', `Request did not complete: ${reason}`);
    }
  },
};

/**
 * Email has no provider wired in this build. The product does not ship a
 * console-logging stand-in that reports success — an unsent email reported as
 * sent is exactly the class of untruth the rest of the product refuses.
 */
const emailNotifier: AlertNotifier = {
  channel: 'email',
  isConfigured: () => false,
  send: async () =>
    receipt(
      'email',
      'notConfigured',
      'No transactional email provider is integrated. Requires an SMTP or API ' +
        'provider (address verification, unsubscribe handling and bounce ' +
        'processing included) before it can be enabled.',
    ),
};

export const NOTIFIERS: readonly AlertNotifier[] = [inAppNotifier, webhookNotifier, emailNotifier];

/** What the deployment can currently do, for honest display in the UI. */
export const deliveryStatus = (): ReadonlyArray<{
  readonly channel: AlertNotifier['channel'];
  readonly configured: boolean;
}> => NOTIFIERS.map((n) => ({ channel: n.channel, configured: n.isConfigured() }));

/**
 * Send a digest on every channel. Channels are independent: a failing webhook
 * must not cost the user their inbox row, so each receipt is collected rather
 * than the first failure aborting the rest.
 */
export const deliverDigest = async (
  userId: UserId,
  digest: AlertDigest,
): Promise<readonly DeliveryReceipt[]> => {
  if (digest.alerts.length === 0) {
    return NOTIFIERS.map((n) => receipt(n.channel, 'skipped', 'Nothing crossed a threshold.'));
  }
  return Promise.all(
    NOTIFIERS.map(async (n) => {
      try {
        return await n.send(userId, digest);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        return receipt(n.channel, 'failed', reason);
      }
    }),
  );
};
