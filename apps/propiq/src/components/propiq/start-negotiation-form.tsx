'use client';

import { useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import { startNegotiation } from '@/server/actions';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { formatINR } from '@/lib/utils';

export const StartNegotiationForm = ({
  propertyId,
  askingPrice,
  fairValueMid,
  suggestedTarget,
  suggestedWalkAway,
}: {
  propertyId: string;
  askingPrice: number;
  fairValueMid?: number;
  suggestedTarget?: number;
  suggestedWalkAway?: number;
}) => {
  const [target, setTarget] = useState(String(suggestedTarget ?? Math.round(askingPrice * 0.92)));
  const [walkAway, setWalkAway] = useState(
    String(suggestedWalkAway ?? Math.round(askingPrice * 0.98)),
  );
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const [pending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await startNegotiation({
            propertyId,
            askingPrice,
            fairValueMid,
            targetPrice: target,
            walkAwayPrice: walkAway,
          });
          setMessage({ ok: result.ok, text: result.message ?? '' });
        });
      }}
      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-5"
    >
      <h2 className="text-sm font-semibold">Set your numbers first</h2>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Asking price is {formatINR(askingPrice)}
        {fairValueMid !== undefined && `, our central estimate is ${formatINR(fairValueMid)}`}.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="target">Target price (₹)</Label>
          <Input
            id="target"
            type="number"
            min={0}
            required
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <p data-figure className="text-[11px] text-[var(--text-muted)]">
            {formatINR(Number(target) || 0)} — what you would be happy to pay.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="walkAway">Walk-away price (₹)</Label>
          <Input
            id="walkAway"
            type="number"
            min={0}
            required
            value={walkAway}
            onChange={(e) => setWalkAway(e.target.value)}
          />
          <p data-figure className="text-[11px] text-[var(--text-muted)]">
            {formatINR(Number(walkAway) || 0)} — above this you leave, whatever is said in the room.
          </p>
        </div>
      </div>

      <Button type="submit" className="mt-4" disabled={pending}>
        {pending && <Loader2 aria-hidden className="animate-spin" />}
        Start tracking
      </Button>

      {message && (
        <p
          role="status"
          className="mt-3 text-xs"
          style={{ color: message.ok ? 'var(--color-buy)' : 'var(--color-avoid)' }}
        >
          {message.text}
        </p>
      )}
    </form>
  );
};
