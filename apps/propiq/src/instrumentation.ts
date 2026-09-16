/**
 * Startup configuration check.
 *
 * `getServerEnv()` validates lazily, on first call. That is fine for catching a
 * typo in development, but in production it produced the worst possible shape
 * of failure: a server that boots happily, answers the tool pages with 200,
 * answers every data-backed route with a 500, and answers four more with a
 * *200* carrying a permanently stuck loading skeleton — because the error is
 * raised inside a Suspense boundary after the shell has already flushed with a
 * 200 status. An uptime monitor watching `/search` sees a healthy service. A
 * crawler sees the word "Loading".
 *
 * Next calls `register()` once per server process before it serves anything, so
 * this is where a misconfiguration belongs. Throwing here means the process
 * refuses to start and says exactly which variable is wrong, instead of
 * degrading into a site that is half up and lying about the other half.
 */

export async function register(): Promise<void> {
  // The edge runtime gets its own invocation of this module and has neither the
  // env surface nor the responsibility for this check.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV !== 'production') return;
  // `next build` starts a server to collect page data; a build is allowed to run
  // with no environment at all, which is how CI and a fresh clone invoke it.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { getServerEnv } = await import('@/lib/env');
  getServerEnv();
}
