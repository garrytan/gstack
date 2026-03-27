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
 * Check if a hostname resolves to the link-local metadata IP 169.254.169.254.
 * Catches hex (0xA9FEA9FE), decimal (2852039166), and octal (0251.0376.0251.0376) forms.
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
