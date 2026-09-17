/**
 * What is actually deployed here.
 *
 * This exists because "the changes are not showing up" was unanswerable three
 * times in a row. Each time the honest answer was a guess: the environment
 * variable, the branch, the repository. Two of those guesses were wrong, and
 * being wrong cost more than the endpoint costs.
 *
 * So the deployment now says what it is. One request, and you know which
 * commit built it, which branch that commit is on, which data mode it
 * resolved, and whether it is serving any property records at all. If the
 * commit here is not the commit you pushed, the deployment is stale and
 * nothing about the page is worth reasoning about until that is fixed.
 *
 * Vercel sets the VERCEL_GIT_* and VERCEL_ENV variables on every build. They
 * are build metadata, not secrets; nothing here reads a key, a token, or a
 * connection string, and nothing here is behind auth because the whole point
 * is to be checkable without it.
 */

import { getPropertyRepository } from '@/data';
import { getServerEnv } from '@/lib/env';
import { clientEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const env = getServerEnv();
  const repo = getPropertyRepository();

  const body = {
    /* Which code is running. Compare this to the SHA you pushed. */
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown (not a Vercel build)',
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? 'unknown',
    message: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? undefined,
    repository: process.env.VERCEL_GIT_REPO_SLUG
      ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
      : 'unknown',
    vercelEnv: process.env.VERCEL_ENV ?? 'none',

    /* What it decided to serve, and whether that decision was declared. */
    dataMode: env.DATA_MODE,
    dataModeDeclared: clientEnv.NEXT_PUBLIC_DATA_MODE ?? null,
    adapter: repo.adapterName,
    servesDemoData: repo.servesDemoData,
    servesNoData: repo.servesNoData,

    /* The two things a reader most often wants to confirm at a glance. */
    siteUrl: clientEnv.NEXT_PUBLIC_SITE_URL,
    checkedAt: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Never cached. A stale answer from a diagnostic endpoint is worse than
      // no answer, because it looks like an answer.
      'cache-control': 'no-store, max-age=0',
    },
  });
}
