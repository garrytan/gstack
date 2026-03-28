// gstack community-recommendations edge function
// Returns skill recommendations based on co-occurrence patterns.
// Input: ?skills=qa,ship (user's top skills as comma-separated query param)
// Output: top 3 recommended skills the user hasn't tried yet.
// Cached for 24 hours via Cache-Control header.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    const url = new URL(req.url);
    const userSkills = (url.searchParams.get("skills") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (userSkills.length === 0) {
      return new Response(JSON.stringify({ recommendations: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Query skill_sequences for co-occurring skills
    const { data: sequences, error } = await supabase
      .from("skill_sequences")
      .select("skill_a, skill_b, co_occurrences")
      .in("skill_a", userSkills)
      .order("co_occurrences", { ascending: false })
      .limit(50);

    if (error) throw error;

    // Find skills the user hasn't used yet, ranked by co-occurrence
    const userSkillSet = new Set(userSkills);
    const recommendations: Record<
      string,
      { co_occurrences: number; paired_with: string[] }
    > = {};

    for (const seq of sequences ?? []) {
      if (userSkillSet.has(seq.skill_b)) continue; // already used
      if (seq.skill_b.startsWith("_")) continue; // skip internal

      if (!recommendations[seq.skill_b]) {
        recommendations[seq.skill_b] = {
          co_occurrences: 0,
          paired_with: [],
        };
      }
      recommendations[seq.skill_b].co_occurrences += seq.co_occurrences;
      recommendations[seq.skill_b].paired_with.push(seq.skill_a);
    }

    // Also get total run counts for percentage calculation
    const { data: benchmarks } = await supabase
      .from("community_benchmarks")
      .select("skill, total_runs");

    const totalBySkill: Record<string, number> = {};
    for (const b of benchmarks ?? []) {
      totalBySkill[b.skill] = b.total_runs;
    }

    // Build top 3 recommendations
    const sorted = Object.entries(recommendations)
      .sort(([, a], [, b]) => b.co_occurrences - a.co_occurrences)
      .slice(0, 3)
      .map(([skill, data]) => {
        const pairedSkill = data.paired_with[0];
        const pairedTotal = totalBySkill[pairedSkill] ?? 0;
        const pct =
          pairedTotal > 0
            ? Math.round((data.co_occurrences / pairedTotal) * 100)
            : 0;

        return {
          skill,
          reason: `used by ${pct}% of /${pairedSkill} users`,
          co_occurrences: data.co_occurrences,
        };
      });

    return new Response(JSON.stringify({ recommendations: sorted }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err) {
    console.error("Recommendations error:", err);
    return new Response(JSON.stringify({ recommendations: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
