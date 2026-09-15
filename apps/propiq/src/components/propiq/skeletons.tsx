/**
 * Loading skeletons.
 *
 * Deliberately scoped to list segments (`/search`, `/localities`, `/dashboard`)
 * rather than placed at the app root.
 *
 * A root `loading.tsx` wraps every route in a Suspense boundary, which makes
 * Next flush the shell — and commit a 200 — before the page body runs. Any
 * `notFound()` after that point can only render the not-found page as a soft
 * 404. For a product whose distribution depends on search and AI citation,
 * correct status codes on unknown properties and localities matter more than a
 * skeleton on a detail page.
 */

export const CardGridSkeleton = ({ count = 6 }: { count?: number }) => (
  <div className="mx-auto max-w-7xl px-4 py-8">
    <div className="skeleton h-8 w-64 rounded" />
    <div className="skeleton mt-3 h-4 w-96 rounded" />
    <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton h-44 rounded-lg" />
      ))}
    </div>
    <span className="sr-only" role="status">
      Loading
    </span>
  </div>
);

export const TableSkeleton = ({ rows = 6 }: { rows?: number }) => (
  <div className="mx-auto max-w-7xl px-4 py-8">
    <div className="skeleton h-8 w-48 rounded" />
    <div className="skeleton mt-3 h-4 w-80 rounded" />
    <div className="mt-6 space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-10 rounded" />
      ))}
    </div>
    <span className="sr-only" role="status">
      Loading
    </span>
  </div>
);
