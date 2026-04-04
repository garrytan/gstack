/**
 * Dashboard edge function — serves the team dashboard HTML.
 *
 * Public URL: https://<project>.supabase.co/functions/v1/dashboard
 * No auth required (the HTML page handles auth client-side via PKCE).
 */

import { getDashboardHTML } from './ui.ts';

Deno.serve((_req: Request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

  const html = getDashboardHTML(supabaseUrl, anonKey);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
});
