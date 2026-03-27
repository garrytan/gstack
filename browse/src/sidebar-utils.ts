/**
 * Shared sidebar utilities — extracted for testability.
 */

/**
 * Sanitize a URL from the Chrome extension before embedding in a prompt.
 * Only accepts http/https, strips control characters, truncates to 2048 chars.
 * Returns null if the URL is invalid or uses a non-http scheme.
 */
export function sanitizeExtensionUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.href.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 2048);
    }
    return null;
  } catch {
    return null;
  }
}
