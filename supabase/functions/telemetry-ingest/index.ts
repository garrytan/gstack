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
  error_message?: string;
  failed_step?: string;
  used_browse?: boolean;
  sessions?: number;
  installation_id?: string;
  source?: string;
  security_url_domain?: string;
  security_payload_hash?: string;
  security_confidence?: number;
  security_layer?: string;
  security_verdict?: string;
  host?: string;
  model_family?: string;
  invoked?: string;
  exit_reason?: string;
  checks?: string;
  routing?: string;
  harness_session_id?: string;
  from_version?: string;
  upgrade_error?: string;
}

// Fields from migration 009 (docs/privacy.md). Each is a pick from a fixed list
// the client also enforces, a 16-hex random session id, or a version; anything
// else is stored as null. Keep these lists equal to bin/gstack-telemetry-log's.
const NEXT_ENUMS: Record<string, string[]> = {
  host: ["claude_code", "codex", "cursor", "openclaw", "hermes", "other", "unknown"],
  model_family: ["claude_opus", "claude_sonnet", "claude_haiku", "claude_other", "gpt", "gemini", "other", "unknown"],
  invoked: ["user", "model", "chained", "unknown"],
  exit_reason: ["completed", "user_stopped", "blocked", "tool_error", "test_failed", "context_limit", "gave_up", "unknown"],
  checks: ["passed", "failed", "not_run", "unknown"],
  routing: ["none", "block", "hooks", "both", "unknown"],
  upgrade_error: ["none", "refused_dirty", "busy", "fetch_failed", "setup_failed", "other", "unknown"],
};
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/;
function nextFields(event: TelemetryEvent) {
  const out: Record<string, string | null> = {};
  for (const [k, allowed] of Object.entries(NEXT_ENUMS)) {
    const v = (event as unknown as Record<string, unknown>)[k];
    out[k] = typeof v === "string" && allowed.includes(v) ? v : null;
  }
  out.harness_session_id = typeof event.harness_session_id === "string" &&
      /^[0-9a-f]{16}$/.test(event.harness_session_id) ? event.harness_session_id : null;
  out.from_version = typeof event.from_version === "string" && VERSION_RE.test(event.from_version)
    ? event.from_version : null;
  return out;
}

// outcome arrives in about ten spellings from older clients; store one of four
// and keep the original in outcome_raw when it differed.
const OUTCOME_MAP: Record<string, string> = {
  success: "success", ok: "success", done: "success", completed: "success",
  error: "error", fail: "error", failed: "error", failure: "error",
  abort: "abort", aborted: "abort", cancelled: "abort", canceled: "abort",
  unknown: "unknown",
};
function normalizeOutcome(outcome: unknown) {
  const raw = String(outcome).slice(0, 20);
  const norm = OUTCOME_MAP[raw.toLowerCase()] ?? "unknown";
  return { outcome: norm, outcome_raw: norm === raw ? null : raw };
}

// bin/gstack-telemetry-log writes source from --source or
// GSTACK_TELEMETRY_SOURCE (default "live"). Keep it so test, eval, CI and
// gstack's own use on Capy ("capy", or "gt" from its maintainer's machines)
// can be told apart from real use; anything unexpected is "other", never "live".
const SOURCES = ["live", "test", "eval", "ci", "capy", "gt"];
function normalizeSource(source: unknown): string {
  if (source === undefined || source === null || source === "") return "live";
  return SOURCES.includes(String(source)) ? String(source) : "other";
}

// Prompt-injection detections (browse/src/security.ts via gstack-telemetry-log
// --event-type attack_attempt; columns from migration 004). Domain only, a
// salted hash, a 0..1 score and two enums; anything else is dropped.
const SECURITY_LAYERS = [
  "stackone_content", "testsavant_content", "transcript_classifier",
  "aria_regex", "canary", "deberta_content",
];
const SECURITY_VERDICTS = ["block", "warn", "log_only"];
function securityFields(event: TelemetryEvent) {
  const domain = typeof event.security_url_domain === "string" &&
      /^[A-Za-z0-9.-]{1,253}$/.test(event.security_url_domain)
    ? event.security_url_domain.toLowerCase() : null;
  const hash = typeof event.security_payload_hash === "string" &&
      /^[0-9a-f]{16,128}$/.test(event.security_payload_hash)
    ? event.security_payload_hash : null;
  const confidence = typeof event.security_confidence === "number" &&
      event.security_confidence >= 0 && event.security_confidence <= 1
    ? event.security_confidence : null;
  return {
    security_url_domain: domain,
    security_payload_hash: hash,
    security_confidence: confidence,
    security_layer: SECURITY_LAYERS.includes(String(event.security_layer)) ? event.security_layer : null,
    security_verdict: SECURITY_VERDICTS.includes(String(event.security_verdict)) ? event.security_verdict : null,
  };
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

    // Service role key, as update-check and community-pulse use. The public
    // anon key can no longer write to these tables (migration 008): the RLS
    // insert policies it relied on also let anyone write arbitrary rows
    // straight through PostgREST. This function is now the only write path,
    // and it validates every field before the insert below.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
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

      // Validate event_type. Activation-funnel events (v1.x) join the originals:
      // onboarding (P0 setup nudge), first_task_scaffold_shown (P4 first-run
      // scaffold), handoff (P1 office-hours → next skill), route (gstack router).
      // attack_attempt carries the prompt-injection fields (migration 004).
      const validTypes = [
        "skill_run",
        "upgrade_prompted",
        "upgrade_completed",
        "onboarding",
        "first_task_scaffold_shown",
        "handoff",
        "route",
        "attack_attempt",
      ];
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
        ...normalizeOutcome(event.outcome),
        error_class: event.error_class ? String(event.error_class).slice(0, 100) : null,
        error_message: event.error_message ? String(event.error_message).slice(0, 500) : null,
        failed_step: event.failed_step ? String(event.failed_step).slice(0, 100) : null,
        used_browse: event.used_browse === true,
        concurrent_sessions: typeof event.sessions === "number" ? event.sessions : 1,
        installation_id: event.installation_id ? String(event.installation_id).slice(0, 64) : null,
        source: normalizeSource(event.source),
        ...(event.event_type === "attack_attempt" ? securityFields(event) : {}),
        ...nextFields(event),
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
