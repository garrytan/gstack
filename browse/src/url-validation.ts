/**
 * URL validation to prevent SSRF and local resource access.
 *
 * Blocks file:// URLs, private/internal IPs, and non-HTTP schemes.
 * Set BROWSE_ALLOW_PRIVATE=1 to bypass for local development.
 */

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Check if a hostname resolves to a private/internal IP address.
 */
function isPrivateHost(hostname: string): boolean {
  // IPv6 loopback
  if (hostname === '[::1]' || hostname === '::1') return true;

  // Strip brackets from IPv6
  const bare = hostname.replace(/^\[|\]$/g, '');

  // IPv6 unique-local (fc00::/7)
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true;

  // IPv4 checks
  const parts = bare.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p))) {
    const [a, b] = parts;
    // 127.0.0.0/8
    if (a === 127) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0
    if (a === 0 && b === 0 && parts[2] === 0 && parts[3] === 0) return true;
  }

  // "localhost" variants
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;

  return false;
}

/**
 * Validate a URL before navigating. Throws if the URL is not allowed.
 */
export function validateUrl(url: string): void {
  // Bypass when explicitly opted in for local development
  if (process.env.BROWSE_ALLOW_PRIVATE === '1') return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Invalid URL: "${url}". Only http: and https: URLs are allowed.`
    );
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Blocked URL scheme "${parsed.protocol}" in "${url}". Only http: and https: are allowed.`
    );
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error(
      `Blocked navigation to private/internal address "${parsed.hostname}". ` +
      `Set BROWSE_ALLOW_PRIVATE=1 to allow local development URLs.`
    );
  }
}
