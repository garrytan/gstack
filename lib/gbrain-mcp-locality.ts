/**
 * gbrain-mcp-locality — is a registered gbrain MCP entry a remote brain? (#3539)
 *
 * An http/url/sse MCP entry used to mean "Path 4: the brain lives on another
 * machine", so transcripts were staged for a brain admin's pull instead of
 * going through `gbrain import`. gbrain's own recommended setup for local
 * agents on a Postgres brain is one resident `gbrain serve --http` on
 * loopback, registered by `gbrain bootstrap harness`. That entry is HTTP but
 * the brain is on this machine, and no brain admin will ever index the
 * staged pages.
 *
 * Rule: an HTTP entry is LOCAL when its URL is http(s) on a loopback host AND
 * this machine's gbrain config names a Postgres engine (a `database_url`,
 * engine not `pglite`) and no `remote_mcp` thin-client marker. Every other
 * HTTP entry stays remote, as before. A PGLite config does not count: Path 4's
 * split-engine setup pairs a remote brain with a local PGLite for code search,
 * and a remote brain reached through a tunnel on a loopback port must stay
 * remote there; a PGLite brain held open by a resident serve is engine-locked
 * for imports anyway. stdio entries are local, as before. Any
 * other URL scheme (ws:, file:) stays remote. The marker test is gbrain's own
 * isThinClient() truthiness (`!!remote_mcp`), so `remote_mcp: 0` or `""` is
 * not a marker.
 *
 * File reads only: no subprocess, no network (a classifier network probe is
 * the #1964 pathology).
 *
 * bin/gstack-skill-start carries a jq copy of this rule for its hot path. It
 * is a conservative subset, not an exact mirror: its URL regex accepts only
 * canonical loopback spellings (localhost, 127.a.b.c without leading zeros,
 * [::1]), so whenever jq says local this file says local too, while some
 * spellings this file accepts (127.1, 0x7f.1, 127.0.0.1.) stay remote in jq.
 * The config half matches exactly. test/gbrain-mcp-locality.test.ts runs both
 * copies over the same table and enforces that relation.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { gbrainConfigDir } from "./gbrain-exec";

export interface GbrainMcpEntry {
  type?: string;
  transport?: string;
  command?: string;
  url?: string;
}

/**
 * True when the URL is http(s) and its host is localhost, 127.0.0.0/8 or ::1.
 * A URL with userinfo, or containing `${`, is never loopback: Claude Code
 * expands `${VAR}` in `url` before connecting, so `http://${X}@127.0.0.1/mcp`
 * can dial any host.
 */
export function isLoopbackMcpUrl(url: string | undefined | null): boolean {
  if (typeof url !== "string" || url.trim() === "" || url.includes("${")) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  // WHATWG URL normalizes IPv4 forms (127.1, 0x7f.1) to dotted quads.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * This machine's gbrain config (gbrainConfigDir()/config.json, honoring
 * GBRAIN_HOME) names a Postgres engine (a non-blank database_url, engine not
 * pglite) and carries no remote_mcp marker (truthy, as in gbrain's
 * isThinClient).
 */
export function hasLocalPostgresEngine(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(gbrainConfigDir(env), "config.json"), "utf-8")) as {
      engine?: unknown;
      database_url?: unknown;
      remote_mcp?: unknown;
    } | null;
    if (!cfg || typeof cfg !== "object") return false;
    if (cfg.remote_mcp) return false;
    return cfg.engine !== "pglite" && typeof cfg.database_url === "string" && cfg.database_url.trim() !== "";
  } catch {
    return false;
  }
}

/** An HTTP MCP URL that reaches this machine's own Postgres gbrain engine. */
export function isLocalHttpGbrain(url: string | undefined | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return isLoopbackMcpUrl(url) && hasLocalPostgresEngine(env);
}

/**
 * Classify one MCP registration: "remote" for an HTTP brain on another
 * machine, "local" for stdio or a loopback HTTP serve of the local engine,
 * null when the entry carries no transport signal.
 */
export function classifyGbrainMcpEntry(
  entry: GbrainMcpEntry | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): "local" | "remote" | null {
  if (!entry || typeof entry !== "object") return null;
  // Same precedence as the transport-only rule this replaces: explicit HTTP
  // type, explicit stdio, then a bare url, then a bare command.
  const mtype = entry.type || entry.transport || "";
  const remoteUnlessLoopback = (): "local" | "remote" => (isLocalHttpGbrain(entry.url, env) ? "local" : "remote");
  if (mtype === "url" || mtype === "http" || mtype === "sse") return remoteUnlessLoopback();
  if (mtype === "stdio") return "local";
  if (entry.url) return remoteUnlessLoopback();
  if (entry.command) return "local";
  return null;
}

/**
 * Classify the gbrain line of `claude mcp list`. HTTP and SSE servers print
 * as `gbrain: <url> (HTTP) - ✓ Connected` (or `(SSE)`); stdio servers print
 * their command with no transport marker.
 *
 * The URL token is everything between the name and the LAST ` (HTTP)` /
 * ` (SSE)` marker. It is never cut at `)`: a cut turns
 * `http://127.0.0.1)@evil.com/mcp` (host evil.com) into `http://127.0.0.1`.
 * A token containing whitespace, or one that is not a loopback http(s) URL
 * over a local engine, is remote. A line that names HTTP/SSE but has no
 * such token is remote, as before; a line with neither is stdio (local).
 */
export function classifyGbrainMcpListLine(
  line: string,
  env: NodeJS.ProcessEnv = process.env,
): "local" | "remote" {
  const m = /^gbrain(?:[-_][\w-]*)?:\s+(.+)\s+\((?:HTTP|SSE)\)/.exec(line);
  if (m) {
    const token = m[1];
    return !/\s/.test(token) && isLocalHttpGbrain(token, env) ? "local" : "remote";
  }
  if (/\b(?:http|HTTP)\b/.test(line) || /\((?:SSE|sse)\)/.test(line)) return "remote";
  return "local";
}
