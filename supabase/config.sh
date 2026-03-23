#!/usr/bin/env bash
# Supabase project config for gstack telemetry
# These are PUBLIC keys — safe to commit (like Firebase public config).
# RLS policies restrict what the anon/publishable key can do (INSERT only).

GSTACK_SUPABASE_URL="https://frugpmstpnojnhfyimgv.supabase.co"
GSTACK_SUPABASE_ANON_KEY="sb_publishable_tR4i6cyMIrYTE3s6OyHGHw_ppx2p6WK"

# Telemetry ingest endpoint (Data API)
GSTACK_TELEMETRY_ENDPOINT="${GSTACK_SUPABASE_URL}/rest/v1"
