/**
 * URL validation for navigation commands — blocks dangerous schemes and cloud metadata endpoints.
 * Localhost and private IPs are allowed (primary use case: QA testing local dev servers).
 */

export const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',  // AWS/GCP/Azure instance metadata
  'fe80::1',          // IPv6 link-local — common metadata endpoint alias
  '::ffff:169.254.169.254', // IPv4-mapped IPv6 form of the metadata IP
  'metadata.google.internal', // GCP metadata
  'metadata.azure.internal',  // Azure IMDS
]);

/**
 * IPv6 prefixes to block (CIDR-style). Any address starting with these
 * hex prefixes is rejected. Covers the full ULA range (fc00::/7 = fc00:: and fd00::).
 */
const BLOCKED_IPV6_PREFIXES = ['fc', 'fd'];

/**
 * Check if an IPv6 address falls within a blocked prefix range.
 * Handles the full ULA range (fc00::/7), not just the exact literal fd00::.
 * Only matches actual IPv6 addresses (must contain ':'), not hostnames
 * like fd.example.com or fcustomer.com.
 */
function isBlockedIpv6(addr: string): boolean {
  const normalized = addr.toLowerCase().replace(/^\[|\]$/g, '');
  // Must contain a colon to be an IPv6 address — avoids false positives on
  // hostnames like fd.example.com or fcustomer.com
  if (!normalized.includes(':')) return false;
  return BLOCKED_IPV6_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * Normalize hostname for blocklist comparison:
 * - Strip trailing dot (DNS fully-qualified notation)
 * - Strip IPv6 brackets (URL.hostname includes [] for IPv6)
 * - Resolve hex (0xA9FEA9FE) and decimal (2852039166) IP representations
 */
function normalizeHostname(hostname: string): string {
  // Strip IPv6 brackets
  let h = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  // Strip trailing dot
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * Check if a hostname resolves to the link-local metadata IP 169.254.169.254.
 * Catches hex (0xA9FEA9FE), decimal (2852039166), and octal (0251.0376.0251.0376) forms.
 */
function isMetadataIp(hostname: string): boolean {
  // Try to parse as a numeric IP via URL constructor — it normalizes all forms
  try {
    const probe = new URL(`http://${hostname}`);
    const normalized = probe.hostname;
    if (BLOCKED_METADATA_HOSTS.has(normalized) || isBlockedIpv6(normalized)) return true;
    // Also check after stripping trailing dot
    if (normalized.endsWith('.') && BLOCKED_METADATA_HOSTS.has(normalized.slice(0, -1))) return true;
  } catch {
    // Not a valid hostname — can't be a metadata IP
  }
  return false;
}

/**
 * Resolve a hostname to its IP addresses and check if any resolve to blocked metadata IPs.
 * Mitigates DNS rebinding: even if the hostname looks safe, the resolved IP might not be.
 *
 * Checks both A (IPv4) and AAAA (IPv6) records — an attacker can use AAAA-only DNS to
 * bypass IPv4-only checks. Each record family is tried independently; failure of one
 * (e.g. no AAAA records exist) is not treated as a rebinding risk.
 */
async function resolvesToBlockedIp(hostname: string): Promise<boolean> {
  try {
    const dns = await import('node:dns');
    const { resolve4, resolve6 } = dns.promises;

    // Check IPv4 A records
    const v4Check = resolve4(hostname).then(
      (addresses) => addresses.some(addr => BLOCKED_METADATA_HOSTS.has(addr)),
      () => false, // ENODATA / ENOTFOUND — no A records, not a risk
    );

    // Check IPv6 AAAA records — the gap that issue #668 identified
    const v6Check = resolve6(hostname).then(
      (addresses) => addresses.some(addr => {
        const normalized = addr.toLowerCase();
        return BLOCKED_METADATA_HOSTS.has(normalized) || isBlockedIpv6(normalized) ||
          // fe80::/10 is link-local — always block (covers all fe80:: addresses)
          normalized.startsWith('fe80:');
      }),
      () => false, // ENODATA / ENOTFOUND — no AAAA records, not a risk
    );

    const [v4Blocked, v6Blocked] = await Promise.all([v4Check, v6Check]);
    return v4Blocked || v6Blocked;
  } catch {
    // Unexpected error — fail open (don't block navigation on DNS infrastructure failure)
    return false;
  }
}

export async function validateNavigationUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Blocked: scheme "${parsed.protocol}" is not allowed. Only http: and https: URLs are permitted.`
    );
  }

  const hostname = normalizeHostname(parsed.hostname.toLowerCase());

  if (BLOCKED_METADATA_HOSTS.has(hostname) || isMetadataIp(hostname) || isBlockedIpv6(hostname)) {
    throw new Error(
      `Blocked: ${parsed.hostname} is a cloud metadata endpoint. Access is denied for security.`
    );
  }

  // DNS rebinding protection: resolve hostname and check if it points to metadata IPs.
  // Skip for loopback/private IPs — they can't be DNS-rebinded and the async DNS
  // resolution adds latency that breaks concurrent E2E tests under load.
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const isPrivateNet = /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(hostname);
  if (!isLoopback && !isPrivateNet && await resolvesToBlockedIp(hostname)) {
    throw new Error(
      `Blocked: ${parsed.hostname} resolves to a cloud metadata IP. Possible DNS rebinding attack.`
    );
  }
}
