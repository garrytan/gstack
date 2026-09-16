'use client';

import { useState, useTransition } from 'react';
import { CheckCheck, Loader2 } from 'lucide-react';
import { markNotificationsRead } from '@/server/actions';
import { Button } from '@/components/ui/button';

export const MarkReadButton = ({ unreadCount }: { unreadCount: number }) => {
  const [message, setMessage] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      const result = await markNotificationsRead();
      setMessage(result.message);
    });
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        onClick={run}
        disabled={pending || unreadCount === 0}
        variant="secondary"
      >
        {pending ? <Loader2 aria-hidden className="animate-spin" /> : <CheckCheck aria-hidden />}
        Mark all read
      </Button>
      {message && (
        <span role="status" className="text-[11px] text-[var(--text-muted)]">
          {message}
        </span>
      )}
    </span>
  );
};
