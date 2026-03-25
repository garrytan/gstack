// gstack community-pulse edge function
// Returns aggregated community stats for the dashboard:
// weekly active count, top skills, crash clusters, version distribution.
// Uses server-side cache (community_pulse_cache table) to prevent DoS.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    // Check cache first
    const { data: cached } = await supabase
      .from("community_pulse_cache")
      .select("data, refreshed_at")
      .eq("id", 1)
      .single();

    if (cached?.refreshed_at) {
      const age = Date.now() - new Date(cached.refreshed_at).getTime();
      if (age < CACHE_MAX_AGE_MS) {
        return new Response(JSON.stringify(cached.data), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
    }

    // Cache is stale or missing — recompute
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    // Weekly active (update checks this week)
    const { count: thisWeek } = await supabase
      .from("update_checks")
      .select("*", { count: "exact", head: true })
      .gte("checked_at", weekAgo);

    // Last week (for change %)
    const { count: lastWeek } = await supabase
      .from("update_checks")
      .select("*", { count: "exact", head: true })
      .gte("checked_at", twoWeeksAgo)
      .lt("checked_at", weekAgo);

    const current = thisWeek ?? 0;
    const previous = lastWeek ?? 0;
    const changePct = previous > 0
      ? Math.round(((current - previous) / previous) * 100)
      : 0;

    // Top skills (last 7 days)
    const { data: skillRows } = await supabase
      .from("telemetry_events")
      .select("skill")
      .eq("event_type", "skill_run")
      .gte("event_timestamp", weekAgo)
      .not("skill", "is", null)
      .limit(1000);

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
    const { data: crashes } = await supabase
      .from("crash_clusters")
      .select("error_class, gstack_version, total_occurrences, identified_users")
      .limit(5);

    // Version distribution (last 7 days)
    const versionCounts: Record<string, number> = {};
    const { data: versionRows } = await supabase
      .from("telemetry_events")
      .select("gstack_version")
      .eq("event_type", "skill_run")
      .gte("event_timestamp", weekAgo)
      .limit(1000);

    for (const row of versionRows ?? []) {
      if (row.gstack_version) {
        versionCounts[row.gstack_version] = (versionCounts[row.gstack_version] ?? 0) + 1;
      }
    }
    const topVersions = Object.entries(versionCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([version, count]) => ({ version, count }));

    const result = {
      weekly_active: current,
      change_pct: changePct,
      top_skills: topSkills,
      crashes: crashes ?? [],
      versions: topVersions,
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
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response(
      JSON.stringify({ weekly_active: 0, change_pct: 0, top_skills: [], crashes: [], versions: [] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
