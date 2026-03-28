// gstack community-benchmarks edge function
// Computes per-skill duration stats from telemetry_events (last 30 days).
// Upserts results into community_benchmarks table.
// Cached for 1 hour via Cache-Control header.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();

    // Fetch all skill_run events with duration from last 30 days
    const { data: events, error } = await supabase
      .from("telemetry_events")
      .select("skill, duration_s, outcome")
      .eq("event_type", "skill_run")
      .eq("source", "live")
      .not("duration_s", "is", null)
      .not("skill", "is", null)
      .gte("event_timestamp", thirtyDaysAgo)
      .order("skill")
      .limit(10000);

    if (error) throw error;
    if (!events || events.length === 0) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Group by skill and compute stats
    const skillMap: Record<
      string,
      { durations: number[]; successes: number; total: number }
    > = {};

    for (const event of events) {
      if (!event.skill || event.duration_s == null) continue;
      if (!skillMap[event.skill]) {
        skillMap[event.skill] = { durations: [], successes: 0, total: 0 };
      }
      skillMap[event.skill].durations.push(Number(event.duration_s));
      skillMap[event.skill].total++;
      if (event.outcome === "success") {
        skillMap[event.skill].successes++;
      }
    }

    const benchmarks = Object.entries(skillMap)
      .filter(([skill]) => !skill.startsWith("_")) // skip internal skills
      .map(([skill, data]) => {
        const sorted = data.durations.sort((a, b) => a - b);
        const len = sorted.length;
        const percentile = (p: number) => {
          const idx = Math.floor((p / 100) * (len - 1));
          return sorted[idx] ?? 0;
        };

        return {
          skill,
          median_duration_s: percentile(50),
          p25_duration_s: percentile(25),
          p75_duration_s: percentile(75),
          total_runs: data.total,
          success_rate:
            data.total > 0
              ? Math.round((data.successes / data.total) * 1000) / 10
              : 0,
          updated_at: new Date().toISOString(),
        };
      });

    // Upsert into community_benchmarks table
    if (benchmarks.length > 0) {
      const { error: upsertError } = await supabase
        .from("community_benchmarks")
        .upsert(benchmarks, { onConflict: "skill" });

      if (upsertError) {
        console.error("Upsert error:", upsertError);
      }
    }

    return new Response(JSON.stringify(benchmarks), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    console.error("Benchmarks error:", err);
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
