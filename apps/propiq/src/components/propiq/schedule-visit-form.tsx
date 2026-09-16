'use client';

import { useState, useTransition } from 'react';
import { CalendarPlus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import type { ActionResult } from '@/server/actions';

export const ScheduleVisitForm = ({
  propertyId,
  action,
}: {
  propertyId: string;
  action: (propertyId: string, scheduledFor: string) => Promise<ActionResult>;
}) => {
  const [date, setDate] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const [pending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await action(propertyId, date);
          setMessage({ ok: result.ok, text: result.message ?? '' });
        });
      }}
      className="rounded-lg propiq-card p-5"
    >
      <h2 className="text-sm font-semibold">Plan the visit</h2>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Go at the hour you would actually be there. A north-facing flat seen at noon tells you
        nothing about five in the afternoon.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="scheduledFor">Date</Label>
          <Input
            id="scheduledFor"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-48"
          />
        </div>
        <Button type="submit" disabled={pending || !date}>
          {pending ? (
            <Loader2 aria-hidden className="animate-spin" />
          ) : (
            <CalendarPlus aria-hidden />
          )}
          Open the checklist
        </Button>
      </div>
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
