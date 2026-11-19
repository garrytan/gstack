// gstack community-pulse edge function
// Returns aggregated community stats for the dashboard: weekly active
// community-tier installs, update checks, top skills, crash clusters, version
// distribution and the prompt-injection aggregate, all from live traffic.
// Uses server-side cache (community_pulse_cache table) to prevent DoS.
//
// Fail-closed contract (#1947): success responses carry `status: "ok"` so
// clients can distinguish authoritative data from legacy responses. Errors
// NEVER masquerade as healthy zeros — the catch serves a stale cache (marked
// `stale: true`) when one exists, else 503 {"error":"pulse_unavailable"}.
// supabase-js does not throw on query failure, so every query destructures
// `error` and throws explicitly; previously errors were discarded and `?? 0`
// turned outages into fake zeros via the success path.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=3600",
};

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  // Cache fetch is hoisted above the recompute try so the catch can serve a
  // stale-but-real snapshot instead of an error when recompute fails.
  let cached: { data: Record<string, unknown>; refreshed_at: string } | null = null;
  try {
    const { data } = await supabase
      .from("community_pulse_cache")
      .select("data, refreshed_at")
      .eq("id", 1)
      .single();
    cached = data ?? null;
  } catch {
    cached = null; // cache miss/failure is non-fatal — recompute decides
  }

  if (cached?.refreshed_at && cached.data && "weekly_update_checks" in cached.data) {
    const age = Date.now() - new Date(cached.refreshed_at).getTime();
    if (age < CACHE_MAX_AGE_MS) {
      // Serving the cache means this (new) backend is healthy; assert the
      // marker even for blobs cached by older code.
      return new Response(JSON.stringify({ ...cached.data, status: "ok" }), {
        status: 200,
        headers: JSON_HEADERS,
      });
    }
  }

  try {
    // Cache is stale or missing — recompute. community_pulse_summary()
    // (migration 006) counts every live row of the last 7 days in SQL: test
    // traffic, fixture-shaped session ids and probe versions are left out, and
    // weekly_active is distinct community-tier installs, not update checks.
    const { data: summary, error: summaryErr } = await supabase.rpc("community_pulse_summary");
    if (summaryErr) throw summaryErr;
    if (!summary || typeof summary !== "object") throw new Error("empty pulse summary");

    const result = { status: "ok", ...(summary as Record<string, unknown>) };

    // Upsert cache
    await supabase
      .from("community_pulse_cache")
      .upsert({
        id: 1,
        data: result,
        refreshed_at: new Date().toISOString(),
      });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: JSON_HEADERS,
    });
  } catch {
    // Recompute failed. A stale snapshot of real data beats an error — and
    // both beat fake zeros, which are indistinguishable from a healthy
    // "no attacks" reading on a security surface.
    if (cached?.data) {
      return new Response(
        JSON.stringify({ ...cached.data, status: "ok", stale: true }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    return new Response(JSON.stringify({ error: "pulse_unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
});
