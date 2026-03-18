/**
 * URL validation — prevent SSRF and local resource access
 *
 * Blocks file:/data:/javascript: schemes and private/internal IPs.
 * Set BROWSE_ALLOW_PRIVATE=1 to bypass the private-IP check (local dev).
 */

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

const BLOCKED_HOSTNAMES = new Set(['localhost']);

/**
 * Check whether an IPv4 address is private/internal.
 * Covers 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 * 169.254.0.0/16 (link-local / cloud metadata), and 0.0.0.0.
 */
function isPrivateIP(hostname: string): boolean {
  // Quick check for 0.0.0.0
  if (hostname === '0.0.0.0') return true;

  // Parse IPv4 octets
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map(Number);
  if (octets.some(o => isNaN(o) || o < 0 || o > 255)) return false;

  const [a, b] = octets;

  if (a === 127) return true;              // 127.0.0.0/8
  if (a === 10) return true;               // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;  // 192.168.0.0/16
  if (a === 169 && b === 254) return true;  // 169.254.0.0/16

  return false;
}

/**
 * Validate a URL before navigating to it.
 * Throws a descriptive error if the URL is blocked.
 */
export function validateNavigationUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Scheme check
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Blocked URL scheme "${parsed.protocol}" — only http: and https: are allowed. ` +
      `Received: ${url}`
    );
  }

  // Private/internal IP check (bypass with BROWSE_ALLOW_PRIVATE=1)
  if (process.env.BROWSE_ALLOW_PRIVATE === '1') return;

  const hostname = parsed.hostname;

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Blocked navigation to "${hostname}" — internal/private hosts are not allowed. ` +
      `Set BROWSE_ALLOW_PRIVATE=1 to override for local development.`
    );
  }

  if (isPrivateIP(hostname)) {
    throw new Error(
      `Blocked navigation to private IP "${hostname}" — internal network access is not allowed. ` +
      `Set BROWSE_ALLOW_PRIVATE=1 to override for local development.`
    );
  }
}
