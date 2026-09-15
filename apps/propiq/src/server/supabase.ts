/**
 * Supabase clients.
 *
 * Three distinct clients, deliberately separated so a caller cannot reach for
 * more privilege than it needs:
 *  - `createServerClient()`  — acts as the signed-in user, RLS enforced.
 *  - `createAdminClient()`   — service role, RLS bypassed. Server-only, and
 *                              used exclusively for trusted ingestion jobs.
 *  - the browser client lives in `src/lib/supabase-browser.ts`.
 */

import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient as createSsrClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { clientEnv, getServerEnv } from '@/lib/env';

const requireSupabaseConfig = (): { url: string; anonKey: string } => {
  const url = clientEnv.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY, or run with PROPIQ_DATA_ADAPTER=fixture.',
    );
  }
  return { url, anonKey };
};

/** Request-scoped client that carries the user's session. RLS applies. */
export const createServerClient = async () => {
  const { url, anonKey } = requireSupabaseConfig();
  const cookieStore = await cookies();
  return createSsrClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // middleware refreshes the session instead, so this is safe to ignore.
        }
      },
    },
  });
};

/**
 * Service-role client. Bypasses RLS entirely.
 * Never call this in response to unvalidated user input.
 */
export const createAdminClient = () => {
  const { url } = requireSupabaseConfig();
  const env = getServerEnv();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for admin operations.');
  }
  return createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
};

/** The signed-in user, or undefined. Never throws on an anonymous request. */
export const getCurrentUser = async () => {
  try {
    const supabase = await createServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error) return undefined;
    return data.user ?? undefined;
  } catch {
    // Supabase not configured (fixture mode). Anonymous is the correct answer.
    return undefined;
  }
};
