'use client';

/**
 * Card actions: save, and add to the comparison tray.
 *
 * "Save" is the real watchlist, so it needs an account and says so when there
 * isn't one — it never fakes a saved state for an anonymous visitor. "Compare"
 * is browser-local and works immediately, because comparing is a reading task
 * and gating it behind a signup would be theatre.
 */

import { useState, useTransition } from 'react';
import { Bookmark, BookmarkCheck, Check, Loader2, Scale } from 'lucide-react';
import { saveToWatchlist } from '@/server/actions';
import { track } from '@/lib/analytics';
import { useShortlist, SHORTLIST_LIMIT } from '@/components/site/shortlist';

export const CardActions = ({
  propertyId,
  propertyName,
}: {
  propertyId: string;
  propertyName: string;
}) => {
  const shortlist = useShortlist();
  const compared = shortlist.has(propertyId);
  const full = !compared && shortlist.entries.length >= SHORTLIST_LIMIT;

  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const save = () => {
    startTransition(async () => {
      const result = await saveToWatchlist(propertyId);
      setSaved(result.ok);
      setMessage(result.message);
      if (result.ok) track('property_saved', { propertyId });
    });
  };

  return (
    <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || saved}
          aria-pressed={saved}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--surface-1)] disabled:opacity-70"
        >
          {pending ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : saved ? (
            <BookmarkCheck aria-hidden className="size-3.5" />
          ) : (
            <Bookmark aria-hidden className="size-3.5" />
          )}
          {saved ? 'Saved' : 'Save'}
        </button>

        {shortlist.enabled && (
          <button
            type="button"
            onClick={() => shortlist.toggle({ id: propertyId, name: propertyName })}
            disabled={full}
            aria-pressed={compared}
            title={full ? `The comparison tray holds ${SHORTLIST_LIMIT} properties.` : undefined}
            className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
              compared
                ? 'border-transparent bg-[var(--color-brand-blue-500)] text-white'
                : 'border-[var(--border-subtle)] hover:bg-[var(--surface-1)]'
            }`}
          >
            {compared ? (
              <Check aria-hidden className="size-3.5" />
            ) : (
              <Scale aria-hidden className="size-3.5" />
            )}
            {compared ? 'In compare' : 'Compare'}
          </button>
        )}
      </div>

      {message && (
        <p role="status" className="mt-2 text-[11px] leading-snug text-[var(--text-muted)]">
          {message}
        </p>
      )}
    </div>
  );
};
