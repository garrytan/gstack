/**
 * Browser Supabase client. Only ever sees the anon key, and RLS applies to
 * everything it can reach.
 */

'use client';

import { createBrowserClient } from '@supabase/ssr';
import { clientEnv } from './env';

export const createClient = () => {
  const url = clientEnv.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Supabase is not configured in this environment.');
  }
  return createBrowserClient(url, anonKey);
};
