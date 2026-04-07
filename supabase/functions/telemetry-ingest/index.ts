// gstack telemetry-ingest edge function
// Validates and inserts a batch of telemetry events.
// Called by bin/gstack-telemetry-sync.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface TelemetryEvent {
  v: number;
  ts: string;
  event_type: string;
  skill: string;
  session_id?: string;
  gstack_version: string;
  os: string;
  arch?: string;
  duration_s?: number;
  outcome: string;
  error_class?: string;
  used_browse?: boolean;
  sessions?: number;
  installation_id?: string;
}

const MAX_BATCH_SIZE = 100;
const MAX_PAYLOAD_BYTES = 50_000; // 50KB

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("POST required", { status: 405 });
  }

  // Check payload size
  const contentLength = parseInt(req.headers.get("content-length") || "0");
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  try {
    const body = await req.json();
    const events: TelemetryEvent[] = Array.isArray(body) ? body : [body];

    if (events.length > MAX_BATCH_SIZE) {
      return new Response(`Batch too large (max ${MAX_BATCH_SIZE})`, { status: 400 });
    }

    // Use the anon key, not the service role key.
    // The service role key bypasses Row Level Security (RLS) and grants full
    // unrestricted database access — wildly over-privileged for a public
    // telemetry endpoint that only needs INSERT on two tables.
    // The anon key + properly configured RLS INSERT policies is correct.
    // See: https://supabase.com/docs/guides/database/postgres/row-level-security
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    // Validate and transform events
    const rows = [];
    const installationUpserts: Map<string, { version: string; os: string }> = new Map();

    for (const event of events) {
      // Required fields
      if (!event.ts || !event.gstack_version || !event.os || !event.outcome) {
        continue; // skip malformed
      }

      // Validate schema version
      if (event.v !== 1) continue;

      // Validate event_type
      const validTypes = ["skill_run", "upgrade_prompted", "upgrade_completed"];
      if (!validTypes.includes(event.event_type)) continue;

      rows.push({
        schema_version: event.v,
        event_type: event.event_type,
        gstack_version: String(event.gstack_version).slice(0, 20),
        os: String(event.os).slice(0, 20),
        arch: event.arch ? String(event.arch).slice(0, 20) : null,
        event_timestamp: event.ts,
        skill: event.skill ? String(event.skill).slice(0, 50) : null,
        session_id: event.session_id ? String(event.session_id).slice(0, 50) : null,
        duration_s: typeof event.duration_s === "number" ? event.duration_s : null,
        outcome: String(event.outcome).slice(0, 20),
        error_class: event.error_class ? String(event.error_class).slice(0, 100) : null,
        used_browse: event.used_browse === true,
        concurrent_sessions: typeof event.sessions === "number" ? event.sessions : 1,
        installation_id: event.installation_id ? String(event.installation_id).slice(0, 64) : null,
      });

      // Track installations for upsert
      if (event.installation_id) {
        installationUpserts.set(event.installation_id, {
          version: event.gstack_version,
          os: event.os,
        });
      }
    }

    if (rows.length === 0) {
      return new Response(JSON.stringify({ inserted: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Insert events
    const { error: insertError } = await supabase
      .from("telemetry_events")
      .insert(rows);

    if (insertError) {
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Upsert installations (update last_seen)
    for (const [id, data] of installationUpserts) {
      await supabase
        .from("installations")
        .upsert(
          {
            installation_id: id,
            last_seen: new Date().toISOString(),
            gstack_version: data.version,
            os: data.os,
          },
          { onConflict: "installation_id" }
        );
    }

    return new Response(JSON.stringify({ inserted: rows.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
});
