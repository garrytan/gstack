// gstack community-pulse edge function
// Returns aggregated community stats for the dashboard:
// weekly active count, top skills, crash clusters, version distribution.
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

  if (cached?.refreshed_at) {
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
    // Cache is stale or missing — recompute
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    // Weekly active (update checks this week)
    const { count: thisWeek, error: thisWeekErr } = await supabase
      .from("update_checks")
      .select("*", { count: "exact", head: true })
      .gte("checked_at", weekAgo);
    if (thisWeekErr) throw thisWeekErr;

    // Last week (for change %)
    const { count: lastWeek, error: lastWeekErr } = await supabase
      .from("update_checks")
      .select("*", { count: "exact", head: true })
      .gte("checked_at", twoWeeksAgo)
      .lt("checked_at", weekAgo);
    if (lastWeekErr) throw lastWeekErr;

    const current = thisWeek ?? 0;
    const previous = lastWeek ?? 0;
    const changePct = previous > 0
      ? Math.round(((current - previous) / previous) * 100)
      : 0;

    // Top skills (last 7 days)
    const { data: skillRows, error: skillErr } = await supabase
      .from("telemetry_events")
      .select("skill")
      .eq("event_type", "skill_run")
      .gte("event_timestamp", weekAgo)
      .not("skill", "is", null)
      .limit(1000);
    if (skillErr) throw skillErr;

    const skillCounts: Record<string, number> = {};
    for (const row of skillRows ?? []) {
      if (row.skill) {
        skillCounts[row.skill] = (skillCounts[row.skill] ?? 0) + 1;
      }
    }
    const topSkills = Object.entries(skillCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([skill, count]) => ({ skill, count }));

    // Crash clusters (top 5)
    const { data: crashes, error: crashErr } = await supabase
      .from("crash_clusters")
      .select("error_class, gstack_version, total_occurrences, identified_users")
      .limit(5);
    if (crashErr) throw crashErr;

    // Version distribution (last 7 days)
    const versionCounts: Record<string, number> = {};
    const { data: versionRows, error: versionErr } = await supabase
      .from("telemetry_events")
      .select("gstack_version")
      .eq("event_type", "skill_run")
      .gte("event_timestamp", weekAgo)
      .limit(1000);
    if (versionErr) throw versionErr;

    for (const row of versionRows ?? []) {
      if (row.gstack_version) {
        versionCounts[row.gstack_version] = (versionCounts[row.gstack_version] ?? 0) + 1;
      }
    }
    const topVersions = Object.entries(versionCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([version, count]) => ({ version, count }));

    // Security events — aggregate attack_attempt events from the last 7 days.
    // Fields emitted by gstack-telemetry-log --event-type attack_attempt:
    //   security_url_domain, security_payload_hash, security_confidence,
    //   security_layer, security_verdict.
    const { data: attackRows, error: attackErr } = await supabase
      .from("telemetry_events")
      .select("security_url_domain, security_layer, security_verdict, installation_id")
      .eq("event_type", "attack_attempt")
      .gte("event_timestamp", weekAgo)
      .limit(5000);
    if (attackErr) throw attackErr;

    // k-anonymity threshold. A domain (or layer) must be reported by at least
    // K_ANON distinct installations to appear in the aggregate. Without this,
    // a single user's attack log leaks their targeted domains to every other
    // gstack user who polls /community-pulse. With it, the dashboard shows
    // only community-wide patterns.
    const K_ANON = 5;

    const attacksTotal = attackRows?.length ?? 0;
    const domainCounts: Record<string, number> = {};
    const domainInstallations: Record<string, Set<string>> = {};
    const layerCounts: Record<string, number> = {};
    const layerInstallations: Record<string, Set<string>> = {};
    const verdictCounts: Record<string, number> = {};
    for (const row of attackRows ?? []) {
      const iid = row.installation_id ?? "";
      if (row.security_url_domain) {
        domainCounts[row.security_url_domain] = (domainCounts[row.security_url_domain] ?? 0) + 1;
        if (iid) {
          (domainInstallations[row.security_url_domain] ??= new Set()).add(iid);
        }
      }
      if (row.security_layer) {
        layerCounts[row.security_layer] = (layerCounts[row.security_layer] ?? 0) + 1;
        if (iid) {
          (layerInstallations[row.security_layer] ??= new Set()).add(iid);
        }
      }
      if (row.security_verdict) {
        // Verdict distribution is low-cardinality (block/warn/log_only) and
        // aggregates population-wide with no re-identification risk, so no
        // k-anon filter.
        verdictCounts[row.security_verdict] = (verdictCounts[row.security_verdict] ?? 0) + 1;
      }
    }
    const topAttackDomains = Object.entries(domainCounts)
      .filter(([domain]) => (domainInstallations[domain]?.size ?? 0) >= K_ANON)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([domain, count]) => ({ domain, count }));
    const topAttackLayers = Object.entries(layerCounts)
      .filter(([layer]) => (layerInstallations[layer]?.size ?? 0) >= K_ANON)
      .sort(([, a], [, b]) => b - a)
      .map(([layer, count]) => ({ layer, count }));
    const attackVerdictDistribution = Object.entries(verdictCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([verdict, count]) => ({ verdict, count }));

    const result = {
      status: "ok",
      weekly_active: current,
      change_pct: changePct,
      top_skills: topSkills,
      crashes: crashes ?? [],
      versions: topVersions,
      // Security aggregate for the /security-dashboard view
      security: {
        attacks_last_7_days: attacksTotal,
        top_attack_domains: topAttackDomains,
        top_attack_layers: topAttackLayers,
        verdict_distribution: attackVerdictDistribution,
      },
    };

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
