'use client';

import { useState, useTransition } from 'react';
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react';
import type { Negotiation } from '@/domain/negotiation/types';
import { STATUS_LABELS } from '@/domain/negotiation/types';
import { negotiationState } from '@/domain/negotiation/engine';
import { ALLOWED_TRANSITIONS } from '@/domain/negotiation/engine';
import { recordOffer, setNegotiationStatus } from '@/server/actions';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { formatINR, formatSignedPercent, formatRelative } from '@/lib/utils';

export const NegotiationTracker = ({ negotiation }: { negotiation: Negotiation }) => {
  const state = negotiationState(negotiation);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const [pending, startTransition] = useTransition();
  const terminal = ALLOWED_TRANSITIONS[negotiation.status].length === 0;

  const submitOffer = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const concessions = String(form.get('concessions') ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    startTransition(async () => {
      const result = await recordOffer({
        negotiationId: negotiation.id,
        party: form.get('party'),
        amount: form.get('amount'),
        concessions,
        note: String(form.get('note') ?? '') || undefined,
      });
      setMessage({ ok: result.ok, text: result.message ?? '' });
    });
  };

  const changeStatus = (status: string) => {
    startTransition(async () => {
      const result = await setNegotiationStatus(negotiation.id, status);
      setMessage({ ok: result.ok, text: result.message ?? '' });
    });
  };

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={state.aboveWalkAway ? 'avoid' : 'accent'}>
            {STATUS_LABELS[negotiation.status]}
          </Badge>
          {state.aboveWalkAway && <Badge tone="avoid">Above your walk-away</Badge>}
        </div>

        <p className="mt-3 text-sm leading-relaxed">{state.guidance}</p>

        <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Asking" value={formatINR(negotiation.askingPrice)} />
          {negotiation.fairValueMid !== undefined && (
            <Stat label="Fair value" value={formatINR(negotiation.fairValueMid)} />
          )}
          <Stat label="Your target" value={formatINR(negotiation.targetPrice)} />
          <Stat
            label="Walk away above"
            value={formatINR(negotiation.walkAwayPrice)}
            tone={state.aboveWalkAway ? 'bad' : undefined}
          />
          <Stat
            label="Gap now"
            value={state.gap === undefined ? '—' : formatINR(state.gap)}
            hint={state.gapPercent === undefined ? undefined : `${state.gapPercent}% apart`}
          />
        </dl>

        {state.sellerMovementPercent > 0 && (
          <p data-figure className="mt-3 text-xs text-[var(--text-muted)]">
            The seller has come down {formatSignedPercent(state.sellerMovementPercent)} from the
            asking price.
          </p>
        )}

        {state.allConcessions.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-semibold">Conceded so far, besides price</p>
            <ul className="mt-1 flex flex-wrap gap-2">
              {state.allConcessions.map((c) => (
                <li key={c}>
                  <Badge tone="neutral">{c}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {negotiation.offers.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold">How it has gone</h2>
          <ol className="mt-3 space-y-2">
            {[...negotiation.offers]
              .sort((a, b) => b.at.localeCompare(a.at))
              .map((offer) => (
                <li
                  key={offer.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3"
                >
                  {offer.party === 'buyer' ? (
                    <ArrowUp
                      aria-hidden
                      className="size-3.5 shrink-0"
                      style={{ color: 'var(--color-buy)' }}
                    />
                  ) : (
                    <ArrowDown
                      aria-hidden
                      className="size-3.5 shrink-0"
                      style={{ color: 'var(--color-watch)' }}
                    />
                  )}
                  <span className="text-xs font-medium capitalize">{offer.party}</span>
                  <span data-figure className="text-sm font-semibold">
                    {formatINR(offer.amount)}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {formatRelative(offer.at)}
                  </span>
                  {offer.concessions?.map((c) => (
                    <Badge key={c} tone="neutral">
                      {c}
                    </Badge>
                  ))}
                  {offer.note && (
                    <span className="w-full text-xs text-[var(--text-secondary)]">
                      {offer.note}
                    </span>
                  )}
                </li>
              ))}
          </ol>
        </section>
      )}

      {!terminal && (
        <section className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-5">
          <h2 className="text-sm font-semibold">Record what just happened</h2>
          <form onSubmit={submitOffer} className="mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="party">Who moved?</Label>
                <Select id="party" name="party" defaultValue="buyer">
                  <option value="buyer">I offered</option>
                  <option value="seller">They countered</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="amount">Amount (₹)</Label>
                <Input id="amount" name="amount" type="number" min={0} required />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="concessions">Anything conceded besides price?</Label>
              <Input
                id="concessions"
                name="concessions"
                placeholder="Free covered parking, waived floor rise"
              />
              <p className="text-[11px] text-[var(--text-muted)]">
                Comma separated. These are usually cheaper for them to give than price, which is why
                they give them first.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="note">Note</Label>
              <Input id="note" name="note" maxLength={500} placeholder="What was said." />
            </div>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 aria-hidden className="animate-spin" />}
              Record it
            </Button>
          </form>

          <div className="mt-6 border-t border-[var(--border-subtle)] pt-4">
            <p className="text-xs font-semibold">Close this out</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {ALLOWED_TRANSITIONS[negotiation.status]
                .filter((s) => s === 'agreed' || s === 'walkedAway' || s === 'lost')
                .map((s) => (
                  <Button
                    key={s}
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() => changeStatus(s)}
                  >
                    {STATUS_LABELS[s]}
                  </Button>
                ))}
            </div>
          </div>
        </section>
      )}

      {message && (
        <p
          role="status"
          className="text-xs"
          style={{ color: message.ok ? 'var(--color-buy)' : 'var(--color-avoid)' }}
        >
          {message.text}
        </p>
      )}
    </div>
  );
};

const Stat = ({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'bad';
}) => (
  <div>
    <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
    <dd
      data-figure
      className="mt-0.5 text-sm font-semibold"
      style={tone === 'bad' ? { color: 'var(--color-avoid)' } : undefined}
    >
      {value}
    </dd>
    {hint && (
      <p data-figure className="text-[10px] text-[var(--text-muted)]">
        {hint}
      </p>
    )}
  </div>
);
