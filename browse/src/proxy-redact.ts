/**
 * Single source of truth for redacting proxy credentials in log lines.
 *
 * Anywhere browse logs a proxy URL (startup banner, error messages, debug
 * output), it MUST go through redactProxyUrl first. Tests assert this for
 * every log path that prints proxy config.
 */

const REDACTED = '***';

/**
 * Redact creds in a proxy URL string. Returns the URL with username and
 * password replaced by '***'. If the input isn't parseable as a URL, returns
 * a generic placeholder rather than echoing it back (input may be malformed
 * AND contain creds).
 */
export function redactProxyUrl(input: string | null | undefined): string {
  if (!input) return '<no proxy>';
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return '<malformed proxy url>';
  }
  if (url.username) url.username = REDACTED;
  if (url.password) url.password = REDACTED;
  return url.toString();
}

/**
 * Redact creds in an upstream config object (host/port/userId/password).
 * Returns a plain object suitable for logging.
 */
export function redactUpstream(upstream: {
  host: string;
  port: number;
  userId?: string;
  password?: string;
}): { host: string; port: number; userId?: string; password?: string } {
  return {
    host: upstream.host,
    port: upstream.port,
    ...(upstream.userId ? { userId: REDACTED } : {}),
    ...(upstream.password ? { password: REDACTED } : {}),
  };
}
