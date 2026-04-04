/**
 * URL validation for navigation commands — blocks dangerous schemes and cloud metadata endpoints.
 * Localhost and private IPs are allowed (primary use case: QA testing local dev servers).
 */

const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',  // AWS/GCP/Azure instance metadata
  'fd00::',           // IPv6 unique local (metadata in some cloud setups)
  'metadata.google.internal', // GCP metadata
  'metadata.azure.internal',  // Azure IMDS
]);

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
 * Extract IPv4 address from IPv4-mapped IPv6 address (::ffff:x.x.x.x or ::x.x.x.x).
 * Returns null if not an IPv4-mapped address.
 */
function extractIpv4FromMappedIpv6(hostname: string): string | null {
  // Match IPv4-mapped IPv6 patterns with dotted decimal notation:
  // - ::ffff:192.0.2.1 (standard IPv4-mapped)
  // - ::192.0.2.1 (deprecated IPv4-compatible)
  // - 0:0:0:0:0:ffff:192.0.2.1 (full form)
  // - 0:0:0:0:0:0:192.0.2.1 (full deprecated form)
  
  // Check for IPv4-mapped pattern with dotted decimal
  const mappedPattern = /^(::ffff:|0:0:0:0:0:ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
  const match = hostname.match(mappedPattern);
  if (match) {
    return match[2];
  }
  
  // Check for deprecated IPv4-compatible pattern (::192.0.2.1 or 0:0:0:0:0:0:192.0.2.1)
  const compatPattern = /^(::|0:0:0:0:0:0:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
  const compatMatch = hostname.match(compatPattern);
  if (compatMatch) {
    return compatMatch[2];
  }
  
  // Check for hex-encoded IPv4-mapped addresses:
  // - ::ffff:a9fe:a9fe (where a9fe = 169.254)
  // - 0:0:0:0:0:ffff:a9fe:a9fe (full form)
  const hexMappedPattern = /^(::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
  const hexMatch = hostname.match(hexMappedPattern);
  if (hexMatch) {
    const part1 = parseInt(hexMatch[2], 16);
    const part2 = parseInt(hexMatch[3], 16);
    if (!isNaN(part1) && !isNaN(part2) && part1 <= 65535 && part2 <= 65535) {
      const octet1 = (part1 >> 8) & 0xff;
      const octet2 = part1 & 0xff;
      const octet3 = (part2 >> 8) & 0xff;
      const octet4 = part2 & 0xff;
      return `${octet1}.${octet2}.${octet3}.${octet4}`;
    }
  }
  
  // Check for deprecated hex IPv4-compatible:
  // - ::a9fe:a9fe
  // - 0:0:0:0:0:0:a9fe:a9fe
  const hexCompatPattern = /^(::|0:0:0:0:0:0:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
  const hexCompatMatch = hostname.match(hexCompatPattern);
  if (hexCompatMatch) {
    const part1 = parseInt(hexCompatMatch[2], 16);
    const part2 = parseInt(hexCompatMatch[3], 16);
    if (!isNaN(part1) && !isNaN(part2) && part1 <= 65535 && part2 <= 65535) {
      const octet1 = (part1 >> 8) & 0xff;
      const octet2 = part1 & 0xff;
      const octet3 = (part2 >> 8) & 0xff;
      const octet4 = part2 & 0xff;
      return `${octet1}.${octet2}.${octet3}.${octet4}`;
    }
  }
  
  return null;
}

/**
 * Check if a hostname resolves to the link-local metadata IP 169.254.169.254.
 * Catches hex (0xA9FEA9FE), decimal (2852039166), octal (0251.0376.0251.0376),
 * and IPv4-mapped IPv6 (::ffff:169.254.169.254) forms.
 */
function isMetadataIp(hostname: string): boolean {
  // Try to parse as a numeric IP via URL constructor — it normalizes all forms
  try {
    const probe = new URL(`http://${hostname}`);
    const normalized = probe.hostname;
    if (BLOCKED_METADATA_HOSTS.has(normalized)) return true;
    // Also check after stripping trailing dot
    if (normalized.endsWith('.') && BLOCKED_METADATA_HOSTS.has(normalized.slice(0, -1))) return true;
  } catch {
    // Not a valid hostname — can't be a metadata IP
  }
  
  // Check for IPv4-mapped IPv6 addresses that bypass URL normalization
  // Examples: ::ffff:169.254.169.254, ::169.254.169.254, 0:0:0:0:0:ffff:169.254.169.254
  const extractedIpv4 = extractIpv4FromMappedIpv6(hostname);
  if (extractedIpv4) {
    // Check if the extracted IPv4 is a metadata IP
    if (BLOCKED_METADATA_HOSTS.has(extractedIpv4)) return true;
    // Also check normalized forms of the extracted IP
    try {
      const probe = new URL(`http://${extractedIpv4}`);
      if (BLOCKED_METADATA_HOSTS.has(probe.hostname)) return true;
    } catch {
      // Ignore errors
    }
  }
  
  return false;
}

/**
 * Resolve a hostname to its IP addresses and check if any resolve to blocked metadata IPs.
 * Mitigates DNS rebinding: even if the hostname looks safe, the resolved IP might not be.
 */
async function resolvesToBlockedIp(hostname: string): Promise<boolean> {
  try {
    const dns = await import('node:dns');
    const { resolve4 } = dns.promises;
    const addresses = await resolve4(hostname);
    return addresses.some(addr => BLOCKED_METADATA_HOSTS.has(addr));
  } catch {
    // DNS resolution failed — not a rebinding risk
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

  if (BLOCKED_METADATA_HOSTS.has(hostname) || isMetadataIp(hostname)) {
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


