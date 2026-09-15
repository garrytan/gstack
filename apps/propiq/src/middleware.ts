import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Session refresh.
 *
 * Supabase access tokens are short-lived. Server Components cannot write
 * cookies, so the refresh has to happen in middleware, where the rotated token
 * can be set on the outgoing response.
 *
 * When Supabase is not configured (fixture mode) this is a no-op rather than a
 * crash — the rest of the product is browsable without auth by design.
 */
export const middleware = async (request: NextRequest): Promise<NextResponse> => {
  const response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touching getUser() is what triggers the refresh; the result is discarded.
  await supabase.auth.getUser();
  return response;
};

export const config = {
  matcher: [
    /*
     * Everything except static assets and image optimisation, which never carry
     * a session and would only add latency.
     */
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
