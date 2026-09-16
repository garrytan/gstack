/**
 * Digest assembly and delivery honesty.
 *
 * The digest half is pure and gets exercised directly. The delivery half is
 * tested for the property that matters most: a channel with no credentials
 * must say so, and must never report a send it did not make.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asId } from '@/domain/shared/types';
import type { UserId } from '@/domain/shared/types';
import { NOTIFIERS, deliverDigest, deliveryStatus } from '@/server/alert-delivery';
import { __resetServerEnvCache } from '@/lib/env';
import { buildDigest, dedupeAlerts, isWorthDelivering } from '@/domain/alerts/digest';
import type { Alert } from '@/domain/alerts/types';

const alert = (overrides: Partial<Alert> = {}): Alert => ({
  kind: 'priceChange',
  label: 'Asking price changed',
  severity: 'info',
  propertyId: 'prop-1',
  headline: 'Asking price fell 4%',
  detail: 'Down from ₹1.60 Cr to ₹1.54 Cr.',
  before: '₹1.60 Cr',
  after: '₹1.54 Cr',
  detectedAt: '2026-05-01T00:00:00.000Z',
  rule: 'priceChangePercent>=1.5',
  ...overrides,
});

const NOW = '2026-05-02T00:00:00.000Z';

describe('dedupeAlerts', () => {
  it('collapses repeats of the same rule on the same property', () => {
    const deduped = dedupeAlerts([alert(), alert()]);
    expect(deduped).toHaveLength(1);
  });

  it('keeps the more severe reading when two runs disagree', () => {
    const deduped = dedupeAlerts([alert({ severity: 'info' }), alert({ severity: 'urgent' })]);
    expect(deduped[0]?.severity).toBe('urgent');
  });

  it('keeps the newer reading when severity ties', () => {
    const deduped = dedupeAlerts([
      alert({ detectedAt: '2026-05-01T00:00:00.000Z', after: 'old' }),
      alert({ detectedAt: '2026-05-02T00:00:00.000Z', after: 'new' }),
    ]);
    expect(deduped[0]?.after).toBe('new');
  });

  it('does not collapse different kinds, or the same kind on different properties', () => {
    expect(
      dedupeAlerts([
        alert({ kind: 'priceChange' }),
        alert({ kind: 'verdictChange' }),
        alert({ propertyId: 'prop-2' }),
      ]),
    ).toHaveLength(3);
  });
});

describe('buildDigest', () => {
  it('orders urgent before attention before info', () => {
    const digest = buildDigest(
      [
        alert({ kind: 'evidenceStale', severity: 'info' }),
        alert({ kind: 'reraChange', severity: 'urgent' }),
        alert({ kind: 'verdictChange', severity: 'attention' }),
      ],
      NOW,
    );
    expect(digest.alerts.map((a) => a.severity)).toEqual(['urgent', 'attention', 'info']);
    expect(digest.highestSeverity).toBe('urgent');
  });

  it('counts by severity', () => {
    const digest = buildDigest(
      [
        alert({ kind: 'reraChange', severity: 'urgent' }),
        alert({ kind: 'verdictChange', severity: 'urgent' }),
        alert({ kind: 'evidenceStale', severity: 'info' }),
      ],
      NOW,
    );
    expect(digest.counts).toEqual({ urgent: 2, attention: 0, info: 1 });
  });

  it('is deterministic — the same alerts in any order produce the same body', () => {
    const a = alert({ kind: 'reraChange', severity: 'urgent' });
    const b = alert({ kind: 'evidenceStale', severity: 'info' });
    expect(buildDigest([a, b], NOW).body).toBe(buildDigest([b, a], NOW).body);
  });

  it('names the rule in the body, so a digest line can be traced to a threshold', () => {
    expect(buildDigest([alert()], NOW).body).toContain('priceChangePercent>=1.5');
  });

  it('never claims changes it does not have', () => {
    const empty = buildDigest([], NOW);
    expect(empty.alerts).toHaveLength(0);
    expect(empty.highestSeverity).toBeUndefined();
    expect(empty.subject).toMatch(/nothing material changed/i);
    expect(isWorthDelivering(empty)).toBe(false);
  });

  it('counts one change as singular', () => {
    expect(buildDigest([alert()], NOW).subject).toContain('1 change');
  });

  it('is worth delivering as soon as one alert survives dedupe', () => {
    expect(isWorthDelivering(buildDigest([alert(), alert()], NOW))).toBe(true);
  });
});

describe('delivery honesty', () => {
  const source = readFileSync(join(process.cwd(), 'src/server/alert-delivery.ts'), 'utf-8');

  it('reports an unconfigured channel rather than pretending to send', () => {
    // The email channel has no provider in this build. If someone wires a
    // console.log stand-in that returns `delivered`, this fails.
    const emailBlock = source.slice(source.indexOf('const emailNotifier'));
    expect(emailBlock).toContain("'notConfigured'");
    expect(emailBlock).not.toContain("'delivered'");
  });

  it('states the integration requirement for every unconfigured channel', () => {
    expect(source).toMatch(/ALERT_WEBHOOK_URL/);
    expect(source).toMatch(/email provider/i);
  });

  it('signs webhook payloads when a secret is configured', () => {
    expect(source).toContain("createHmac('sha256'");
    expect(source).toContain('x-propiq-signature');
  });

  it('bounds the webhook request so a dead endpoint cannot hang the scheduler', () => {
    expect(source).toContain('AbortSignal.timeout');
  });

  it('isolates channels so one failure does not cost the others', () => {
    // Promise.all over per-channel try/catch, not a sequential chain that a
    // throw would abort.
    expect(source).toContain('Promise.all');
    expect(source).toMatch(/catch \(error\)/);
  });

  it('sends nothing at all when no alert cleared a threshold', () => {
    expect(source).toContain("'skipped', 'Nothing crossed a threshold.'");
  });
});

describe('webhook channel', () => {
  const USER = asId<UserId>('user-1');
  const digest = buildDigest([alert()], NOW);

  afterEach(() => {
    delete process.env.ALERT_WEBHOOK_URL;
    delete process.env.ALERT_WEBHOOK_SECRET;
    __resetServerEnvCache();
    vi.unstubAllGlobals();
  });

  const webhook = () => {
    const notifier = NOTIFIERS.find((n) => n.channel === 'webhook');
    if (!notifier) throw new Error('webhook notifier is not registered');
    return notifier;
  };

  const headersOf = (init: RequestInit | undefined): Record<string, string> =>
    (init?.headers as Record<string, string> | undefined) ?? {};

  it('reports itself unconfigured, and posts nothing, without a URL', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    __resetServerEnvCache();

    const receipt = await webhook().send(USER, digest);
    expect(receipt.outcome).toBe('notConfigured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts the digest when a URL is configured', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://example.test/hook';
    __resetServerEnvCache();
    const fetchSpy = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const receipt = await webhook().send(USER, digest);
    expect(receipt.outcome).toBe('delivered');
    expect(fetchSpy).toHaveBeenCalledOnce();

    const call = fetchSpy.mock.calls[0];
    const [url, init] = call ?? ['', {}];
    expect(url).toBe('https://example.test/hook');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as { alerts: unknown[]; subject: string };
    expect(body.alerts).toHaveLength(1);
    expect(body.subject).toBe(digest.subject);
  });

  it('signs the payload only when a secret is set', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://example.test/hook';
    __resetServerEnvCache();
    const unsigned = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', unsigned);
    await webhook().send(USER, digest);
    const withoutSecret = headersOf(unsigned.mock.calls[0]?.[1]);
    expect(withoutSecret['x-propiq-signature']).toBeUndefined();

    process.env.ALERT_WEBHOOK_SECRET = 'a-secret-long-enough';
    __resetServerEnvCache();
    const signed = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', signed);
    await webhook().send(USER, digest);
    const withSecret = headersOf(signed.mock.calls[0]?.[1]);
    expect(withSecret['x-propiq-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('reports a non-2xx response as failed rather than delivered', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://example.test/hook';
    __resetServerEnvCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );

    expect((await webhook().send(USER, digest)).outcome).toBe('failed');
  });

  it('reports a thrown request as failed, without taking down the other channels', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://example.test/hook';
    __resetServerEnvCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const receipts = await deliverDigest(USER, digest);
    expect(receipts.find((r) => r.channel === 'webhook')?.outcome).toBe('failed');
    // The inbox write is independent and must still have happened.
    expect(receipts.find((r) => r.channel === 'inApp')?.outcome).toBe('delivered');
  });

  it('skips every channel when the digest is empty', async () => {
    const receipts = await deliverDigest(USER, buildDigest([], NOW));
    expect(receipts.map((r) => r.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  it('reports the in-app channel as always available', () => {
    expect(deliveryStatus().find((c) => c.channel === 'inApp')?.configured).toBe(true);
    expect(deliveryStatus().find((c) => c.channel === 'email')?.configured).toBe(false);
  });
});
