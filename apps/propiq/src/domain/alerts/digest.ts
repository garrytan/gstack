/**
 * Alert digests.
 *
 * Evaluation produces alerts; delivery needs a *message*. Turning one into the
 * other is arithmetic and string assembly with no I/O, so it lives here where
 * it can be tested without a mail server, a webhook endpoint or a clock.
 *
 * The dedupe rule matters more than it looks. A user who watches the same
 * property through two evaluation runs in one day should not receive the same
 * "price changed" line twice, and when two runs disagree on severity the more
 * serious reading is the one worth sending.
 */

import type { Instant } from '../shared/types';
import type { Alert, AlertSeverity } from './types';

/** Most serious first. Used for both ordering and dedupe tie-breaks. */
export const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  urgent: 0,
  attention: 1,
  info: 2,
};

export interface AlertDigest {
  readonly generatedAt: Instant;
  /** Subject line. Describes the count and the worst severity, nothing more. */
  readonly subject: string;
  /** Plain text body. Every channel can render this; none has to parse HTML. */
  readonly body: string;
  readonly alerts: readonly Alert[];
  readonly counts: Readonly<Record<AlertSeverity, number>>;
  /** `undefined` when there is nothing to send, which is a normal outcome. */
  readonly highestSeverity: AlertSeverity | undefined;
}

/**
 * One alert per property per kind. Keeps the most severe reading, and among
 * equally severe readings the most recently detected one.
 */
export const dedupeAlerts = (alerts: readonly Alert[]): readonly Alert[] => {
  const best = new Map<string, Alert>();
  for (const alert of alerts) {
    const key = `${alert.propertyId}::${alert.kind}`;
    const held = best.get(key);
    if (!held) {
      best.set(key, alert);
      continue;
    }
    const moreSevere = SEVERITY_RANK[alert.severity] < SEVERITY_RANK[held.severity];
    const sameSeverityButNewer =
      alert.severity === held.severity && alert.detectedAt > held.detectedAt;
    if (moreSevere || sameSeverityButNewer) best.set(key, alert);
  }
  return [...best.values()];
};

const orderAlerts = (alerts: readonly Alert[]): readonly Alert[] =>
  [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.propertyId.localeCompare(b.propertyId) ||
      a.kind.localeCompare(b.kind),
  );

const countBySeverity = (alerts: readonly Alert[]): Record<AlertSeverity, number> => {
  const counts: Record<AlertSeverity, number> = { urgent: 0, attention: 0, info: 0 };
  for (const alert of alerts) counts[alert.severity] += 1;
  return counts;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const buildSubject = (alerts: readonly Alert[], counts: Record<AlertSeverity, number>): string => {
  if (alerts.length === 0) return 'PropIQ: nothing material changed';
  const total = plural(alerts.length, 'change', 'changes');
  if (counts.urgent > 0)
    return `PropIQ: ${counts.urgent} urgent of ${total} on properties you track`;
  if (counts.attention > 0)
    return `PropIQ: ${counts.attention} needing attention of ${total} on properties you track`;
  return `PropIQ: ${total} on properties you track`;
};

const buildBody = (alerts: readonly Alert[]): string => {
  if (alerts.length === 0) {
    return 'Nothing crossed a reporting threshold on the properties you track.';
  }
  const lines = alerts.map(
    (a) =>
      `[${a.severity.toUpperCase()}] ${a.label} — ${a.headline}\n` +
      `  ${a.detail}\n` +
      `  ${a.before} → ${a.after}\n` +
      `  property: ${a.propertyId} · rule: ${a.rule}`,
  );
  return [
    'Material changes on the properties you track.',
    '',
    ...lines,
    '',
    'Every line above crossed a published threshold. Thresholds are listed at /methodology.',
  ].join('\n');
};

/**
 * Assemble a digest. Returns one even when there is nothing to report — the
 * caller decides whether an empty digest is worth delivering, and having the
 * shape be total makes that decision explicit rather than a null check.
 */
export const buildDigest = (alerts: readonly Alert[], now: Instant): AlertDigest => {
  const ordered = orderAlerts(dedupeAlerts(alerts));
  const counts = countBySeverity(ordered);
  return {
    generatedAt: now,
    subject: buildSubject(ordered, counts),
    body: buildBody(ordered),
    alerts: ordered,
    counts,
    highestSeverity: ordered[0]?.severity,
  };
};

/** An empty digest is never worth a notification. */
export const isWorthDelivering = (digest: AlertDigest): boolean => digest.alerts.length > 0;
