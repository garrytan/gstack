'use client';

import { useState, useTransition } from 'react';
import { Bookmark, BookmarkCheck, Loader2 } from 'lucide-react';
import { removeFromWatchlist, saveToWatchlist } from '@/server/actions';
import { track } from '@/lib/analytics';
import { Button } from '@/components/ui/button';

export const WatchlistButton = ({
  propertyId,
  initiallyWatched,
}: {
  propertyId: string;
  initiallyWatched: boolean;
}) => {
  const [watched, setWatched] = useState(initiallyWatched);
  const [message, setMessage] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    startTransition(async () => {
      const next = !watched;
      const result = next
        ? await saveToWatchlist(propertyId)
        : await removeFromWatchlist(propertyId);

      if (result.ok) {
        setWatched(next);
        if (next) track('property_saved', { propertyId });
      }
      setMessage(result.message);
    });
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        onClick={toggle}
        disabled={pending}
        variant={watched ? 'secondary' : 'primary'}
        aria-pressed={watched}
      >
        {pending ? (
          <Loader2 aria-hidden className="animate-spin" />
        ) : watched ? (
          <BookmarkCheck aria-hidden />
        ) : (
          <Bookmark aria-hidden />
        )}
        {watched ? 'Saved' : 'Save'}
      </Button>
      {message && (
        <span role="status" className="text-[11px] text-[var(--text-muted)]">
          {message}
        </span>
      )}
    </span>
  );
};
