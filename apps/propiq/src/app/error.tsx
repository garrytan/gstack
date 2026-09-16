'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced to the browser console only; the digest is what correlates with
    // the server log. The message itself is never shown to the user, because it
    // can carry query internals.
    console.error('[propiq] render error', error.digest ?? error.message);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something broke on our side</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-secondary)]">
        This page could not be built. Nothing you did caused it, and no partial or guessed data has
        been shown in its place.
      </p>
      {error.digest && (
        <p className="mt-3 font-mono text-xs text-[var(--text-muted)]">Reference: {error.digest}</p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-[#0a2a2b] hover:bg-accent-400"
      >
        Try again
      </button>
    </div>
  );
}
