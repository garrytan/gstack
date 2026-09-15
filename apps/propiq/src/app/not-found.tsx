import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-24 text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-500">404</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">We do not have that page</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-secondary)]">
        The property or page you asked for is not in our coverage. PropIQ covers one market densely
        rather than every market thinly, so a property outside it will not resolve here.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Link
          href="/search"
          className="inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-ink-950 hover:bg-accent-400"
        >
          Search properties
        </Link>
        <Link
          href="/"
          className="inline-flex h-10 items-center rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium hover:bg-[var(--surface-2)]"
        >
          Home
        </Link>
      </div>
    </div>
  );
}
