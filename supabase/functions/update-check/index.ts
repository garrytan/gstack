// gstack update-check edge function
// Logs an install ping and returns the current latest version.
// Called by bin/gstack-update-check as a parallel background request.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CURRENT_VERSION = Deno.env.get("GSTACK_CURRENT_VERSION") || "0.6.4.1";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(CURRENT_VERSION, { status: 200 });
  }

  try {
    const { version, os } = await req.json();

    if (!version || !os) {
      return new Response(CURRENT_VERSION, { status: 200 });
    }

    // Use anon key — the service role key bypasses RLS and is over-privileged
    // for a public endpoint that only needs INSERT on update_checks.
    // (Same rationale as telemetry-ingest; see that function's comments.)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    // Log the update check (fire-and-forget)
    await supabase.from("update_checks").insert({
      gstack_version: String(version).slice(0, 20),
      os: String(os).slice(0, 20),
    });

    return new Response(CURRENT_VERSION, { status: 200 });
  } catch {
    // Always return the version, even if logging fails
    return new Response(CURRENT_VERSION, { status: 200 });
  }
});
